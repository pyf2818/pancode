/* 阶段二-2 多根解析层：谁的门、屋里的相对路径、越界绝不回退、撤销立刻生效 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RootStore, isAbsoluteish, MAX_LIVE } from "../server/root-store";
import { RootGrants } from "../server/root-grants";
import { FileStore } from "../server/files";
import { shardKey } from "../server/ws-key";

let TMP = "";
const DATA = () => path.join(TMP, "data");
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };

let active, other, ro, grants, store, activeStore;

beforeEach(async () => {
  TMP = mk(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pancode-rstore-")), "root"));
  mk(DATA());
  active = mk(path.join(TMP, "ws"));
  other = mk(path.join(TMP, "other-project"));
  ro = mk(path.join(TMP, "readonly-dir"));
  fs.writeFileSync(path.join(active, "a.js"), "A", "utf8");
  fs.writeFileSync(path.join(other, "b.js"), "B", "utf8");
  fs.writeFileSync(path.join(ro, "c.js"), "C", "utf8");
  grants = new RootGrants(path.join(DATA(), ".pancode", "roots.json"), DATA());
  await grants.ensure(active, "当前工作区");
  await grants.add({ path: other, label: "另一个项目" });
  await grants.add({ path: ro, label: "只看的目录", writable: false });
  activeStore = new FileStore(active, null);
  store = new RootStore({ grants, dataRoot: DATA(), auditDir: null });
  store.setActive(active, activeStore);
});
afterEach(() => { try { store.closeAll(); fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

describe("默认归属：不带 root 时与单根时代一致", () => {
  it("相对路径落在当前工作区，用的就是外部那个 FileStore 实例（不再造第二个 watcher）", () => {
    const r = store.resolve({ path: "a.js" }, false);
    expect(r.ok).toBe(true);
    expect(r.store).toBe(activeStore);
    expect(r.rel).toBe("a.js");
    expect(r.root.active).toBe(true);
    expect(store.liveCount()).toBe(1);      // 没有多开实例
    expect(r.store.read("a.js")).toBe("A");
  });

  it("当前工作区里的绝对写法也认（映射成根内相对路径，不判越界）", () => {
    const r = store.resolve({ path: path.join(active, "sub", "x.js") }, true);
    expect(r.ok).toBe(true);
    expect(r.rel).toBe("sub/x.js");
    expect(r.root.active).toBe(true);
  });
});

describe("跨根：绝对路径按授权归属", () => {
  it("落在别的授权根里 → 换成那个根的相对路径与实例", () => {
    const r = store.resolve({ path: path.join(other, "src", "b.js") }, false);
    expect(r.ok).toBe(true);
    expect(r.rel).toBe(path.join("src", "b.js").replace(/\\/g, "/"));
    expect(r.store).not.toBe(activeStore);
    expect(fs.existsSync(path.join(r.store.dir, r.rel))).toBe(false);  // 只是解析，不该已经把文件读进内存
    expect(r.root.label).toBe("另一个项目");
  });

  it("读到的内容确实是那个目录里的，而不是当前工作区的同名文件", () => {
    fs.writeFileSync(path.join(active, "b.js"), "当前根里的同名文件", "utf8");
    const r = store.resolve({ path: path.join(other, "b.js") }, false);
    expect(r.store.read(r.rel)).toBe("B");
    expect(activeStore.read("b.js")).toBe("当前根里的同名文件");
  });

  it("指定根之后，相对路径就以那个根为基准", () => {
    const r = store.resolve({ root: shardKey(other, DATA()), path: "b.js" }, false);
    expect(r.ok).toBe(true);
    expect(r.store.dir).toBe(other);
    expect(r.store.read("b.js")).toBe("B");
  });
});

describe("越界：拒绝，且绝不悄悄退回当前根", () => {
  it("没授权过的绝对路径直接拒", () => {
    const outside = path.join(TMP, "not-granted", "secret.txt");
    const r = store.resolve({ path: outside }, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/不在任何已授权的目录内/);
    expect(r.error).toMatch(/必须由用户先把那个目录加入授权/);
  });

  it("拒绝时不返回任何 store：不给「顺手读当前根的同名文件」留后路", () => {
    const r = store.resolve({ path: path.join(TMP, "not-granted", "a.js") }, false);
    expect(r.store).toBeUndefined();
    expect(r.rel).toBeUndefined();
  });

  it("授权父目录不顺带覆盖名字撞车的兄弟目录", () => {
    mk(path.join(TMP, "ws-secret"));
    fs.writeFileSync(path.join(TMP, "ws-secret", "x.js"), "S", "utf8");
    const r = store.resolve({ path: path.join(TMP, "ws-secret", "x.js") }, false);
    expect(r.ok).toBe(false);
  });

  it("空路径与只给 root 不给 path 都算参数错误", () => {
    expect(store.resolve({ path: "  " }, false).error).toMatch(/路径为空/);
    expect(store.resolve({}, false).error).toMatch(/路径为空/);
  });
});

describe("root 参数的三种写法", () => {
  it("分片键 / 绝对目录 / 授权名 都命中同一个根", () => {
    const byId = store.resolve({ root: shardKey(other, DATA()), path: "b.js" }, false);
    const byDir = store.resolve({ root: other, path: "b.js" }, false);
    const byLabel = store.resolve({ root: "另一个项目", path: "b.js" }, false);
    expect(byId.ok && byDir.ok && byLabel.ok).toBe(true);
    expect(byId.store.dir).toBe(byDir.store.dir);
    expect(byLabel.store.dir).toBe(byId.store.dir);
  });

  it("active / . 表示当前根；不认识的名字把可选项摊开给模型", () => {
    expect(store.resolve({ root: "active", path: "a.js" }, false).store).toBe(activeStore);
    expect(store.resolve({ root: ".", path: "a.js" }, false).store).toBe(activeStore);
    const bad = store.resolve({ root: "随便写的名字", path: "a.js" }, false);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/当前已授权/);
    expect(bad.error).toContain(other);                 // 可选项里必须有路径：模型认的是路径，不是 32 位 id
    expect(bad.error).toContain(ro + "（只读）");          // 只读根必须标出来，否则模型会照着写再撞一次墙
    expect(bad.error).toContain("【当前工作区】");
  });

  it("给了一个不存在于清单里的分片键：说清楚没有这条授权", () => {
    const r = store.resolve({ root: "f".repeat(32), path: "a.js" }, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/没有找到 id=/);
  });
});

describe("只读授权与撤销", () => {
  it("只读根允许读、拒绝写，理由里说清是只读", () => {
    const read = store.resolve({ path: path.join(ro, "c.js") }, false);
    expect(read.ok).toBe(true);
    expect(read.store.read(read.rel)).toBe("C");
    const write = store.resolve({ path: path.join(ro, "c.js") }, true);
    expect(write.ok).toBe(false);
    expect(write.error).toMatch(/只读授权/);
    expect(write.error).toMatch(/改成可写/);
  });

  /* 这条是"撤销授权的实效不靠实例被回收"的钉子：先读一次让 FileStore 实例留在缓存里，
     再撤销，仍然必须够不着。 */
  it("撤销授权后立刻够不着，哪怕缓存里的实例还活着", async () => {
    const before = store.resolve({ path: path.join(other, "b.js") }, false);
    expect(before.ok).toBe(true);
    expect(store.liveCount()).toBeGreaterThan(1);
    await grants.remove(shardKey(other, DATA()));
    const after = store.resolve({ path: path.join(other, "b.js") }, false);
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/不在任何已授权的目录内/);
  });

  it("改成只读之后，同一个缓存实例也立刻写不进", async () => {
    store.resolve({ path: path.join(other, "b.js") }, true);   // 先建实例
    await grants.setWritable(shardKey(other, DATA()), false);
    const r = store.resolve({ path: path.join(other, "b.js") }, true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/只读/);
  });

  it("授权过但盘被拔了：报「目录当前不在盘上」，不是报没权限", async () => {
    const gone = mk(path.join(TMP, "usb"));
    await grants.add({ path: gone, label: "U 盘" });
    store.resolve({ path: path.join(gone, "x.js") }, false);
    fs.rmSync(gone, { recursive: true, force: true });
    const r = store.resolve({ path: path.join(gone, "x.js") }, false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/当前不在盘上/);
  });
});

