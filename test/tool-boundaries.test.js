/* ============================================================
   工具执行边界（回归）
   apply_edit 在"暂存"之前必须完成三件事：路径归属、读写档、deny 规则。
   以前它一样都不做：跨根时改到当前工作区同名文件、auto 档绕过 deny 规则。
   edit_files 的归组键必须是「根 + 根内相对路径」，不是模型写的那串 path。
   run_tests 必须与 run_command 走同一条沙箱包装，argv 非空时走无 shell spawn。
   ============================================================ */
const TOOLS = require("../server/tools/file-tools");
const testTools = require("../server/tools/test-tools");
const sandbox = require("../server/sandbox");

function memStore(dir, files) {
  const map = new Map(Object.entries(files || {}));
  return {
    dir,
    exists: (p) => map.has(p),
    read: (p) => (map.has(p) ? map.get(p) : ""),
    write: (p, c) => { map.set(p, c); },
    remove: (p) => { map.delete(p); },
    _map: map,
  };
}

function cards() {
  const list = [];
  const tool = (kind, title, arg) => {
    const c = {
      kind, title, arg, bodies: [], dones: [],
      body(s) { this.bodies.push(s); },
      done(ok, msg, undo) { this.dones.push({ ok, msg, undo }); },
    };
    list.push(c);
    return c;
  };
  return { list, tool };
}

function agentOf(store, extra) {
  const c = cards();
  const a = Object.assign({
    files: store,
    cfg: { permissions: { mode: "ask", allow: [], deny: [] } },
    tool: c.tool,
    emit() {},
    fileChanged() {},
    pushChanges() {},
    _recordWrite() {},
    _convIdNow: () => "conv-1",
    _gate: async () => ({ blocked: false, approved: true }),
    _snapshotBefore(p, s) {
      const st = s || store;
      const existed = st.exists(p);
      return { path: p, beforeExisted: existed, beforeContent: existed ? st.read(p) : null, store: st === store ? null : st, dir: st.dir };
    },
    _pushCheckpoint() {},
    _approvalDecision: () => ({ action: "allow" }),
  }, extra || {});
  a._cards = c.list;
  return a;
}

describe("apply_edit：先判边界，再暂存", () => {
  const spec = { path: "src/x.js", edits: [{ old_string: "OLD", new_string: "NEW" }] };

  function patchSpy() {
    const calls = [];
    return { calls, patch: { stage: (...args) => { calls.push(args); return { ok: true, staged: [{ path: "src/x.js", status: "M", isNew: false, add: 1, del: 1, hunks: [], original: "OLD", modified: "NEW" }] }; } } };
  }

  it("deny 规则命中 → 不暂存、不落盘", async () => {
    const store = memStore("/ws/a", { "src/x.js": "OLD" });
    const spy = patchSpy();
    let staged = 0;
    const a = agentOf(store, {
      patch: { stage: (...args) => { staged++; return spy.patch.stage(...args); } },
      roots: { resolve: () => ({ ok: true, store, rel: "src/x.js", root: { active: true, id: "ra", dir: "/ws/a", label: "A", writable: true } }) },
      _approvalDecision: () => ({ action: "block", reason: "命中拒绝规则 deny src/**" }),
    });
    const out = await TOOLS.apply_edit(a, spec);
    expect(out).toContain("被拒绝规则拦截");
    expect(out).toContain("未暂存任何改动");
    expect(staged).toBe(0);
    expect(store.read("src/x.js")).toBe("OLD");
  });

  it("目标属于另一个已授权根 → 拒绝并指路 edit_files；当前工作区同名文件不动", async () => {
    const cur = memStore("/ws/a", { "src/x.js": "CURRENT" });
    const foreign = memStore("/ws/b", { "src/x.js": "FOREIGN" });
    let staged = 0;
    const a = agentOf(cur, {
      patch: { stage: (...args) => { staged++; return { ok: true, staged: [] }; } },
      roots: {
        resolve: () => ({
          ok: true, store: foreign, rel: "src/x.js",
          root: { active: false, id: "rb", dir: "/ws/b", label: "B", writable: true },
        }),
      },
    });
    const out = await TOOLS.apply_edit(a, { root: "rb", path: "src/x.js", edits: spec.edits });
    expect(out).toContain("只改当前工作区");
    expect(out).toContain("edit_files");
    expect(out).toContain("B");
    expect(staged).toBe(0);
    expect(cur.read("src/x.js")).toBe("CURRENT");
    expect(foreign.read("src/x.js")).toBe("FOREIGN");
  });

  it("只读根 / 未授权 → 沿用 roots 的拒绝理由，同样不暂存", async () => {
    const store = memStore("/ws/a", {});
    let staged = 0;
    const a = agentOf(store, {
      patch: { stage: () => { staged++; return { ok: true, staged: [] }; } },
      roots: { resolve: () => ({ ok: false, error: "「B」是只读授权，不能写入 src/x.js。" }) },
    });
    const out = await TOOLS.apply_edit(a, spec);
    expect(out).toContain("编辑未应用");
    expect(out).toContain("只读授权");
    expect(staged).toBe(0);
  });

  it("auto 档写盘失败 → 明说失败，不许回执写成「已自动写入」", async () => {
    const store = memStore("/ws/a", { "src/x.js": "OLD" });
    const a = agentOf(store, {
      cfg: { permissions: { mode: "auto", allow: [], deny: [] } },
      roots: { resolve: () => ({ ok: true, store, rel: "src/x.js", root: { active: true, id: "ra", dir: "/ws/a", label: "A", writable: true } }) },
      patch: { stage: () => ({ ok: true, staged: [{ path: "src/x.js", status: "M", isNew: false, add: 1, del: 1, hunks: [], original: "OLD", modified: "NEW" }] }) },
      applyPatch: () => ({ applied: [], conflicts: [], failed: [{ path: "src/x.js", error: "EACCES" }] }),
    });
    const out = await TOOLS.apply_edit(a, spec);
    expect(out).toContain("写入失败");
    expect(out).toContain("EACCES");
    expect(out).not.toContain("已自动写入");
    expect(a._cards[0].dones[0].ok).toBe(false);
  });

  it("auto 档成功 → 回执点名写过的文件", async () => {
    const store = memStore("/ws/a", { "src/x.js": "OLD" });
    const a = agentOf(store, {
      cfg: { permissions: { mode: "auto", allow: [], deny: [] } },
      roots: { resolve: () => ({ ok: true, store, rel: "src/x.js", root: { active: true, id: "ra", dir: "/ws/a", label: "A", writable: true } }) },
      patch: { stage: () => ({ ok: true, staged: [{ path: "src/x.js", status: "M", isNew: false, add: 1, del: 1, hunks: [], original: "OLD", modified: "NEW" }] }) },
      applyPatch: () => ({ applied: ["src/x.js"], conflicts: [], failed: [] }),
    });
    const out = await TOOLS.apply_edit(a, spec);
    expect(out).toContain("已自动写入 1 个文件改动");
    expect(out).toContain("src/x.js");
  });
});

