/* ============================================================
   影子撤销仓的三条硬约束（回归）
   1. 同名不同地的两个项目不能共用一个仓
   2. 用之前必须验 worktree 身份，宁可不撤销也不在别人目录里动手
   3. 撤销只碰"这个检查点改过的路径"，未跟踪文件与手工改动必须原样活着

   第 3 条是这次的真回归点：旧实现是 reset --hard + clean -fd，
   红的是"用户没提交的工作被一起删掉"。所以反向对照必须放在这里——
   没有它，把实现换回全局清理这条测试也会绿。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const shadow = require("../server/shadow-git");
const { FileStore } = require("../server/files");

let tmpRoot;

function mkTemp() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-shadow-"));
  return tmpRoot;
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(dir, rel) { return fs.readFileSync(path.join(dir, rel), "utf8"); }
function exists(dir, rel) { return fs.existsSync(path.join(dir, rel)); }

function git(gitDir, args) {
  return String(execFileSync("git", ["-C", gitDir].concat(args), { encoding: "utf8", windowsHide: true }));
}

/* 一个真实工作区 + 一个真实影子仓 */
function workspace(name) {
  const root = path.join(tmpRoot, name);
  const ws = path.join(root, "demo");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(ws, { recursive: true });
  return { ws, dataRoot, files: new FileStore(ws) };
}

afterEach(() => {
  if (tmpRoot) { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {} }
  tmpRoot = null;
});

describe("分片身份：同名项目不共仓", () => {
  it("两个 demo 目录拿到两个不同的仓目录", () => {
    mkTemp();
    const a = path.join(tmpRoot, "e", "demo");
    const b = path.join(tmpRoot, "d", "demo");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    expect(shadow.shadowDirFor(tmpRoot, a)).not.toBe(shadow.shadowDirFor(tmpRoot, b));
    expect(path.basename(shadow.shadowDirFor(tmpRoot, a))).not.toBe("demo");
  });

  it("同一目录的写法差异收敛到同一个仓（去尾分隔符 / 大小写）", () => {
    mkTemp();
    const dir = path.join(tmpRoot, "ws");
    expect(shadow.shadowDirFor(tmpRoot, dir + path.sep)).toBe(shadow.shadowDirFor(tmpRoot, dir));
    if (process.platform === "win32") {
      expect(shadow.shadowDirFor(tmpRoot, dir.toUpperCase())).toBe(shadow.shadowDirFor(tmpRoot, dir));
    }
  });
});

describe("ensureShadowRepo：初始化后自证身份", () => {
  it("新工作区初始化后 ok，core.worktree 指向本项目，并且已经有初始提交", () => {
    mkTemp();
    const { ws, dataRoot } = workspace("a");
    write(ws, "a.txt", "v1");
    const r = shadow.ensureShadowRepo(dataRoot, ws);
    expect(r.ok).toBe(true);
    expect(shadow.worktreeMatches(r.dir, ws)).toBe(true);
    expect(() => git(r.dir, ["rev-parse", "--verify", "HEAD"])).not.toThrow();
  });

  it("仓存在但 worktree 指向别处 → ok=false（拒绝在别人目录里回退）", () => {
    mkTemp();
    const { ws, dataRoot } = workspace("b");
    const other = path.join(tmpRoot, "b", "other");
    fs.mkdirSync(other, { recursive: true });
    write(other, "foreign.txt", "不该被碰");
    const dir = shadow.shadowDirFor(dataRoot, ws);
    shadow.initRepo(dir, other);

    const r = shadow.ensureShadowRepo(dataRoot, ws);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/worktree/);
    expect(shadow.worktreeMatches(dir, other)).toBe(true);   // 别人的仓一点没动
  });

  it("老版按 basename 分的仓，身份对得上才认领（改名搬家）", () => {
    mkTemp();
    const { ws, dataRoot } = workspace("c");
    write(ws, "a.txt", "v1");
    const legacy = shadow.legacyShadowDirFor(dataRoot, ws);
    expect(legacy).not.toBe(shadow.shadowDirFor(dataRoot, ws));
    shadow.initRepo(legacy, ws);

    const r = shadow.ensureShadowRepo(dataRoot, ws);
    expect(r.ok).toBe(true);
    expect(r.adopted).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(shadow.worktreeMatches(r.dir, ws)).toBe(true);
  });

  it("老版仓的 worktree 是别处 → 不认领，另起新仓，老仓原样不动", () => {
    mkTemp();
    const { ws, dataRoot } = workspace("d");
    const other = path.join(tmpRoot, "d", "other");
    fs.mkdirSync(other, { recursive: true });
    const legacy = shadow.legacyShadowDirFor(dataRoot, ws);
    shadow.initRepo(legacy, other);

    const r = shadow.ensureShadowRepo(dataRoot, ws);
    expect(r.ok).toBe(true);
    expect(r.dir).toBe(shadow.shadowDirFor(dataRoot, ws));
    expect(r.adopted).toBeFalsy();
    expect(shadow.worktreeMatches(legacy, other)).toBe(true);
  });
});