describe("实例封顶：额外根不无限攒 watcher", () => {
  it("超出上限时挤掉最久没用的，活动根那个绝不动", async () => {
    const dirs = [];
    for (let i = 0; i < MAX_LIVE + 2; i++) {
      const d = mk(path.join(TMP, "extra" + i));
      fs.writeFileSync(path.join(d, "f.js"), "x", "utf8");
      await grants.add({ path: d });
      dirs.push(d);
    }
    for (const d of dirs) store.resolve({ path: path.join(d, "f.js") }, false);
    expect(store.liveCount()).toBeLessThanOrEqual(MAX_LIVE);
    // 活动根即便最久没被访问也不能被淘汰（它带着 watch）
    const hot = store.resolve({ path: path.join(dirs[dirs.length - 1], "f.js") }, false);
    expect(hot.store).not.toBe(activeStore);
    expect(store.resolve({ path: "a.js" }, false).store).toBe(activeStore);
    expect(store.liveCount()).toBeLessThanOrEqual(MAX_LIVE);
  });

  it("invalidate 之后再解析会换一个新实例", () => {
    const a = store.resolve({ root: other, path: "b.js" }, false);
    expect(store.invalidate(shardKey(other, DATA()))).toBe(true);
    const b = store.resolve({ root: other, path: "b.js" }, false);
    expect(b.store).not.toBe(a.store);
  });
});