describe("edit_files：归组键是「根 + 相对路径」", () => {
  it("两个根下同名 src/x.js 都被改到，互不覆盖", async () => {
    const cur = memStore("/ws/a", { "src/x.js": "OLD" });
    const other = memStore("/ws/b", { "src/x.js": "OLD" });
    const checkpoints = [];
    let gates = 0;
    const a = agentOf(cur, {
      roots: {
        resolve: ({ root }) => (root === "rb"
          ? { ok: true, store: other, rel: "src/x.js", root: { active: false, id: "rb", dir: "/ws/b", label: "B", writable: true } }
          : { ok: true, store: cur, rel: "src/x.js", root: { active: true, id: "ra", dir: "/ws/a", label: "A", writable: true } }),
      },
      _gate: async () => { gates++; return { blocked: false, approved: true }; },
      _pushCheckpoint: (snaps, label) => checkpoints.push({ snaps, label }),
    });

    const out = await TOOLS.edit_files(a, { ops: [
      { path: "src/x.js", root: "ra", old_string: "OLD", new_string: "AAA" },
      { path: "src/x.js", root: "rb", old_string: "OLD", new_string: "BBB" },
    ] });

    expect(cur.read("src/x.js")).toBe("AAA");
    expect(other.read("src/x.js")).toBe("BBB");
    expect(out).toContain("已原子写入 2 个文件");
    expect(gates).toBe(2);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].snaps).toHaveLength(2);
    expect(checkpoints[0].label).toContain("2 个文件");
  });
});

/* 跨根改动的回执不许分阶段说谎：内存栈里的检查点带着自己那个 FileStore，
   本进程内退得回来；影子快照只覆盖当前工作区，重启后这批退不回来。
   写一句不分阶段的"/undo 可以撤销"，模型就照抄成对用户的承诺。 */
