/* ============================================================
   auth.js 单元测试
   - register / login / verify / logout / removeUser / hasUsers
   - 密码 scrypt + salt，会话内存 Map + 24h 过期
   通过 PANCODE_DATA_DIR 指向临时目录，隔离 users.json
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmpDir;
let auth;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-auth-"));
  process.env.PANCODE_DATA_DIR = tmpDir;
  /* 清除 require 缓存，使 auth.js 重新读取 PANCODE_DATA_DIR 计算 USERS_FILE */
  delete require.cache[require.resolve("../server/auth")];
  auth = require("../server/auth");
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  delete process.env.PANCODE_DATA_DIR;
  delete require.cache[require.resolve("../server/auth")];
});

describe("auth.register", () => {
  it("正常注册成功并返回 token", () => {
    const r = auth.register("alice", "pass1234");
    expect(r.ok).toBe(true);
    expect(r.token).toBeTruthy();
    expect(r.username).toBe("alice");
  });

  it("用户名过短拒绝", () => {
    expect(auth.register("a", "pass1234").ok).toBe(false);
  });

  it("密码过短拒绝", () => {
    expect(auth.register("bob", "12").ok).toBe(false);
  });

  it("重复用户名拒绝", () => {
    auth.register("alice", "pass1234");
    const r = auth.register("alice", "other456");
    expect(r.ok).toBe(false);
  });

  it("注册后 hasUsers 为 true", () => {
    expect(auth.hasUsers()).toBe(false);
    auth.register("alice", "pass1234");
    expect(auth.hasUsers()).toBe(true);
  });
});

describe("auth.login", () => {
  beforeEach(() => {
    auth.register("alice", "pass1234");
  });

  it("正确凭据登录成功", () => {
    const r = auth.login("alice", "pass1234");
    expect(r.ok).toBe(true);
    expect(r.token).toBeTruthy();
    expect(r.username).toBe("alice");
  });

  it("错误密码拒绝", () => {
    expect(auth.login("alice", "wrong").ok).toBe(false);
  });

  it("不存在用户拒绝", () => {
    expect(auth.login("nobody", "pass1234").ok).toBe(false);
  });
});

describe("auth.verify", () => {
  it("有效 token 验证通过", () => {
    const r = auth.register("alice", "pass1234");
    const v = auth.verify(r.token);
    expect(v).toBeTruthy();
    expect(v.username).toBe("alice");
  });

  it("无效 token 返回 null", () => {
    expect(auth.verify("nonexistent-token")).toBeNull();
  });

  it("空 token 返回 null", () => {
    expect(auth.verify("")).toBeNull();
    expect(auth.verify(null)).toBeNull();
    expect(auth.verify(undefined)).toBeNull();
  });

  it("logout 后 token 失效", () => {
    const r = auth.register("alice", "pass1234");
    expect(auth.verify(r.token)).toBeTruthy();
    auth.logout(r.token);
    expect(auth.verify(r.token)).toBeNull();
  });
});

describe("auth.removeUser", () => {
  it("删除已存在用户成功", () => {
    auth.register("alice", "pass1234");
    expect(auth.removeUser("alice")).toBe(true);
    expect(auth.hasUsers()).toBe(false);
  });

  it("删除不存在用户返回 false", () => {
    expect(auth.removeUser("ghost")).toBe(false);
  });

  it("删除用户后其会话被吊销", () => {
    const r = auth.register("alice", "pass1234");
    expect(auth.verify(r.token)).toBeTruthy();
    auth.removeUser("alice");
    expect(auth.verify(r.token)).toBeNull();
  });
});

describe("auth — 密码安全", () => {
  it("users.json 中不存明文密码", () => {
    auth.register("alice", "mySecretPass123");
    const usersFile = path.join(tmpDir, ".pancode", "users.json");
    const raw = fs.readFileSync(usersFile, "utf8");
    expect(raw).not.toContain("mySecretPass123");
    /* 应包含 salt + hash 字段 */
    const users = JSON.parse(raw);
    expect(users.alice.salt).toBeTruthy();
    expect(users.alice.hash).toBeTruthy();
    expect(users.alice.hash).not.toBe(users.alice.salt);
  });
});
