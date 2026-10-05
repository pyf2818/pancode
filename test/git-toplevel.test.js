/* GitLayer 的"这个工作区到底是不是仓库根"判定：
   同一个目录有很多种写法（短名、大小写、分隔符、git 自己输出的正斜杠），
   判据只要严格按字符串比，仓库就会静默退化成快照模式——diff 基线、改动面板、提交全废。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { GitLayer, sameDir, isHomeRepo, isIgnoredHere } = require("../server/git");
const { FileStore } = require("../server/files");

/* 这一支每个用例都要真起 git 子进程建仓库，单跑 1.6–5.7s，全量并行时更慢。
   默认 5s 上限会把"这台 Windows 上 git 慢"误判成"逻辑错"（实测并行跑红两条、单跑 15/15 绿），
   所以只在本文件里把上限抬高——不是把断言放宽。
   （`vi` 由 vitest.config 的 globals:true 提供；`require("vitest")` 在 CJS 里会直接报错。） */
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

const HAS_GIT = (() => {
  try { cp.execFileSync("git", ["--version"], { windowsHide: true, timeout: 8000 }); return true; }
  catch (e) { return false; }
})();

let TMP;
function mkRepo(rel) {
  const dir = path.join(TMP, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.js"), "A\n", "utf8");
  const run = (args) => cp.spawnSync("git", ["-C", dir].concat(args), { encoding: "utf8", windowsHide: true });
  run(["init", "-q"]);
  run(["config", "user.email", "t@t"]);
  run(["config", "user.name", "t"]);
  /* 关掉换行转换：这台机器的全局 core.autocrlf=true，检出会把 "A\n" 变成 "A\r\n"，
     测试要比的是路径换算与作用范围，不是行尾。 */
  run(["config", "core.autocrlf", "false"]);
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}
function layer(dir) {
  const g = new GitLayer(dir, new FileStore(dir, null));
  /* W12 之后 _init 是同步探测，构造完就能读 available */
  return g;
}

beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-gittop-")); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

describe("sameDir", () => {
  it("大小写、分隔符、尾斜杠都算同一个目录（Windows 不区分大小写）", () => {
    const p = path.join(TMP, "ws");
    fs.mkdirSync(p, { recursive: true });
    expect(sameDir(p, p + path.sep)).toBe(true);
    expect(sameDir(p, p.replace(/\\/g, "/"))).toBe(true);
    if (process.platform === "win32") {
      expect(sameDir(p, p.toUpperCase())).toBe(true);
      expect(sameDir(p.replace(/\\/g, "/"), p.toUpperCase())).toBe(true);
    }
  });
  it("不相干的目录不会被判成同一个（不许为了省事改成前缀匹配）", () => {
    const a = path.join(TMP, "ws");
    const b = path.join(TMP, "ws-secret");
    fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
    expect(sameDir(a, b)).toBe(false);
  });
});

(HAS_GIT ? describe : describe.skip)("GitLayer 仓库探测", () => {
  it("工作区路径换成另一种写法（大小写/分隔符/短名）也认得出是仓库根", () => {
    const dir = mkRepo("ws");
    /* 这一发就是真实症状：os.tmpdir() 在这台机器上给的是 8.3 短名，
       git 返回的是长名，迁移前的 `path.resolve(top) === path.resolve(dir)` 直接判不等。 */
    const alt = process.platform === "win32"
      ? dir.toUpperCase().replace(/\\/g, "/")
      : dir + "/";
    expect(alt).not.toBe(dir);
    expect(layer(alt).available).toBe(true);
  });

  it("工作区是仓库的子目录时也认（#27：discovered toplevel）", () => {
    const repo = mkRepo("repo");
    const sub = path.join(repo, "pkg");
    fs.mkdirSync(sub, { recursive: true });
    const g = layer(sub);
    expect(g.available).toBe(true);
    expect(g.prefix).toBe("pkg/");
  });

  /* 这条是 #27 唯一的一票否决：仓库根 == 用户主目录。
     实测这台机器 `~/.git` 真的存在（还一次提交都没有）——没有这道否决，
     主目录下的每个普通文件夹都会被判成"仓库子目录"，一次提交就提交进家目录。 */
  it("仓库根就是用户主目录时一概不认", () => {
    const home = os.homedir();
    expect(isHomeRepo(home, home)).toBe(true);
    expect(isHomeRepo(home + path.sep, home)).toBe(true);
    expect(isHomeRepo(path.join(home, "proj"), home)).toBe(false);
    expect(isHomeRepo("D:\\repos\\p", home)).toBe(false);
    const plain = path.join(TMP, "plain-in-ancestor");
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "x.js"), "X\n", "utf8");
    const g = layer(plain);
    // 祖先里除了家目录那个误建仓库之外没有别的仓库 → 必须是快照模式
    expect(g.available).toBe(false);
  });

  it("根本不是仓库的目录：降级为快照模式而不是报错", async () => {
    const plain = path.join(TMP, "plain");
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, "x.js"), "X\n", "utf8");
    const g = layer(plain);
    expect(g.available).toBe(false);
    expect(await g.changes()).toEqual([]);          // 快照模式下不虚构改动
    expect(g.snapshot["x.js"]).toBe("X\n");         // 但基线还在
  });
});

