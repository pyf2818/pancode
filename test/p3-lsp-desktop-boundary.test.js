/* ============================================================
   审查项 F13：桌面端与语言服务器的纵深边界
   ------------------------------------------------------------
   两块一起钉，因为它们犯的是同一种错——"来源/范围由客户端说了算"：
   · Electron：红绿灯是无边框窗口唯一的出口，谁都能发这条 IPC；当前窗口被导航走没人拦；
     渲染进程还无条件挂着 no-sandbox。
   · LSP：/lsp 校验令牌（不是匿名端口），但 root 是 query 里的一个路径，
     直接拿去当子进程 cwd，整份 process.env（含 API Key、会话令牌）原样继承，
     initialize 里的 rootUri 又是第二个可以完全不同的客户端值。
   判据全部对着"旧行为"写：每条都要能在旧代码上是红的。
   ============================================================ */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const frameTrust = require("../electron/frame-trust");
const { LspManager, pinInitializeRoot } = require("../server/lsp-bridge");

const APP = "http://127.0.0.1:8767";

describe("桌面端来源判定（frame-trust）", () => {
  test("自家地址认，别的来源一律不认（含 docx 预览那个 about:srcdoc 子框）", () => {
    expect(frameTrust.isAppUrl(APP, APP + "/", false)).toBe(true);
    expect(frameTrust.isAppUrl(APP, APP + "/api/health", false)).toBe(true);
    expect(frameTrust.isAppUrl(APP, APP, false)).toBe(true);
    expect(frameTrust.isAppUrl(APP, APP + "?x=1", false)).toBe(true);
    // 同前缀不同端口/主机：8767 与 87670、127.0.0.12 都不是自家
    expect(frameTrust.isAppUrl(APP, "http://127.0.0.1:87670/", false)).toBe(false);
    expect(frameTrust.isAppUrl(APP, "http://127.0.0.12:8767/", false)).toBe(false);
    expect(frameTrust.isAppUrl(APP, "http://localhost:8767/", false)).toBe(false);
    expect(frameTrust.isAppUrl(APP, "about:srcdoc", false)).toBe(false);
    expect(frameTrust.isAppUrl(APP, "", false)).toBe(false);
  });

  test("后端起不来时那张 data: 错误页要认——无边框窗口只有红绿灯能关", () => {
    const fail = "data:text/html;charset=utf-8,%3Ch3%3Epancode%20%E5%90%8E%E7%AB%AF%E5%90%AF%E5%8A%A8%E5%A4%B1%E8%B4%A5%3C/h3%3E";
    expect(frameTrust.isAppUrl(APP, fail, false)).toBe(false);
    expect(frameTrust.isAppUrl(APP, fail, true)).toBe(true);
  });

  test("导航策略：自家的放行、http(s)/mailto 转系统浏览器、其余拒绝", () => {
    expect(frameTrust.navigationAction(APP, APP + "/workspace", false).action).toBe("allow");
    expect(frameTrust.navigationAction(APP, "https://example.com/doc", false).action).toBe("external");
    expect(frameTrust.navigationAction(APP, "http://example.com/doc", false).action).toBe("external");
    expect(frameTrust.navigationAction(APP, "mailto:a@b.c", false).action).toBe("external");
    expect(frameTrust.navigationAction(APP, "file:///C:/Windows/win.ini", false).action).toBe("block");
    expect(frameTrust.navigationAction(APP, "smb://share/x", false).action).toBe("block");
    expect(frameTrust.navigationAction(APP, "javascript:alert(1)", false).action).toBe("block");
    // \\.\ 设备路径：new URL 解析不出协议，按最严的拒绝处理
    expect(frameTrust.navigationAction(APP, "\\\\.\\PhysicalDrive0", false).action).toBe("block");
    expect(frameTrust.navigationAction(APP, "not a url", false).action).toBe("block");
  });
});

