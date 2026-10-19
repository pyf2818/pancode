/* 视觉链路单测：截图的像素只在"显式请求 + 开关打开"时才交给模型。
   ————————————————————————————————————————————
   这一项最容易做出来的假象是"回执说已截图，模型其实一个像素都没看到"。
   所以判据的重点是三条：
   1) 没开 vision / 上游拒收 / 图太大时，绝不能入队，且实话要说清"只有用户看得见"；
   2) 入队的图只在**下一次请求**里带一次，请求发出去就收掉（base64 不进对话历史）；
   3) 附图要计入 token 估算——以前只算 text 部件，贴三张图进度条纹丝不动，
      而真实 prompt_tokens 已经涨了几千，水位骗人是这条链最坏的失败方式。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");
const vision = require("../server/computer/vision");

let TMP;
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-vision-")); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 已被自己清掉 */ } }, 30000);

function mkShot(name, bytes) {
  const abs = path.join(TMP, name);
  fs.writeFileSync(abs, Buffer.alloc(bytes, 7));
  return { abs, rel: name };
}
function agent(cfgExtra) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = Object.assign({ llm: { vision: true, contextWindow: 128000 }, context: {} }, cfgExtra || {});
  a._currentConv = "default";
  a.emitted = [];
  a.emit = (m) => a.emitted.push(m);
  a._trace = [];
  a._traceEvent = () => {};
  return a;
}

describe("入队闸门", () => {
  it("vision 没开时不入队，并说明该去哪开", () => {
    const a = agent({ llm: { vision: false } });
    const shot = mkShot("off.jpeg", 2048);
    const v = a.offerVision({ abs: shot.abs, rel: shot.rel, caption: "看排版" });
    expect(v.ok).toBe(false);
    expect(v.why).toBe("off");
    expect(a._visionFor("default")).toEqual([]);
    expect(vision.explain(v)).toContain("llm.vision");
    expect(vision.explain(v)).not.toMatch(/会随下一次请求交给你/);   // 没喂就不许说喂了
  });

  it("图超过 3MB 不入队，并把大小与出路说清楚", () => {
    const a = agent();
    const big = mkShot("big.png", 3 * 1024 * 1024 + 1024);
    const v = a.offerVision({ abs: big.abs, rel: big.rel });
    expect(v.ok).toBe(false);
    expect(v.why).toBe("too_big");
    expect(vision.explain(v)).toContain("3.0MB");
    expect(vision.explain(v)).toContain("window_ref");
  });

  it("文件不在盘上时不假装登记成功", () => {
    const a = agent();
    const v = a.offerVision({ abs: path.join(TMP, "没有这个文件.jpeg") });
    expect(v.ok).toBe(false);
    expect(v.why).toBe("missing");
  });

  it("上游拒收过一次以后，本会话不再入队", () => {
    const a = agent();
    a._visionRejected = true;
    const shot = mkShot("rej.jpeg", 1024);
    const v = a.offerVision({ abs: shot.abs, rel: shot.rel });
    expect(v.why).toBe("rejected");
    expect(a._visionFor("default")).toEqual([]);
  });
});

describe("像素随请求带一次", () => {
  it("登记后能取到 data URL，且 mime 跟着扩展名走", () => {
    const a = agent();
    const shot = mkShot("one.jpeg", 4096);
    expect(a.offerVision({ abs: shot.abs, rel: shot.rel, caption: "按钮在不在" }).ok).toBe(true);
    const list = a._visionFor("default");
    expect(list).toHaveLength(1);
    const msg = a._visionMessage(list);
    expect(msg.role).toBe("user");
    const kinds = msg.content.map((p) => p.type);
    expect(kinds).toContain("image_url");
    expect(msg.content.find((p) => p.type === "image_url").image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(JSON.stringify(msg)).toContain("按钮在不在");
    /* 只教它别拿像素当坐标用：这条链最容易犯的错是看图猜位置然后点空 */
    expect(JSON.stringify(msg)).toContain("不要按像素坐标");
  });

  it("清空以后再取就是空 —— 同一张图不许每轮重复上传", () => {
    const a = agent();
    const shot = mkShot("twice.png", 1024);
    a.offerVision({ abs: shot.abs, rel: shot.rel });
    expect(a._visionFor("default")).toHaveLength(1);
    a._clearVision("default");
    expect(a._visionFor("default")).toEqual([]);
  });

  it("一轮最多带 4 张，多的丢最早的（水位比张数金贵）", () => {
    const a = agent();
    for (let i = 0; i < 6; i++) {
      const s = mkShot("s" + i + ".png", 512);
      a.offerVision({ abs: s.abs, rel: s.rel, caption: "c" + i });
    }
    const list = a._visionFor("default");
    expect(list).toHaveLength(4);
    expect(list[0].rel).toBe("s2.png");
  });

  it("按会话分开排队：并行会话的截图不许串到别的请求里", () => {
    const a = agent();
    const s1 = mkShot("convA.png", 512);
    const s2 = mkShot("convB.png", 512);
    a.offerVision({ abs: s1.abs, rel: s1.rel });            // _currentConv = default
    a._currentConv = "other";
    a.offerVision({ abs: s2.abs, rel: s2.rel });
    expect(a._visionFor("default").map((x) => x.rel)).toEqual(["convA.png"]);
    expect(a._visionFor("other").map((x) => x.rel)).toEqual(["convB.png"]);
  });

  it("图读不出来时降级成一句说明，而不是把整轮请求弄崩", () => {
    const a = agent();
    const msg = a._visionMessage([{ abs: path.join(TMP, "不存在.png"), rel: "不存在.png", caption: "x", mime: "image/png" }]);
    expect(msg.content.some((p) => p.type === "image_url")).toBe(false);
    expect(JSON.stringify(msg)).toContain("这张没给你");
  });
});

describe("附图要计入 token 估算", () => {
  it("同样一段文字，带一张图必须比不带图估得多", () => {
    const a = agent();
    const text = { role: "user", content: "看一下这张图" };
    const withImg = { role: "user", content: [{ type: "text", text: "看一下这张图" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
    expect(a._estTokens([withImg])).toBeGreaterThan(a._estTokens([text]));
  });
});
