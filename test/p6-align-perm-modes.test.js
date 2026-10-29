/* ============================================================
   P6-#11/#12 权限档位对齐 openanlan（Claude Code）：补 acceptEdits / dontAsk / smart 三档。
   （smart = 它的 auto 档 —— pancode 的 auto 已被"全放行"占用，改名保留语义，
     旧三档 ask/semi/auto 的判定一字未改：改了等于把用户机器上的配置悄悄换含义。）
   这里钉的是**判序的位置**，因为三档各自的危险面都在"插在哪一道之后"：
     acceptEdits 不能盖过 deny 规则与不可逆守卫
     dontAsk     不能留下一张没人能点的卡
     smart       判不了时必须回落问人，而不是当成放行
   ============================================================ */
const { LlmAgent } = require("../server/agent-llm");

function agent(mode, extra) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { permissions: { mode, allow: [], deny: [] } };
  a._sessionGrants = new Set();
  a._convIdNow = () => "c1";
  a._liveHistory = () => [];
  a.emit = () => {};
  a._decision = () => {};
  Object.assign(a, extra || {});
  return a;
}
const patchOf = (paths) => paths.map((p) => p + "\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n").join("");

describe("acceptEdits：只免文件改动那一格", () => {
  it("write_file / apply_edit 这类算得出路径的改盘工具免确认", () => {
    expect(agent("acceptEdits")._approvalDecision("write_file", { path: "src/a.js" }).action).toBe("allow");
    expect(agent("acceptEdits")._approvalDecision("apply_edit", { patch: patchOf(["src/a.js"]) }).action).toBe("allow");
  });

  it("run_command 不是文件编辑，照样问", () => {
    const d = agent("acceptEdits")._approvalDecision("run_command", { command: "rm -rf build" });
    expect(d.action).toBe("ask");
    expect(d.reason).toContain("不是文件改动");
  });

  it("不可逆守卫排在前面：delete_file 即使在 acceptEdits 也仍要问", () => {
    expect(agent("acceptEdits")._approvalDecision("delete_file", { path: "src/a.js" }).action).toBe("ask");
  });

  it("deny 规则仍然赢：acceptEdits 不许替被拒绝的路径背书", () => {
    const a = agent("acceptEdits");
    a.cfg.permissions.deny = [{ tool: "write_file", pattern: "src/**", action: "deny" }];
    expect(a._approvalDecision("write_file", { path: "src/a.js" }).action).toBe("block");
  });

  it("只读工具不受档位影响（本来就一直免检）", () => {
    expect(agent("acceptEdits")._approvalDecision("read_file", { path: "src/a.js" }).action).toBe("allow");
  });
});

describe("dontAsk：该问的一律拒绝，不留弹不掉的卡", () => {
  it("本来要问的写操作直接拒", () => {
    const d = agent("dontAsk")._approvalDecision("run_command", { command: "ls" });
    expect(d.action).toBe("block");
    expect(d.reason).toContain("不再询问");
  });

  it("不可逆那一格也被覆盖：不能弹出一张无人能点的卡", () => {
    expect(agent("dontAsk")._approvalDecision("delete_file", { path: "src/a.js" }).action).toBe("block");
  });

  it("只读仍放行 —— 这一档收的是「问人」，不是收「读」", () => {
    expect(agent("dontAsk")._approvalDecision("read_file", { path: "src/a.js" }).action).toBe("allow");
    expect(agent("dontAsk")._approvalDecision("git_status", {}).action).toBe("allow");
  });

  it("allow 规则命中仍放行（用户明确授权过的东西不该被这档收回）", () => {
    const a = agent("dontAsk");
    a.cfg.permissions.allow = [{ tool: "run_command", pattern: "npm test", action: "allow" }];
    expect(a._approvalDecision("run_command", { command: "npm test" }).action).toBe("allow");
  });
});

describe("旧三档语义逐字不变（对齐不许顺手改坏在用的配置）", () => {
  it("ask：写操作问、只读放", () => {
    expect(agent("ask")._approvalDecision("write_file", { path: "a.js" }).action).toBe("ask");
    expect(agent("ask")._approvalDecision("read_file", { path: "a.js" }).action).toBe("allow");
  });
  it("semi：与 ask 同样拦写操作（差别在 allow 规则那一层，不在这条链上）", () => {
    expect(agent("semi")._approvalDecision("write_file", { path: "a.js" }).action).toBe("ask");
  });
  it("auto：写操作放行，但不可逆仍拦", () => {
    expect(agent("auto")._approvalDecision("write_file", { path: "a.js" }).action).toBe("allow");
    expect(agent("auto")._approvalDecision("delete_file", { path: "a.js" }).action).toBe("ask");
  });
});

