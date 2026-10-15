/* ============================================================
   P-M1 · GitLayer 的 worktree 副本层（真仓库、真子进程）
   这一层的价值全在"两份现实互不可见"这句话是不是真的，所以断言都落在盘上：
     · 开完副本，主检出的改动列表必须还是干净的 —— 不写 .git/info/exclude 的话
       git status 会永远挂着一条 "?? .worktrees/"，用户的改动面板从此多一条假改动；
     · 在副本里写的文件，主检出里查不到；反过来也一样；
     · remove 的三道闸：只准删 .worktrees 下的（主检出一律碰不到）、
       当前工作区正踩在里面不许删、有未提交东西要 force 才删。
   名字与基线是会被拼进路径交给 git 的，所以非法形状必须在服务端拒掉，不能指望调用点干净。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { GitLayer, WORKTREE_DIR, dirContains, sameDir } = require("../server/git");
const { FileStore } = require("../server/files");

/* 每个用例都要真起 git 建仓库 + 真开副本，单跑就几秒，全量并行时更慢（与 git-toplevel 同一原因） */
vi.setConfig({ testTimeout: 40000, hookTimeout: 40000 });

const HAS_GIT = (() => {
  try { cp.execFileSync("git", ["--version"], { windowsHide: true, timeout: 8000 }); return true; }
  catch (e) { return false; }
});
const skip = HAS_GIT ? describe : describe.skip;

let TMP;
function mkRepo(name) {
  const dir = path.join(TMP, name || "repo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.js"), "A\n", "utf8");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "b.js"), "B\n", "utf8");
  const run = (args) => cp.spawnSync("git", ["-C", dir].concat(args), { encoding: "utf8", windowsHide: true });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  run(["config", "core.autocrlf", "false"]);   // 不比行尾，只比路径与作用范围
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}
const layer = (dir) => new GitLayer(dir, new FileStore(dir, null));
const git = (dir, args) => cp.spawnSync("git", ["-C", dir].concat(args), { encoding: "utf8", windowsHide: true });

beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-wt-")); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

skip("开副本", () => {
  it("建出目录与分支，并把主检出的改动列表保持干净", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    expect(g.available).toBe(true);
    const r = await g.addWorktree("feat-x");
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(r.path, "a.js"))).toBe(true);       // 副本里是真实检出，不是空目录
    expect(git(dir, ["rev-parse", "--verify", "refs/heads/feat-x"]).status).toBe(0);
    /* 这一条是整组里最容易悄悄失效的：exclude 没写进去，产品照样"能用"，
       只是用户的改动面板从此多一条假的未跟踪目录。 */
    expect((await g.changes()).map((c) => c.path)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain(WORKTREE_DIR + "/");
  });

  it("副本里写的东西，主检出看不见；反过来也一样", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    const r = await g.addWorktree("only-there");
    fs.writeFileSync(path.join(r.path, "only-there.txt"), "只在副本里\n", "utf8");
    expect(fs.existsSync(path.join(dir, "only-there.txt"))).toBe(false);
    fs.writeFileSync(path.join(dir, "only-here.txt"), "只在主检出\n", "utf8");
    expect(fs.existsSync(path.join(r.path, "only-here.txt"))).toBe(false);
    /* 主检出多了一个未跟踪文件，副本的改动列表不该跟着变 —— 两边各有自己的 git 状态 */
    const inMain = (await g.changes()).map((c) => c.path);
    expect(inMain).toContain("only-here.txt");
    expect(inMain).not.toContain("only-there.txt");
  });

  it("同名分支已存在时检出它，而不是再建一条", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    git(dir, ["branch", "existing"]);
    const r = await g.addWorktree("existing");
    expect(r.ok).toBe(true);
    expect(r.reusedBranch).toBe(true);
    const w = await g.worktrees();
    expect((w.worktrees.find((x) => x.branch === "existing") || {}).main).toBe(false);
  });

  it("base 真的生效：从旧提交起一份，副本里看到的是那一版", async () => {
    const dir = mkRepo();
    fs.writeFileSync(path.join(dir, "a.js"), "第二版", "utf8");
    git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "second"]);
    const g = layer(dir);
    const r = await g.addWorktree("from-first", { base: "HEAD~1" });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(r.path, "a.js"), "utf8").trim()).toBe("A");
    expect(fs.readFileSync(path.join(dir, "a.js"), "utf8").trim()).toBe("第二版");
  });

  it("非法名字与非法基线一律拒（这些串会拼进路径交给 git）", async () => {
    const g = layer(mkRepo());
    for (const bad of ["../evil", "a/b", "..", "-b", "", "x".repeat(60), "带中文"]) {
      const r = await g.addWorktree(bad);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/副本名/);
    }
    const r = await g.addWorktree("ok-name", { base: "../outside" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/基线/);
  });

  it("不是 Git 仓库时三句话都说得清，而不是抛异常", async () => {
    const plain = path.join(TMP, "plain");
    fs.mkdirSync(plain, { recursive: true });
    const g = layer(plain);
    expect(g.available).toBe(false);
    expect((await g.worktrees()).error).toMatch(/不是 Git 仓库/);
    expect((await g.addWorktree("x")).error).toMatch(/不是 Git 仓库/);
    expect((await g.removeWorktree("x")).error).toMatch(/不是 Git 仓库/);
  });
});