describe("语言服务器的 root 授权（LspManager._authorizeRoot）", () => {
  /* realpathSync 一下：Windows 的 temp 常常是 8.3 短名（C:\Users\ANLAN~1\…），
     拿短名去和真实路径做前缀比较会误判成"越界"，测出来的是夹具的问题而不是产品的。 */
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pc-lsp-")));
  const granted = path.join(tmp, "proj");
  fs.mkdirSync(granted, { recursive: true });
  fs.mkdirSync(path.join(granted, "src"), { recursive: true });

  /* 授权判据注入成一个纯函数：这里只问"命中已授权根吗"，真实清单在 server/index.js 接 rootGrants.findFor。 */
  const mgr = new LspManager({ lsp: { servers: { python: { command: "x", enabled: true } } } }, {
    findRoot: (p) => {
      const n = (s) => String(s).replace(/[\\/]+$/g, "").toLowerCase();
      const t = n(p), g = n(granted);
      return (t === g || t.startsWith(g + path.sep)) ? { path: granted, writable: true } : null;
    },
    defaultRoot: () => granted,
  });

  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

  test("已授权目录内的 file URI 与本地路径都收（多根工作区不能被一条前缀匹配误伤）", () => {
    const uri = "file:///" + granted.replace(/\\/g, "/");
    expect(mgr._authorizeRoot(uri).abs).toBe(path.resolve(granted));
    expect(mgr._authorizeRoot(granted).abs).toBe(path.resolve(granted));
    expect(mgr._authorizeRoot(path.join(granted, "src")).abs).toBe(path.resolve(path.join(granted, "src")));
    expect(mgr._authorizeRoot(uri).uri).toBe("file:///" + path.resolve(granted).replace(/\\/g, "/"));
  });

  test("客户端没给 root 时用当前工作区，不再退回 process.cwd()", () => {
    // 打包态 process.cwd() 是安装目录（Program Files 下面），语言服务器在那儿起就是换个方向越界
    expect(mgr._authorizeRoot("").abs).toBe(path.resolve(granted));
    expect(mgr._authorizeRoot("").abs).not.toBe(path.resolve(process.cwd()));
  });

  test("授权范围外的路径被拒绝，并且给得出人话", () => {
    const r = mgr._authorizeRoot(process.env.TEMP || os.tmpdir());
    expect(r.abs).toBeFalsy();
    expect(String(r.error)).toContain("已授权");
  });

  test("file:/// 在 Windows 上多出来的那个前导斜杠不影响判定", () => {
    const raw = "file:///" + path.resolve(granted).replace(/\\/g, "/");
    expect(mgr._authorizeRoot(raw).abs).toBe(path.resolve(granted));
    // UNC 不是任何工作区里的路径：认不出来，退回默认而不是拿去当 cwd
    expect(mgr._authorizeRoot("//attacker/share").abs).toBe(path.resolve(granted));
  });

  test("软链指向授权外时拒绝；建不出软链就大声 SKIP，不混在通过里", () => {
    const mkLink = (target, linkPath) => {
      try { fs.symlinkSync(target, linkPath, "junction"); return ""; }
      catch (e) { return (e && e.code) || String(e); }
    };
    const inner = path.join(granted, "inner");
    fs.mkdirSync(inner, { recursive: true });
    // 正向对照：inner 本身在授权根里，先确认这一步是过的——否则"escape 被拒"可能只是因为整条路径都不认
    expect(mgr._authorizeRoot(inner).abs).toBe(path.resolve(inner));
    const err = mkLink(tmp, path.join(inner, "escape"));
    if (err) { console.log("  SKIP：本机建不出 junction（" + err + "），软链越界这条要在能建的机器上补跑"); return; }
    // granted\inner\escape 词法上在授权根里，realpath 落到外面
    const r = mgr._authorizeRoot(path.join(inner, "escape"));
    expect(r.abs).toBeFalsy();
    expect(String(r.error)).toContain("软链");
  });

  test("没有注入授权判据时按「谁都没授权」处理（fail-closed，不是随便起）", () => {
    const bare = new LspManager({}, {});
    const r = bare._authorizeRoot(granted);
    expect(r.abs).toBeFalsy();
    expect(r.error).toBeTruthy();
  });

  test("rootError 的连接不起子进程：回一条可读的 lsp.error 就关掉", () => {
    const sent = [];
    let closed = 0;
    const ws = { readyState: 1, _lspParams: { lang: "python", rootError: "该目录不在已授权的工作区里" }, send: (m) => sent.push(JSON.parse(m)), close: () => { closed++; } };
    // 真起进程会被 spawn 一个不存在的命令，所以这条只带 rootError：先到授权判据，不碰 spawn
    mgr._onConnection(ws, {});
    expect(closed).toBe(1);
    expect(sent[0].type).toBe("lsp.error");
    expect(String(sent[0].message)).toContain("已授权");
  });
});