describe("restoreLast：只回退这个检查点动过的路径", () => {
  function prepared() {
    mkTemp();
    const { ws, dataRoot, files } = workspace("undo");
    write(ws, "a.txt", "v1");
    write(ws, "keep.txt", "keep-v1");
    const ready = shadow.ensureShadowRepo(dataRoot, ws);
    expect(ready.ok).toBe(true);
    /* 一个检查点：改 a + 新建 new.txt（真实调用只记这次写过的路径） */
    write(ws, "a.txt", "v2");
    write(ws, "new.txt", "created by agent");
    shadow.commit(ready.dir, ws, "checkpoint-1", ["a.txt", "new.txt"]);
    /* 检查点之后、用户自己的动作：改未跟踪文件、手工改另一个已跟踪文件、新增未跟踪文件 */
    write(ws, "keep.txt", "manual edit after checkpoint");
    write(ws, "scratch.log", "user notes");
    const parent = git(ready.dir, ["rev-parse", "HEAD~1"]).trim();
    return { ws, files, dir: ready.dir, parent };
  }

  it("改过的文件回到父提交，新建的文件被删掉", () => {
    const { ws, files, dir } = prepared();
    const r = shadow.restoreLast(dir, ws, files);
    expect(r.ok).toBe(true);
    expect(r.restored).toEqual(["a.txt"]);
    expect(r.removed).toEqual(["new.txt"]);
    expect(read(ws, "a.txt")).toBe("v1");
    expect(exists(ws, "new.txt")).toBe(false);
  });

  it("检查点之外的未跟踪文件与手工改动必须原样活着（旧的 reset --hard + clean -fd 会全杀）", () => {
    const { ws, files, dir } = prepared();
    shadow.restoreLast(dir, ws, files);
    expect(read(ws, "keep.txt")).toBe("manual edit after checkpoint");
    expect(read(ws, "scratch.log")).toBe("user notes");
  });

  it("撤销成功后 HEAD 也退一格，下一份检查点不会把撤掉的内容再装回来", () => {
    const { ws, files, dir, parent } = prepared();
    const r1 = shadow.restoreLast(dir, ws, files);
    expect(r1.ok).toBe(true);
    expect(git(dir, ["rev-parse", "HEAD"]).trim()).toBe(parent);

    /* 撤销之后再产生一份新检查点（只新建 next.txt）→ 再撤销只该删 next.txt，
       a.txt 必须保持撤销后的 v1；HEAD 没退的话这里会从被撤掉的 C1 取回 v2。 */
    write(ws, "next.txt", "next checkpoint");
    shadow.commit(dir, ws, "checkpoint-2", ["next.txt"]);
    const r2 = shadow.restoreLast(dir, ws, files);
    expect(r2.ok).toBe(true);
    expect(r2.removed).toEqual(["next.txt"]);
    expect(read(ws, "a.txt")).toBe("v1");
  });

  it("检查点只记 agent 写过的路径：用户的未跟踪文件与手工改动不会被卷进去", () => {
    const { ws, files, dir } = prepared();
    /* 现在工作区里：scratch.log（未跟踪）、keep.txt（手工改）、a.txt=v2、new.txt */
    write(ws, "agent2.txt", "agent output");
    shadow.commit(dir, ws, "checkpoint-2", ["agent2.txt"]);
    const r = shadow.restoreLast(dir, ws, files);
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual(["agent2.txt"]);
    expect(read(ws, "scratch.log")).toBe("user notes");
    expect(read(ws, "keep.txt")).toBe("manual edit after checkpoint");
    expect(read(ws, "a.txt")).toBe("v2");        // 这份检查点没碰过 a，不该回退它
    expect(read(ws, "new.txt")).toBe("created by agent");
  });

  it("没有更早的检查点时明确拒绝，且不删任何东西", () => {
    mkTemp();
    const { ws, dataRoot, files } = workspace("only");
    write(ws, "a.txt", "v1");
    const ready = shadow.ensureShadowRepo(dataRoot, ws);
    const r = shadow.restoreLast(ready.dir, ws, files);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/更早的检查点/);
    expect(read(ws, "a.txt")).toBe("v1");
  });

  it("父提交里没有、现在也没了的路径不算失败", () => {
    const { ws, files, dir } = prepared();
    fs.unlinkSync(path.join(ws, "new.txt"));       // 检查点新建，但用户在撤销前已手动删掉
    const r = shadow.restoreLast(dir, ws, files);
    expect(r.ok).toBe(true);
    expect(r.removed).toEqual([]);
    expect(read(ws, "a.txt")).toBe("v1");
  });
});

