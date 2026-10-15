/* ============================================================
   P2-5 会话令牌不以明文落盘（C-M5）

   原形状：sessions.json 的 key 就是 token 本身
   （server/auth.js 的 snapshot() 与 loadSessions() 都是 `for (const tok of …)`）。
   那份文件一旦被备份 / 同步 / 误传出去，拿到的人手上就是可直接使用的凭据
   —— 而这份文件存在的唯一理由是"重启后还认得我"，它本不该是一张可用的票。

   现在落盘的 key 是 token 的 sha256。这个文件要盯住三件事：
     1. 盘上没有明文 token；
     2. 重启后仍然认得（这是 sessions.json 存在的理由，不能为了安全把功能改没了）；
     3. 旧格式（明文 key）能在启动时自动迁移，而不是让用户静默掉一次登录。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

/* 独立算 sha256，不从 server/auth 里取 tokenKey —— 用被测模块的函数
   去断言被测模块的输出，等于自己给自己作证。 */
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

let tmpDir;
let auth;

function freshRequire() {
  /* auth 的数据根取自 config.ROOT，config 在 require 时就把 PANCODE_DATA_DIR 定死；
     不清 config 缓存，sessions.json 会静默写进真实仓库的 .pancode/。 */
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/safe-write")];
  delete require.cache[require.resolve("../server/auth")];
  return require("../server/auth");
}
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-tok-"));
  process.env.PANCODE_DATA_DIR = tmpDir;
  auth = freshRequire();
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  delete process.env.PANCODE_DATA_DIR;
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/safe-write")];
  delete require.cache[require.resolve("../server/auth")];
});

const SESS = () => path.join(tmpDir, ".pancode", "sessions.json");
const readSess = () => JSON.parse(fs.readFileSync(SESS(), "utf8"));

describe("盘上没有明文 token", () => {
  it("sessions.json 的 key 是 sha256(token)，不是 token", async () => {
    const r = await auth.register("alice", "pass1234");
    await auth.flushSessions();
    const disk = readSess();
    expect(disk[r.token]).toBeUndefined();      // 明文 key 不该在
    expect(disk[sha256(r.token)]).toBeTruthy();  // 哈希 key 该在
  });

  it("整个文件里搜不到 token 的明文（含 value 字段里）", async () => {
    const r = await auth.register("alice", "pass1234");
    await auth.flushSessions();
    const raw = fs.readFileSync(SESS(), "utf8");
    expect(raw.indexOf(r.token)).toBe(-1);
  });

  it("tokenKey 是稳定的纯 sha256（重启后必须能重算出同一个 key）", () => {
    expect(auth.tokenKey("abc")).toBe(sha256("abc"));
    expect(auth.tokenKey("abc")).toBe(auth.tokenKey("abc"));
    /* 与 pepper 方案区分开：加 pepper 的话这里每次调用都会不一样 */
  });

  it("不同 token 映射到不同 key（不会因为取哈希而合并会话）", async () => {
    const a = await auth.register("alice", "pass1234");
    const b = await auth.login("alice", "pass1234");
    expect(a.token).not.toBe(b.token);
    await auth.flushSessions();
    expect(Object.keys(readSess()).length).toBe(2);
    expect(auth.verify(a.token).username).toBe("alice");
    expect(auth.verify(b.token).username).toBe("alice");
  });
});

describe("安全没换来功能损失：重启后仍然认得", () => {
  it("哈希存储下会话跨重启存活", async () => {
    const r = await auth.register("alice", "pass1234");
    await auth.flushSessions();
    const again = freshRequire();
    const s = again.verify(r.token);
    expect(s).toBeTruthy();
    expect(s.username).toBe("alice");
  });

  it("登录态也跨重启（登录与注册走的是同一条路）", async () => {
    await auth.register("alice", "pass1234");
    const r = await auth.login("alice", "pass1234");
    await auth.flushSessions();
    expect(freshRequire().verify(r.token)).toBeTruthy();
  });

  it("登出后哈希 key 从盘上一并消失", async () => {
    const r = await auth.register("alice", "pass1234");
    await auth.flushSessions();
    expect(readSess()[sha256(r.token)]).toBeTruthy();
    expect(auth.logout(r.token)).toBe(true);
    await auth.flushSessions();
    expect(readSess()[sha256(r.token)]).toBeUndefined();
    expect(freshRequire().verify(r.token)).toBeNull();
  });

  it("删用户会吊销该用户名下所有会话（哈希形态下也一个不漏）", async () => {
    const a = await auth.register("alice", "pass1234");
    const b = await auth.login("alice", "pass1234");
    await auth.flushSessions();
    expect(Object.keys(readSess()).length).toBe(2);
    await auth.removeUser("alice");
    await auth.flushSessions();
    expect(readSess()[sha256(a.token)]).toBeUndefined();
    expect(readSess()[sha256(b.token)]).toBeUndefined();
    expect(freshRequire().verify(a.token)).toBeNull();
    expect(freshRequire().verify(b.token)).toBeNull();
  });

  it("删用户不会误伤别人的会话", async () => {
    await auth.register("alice", "pass1234");
    const bob = await auth.register("bob", "pass1234");
    await auth.removeUser("alice");
    expect(freshRequire().verify(bob.token).username).toBe("bob");
  });

  it("过期会话在哈希形态下同样不复活", async () => {
    const r = await auth.register("alice", "pass1234");
    await auth.flushSessions();
    const disk = readSess();
    disk[sha256(r.token)].ts = Date.now() - 31 * 24 * 60 * 60 * 1000;
    fs.writeFileSync(SESS(), JSON.stringify(disk));
    expect(freshRequire().verify(r.token)).toBeNull();
  });

  it("滑动续期改的是哈希 key 那一条（不是往盘上塞一条新 token）", async () => {
    const r = await auth.register("alice", "pass1234");
    await auth.flushSessions();
    const before = Object.keys(readSess());
    auth.verify(r.token);                 // 首见
    await new Promise((res) => setTimeout(res, 700));
    auth.verify(r.token);                 // 跨过 TOUCH_PERSIST_MS 才会落盘
    await new Promise((res) => setTimeout(res, 700));
    expect(Object.keys(readSess()).sort()).toEqual(before.sort());
    expect(readSess()[sha256(r.token)]).toBeTruthy();
  });
});

