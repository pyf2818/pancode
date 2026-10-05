/* 阶段二-1 全局授权根清单：键归一、边界包含、只读/可写、撤销不删数据、目录失踪不静默摘除 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RootGrants, contains } from "../server/root-grants";
import { shardKey, normalizeDir } from "../server/ws-key";

let TMP = "";
const DATA = () => path.join(TMP, "data");
const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* safeWrite.saveJson 是异步的（按路径排队 + Windows EPERM 退避）：
   POST 回来不等于盘上有了，测试必须轮询到读得回来为止。 */
async function untilRead(pred, ms) {
  const deadline = Date.now() + (ms || 3000);
  while (Date.now() < deadline) {
    try { if (pred(JSON.parse(fs.readFileSync(path.join(DATA(), ".pancode", "roots.json"), "utf8")))) return true; } catch (e) {}
    await wait(40);
  }
  return false;
}

function newGrants() { return new RootGrants(path.join(DATA(), ".pancode", "roots.json"), DATA()); }

beforeEach(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-roots-")); mk(DATA()); });
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

describe("授权条目：键与去重", () => {
  it("同一个目录不论怎么写都是同一条授权", async () => {
    const g = newGrants();
    const dir = mk(path.join(TMP, "Proj"));
    const a = await g.add({ path: dir });
    const b = await g.add({ path: dir + path.sep });
    const c = await g.add({ path: process.platform === "win32" ? dir.toUpperCase() : dir });
    expect(a.root.id).toBe(shardKey(dir, DATA()));
    expect(b.root.id).toBe(a.root.id);
    expect(c.root.id).toBe(a.root.id);
    expect(g.list().length).toBe(1);
  });

  it("重复授权是更新不是新增，且不会把 grantedAt 洗掉", async () => {
    const g = newGrants();
    const dir = mk(path.join(TMP, "Proj"));
    const first = await g.add({ path: dir, label: "旧名" });
    const grantedAt = first.root.grantedAt;
    await wait(5);
    const again = await g.add({ path: dir, writable: false, label: "新名" });
    expect(g.list().length).toBe(1);
    expect(again.root.writable).toBe(false);
    expect(again.root.label).toBe("新名");
    expect(again.root.grantedAt).toBe(grantedAt);
  });

  it("目录不存在就拒绝授权，不落盘一条假的", async () => {
    const g = newGrants();
    const r = await g.add({ path: path.join(TMP, "nope") });
    expect(r.error).toMatch(/目录不存在/);
    expect(g.list()).toEqual([]);
  });

  it("落盘按数据根的 .pancode/roots.json，重启后读得回来", async () => {
    const g = newGrants();
    await g.add({ path: mk(path.join(TMP, "Proj")), label: "项目" });
    expect(await untilRead((d) => (d.roots || []).length === 1)).toBe(true);
    const g2 = newGrants();
    expect(g2.list().length).toBe(1);
    expect(g2.list()[0].label).toBe("项目");
  });

  it("老文件里缺 id 的条目按路径补算，不丢授权", async () => {
    const dir = mk(path.join(TMP, "Proj"));
    const file = path.join(DATA(), ".pancode", "roots.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, roots: [{ path: dir, writable: false }] }), "utf8");
    const g = newGrants();
    expect(g.list().length).toBe(1);
    expect(g.list()[0].id).toBe(shardKey(dir, DATA()));
    expect(g.list()[0].writable).toBe(false);
  });
});

describe("路径归属：边界与最具体的根优先", () => {
  it("授权 E:/proj 不顺带覆盖 E:/proj-secret", () => {
    const norm = (p) => normalizeDir(p, DATA());   // 与键同一个规范化：绝对化 + 去尾分隔符 + Windows 折大小写
    expect(contains(norm(path.join(TMP, "proj")), norm(path.join(TMP, "proj", "a.js")))).toBe(true);
    expect(contains(norm(path.join(TMP, "proj")), norm(path.join(TMP, "proj-secret", "a.js")))).toBe(false);
    expect(contains(norm(path.join(TMP, "proj")), norm(path.join(TMP, "proj")))).toBe(true);
  });

  it("同时授权父目录与子目录时，子目录的只读约束赢过父目录的可写", async () => {
    const g = newGrants();
    const parent = mk(path.join(TMP, "A"));
    const sub = mk(path.join(TMP, "A", "sub"));
    await g.add({ path: parent, writable: true });
    await g.add({ path: sub, writable: false });
    expect(g.canWrite(path.join(parent, "x.js")).ok).toBe(true);
    const inSub = g.canWrite(path.join(sub, "x.js"));
    expect(inSub.ok).toBe(false);
    expect(inSub.reason).toMatch(/只读/);
  });

  it("没授权过的路径直接拒，理由里带上是哪条路径", async () => {
    const g = newGrants();
    await g.add({ path: mk(path.join(TMP, "A")) });
    const outside = path.join(TMP, "B", "x.js");
    const r = g.canWrite(outside);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/不在任何已授权的目录里/);
    expect(r.reason).toContain(outside);
  });
});

describe("撤销与体检", () => {
  it("撤销授权只删清单里这一行，目录和文件一个都不碰", async () => {
    const g = newGrants();
    const dir = mk(path.join(TMP, "Proj"));
    fs.writeFileSync(path.join(dir, "keep.txt"), "数据", "utf8");
    const id = (await g.add({ path: dir })).root.id;
    const r = await g.remove(id);
    expect(r.ok).toBe(true);
    expect(g.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  it("撤销不存在的授权给明确错误，不假装成功", async () => {
    const g = newGrants();
    expect((await g.remove("nope")).error).toMatch(/没有这条授权/);
  });

  it("目录被挂盘拔掉时标 stale，但不静默摘除", async () => {
    const g = newGrants();
    const dir = mk(path.join(TMP, "disk"));
    await g.add({ path: dir });
    fs.rmSync(dir, { recursive: true, force: true });
    const row = g.list()[0];
    expect(row.stale).toBe(true);
    expect(g.rows.length).toBe(1);
  });

  it("目录还在但已不是当初授权的那个（软链改指/删后重建）标 moved", async () => {
    const g = newGrants();
    const dir = mk(path.join(TMP, "Proj"));
    await g.add({ path: dir });
    g.rows[0].realPath = path.join(TMP, "别处");   // 授权时记下的真实路径与现在不一致
    expect(g.list()[0].moved).toBe(true);
    expect(g.list()[0].stale).toBe(false);
  });
});

describe("活动工作区与使用记录", () => {
  it("ensure 保证工作区在清单里，且不覆盖用户改过的只读", async () => {
    const g = newGrants();
    const ws = mk(path.join(TMP, "ws"));
    const r1 = await g.ensure(ws, "当前工作区");
    expect(r1.source).toBe("workspace");
    expect(r1.writable).toBe(true);
    await g.setWritable(r1.id, false);
    const r2 = await g.ensure(ws, "当前工作区");
    expect(r2.writable).toBe(false);
    expect(g.list().length).toBe(1);
  });

  it("lastUsedAt 一分钟内的重复使用不再刷盘", async () => {
    const g = newGrants();
    const dir = mk(path.join(TMP, "Proj"));
    await g.add({ path: dir });
    const f = path.join(dir, "a.js");
    expect(g.touch(f)).toBe(true);
    expect(g.rows[0].lastUsedAt > 0).toBe(true);
    expect(g.touch(f)).toBe(false);        // 节流：不打盘
    g.rows[0].lastUsedAt = 0;
    expect(g.touch(f)).toBe(true);        // 过期后重新记
  });
});