skip("清单与移除", () => {
  it("清单分得清主检出、当前工作区所在、以及登记在但目录没了", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    const r = await g.addWorktree("gone");
    const w0 = await g.worktrees();
    /* 比目录不能按字符串：git 输出的是它自己解析过的路径，而临时目录在 Windows 上是 8.3 短名 */
    expect(sameDir(w0.worktrees.find((x) => x.main).path, dir)).toBe(true);
    expect(w0.worktrees.find((x) => x.branch === "gone").current).toBe(false);
    fs.rmSync(r.path, { recursive: true, force: true });
    const w1 = await g.worktrees();
    const lost = w1.worktrees.find((x) => x.branch === "gone");
    expect(lost.exists).toBe(false);                 // 目录没了但登记还在 → 界面要标出来
  });

  it("主检出与仓库外的路径一概删不到", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    const out = await g.removeWorktree(dir);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/只允许移除/);
    expect(fs.existsSync(dir)).toBe(true);           // 拒绝就是真拒绝，不是"报错但已经删了"
    const outside = path.join(TMP, "elsewhere");
    fs.mkdirSync(outside, { recursive: true });
    expect((await g.removeWorktree(outside)).ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("当前工作区正踩在这份副本里时不许删（不能把用户脚下的地板抽走）", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    const r = await g.addWorktree("live");
    const inWt = layer(r.path);                      // 工作区切到副本里
    const back = await inWt.removeWorktree("live");
    expect(back.ok).toBe(false);
    expect(back.error).toMatch(/当前工作区/);
    expect(fs.existsSync(r.path)).toBe(true);
    /* 副本就开在主检出目录里面，所以"工作区落在这份的路径之下"对两份同时成立 ——
       current 只准给最具体的那一份，否则切进副本后主检出那行还挂着"当前工作区在这份里"。 */
    const cur = (await inWt.worktrees()).worktrees.filter((x) => x.current);
    expect(cur).toHaveLength(1);
    expect(sameDir(cur[0].path, r.path)).toBe(true);
  });

  it("副本里有未提交的东西时默认拒删，force 才删，且不留 .worktrees 空壳", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    const r = await g.addWorktree("dirty");
    fs.writeFileSync(path.join(r.path, "wip.txt"), "还没提交\n", "utf8");
    const first = await g.removeWorktree("dirty");
    expect(first.ok).toBe(false);
    expect(first.dirty).toBe(true);                  // 上层据此再问一句"要不要连它一起删"
    expect(fs.existsSync(r.path)).toBe(true);
    const forced = await g.removeWorktree("dirty", true);
    expect(forced.ok).toBe(true);
    expect(fs.existsSync(r.path)).toBe(false);
    expect(fs.existsSync(path.join(dir, WORKTREE_DIR))).toBe(false);
    expect((await g.worktrees()).worktrees.filter((x) => x.branch === "dirty")).toHaveLength(0);
  });

  it("手工删掉目录后再移除，顺手清登记并说明发生了什么", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    const r = await g.addWorktree("pruned");
    fs.rmSync(r.path, { recursive: true, force: true });
    const x = await g.removeWorktree("pruned");
    expect(x.ok).toBe(false);
    expect(x.gone).toBe(true);
    expect((await g.worktrees()).worktrees.some((w) => w.branch === "pruned")).toBe(false);
  });

  it("排除表幂等：反复开副本不会往 exclude 里堆同一行", async () => {
    const dir = mkRepo();
    const g = layer(dir);
    await g.addWorktree("one");
    await g.addWorktree("two");
    const raw = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
    expect(raw.split(/\r?\n/).filter((l) => l.trim() === WORKTREE_DIR + "/")).toHaveLength(1);
  });
});

skip("dirContains", () => {
  it("相等算包含，兄弟前缀不算（/repo 不能把 /repo-evil 认成自己家里）", () => {
    const dir = mkRepo();
    expect(dirContains(dir, dir)).toBe(true);
    expect(dirContains(dir, path.join(dir, "src", "b.js"))).toBe(true);
    expect(dirContains(dir, path.join(path.dirname(dir), path.basename(dir) + "-evil"))).toBe(false);
  });
});

function sameAbs(a, b) {
  const n = (p) => path.resolve(String(p).replace(/[\\/]+$/, "")).toLowerCase().replace(/\\/g, "/");
  return n(a) === n(b);
}