describe("绝对路径判定不能只靠 path.isAbsolute", () => {
  it("盘符写法与 UNC 都算绝对（模型就会这么写）", () => {
    expect(isAbsoluteish("C:\\Users\\x\\a.js")).toBe(true);
    expect(isAbsoluteish("C:/Users/x/a.js")).toBe(true);
    expect(isAbsoluteish("\\\\srv\\share\\a.js")).toBe(true);
    expect(isAbsoluteish("src/a.js")).toBe(false);
    expect(isAbsoluteish("./a.js")).toBe(false);
    expect(isAbsoluteish("")).toBe(false);
  });
});

describe("跨根写的审计归属", () => {
  /* 审计目录是全根共用一份：日志里只留相对路径，两个项目里的同名文件就分不出是谁被改了。 */
  it("每条文件审计都带上产生它的那个根，同名相对路径也分得开", () => {
    const auditDir = mk(path.join(TMP, "audit"));
    const s = new RootStore({ grants, dataRoot: DATA(), auditDir });
    s.setActive(active, new FileStore(active, auditDir));
    const f1 = s.resolve({ path: path.join(other, "b.js") }, true);
    const f2 = s.resolve({ path: "b.js" }, true);          // 当前根里的同名文件
    expect(f1.ok && f2.ok).toBe(true);
    f1.store.write(f1.rel, "从另一个根写的");
    f2.store.write(f2.rel, "从当前根写的");
    const day = new Date().toISOString().slice(0, 10);
    const lines = fs.readFileSync(path.join(auditDir, day + ".log"), "utf8").split("\n")
      .filter((l) => /\| fs \| write \| b\.js \| root=/.test(l));
    const roots = lines.map((l) => l.split("| root=")[1].trim().toLowerCase());
    expect(roots.length).toBe(2);
    expect(roots).toContain(path.resolve(other).toLowerCase());
    expect(roots).toContain(path.resolve(active).toLowerCase());
    s.closeAll();
  });
});
