/* ============================================================
   auth.js 单元测试
   - register / login / verify / logout / removeUser / hasUsers / listUsers
   - 密码 scrypt（异步）+ salt + timingSafeEqual；会话落盘 + 30 天滑动过期
   - 回归重点：会话必须跨进程重启存活（旧实现只放内存，重启即全员掉登录）
   通过 PANCODE_DATA_DIR 指向临时目录，隔离 users.json / sessions.json
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmpDir;
let auth;

function freshRequire() {
  /* auth 的数据根取自 config.ROOT，而 config 在 require 时就把 PANCODE_DATA_DIR 定死；
     不清 config 缓存，users.json 会静默写进真实仓库的 .pancode/。 */
  delete require.cache[require.resolve("../server/config")];
  delete require.cache[require.resolve("../server/safe-write")];
  delete require.cache[require.resolve("../server/auth")];
  return require("../server/auth");
}
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-auth-"));
  process.env.PANCODE_DATA_DIR = tmpDir;
  auth = freshRequire();
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  delete process.env.PANCODE_DATA_DIR;
  delete require.cache[require.resolve("../server/auth")];
  delete require.cache[require.resolve("../server/config")];
});

it("数据根跟随 PANCODE_DATA_DIR（绝不把账号写进仓库）", () => {
  expect(path.resolve(auth.USERS_FILE).startsWith(path.resolve(tmpDir))).toBe(true);
  expect(path.resolve(auth.SESS_FILE).startsWith(path.resolve(tmpDir))).toBe(true);
});

describe("auth.register", () => {
  it("正常注册成功并返回 token", async () => {
    const r = await auth.register("alice", "pass1234");
    expect(r.ok).toBe(true);
    expect(r.token).toBeTruthy();
    expect(r.username).toBe("alice");
  });

  it("用户名过短拒绝", async () => {
    expect((await auth.register("a", "pass1234")).ok).toBe(false);
  });

  it("用户名含路径 / HTML 危险字符拒绝", async () => {
    expect((await auth.register("../etc/passwd", "pass1234")).ok).toBe(false);
    expect((await auth.register('a<b>"c', "pass1234")).ok).toBe(false);
    expect((await auth.register("a\\b", "pass1234")).ok).toBe(false);
  });

  it("用户名超长拒绝", async () => {
    expect((await auth.register("x".repeat(33), "pass1234")).ok).toBe(false);
  });

  it("密码过短 / 过长都拒绝（过长会放大 scrypt 开销）", async () => {
    expect((await auth.register("bob", "12")).ok).toBe(false);
    expect((await auth.register("bob", "x".repeat(129))).ok).toBe(false);
  });

  it("重复用户名拒绝", async () => {
    await auth.register("alice", "pass1234");
    expect((await auth.register("alice", "other456")).ok).toBe(false);
  });

  it("注册后 hasUsers 为 true（写盘必须同步完成，否则重名检查会漏）", async () => {
    expect(auth.hasUsers()).toBe(false);
    await auth.register("alice", "pass1234");
    expect(auth.hasUsers()).toBe(true);
  });
});

describe("auth.login", () => {
  beforeEach(async () => { await auth.register("alice", "pass1234"); });

  it("正确凭据登录成功", async () => {
    const r = await auth.login("alice", "pass1234");
    expect(r.ok).toBe(true);
    expect(r.token).toBeTruthy();
    expect(r.username).toBe("alice");
  });

  it("错误密码拒绝", async () => {
    expect((await auth.login("alice", "wrong")).ok).toBe(false);
  });

  it("不存在用户拒绝并带 noUser 标记（前端据此引导注册）", async () => {
    const r = await auth.login("nobody", "pass1234");
    expect(r.ok).toBe(false);
    expect(r.noUser).toBe(true);
  });

  it("同一用户两次登录拿到不同 token，且都有效", async () => {
    const a = await auth.login("alice", "pass1234");
    const b = await auth.login("alice", "pass1234");
    expect(a.token).not.toBe(b.token);
    expect(auth.verify(a.token)).toBeTruthy();
    expect(auth.verify(b.token)).toBeTruthy();
  });
});