/* ============================================================
   工作区是仓库的子目录（monorepo 里只打开 web/app）
   判据从"工作区==仓库根"放宽到"工作区落在某个仓库里"之后，
   所有路径都要在两个坐标系之间换算：git 说的永远是仓库根相对，
   而 FileStore / 改动面板 / 提交接口说的是工作区相对。
   ============================================================ */
describe("子目录工作区的路径换算", () => {
  let repo, sub;
  beforeEach(() => {
    repo = mkRepo("repo");
    sub = path.join(repo, "web", "app");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "main.js"), "M1\n", "utf8");
    fs.writeFileSync(path.join(repo, "web", "shared.js"), "S1\n", "utf8");
    const run = (dir, ...a) => cp.spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", windowsHide: true });
    run(repo, "add", "-A");
    run(repo, "commit", "-q", "-m", "add web");
  });

  it("认得出仓库根在上两级，且记的是工作区相对仓库根的位置", () => {
    const g = layer(sub);
    expect(g.available).toBe(true);
    expect(g.prefix).toBe("web/app/");
    expect(g.info().sub).toBe("web/app/");
  });

  it("仓库根工作区的 prefix 是空串（换算层不许改变老行为）", () => {
    const g = layer(repo);
    expect(g.available).toBe(true);
    expect(g.prefix).toBe("");
  });

  /* 祖先仓库把本目录整个 ignore 掉 → git status 永远列不出这里的改动。
     认了它等于把改动面板换成静默空集，快照模式反而什么都对（smoke 夹具就是这么坏的）。 */
  it("被祖先仓库 ignore 掉的子目录：退回快照模式，改动照样看得见", async () => {
    fs.writeFileSync(path.join(repo, ".gitignore"), "scratch/\n", "utf8");
    const scratch = path.join(repo, "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "s.js"), "S1\n", "utf8");
    const run = (dir, ...a) => cp.spawnSync("git", ["-C", dir].concat(a), { encoding: "utf8", windowsHide: true });
    run(repo, "add", ".gitignore");
    run(repo, "commit", "-q", "-m", "ignore scratch");
    expect(isIgnoredHere(scratch)).toBe(true);
    expect(isIgnoredHere(sub)).toBe(false);
    const g = layer(scratch);
    expect(g.available).toBe(false);
    fs.writeFileSync(path.join(scratch, "s.js"), "S2\n", "utf8");
    expect((await g.changes()).map((c) => c.path)).toContain("s.js");   // 快照基线照样看得见这次改动
  });

  it("改动只列本工作区之内的，且路径是工作区相对（不是仓库根相对）", async () => {
    fs.writeFileSync(path.join(sub, "main.js"), "M2\n", "utf8");
    fs.writeFileSync(path.join(sub, "new.js"), "N\n", "utf8");
    fs.writeFileSync(path.join(repo, "root.txt"), "r2\n", "utf8");        // 仓库别处的改动
    fs.writeFileSync(path.join(repo, "web", "shared.js"), "S2\n", "utf8"); // 上一级的改动
    const list = await layer(sub).changes();
    const paths = list.map((c) => c.path).sort();
    expect(paths).toEqual(["main.js", "new.js"]);
    expect(list.find((c) => c.path === "main.js").status).toBe("M");
    expect(list.find((c) => c.path === "new.js").status).toBe("A");
  });

  it("基线取的是仓库里那个文件，不是同名巧合", async () => {
    /* 仓库根放一个**同名**的 main.js（内容不同），并把子目录那份改成未提交的修改：
       - 前缀换算对 → 取到 HEAD 里的 "M1\n"
       - 前缀漏了   → `git show HEAD:main.js` 会取到仓库根那份 "ROOT\n"
       - 悄悄降级   → 快照基线等于当前内容 "M2\n"
       三种结果互不相同，所以这条断言不会"因为别的原因碰巧通过"。 */
    fs.writeFileSync(path.join(repo, "main.js"), "ROOT\n", "utf8");
    cp.spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8", windowsHide: true });
    cp.spawnSync("git", ["-C", repo, "commit", "-q", "-m", "root main.js"], { encoding: "utf8", windowsHide: true });
    fs.writeFileSync(path.join(sub, "main.js"), "M2\n", "utf8");
    const g = layer(sub);
    expect(g.snapshot["main.js"]).toBe("M2\n");               // 先确认快照兜底给的是"错的那一个"
    expect(await g.baseline("main.js")).toBe("M1\n");
    expect(await g.baseline("nope.js")).toBe(null);
  });

  it("git diff 带文件名不再抛错（参数曾把模块级 path 遮掉）", async () => {
    fs.writeFileSync(path.join(sub, "main.js"), "M3\n", "utf8");
    const r = await layer(sub).diff("main.js");
    expect(r.ok).toBe(true);
    expect(r.diff).toContain("+M3");
    expect(r.diff).not.toContain("is not a function");
    expect(r.diff).toContain("web/app/main.js");   // diff 头里是仓库根路径，这没错
    const abs = await layer(sub).diff(path.join(sub, "main.js"));
    expect(abs.ok).toBe(false);                     // 绝对路径仍被拒（老语义）
  });

  it("选择性提交只吃本工作区的文件，仓库别处的改动留在工作区", async () => {
    fs.writeFileSync(path.join(sub, "main.js"), "M2\n", "utf8");
    fs.writeFileSync(path.join(repo, "root.txt"), "r2\n", "utf8");
    const g = layer(sub);
    const r = await g.commit("test: 只提交子目录", ["main.js"]);
    expect(r.ok).toBe(true);
    const st = cp.spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    expect(st.stdout).toContain("root.txt");        // 仓库根那个改动没被卷进提交
    expect(st.stdout).not.toContain("web/app/main.js");
  });

  it("全量提交同样不外溢：add -A 只作用于本工作区", async () => {
    fs.writeFileSync(path.join(sub, "main.js"), "M2\n", "utf8");
    fs.writeFileSync(path.join(repo, "root.txt"), "r2\n", "utf8");
    const r = await layer(sub).commit("test: 子目录全量");
    expect(r.ok).toBe(true);
    const shown = cp.spawnSync("git", ["-C", repo, "show", "--stat", "--oneline", "HEAD", "-1"],
      { encoding: "utf8" }).stdout;
    expect(shown).toContain("web/app/main.js");
    expect(shown).not.toContain("root.txt");
  });

  it("丢弃改动只回滚本工作区，仓库别处的一个字都不动", async () => {
    fs.writeFileSync(path.join(sub, "main.js"), "M2\n", "utf8");
    fs.writeFileSync(path.join(sub, "junk.txt"), "要被我删掉\n", "utf8");
    fs.writeFileSync(path.join(repo, "root.txt"), "r2\n", "utf8");
    fs.writeFileSync(path.join(repo, "keep-me.txt"), "别碰我\n", "utf8");   // 仓库别处的未跟踪文件
    await layer(sub).discardAll();
    expect(fs.readFileSync(path.join(sub, "main.js"), "utf8")).toBe("M1\n");
    expect(fs.existsSync(path.join(sub, "junk.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(repo, "root.txt"), "utf8")).toBe("r2\n");
    expect(fs.existsSync(path.join(repo, "keep-me.txt"))).toBe(true);
  });
});
