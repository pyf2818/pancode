/* ============================================================
   阶段一-2 权限主体（subject）规范化回归。

   修的两个静默失效：
     ① apply_edit 不在 _hookSubject 清单里 —— deny "src/**" 拦不住它，
        而它是"改已有文件的首选工具"，等于最常见的写路径完全不受路径规则约束；
        它的 patch 字段一次还能改多个文件。
     ② 路径主体不规范化 —— 模型写 ./src/x、src\\x、/src/x，
        而 glob 是 ^…$ 锚定的，不命中即静默放行。

   以及一处收紧：allow 规则 "src" 以前靠无边界 startsWith 会连带放行 "src-eval/x.js"。
   ============================================================ */
const { LlmAgent, _ctx } = require("../server/agent-llm");
const { canonicalRulePath, pathPrefixHit } = _ctx;

function agent(perm, extra) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { permissions: Object.assign({ mode: "ask", allow: [], deny: [] }, perm || {}) };
  a._sessionGrants = new Set();
  Object.assign(a, extra || {});
  return a;
}

/* Aider 风格补丁：块前非空行即文件路径（server/patch.js:216） */
function patchOf(paths) {
  return paths.map((p) => p + "\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n").join("");
}

describe("canonicalRulePath：模型的路径写法收敛成一种", () => {
  it("反斜杠 / 前导 ./ / 前导 / / 盘符 / 重复斜杠都归一成根内相对路径", () => {
    for (const p of ["src/x.js", "./src/x.js", "src\\x.js", "/src/x.js", ".\\src\\x.js",
      "C:/src/x.js", "C:\\src\\x.js", "src//x.js", "././src/x.js"]) {
      expect(canonicalRulePath(p), p).toBe("src/x.js");
    }
  });

  it("保留 .. 段（越界判断归 FileStore.safePath，不归规则）", () => {
    expect(canonicalRulePath("../x.js")).toBe("../x.js");
    expect(canonicalRulePath("src/../../x.js")).toBe("src/../../x.js");
  });

  it("空与非字符串安全返回空串", () => {
    for (const p of ["", "   ", null, undefined]) expect(canonicalRulePath(p)).toBe("");
  });
});

describe("pathPrefixHit：只在分隔符边界上退化", () => {
  it("src 命中 src/x.js，不命中 src-eval/x.js", () => {
    expect(pathPrefixHit("src", "src/x.js")).toBe(true);
    expect(pathPrefixHit("src", "src/sub/x.js")).toBe(true);
    expect(pathPrefixHit("src", "src-eval/x.js")).toBe(false);
    expect(pathPrefixHit("src", "src.js")).toBe(false);
    expect(pathPrefixHit("src", "notsrc/x.js")).toBe(false);
  });

  it("pattern 末尾的 * 去掉后仍按段边界判", () => {
    expect(pathPrefixHit("src*", "src/x.js")).toBe(true);
    expect(pathPrefixHit("src/*", "src/x.js")).toBe(true);
    expect(pathPrefixHit("src/*", "src-eval/x.js")).toBe(false);
  });
});

describe("_subjectPaths：apply_edit 一次改多文件也要全被看见", () => {
  it("非路径类工具返回 null（保持原来的文本主体判定）", () => {
    const a = agent();
    for (const n of ["read_file", "run_command", "git_commit", "web_fetch", "mcp__x__y"]) {
      expect(a._subjectPaths(n, { path: "src/x.js" }), n).toBeNull();
    }
  });

  it("write_file / delete_file 取 path 并规范化", () => {
    const a = agent();
    expect(a._subjectPaths("write_file", { path: "./src/a.js" })).toEqual(["src/a.js"]);
    expect(a._subjectPaths("delete_file", { path: "C:\\src\\a.js" })).toEqual(["src/a.js"]);
  });

  it("apply_edit 的 patch 里每个文件都进主体（这是原来漏掉的）", () => {
    const a = agent();
    const got = a._subjectPaths("apply_edit", { patch: patchOf(["docs/a.md", "src/b.js", ".env"]) });
    expect(got).toContain("docs/a.md");
    expect(got).toContain("src/b.js");
    expect(got).toContain(".env");
  });

  it("apply_edit 只有 path 时也正常；两者都给时去重合并", () => {
    const a = agent();
    expect(a._subjectPaths("apply_edit", { path: "src/b.js" })).toEqual(["src/b.js"]);
    const both = a._subjectPaths("apply_edit", { path: "src/b.js", patch: patchOf(["docs/a.md", "src/b.js"]) });
    expect(both).toHaveLength(2);
  });

  it("路径解析不出来时返回空数组而不是 null（不能退化成「无路径约束」）", () => {
    const a = agent();
    expect(a._subjectPaths("write_file", {})).toEqual([]);
  });

  it("_hookSubject 对 apply_edit 不再是空串（hooks 也拿得到主体了）", () => {
    const a = agent();
    expect(a._hookSubject("apply_edit", { path: "src/b.js" })).toBe("src/b.js");
    expect(a._hookSubject("run_command", { command: "git push --force" })).toBe("git push --force");
  });
});