describe("旧格式（明文 key）自动迁移", () => {
  function writeLegacy(token, username) {
    fs.mkdirSync(path.dirname(SESS()), { recursive: true });
    fs.writeFileSync(SESS(), JSON.stringify({
      [token]: { username, ts: Date.now(), lastSeen: Date.now() },
    }));
  }

  it("升级后旧 token 仍然有效（不能为了安全把用户静默踢下线）", () => {
    const tok = "a".repeat(48);
    writeLegacy(tok, "alice");
    const again = freshRequire();
    const s = again.verify(tok);
    expect(s).toBeTruthy();
    expect(s.username).toBe("alice");
  });

  it("迁移是同步落盘的 —— 不留「进程被杀则明文还在」的窗口", () => {
    const tok = "b".repeat(48);
    writeLegacy(tok, "alice");
    freshRequire();
    const raw = fs.readFileSync(SESS(), "utf8");
    expect(raw.indexOf(tok)).toBe(-1);
    expect(JSON.parse(raw)[sha256(tok)]).toBeTruthy();
  });

  it("迁移不会把哈希当成明文再哈希一次（否则旧会话全废）", () => {
    const tok = "c".repeat(48);
    writeLegacy(tok, "alice");
    const again = freshRequire();
    expect(again.verify(tok)).toBeTruthy();
    expect(Object.keys(readSess())).toEqual([sha256(tok)]);
  });

  it("已是哈希格式的文件不会被再迁移一次（幂等）", () => {
    const tok = "d".repeat(48);
    writeLegacy(tok, "alice");
    const first = freshRequire();          // 触发迁移
    expect(first.verify(tok)).toBeTruthy();
    const after = fs.readFileSync(SESS(), "utf8");
    const second = freshRequire();         // 再来一次
    expect(second.verify(tok)).toBeTruthy();
    expect(fs.readFileSync(SESS(), "utf8")).toBe(after);
  });

  it("明文与哈希混在一份文件里也能全部迁移", () => {
    const plain = "e".repeat(48);
    const hashed = "f".repeat(48);
    fs.mkdirSync(path.dirname(SESS()), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(SESS(), JSON.stringify({
      [plain]: { username: "alice", ts: now, lastSeen: now },
      [sha256(hashed)]: { username: "bob", ts: now, lastSeen: now },
    }));
    const again = freshRequire();
    expect(again.verify(plain).username).toBe("alice");
    expect(again.verify(hashed).username).toBe("bob");
    expect(fs.readFileSync(SESS(), "utf8").indexOf(plain)).toBe(-1);
  });

  it("迁移时顺手丢掉已过期的会话（不迁垃圾）", () => {
    const old = "9".repeat(48);
    const live = "0".repeat(48);
    const now = Date.now();
    fs.mkdirSync(path.dirname(SESS()), { recursive: true });
    fs.writeFileSync(SESS(), JSON.stringify({
      [old]: { username: "alice", ts: now - 31 * 24 * 3600 * 1000, lastSeen: 0 },
      [live]: { username: "bob", ts: now, lastSeen: now },
    }));
    const again = freshRequire();
    expect(again.verify(old)).toBeNull();
    expect(Object.keys(readSess())).toEqual([sha256(live)]);
  });

  it("迁移后盘上只有哈希，不再需要 reload", () => {
    const tok = "a".repeat(48);
    writeLegacy(tok, "alice");
    freshRequire();
    expect(Object.keys(readSess())).toEqual([sha256(tok)]);
  });

  it("没有会话文件时照常启动（迁移不是启动前置条件）", () => {
    const again = freshRequire();
    expect(again.verify("whatever")).toBeNull();
  });
});

describe("误用防护", () => {
  it("空 token / undefined 不会误命中某条会话", async () => {
    await auth.register("alice", "pass1234");
    expect(auth.verify("")).toBeNull();
    expect(auth.verify(undefined)).toBeNull();
    expect(auth.verify(null)).toBeNull();
  });

  it("登出空 token 返回 false，不误删", async () => {
    await auth.register("alice", "pass1234");
    expect(auth.logout("")).toBe(false);
    expect(auth.logout(undefined)).toBe(false);
  });

  it("verify 的返回值与 listUsers 都不带 token 或其哈希", async () => {
    const r = await auth.register("alice", "pass1234");
    const s = auth.verify(r.token);
    expect(JSON.stringify(s)).not.toContain(r.token);
    /* listUsers 也绝不带出 token 或哈希 */
    const list = JSON.stringify(auth.listUsers());
    expect(list).not.toContain(r.token);
    expect(list).not.toContain(sha256(r.token));
  });
});