describe("smart：分类器判定", () => {
  it("判序只出 classify 哨兵（本方法必须保持同步，file-tools 也在直接调它）", () => {
    const d = agent("smart")._approvalDecision("write_file", { path: "src/a.js" });
    expect(d.action).toBe("classify");
  });

  it("只读与 deny 轮不到分类器：确定性那道先给结论", () => {
    expect(agent("smart")._approvalDecision("read_file", { path: "a.js" }).action).toBe("allow");
    const a = agent("smart");
    a.cfg.permissions.deny = [{ tool: "write_file", pattern: "src/**", action: "deny" }];
    expect(a._approvalDecision("write_file", { path: "src/a.js" }).action).toBe("block");
  });

  it("不可逆仍走人工，不拿模型判断去顶替硬守卫", () => {
    expect(agent("smart")._approvalDecision("delete_file", { path: "a.js" }).action).toBe("ask");
    expect(agent("smart")._approvalDecision("git_push", {}).action).toBe("ask");
  });

  it("回答解析只认 ALLOW/DENY，废话一律 unknown", () => {
    const a = agent("smart");
    expect(a._parseSmartVerdict("ALLOW\n跟用户目标一致").verdict).toBe("allow");
    expect(a._parseSmartVerdict("DENY\n这会删掉没提交的东西").verdict).toBe("deny");
    expect(a._parseSmartVerdict("拒绝\n越权了").verdict).toBe("deny");
    expect(a._parseSmartVerdict("我觉得可以吧").verdict).toBe("unknown");
    expect(a._parseSmartVerdict("").verdict).toBe("unknown");
    expect(a._parseSmartVerdict(undefined).verdict).toBe("unknown");
  });

  it("负控：分类器调用失败 = unknown，绝不退化成放行", async () => {
    const a = agent("smart", {
      _chatStream: async () => { throw new Error("上游 500"); },
    });
    const v = await a._smartVerdict("write_file", { path: "src/a.js" });
    expect(v.verdict).toBe("unknown");
    expect(v.reason).toContain("调用失败");
  });

  it("同一发只问一次：60 秒内命中缓存，不再花钱", async () => {
    let calls = 0;
    const a = agent("smart", {
      _chatStream: async () => { calls++; return { content: "ALLOW\n一致" }; },
    });
    await a._smartVerdict("write_file", { path: "src/a.js" });
    await a._smartVerdict("write_file", { path: "src/a.js" });
    expect(calls).toBe(1);
    await a._smartVerdict("write_file", { path: "src/另一个.js" });
    expect(calls).toBe(2);                      // 换了对象就是另一发，不共用结论
  });

  it("连续拒 3 次后停手回落问人；回落过一次之后重新上膛", async () => {
    const asked = [];
    const a = agent("smart", {
      _chatStream: async (msgs) => { asked.push(msgs[1].content); return { content: "DENY\n不合适" }; },
    });
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push((await a._smartVerdict("write_file", { path: "f" + i + ".js" })).verdict);
    }
    expect(seen).toEqual(["deny", "deny", "deny", "unknown", "deny"]);
    expect(asked).toHaveLength(4);                                  // 先证明"问了哪几次"这条判据不是空转
    expect(asked.some((s) => /f3\.js/.test(s))).toBe(false);   // 第 4 次没花模型的钱
    expect(asked.some((s) => /f4\.js/.test(s))).toBe(true);    // 但回落过一次后就重新上膛，不是永久自废
  });

  it("brief 带上了契约性质（撤不回 / 伸到本机之外要能被判据看见）", () => {
    const a = agent("smart");
    const brief = a._smartBrief("git_push", { remote: "origin" }, "origin/master");
    expect(brief).toContain("git_push");
    expect(brief).toContain("撤不回");
    const web = a._smartBrief("web_fetch", { url: "http://x" }, "http://x");
    expect(web).toContain("伸到本机之外");
  });
});

describe("smart 档在 _gate 里的三种落点", () => {
  const gateOf = (verdict) => {
    const calls = { approval: 0 };
    const a = agent("smart", {
      _smartVerdict: async () => ({ verdict, reason: "桩理由" }),
      requestApproval: async () => { calls.approval++; return { approved: true }; },
    });
    a._hookSubject = () => "src/a.js";
    return { a, calls };
  };

  it("分类器放行 → 不弹卡", async () => {
    const { a, calls } = gateOf("allow");
    const r = await a._gate("write_file", { path: "src/a.js" });
    expect(r.blocked).toBe(false);
    expect(r.approved).toBe(true);
    expect(calls.approval).toBe(0);
  });

  it("分类器拒绝 → 拦下并把理由给回模型", async () => {
    const { a, calls } = gateOf("deny");
    const r = await a._gate("write_file", { path: "src/a.js" });
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("桩理由");
    expect(calls.approval).toBe(0);
  });

  it("判不了 → 回落弹卡（既不是放行也不是拒绝）", async () => {
    const { a, calls } = gateOf("unknown");
    const r = await a._gate("write_file", { path: "src/a.js" });
    expect(r.blocked).toBe(false);
    expect(calls.approval).toBe(1);
  });
});

describe("配置层认得新档位", () => {
  it("PERMISSION_MODES 含三档新值，且旧三档仍在原位", () => {
    const { PERMISSION_MODES } = require("../server/config");
    expect(PERMISSION_MODES).toEqual(["ask", "semi", "acceptEdits", "smart", "auto", "dontAsk"]);
  });
});