describe("auth.verify", () => {
  it("有效 token 验证通过", async () => {
    const r = await auth.register("alice", "pass1234");
    expect(auth.verify(r.token).username).toBe("alice");
  });

  it("无效 token 返回 null", () => {
    expect(auth.verify("nonexistent-token")).toBeNull();
  });

  it("空 token 返回 null", () => {
    expect(auth.verify("")).toBeNull();
    expect(auth.verify(null)).toBeNull();
    expect(auth.verify(undefined)).toBeNull();
  });

  it("logout 后 token 失效", async () => {
    const r = await auth.register("alice", "pass1234");
    expect(auth.verify(r.token)).toBeTruthy();
    auth.logout(r.token);
    expect(auth.verify(r.token)).toBeNull();
  });
});

describe("会话持久化（重启不掉登录）", () => {
  it("token 落盘，重新加载模块后仍然认得", async () => {
    const r = await auth.register("alice", "pass1234");
    await new Promise((res) => setTimeout(res, 900));   // persistSessions 有 500ms 合并窗
    const again = freshRequire();
    expect(again.verify(r.token)).toBeTruthy();
    expect(again.verify(r.token).username).toBe("alice");
  });

  it("盘上没有会话文件时不报错", () => {
    const a2 = freshRequire();
    expect(a2.verify("whatever")).toBeNull();
  });

  it("过期会话不会被加载回来", async () => {
    const r = await auth.register("alice", "pass1234");
    await new Promise((res) => setTimeout(res, 900));
    const file = path.join(tmpDir, ".pancode", "sessions.json");
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    const k = Object.keys(disk).find((x) => disk[x].username === "alice");
    disk[k].ts = Date.now() - 31 * 24 * 60 * 60 * 1000;      // 31 天没动
    fs.writeFileSync(file, JSON.stringify(disk));
    const again = freshRequire();
    expect(again.verify(r.token)).toBeNull();
  });
});

describe("auth.removeUser", () => {
  it("删除已存在用户成功", async () => {
    await auth.register("alice", "pass1234");
    expect(await auth.removeUser("alice")).toBe(true);
    expect(auth.hasUsers()).toBe(false);
  });

  it("删除不存在用户返回 false", async () => {
    expect(await auth.removeUser("ghost")).toBe(false);
  });

  it("删除用户后其会话被吊销", async () => {
    const r = await auth.register("alice", "pass1234");
    expect(auth.verify(r.token)).toBeTruthy();
    await auth.removeUser("alice");
    expect(auth.verify(r.token)).toBeNull();
  });
});

describe("auth.listUsers", () => {
  it("只返回用户名与计数，绝不带 salt / hash", async () => {
    await auth.register("alice", "pass1234");
    await auth.register("bob", "pass1234");
    const list = auth.listUsers();
    expect(list.length).toBe(2);
    const raw = JSON.stringify(list);
    expect(raw).not.toMatch(/salt|hash/i);
    expect(list.map((u) => u.username).sort()).toEqual(["alice", "bob"]);
  });
});

describe("auth — 密码安全", () => {
  it("users.json 中不存明文密码", async () => {
    await auth.register("alice", "mySecretPass123");
    const raw = fs.readFileSync(path.join(tmpDir, ".pancode", "users.json"), "utf8");
    expect(raw).not.toContain("mySecretPass123");
    const users = JSON.parse(raw);
    expect(users.alice.salt).toBeTruthy();
    expect(users.alice.hash).toBeTruthy();
    expect(users.alice.hash).not.toBe(users.alice.salt);
  });

  it("同名不同密码得到不同 salt 与 hash（防彩虹表）", async () => {
    await auth.register("alice", "pass1234");
    const a = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pancode", "users.json"), "utf8")).alice;
    await auth.removeUser("alice");
    await auth.register("alice", "pass1234");
    const b = JSON.parse(fs.readFileSync(path.join(tmpDir, ".pancode", "users.json"), "utf8")).alice;
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});
