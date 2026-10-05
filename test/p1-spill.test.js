/* ============================================================
   P1-9 单测：超长工具结果的 spill（全文落盘 + <persisted-output> 预览信封）
   修前的行为：只砍中段、把中间内容无声丢掉 —— 模型想看全文只能重跑命令，
   用户也拿不到那份输出。修后：头尾保留 + 全文落进数据根 spill 目录 + 给出路径与取回方式。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");

let TMP;
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-spill-")); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }, 30000);

function agent(cfgExtra) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = Object.assign({
    llm: { contextWindow: 128000 },
    context: { budgetTokens: 1000000, autoCompact: true },
  }, cfgExtra || {});
  a.history = [];
  a._lastPrompt = 0;
  a._lastPromptLen = 0;
  a._currentConv = "default";
  a._spillRoot = path.join(TMP, "spill");
  a.emitted = [];
  a.emit = (m) => a.emitted.push(m);
  a._trace = [];
  a._traceEvent = (t, d) => { a._trace.push({ t, d }); };
  return a;
}

const pad = (n, ch) => String(ch || "x").repeat(n);

describe("_boundToolResult — 未超限就不加任何 framing", () => {
  it("短结果原样返回（不包 envelope、不落盘、不写 trace）", () => {
    const a = agent();
    const s = "一共 3 处匹配";
    expect(a._boundToolResult("search_code", s)).toBe(s);
    expect(a._trace.length).toBe(0);
    expect(fs.existsSync(path.join(TMP, "spill"))).toBe(false);
  });

  it("null / undefined 原样成空串，不抛错", () => {
    const a = agent();
    expect(a._boundToolResult("read_file", null)).toBe("");
    expect(a._boundToolResult("read_file", undefined)).toBe("");
  });
});

describe("_boundToolResult — 超限时的信封", () => {
  it("头尾都保留，中间被省略的字符数说得很准", () => {
    const a = agent();
    const s = "H".repeat(50000);
    const out = a._boundToolResult("run_command", s);
    const m = out.match(/上面是前 (\d+) 字符，下面是末尾 (\d+) 字符/);
    expect(m).toBeTruthy();
    const head = Number(m[1]);
    const tail = Number(m[2]);
    expect(head).toBe(Math.floor(24000 * 0.7));
    expect(head + tail).toBe(24000);
    expect(out.startsWith("H".repeat(head))).toBe(true);
    expect(out.endsWith("H".repeat(tail))).toBe(true);
    const n = out.match(/原 (\d+) 字符，中间 (\d+) 字符未随本条结果返回/);
    expect(Number(n[1])).toBe(50000);
    expect(Number(n[2])).toBe(50000 - head - tail);   // 报的省略数必须等于真的没给的那部分
  });

  it("信封点名：全文路径、头尾各留了多少、以及不要盲目重跑", () => {
    const a = agent();
    const out = a._boundToolResult("run_command", pad(60000));
    expect(out).toContain("<persisted-output>");
    expect(out).toContain("</persisted-output>");
    expect(out).toMatch(/全文已保存到：/);
    expect(out).toContain("报错与结论通常在末尾");
    expect(out).toContain("不要盲目重跑同一条命令");
  });

  it("水位越高收得越紧：60% / 80% 三档预览上限", () => {
    const mk = (histChars) => {
      const a = agent({ llm: { contextWindow: 128000 }, context: { budgetTokens: 128000, autoCompact: true } });
      a.history = [{ role: "user", content: histChars }];
      return a;
    };
    const big = pad(60000);
    // 阈值 102400 token ≈ 409600 字符正文：按水位反推行数
    const low = mk(pad(10000));
    const mid = mk(pad(270000));   // ~67500 token / 102400 ≈ 66%
    const high = mk(pad(360000));  // ~90000 token / 102400 ≈ 88%
    const span = (o) => {
      const m = o.match(/上面是前 (\d+) 字符，下面是末尾 (\d+) 字符/);
      return Number(m[1]) + Number(m[2]);
    };
    expect(span(low._boundToolResult("run_command", big))).toBe(24000);
    expect(span(mid._boundToolResult("run_command", big))).toBe(8000);
    expect(span(high._boundToolResult("run_command", big))).toBe(4000);
  });
});

describe("_spillToolResult — 落盘本身", () => {
  it("全文按内容逐字节写进会话子目录，文件名带工具名", () => {
    const a = agent();
    a._currentConv = "conv-7";
    const text = "构建日志\n" + pad(30000, "A") + "\n失败于 step 3";
    const out = a._boundToolResult("run_command", text);
    const m = out.match(/全文已保存到：(.+)/);
    expect(m).toBeTruthy();
    const fp = m[1].trim();
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp, "utf8")).toBe(text);
    expect(path.basename(fp)).toContain("run_command");
    expect(fp.replace(/\\/g, "/")).toContain("/spill/conv-7/");
  });

  it("路径穿越被挡：会话名里的斜杠与点都进不了目录结构", () => {
    const a = agent();
    a._currentConv = "../../etc/passwd";
    const out = a._boundToolResult("read_file", pad(60000));
    const fp = out.match(/全文已保存到：(.+)/)[1].trim();
    const rel = path.relative(path.join(TMP, "spill"), path.dirname(fp));
    expect(rel.startsWith("..")).toBe(false);
    expect(fs.existsSync(fp)).toBe(true);
  });

  it("同一毫秒内的连续溢出各自成文件，不互相覆盖", () => {
    const a = agent();
    const p1 = a._spillToolResult("run_command", pad(100));
    const p2 = a._spillToolResult("run_command", pad(200));
    expect(p1 && p2 && p1 !== p2).toBe(true);
    expect(fs.readFileSync(p2, "utf8").length).toBe(200);
  });

  it("每会话只保留最近 60 份，超出的按时间淘汰", () => {
    const a = agent();
    a._currentConv = "prune-me";
    const dir = path.join(TMP, "spill", "prune-me");
    fs.mkdirSync(dir, { recursive: true });
    const base = Date.now() - 500000;
    for (let i = 0; i < 80; i++) {
      const f = path.join(dir, (base + i) + "-old.txt");
      fs.writeFileSync(f, "x");
      fs.utimesSync(f, new Date(base + i), new Date(base + i));
    }
    a._spillToolResult("run_command", pad(100));
    const left = fs.readdirSync(dir);
    expect(left.length).toBeLessThanOrEqual(60);
    expect(left.filter((f) => f.endsWith("-old.txt")).length).toBeLessThanOrEqual(59);
  });

  it("超过单文件上限的超大输出不写盘，但信封会如实说落盘失败（不谎报路径）", () => {
    const a = agent();
    const out = a._boundToolResult("run_command", "H".repeat(4 * 1024 * 1024 + 10));
    expect(out).toContain("全文未能落盘");
    expect(out).not.toMatch(/全文已保存到：/);
    expect(out).toContain("H".repeat(100));   // 头尾预览仍在
  });

  it("落盘目录不可写时降级为纯预览，绝不抛错打断工具返回", () => {
    const a = agent();
    a._spillRoot = path.join(TMP, "bad\0path");   // mkdir 必失败
    const out = a._boundToolResult("run_command", pad(60000));
    expect(out).toContain("全文未能落盘");
    expect(out.length).toBeLessThan(70000);
  });

  it("trace 记下一次 spill 事实（供 Trace 面板与成本回看）", () => {
    const a = agent();
    a._boundToolResult("search_code", pad(60000));
    const ev = a._trace.find((e) => e.t === "tool.spill");
    expect(ev).toBeTruthy();
    expect(ev.d.name).toBe("search_code");
    expect(ev.d.original).toBe(60000);
    expect(ev.d.spilled).toBe(true);
    expect(ev.d.omitted).toBeGreaterThan(0);
  });
});