/* headCheckpoint：栈空时能不能给用户一个"再往回退一步"的入口，判据全在这一份里。
   露错一条的代价不对称：把 init 全量快照当成一步暴露出去，用户点一下就把工作区抹回开机那一刻；
   把 "undo …" 那条回退记录当成一步，点下去是"重放刚撤掉的改动"，与按钮语义正相反。 */
describe("headCheckpoint：只把真检查点暴露成可回退的一步", () => {
  function repo() {
    mkTemp();
    const { ws, dataRoot, files } = workspace("head");
    write(ws, "a.txt", "v1");
    const ready = shadow.ensureShadowRepo(dataRoot, ws);
    return { ws, files, dir: ready.dir };
  }

  it("只有初始全量快照时不给入口（反向对照：这条必须为 null）", () => {
    const { ws, dir } = repo();
    expect(shadow.headCheckpoint(dir, ws)).toBeNull();
  });

  it("真检查点给出口：标签、归属会话、会动哪些文件都说得清", () => {
    const { ws, dir } = repo();
    write(ws, "a.txt", "v2");
    write(ws, "new.txt", "created");
    shadow.commit(dir, ws, "[conv:c-7] 写入 a.txt", ["a.txt", "new.txt"]);
    const ck = shadow.headCheckpoint(dir, ws);
    expect(ck).toBeTruthy();
    expect(ck.convId).toBe("c-7");
    expect(ck.label).toBe("写入 a.txt");
    const byPath = {};
    ck.files.forEach((f) => { byPath[f.path] = f.action; });
    expect(byPath["a.txt"]).toBe("改回原样");
    expect(byPath["new.txt"]).toBe("删掉这个新建的文件");
  });

  it("没有 [conv:] 前缀的老记录照样读得出标签，归属留空（不假装知道是谁的）", () => {
    const { ws, dir } = repo();
    write(ws, "a.txt", "v2");
    shadow.commit(dir, ws, "checkpoint-1", ["a.txt"]);
    const ck = shadow.headCheckpoint(dir, ws);
    expect(ck.label).toBe("checkpoint-1");
    expect(ck.convId).toBe("");
  });

  it("回退记录（undo …）不算「下一步可撤」", () => {
    const { ws, dir } = repo();
    write(ws, "a.txt", "v2");
    shadow.commit(dir, ws, "原子编辑 1 个文件", ["a.txt"]);
    shadow.commit(dir, ws, "undo 原子编辑 1 个文件", ["a.txt"]);
    expect(shadow.headCheckpoint(dir, ws)).toBeNull();
  });

  /* 真身长这样：[conv:c-1] undo 写入 a.txt —— 前缀会挡住"只看 subject 开头"的写法，
     漏判的后果是点一下变成"重做刚撤掉的那步"。 */
  it("带 [conv:] 前缀的回退记录同样不算（前缀不能把判据瞎掉）", () => {
    const { ws, dir } = repo();
    write(ws, "a.txt", "v2");
    shadow.commit(dir, ws, "[conv:c-1] 写入 a.txt", ["a.txt"]);
    shadow.commit(dir, ws, "[conv:c-1] undo 写入 a.txt", ["a.txt"]);
    expect(shadow.headCheckpoint(dir, ws)).toBeNull();
    // 而它前面那条真检查点仍然读得出来（说明 null 是判出来的，不是读坏了）
    const { execFileSync } = require("child_process");
    execFileSync("git", ["-C", dir, "reset", "--soft", "HEAD~1"], { stdio: "pipe", windowsHide: true });
    const ck = shadow.headCheckpoint(dir, ws);
    expect(ck && ck.label).toBe("写入 a.txt");
    expect(ck && ck.convId).toBe("c-1");
  });

  it("没改过任何文件的空检查点不给入口（点了也无事可做）", () => {
    const { ws, dir } = repo();
    write(ws, "a.txt", "v2");
    shadow.commit(dir, ws, "写入 a.txt", ["a.txt"]);
    // 再提交一次同样的内容：--allow-empty 会留下一条没有变更的 commit
    shadow.commit(dir, ws, "重复提交", ["a.txt"]);
    const ck = shadow.headCheckpoint(dir, ws);
    expect(ck).toBeNull();
  });
});