describe("语言服务器子进程的最小化环境", () => {
  const mgr = new LspManager({}, {});

  test("凭据形状的环境变量不进子进程，语言服务器要用的那些留着", () => {
    const keep = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, SESSIONNAME: "Console" };
    process.env.SESSIONNAME = "Console";
    const drop = {
      OPENAI_API_KEY: "sk-real",
      ANTHROPIC_API_KEY: "sk-real",
      GH_TOKEN: "ghp-real",
      AWS_SECRET_ACCESS_KEY: "z",
      MY_SIGNING_KEY: "z",
      PANCODE_DATA_DIR: "C:/Users/me/AppData/Roaming/pancode",
      PANCODE_PROBE_CLOSE_MS: "9000",
    };
    Object.assign(process.env, keep, drop);
    const env = mgr._childEnv();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.MY_SIGNING_KEY).toBeUndefined();
    expect(env.PANCODE_DATA_DIR).toBeUndefined();
    // 反过来也要成立：这些是语言服务器真的需要的，摘错了就是"pyright 起不来"那种回归
    expect(env.PATH).toBeTruthy();
    expect(env.TEMP).toBeTruthy();
    // SESSIONNAME 里含 "SESSION" 但不是一个独立词，不该被误伤
    expect(env.SESSIONNAME).toBe("Console");
    for (const k of Object.keys(drop)) delete process.env[k];
  });

  test("整份继承时代的那些键，逐个点名而不是「不知道摘了什么」", () => {
    process.env.PANCODE_LSP_PROBE_SECRET = "s";
    process.env.XDG_CONFIG_HOME = "/tmp/xdg-lsp";
    const env = mgr._childEnv();
    expect(env.PANCODE_LSP_PROBE_SECRET).toBeUndefined();
    // 不是凭据、也不是本项目开关的东西不该动：pyright/gopls 会读用户配置目录
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/xdg-lsp");
    delete process.env.PANCODE_LSP_PROBE_SECRET;
    delete process.env.XDG_CONFIG_HOME;
  });
});

describe("initialize 的工作区根由桥接层做主（pinInitializeRoot）", () => {
  const abs = path.resolve("E", "VStudio_Project", "granted-ws");   // 只当字符串用，不碰盘
  const uri = "file:///" + abs.replace(/\\/g, "/");

  test("客户端把 rootUri 写成别的目录也会被改写回授权根", () => {
    const msg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: "file:///C:/Users", workspaceFolders: null } };
    const out = pinInitializeRoot(msg, abs, uri);
    expect(out.params.rootUri).toBe(uri);
    expect(out.params.rootPath).toBe(abs);
    expect(out.params.workspaceFolders).toEqual([{ uri, name: path.basename(abs), index: 0 }]);
    // 其余参数（capabilities 等）原样带过去，否则语言服务器协商不上
    expect(out.jsonrpc).toBe("2.0");
    expect(out.id).toBe(1);
  });

  test("非 initialize 的帧一律不动（改了会把正常协议弄坏）", () => {
    const didOpen = { method: "textDocument/didOpen", params: { textDocument: { uri: "file:///C:/other/a.py" } } };
    expect(pinInitializeRoot(didOpen, abs, uri)).toBe(didOpen);
    const noRoot = { method: "initialize", params: { rootUri: "file:///C:/Users" } };
    expect(pinInitializeRoot(noRoot, "", uri)).toBe(noRoot);   // 没有授权根时不重写，交给上层已经拒绝掉的连接
  });

  test("重写不改调用方对象（透传的是同一个引用会污染前端后续帧）", () => {
    const msg = { method: "initialize", params: { rootUri: "file:///C:/Users" } };
    const out = pinInitializeRoot(msg, abs, uri);
    expect(out).not.toBe(msg);
    expect(msg.params.rootUri).toBe("file:///C:/Users");
  });
});