describe("_approvalDecision：deny 命中任一 / allow 覆盖全部", () => {
  it("deny src/** 拦住 apply_edit —— 迁移前它完全没有主体，规则形同不存在", () => {
    const a = agent({ mode: "auto", deny: [{ tool: "apply_edit", pattern: "src/**" }] });
    expect(a._approvalDecision("apply_edit", { path: "./src/x.js" }).action).toBe("block");
  });

  it("多文件 patch 里只要有路径命中 deny，整个调用就拦下", () => {
    const a = agent({ mode: "auto", deny: [{ tool: "apply_edit", pattern: "src/**" }] });
    const d = a._approvalDecision("apply_edit", { patch: patchOf(["docs/a.md", "src/b.js"]) });
    expect(d.action).toBe("block");
    expect(d.reason).toContain("拒绝规则");
  });

  it("allow docs/** 不足以放行同时改了 src 的 patch（deny 没命中也要退回人工确认）", () => {
    const a = agent({ mode: "ask", allow: [{ tool: "apply_edit", pattern: "docs/**" }] });
    const d = a._approvalDecision("apply_edit", { patch: patchOf(["docs/a.md", "src/b.js"]) });
    expect(d.action).toBe("ask");
  });

  it("allow 覆盖全部被触碰路径才直接放行", () => {
    const a = agent({ mode: "ask", allow: [{ tool: "apply_edit", pattern: "docs/**" }] });
    const d = a._approvalDecision("apply_edit", { patch: patchOf(["docs/a.md", "docs/b.md"]) });
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("全部 2 个路径");
  });

  it("allow 规则 src 不再连带放行 src-eval/x.js（段边界收紧）", () => {
    const a = agent({ mode: "ask", allow: [{ tool: "write_file", pattern: "src" }] });
    expect(a._approvalDecision("write_file", { path: "src/x.js" }).action).toBe("allow");
    expect(a._approvalDecision("write_file", { path: "src-eval/x.js" }).action).toBe("ask");
  });

  it("命令类的前缀语义保持不变：deny git push 仍拦住 git push --force", () => {
    const a = agent({ mode: "auto", deny: [{ tool: "run_command", pattern: "git push" }] });
    expect(a._approvalDecision("run_command", { command: "git push --force" }).action).toBe("block");
  });

  it("delete_file 的不可逆强制确认不受影响", () => {
    const a = agent({
      mode: "auto",
      allow: [{ tool: "delete_file", pattern: "**" }],
      deny: [],
    });
    a._sessionGrants = new Set(["delete_file"]);
    const d = a._approvalDecision("delete_file", { path: "src/x.js" });
    expect(d.action).toBe("ask");
    expect(d.reason).toContain("不可逆");
  });

  it("无规则时不受影响：auto 放行写类、只读仍然免确认", () => {
    const a = agent({ mode: "auto" });
    expect(a._approvalDecision("write_file", { path: "a.js" }).action).toBe("allow");
    expect(a._approvalDecision("read_file", { path: "a.js" }).action).toBe("allow");
  });

  it("deny 仍排在 allow 与会话授权之前（顺序不变）", () => {
    const a = agent({
      mode: "auto",
      allow: [{ tool: "write_file", pattern: "**" }],
      deny: [{ tool: "write_file", pattern: ".env" }],
    });
    a._sessionGrants = new Set(["write_file"]);
    expect(a._approvalDecision("write_file", { path: ".env" }).action).toBe("block");
    expect(a._approvalDecision("write_file", { path: "src/a.js" }).action).toBe("allow");
  });
});