describe("跨根写入的撤销边界要说准", () => {
  function foreignAgent(pushed) {
    const cur = memStore("/ws/a", {});
    const other = memStore("/ws/b", {});
    const a = agentOf(cur, {
      roots: {
        resolve: () => ({
          ok: true, store: other, rel: "src/x.js",
          root: { active: false, id: "rb", dir: "/ws/b", label: "B", writable: true },
        }),
      },
      _pushCheckpoint: (snaps, label) => pushed.push({ snaps, label }),
    });
    return { a, other };
  }

  it("write_file 跨根：不再许诺无条件的 /undo，写清重启后退不回来", async () => {
    const pushed = [];
    const { a, other } = foreignAgent(pushed);
    const out = await TOOLS.write_file(a, { path: "src/x.js", content: "NEW", root: "rb" });
    expect(other.read("src/x.js")).toBe("NEW");
    expect(pushed).toHaveLength(1);
    expect(out).not.toContain("/undo 可以撤销");
    expect(out).toContain("撤销只在本次服务运行期间有效");
    expect(out).toContain("重启后这批退不回来");
  });

  it("delete_file 跨根：同样带边界", async () => {
    const cur = memStore("/ws/a", {});
    const other = memStore("/ws/b", { "src/x.js": "OLD" });
    const a = agentOf(cur, {
      roots: {
        resolve: () => ({
          ok: true, store: other, rel: "src/x.js",
          root: { active: false, id: "rb", dir: "/ws/b", label: "B", writable: true },
        }),
      },
    });
    const out = await TOOLS.delete_file(a, { path: "src/x.js", root: "rb" });
    expect(out).not.toContain("/undo 可以恢复");
    expect(out).toContain("重启后这批退不回来");
  });

  it("edit_files 混合批次：点名哪些文件属于别的根，其余只说本进程内可回滚", async () => {
    const cur = memStore("/ws/a", { "src/x.js": "OLD" });
    const other = memStore("/ws/b", { "src/x.js": "OLD" });
    const a = agentOf(cur, {
      roots: {
        resolve: ({ root }) => (root === "rb"
          ? { ok: true, store: other, rel: "src/x.js", root: { active: false, id: "rb", dir: "/ws/b", label: "B", writable: true } }
          : { ok: true, store: cur, rel: "src/x.js", root: { active: true, id: "ra", dir: "/ws/a", label: "A", writable: true } }),
      },
    });
    const out = await TOOLS.edit_files(a, { ops: [
      { path: "src/x.js", root: "ra", old_string: "OLD", new_string: "AAA" },
      { path: "src/x.js", root: "rb", old_string: "OLD", new_string: "BBB" },
    ] });
    expect(out).toContain("本次服务运行期间");
    expect(out).toContain("B:src/x.js 属于别的根");
    expect(out).toContain("重启后这批退不回来");
  });

  it("edit_files 全在本工作区：不许凭空扯别的根", async () => {
    const cur = memStore("/ws/a", { "src/x.js": "OLD" });
    const a = agentOf(cur, {
      roots: {
        resolve: () => ({ ok: true, store: cur, rel: "src/x.js", root: { active: true, id: "ra", dir: "/ws/a", label: "A", writable: true } }),
      },
    });
    const out = await TOOLS.edit_files(a, { ops: [{ path: "src/x.js", old_string: "OLD", new_string: "AAA" }] });
    expect(out).toContain("本次服务运行期间");
    expect(out).not.toContain("属于别的根");
  });
});

describe("run_tests：与 run_command 同一条沙箱路径", () => {
  const saved = sandbox.wrap;
  afterEach(() => { sandbox.wrap = saved; });

  it("包装后的 display 与 argv 原样交给终端（argv 非空 = 无 shell spawn）", async () => {
    const calls = [];
    sandbox.wrap = (cmd, opts) => {
      calls.push({ cmd, opts });
      return { command: "docker exec x " + cmd, display: "docker exec x " + cmd, argv: ["docker", "exec", "x", cmd], backend: "docker", sandboxed: true, note: "容器隔离" };
    };
    const ran = [];
    const c = cards();
    const a = {
      files: { dir: "/ws", read: () => null, exists: () => false },
      cfg: { permissions: { mode: "ask" } },
      tool: c.tool,
      state() {},
      pushChanges() {},
      _gate: async () => ({ blocked: false, approved: true }),
      term: { run: async (...args) => { ran.push(args); return { out: "1 passed", code: 0 }; } },
    };

    const out = await testTools.run_tests(a, { command: "pytest -q", timeoutSec: 60 });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.workspace).toBe("/ws");
    expect(ran).toHaveLength(1);
    expect(ran[0][1]).toBe("docker exec x pytest -q");
    expect(ran[0][2]).toEqual(["docker", "exec", "x", "pytest -q"]);
    expect(ran[0][3]).toMatchObject({ strict: true, ai: true });
    expect(out).toContain("【测试通过】");
    expect(c.list[0].bodies.join("")).toContain("沙箱·docker");
  });

  it("policy 后端（argv=null）保持原来的字符串调用，不伪造 argv", async () => {
    sandbox.wrap = (cmd) => ({ command: cmd, display: cmd, argv: null, backend: "policy", sandboxed: false, note: "" });
    const ran = [];
    const c = cards();
    const a = {
      files: { dir: "/ws", read: () => null, exists: () => false },
      cfg: {},
      tool: c.tool,
      state() {},
      pushChanges() {},
      _gate: async () => ({ blocked: false, approved: true }),
      term: { run: async (...args) => { ran.push(args); return { out: "1 passed", code: 0 }; } },
    };
    await testTools.run_tests(a, { command: "pytest -q" });
    expect(ran[0][2]).toBeNull();
  });
});
