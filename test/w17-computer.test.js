/* ============================================================
   W17 电脑控制 / 浏览器自动化的纯逻辑单测。

   这里只钉"不需要真起浏览器、不需要真起 PowerShell 也能判对错"的那部分：
   参数拼装、协议解析、截图落盘的路径边界、脚本落盘的 BOM。
   真链路（能不能开页、能不能点中控件）在 scripts/_verify_browser.js 与
   scripts/_verify_computer.js 里，两边不重复也不互相顶替。

   数据根一律临时目录：shots / computer 都往 config.ROOT 下面写，
   不隔离就是往开发者真实的 .pancode 里丢截图。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

let tmpDir;
let ab;
let shots;
let uia;
let configMod;

function freshRequire() {
  /* config 在 require 时就把 PANCODE_DATA_DIR 定死，不清缓存会静默写进真实仓库根。 */
  for (const m of ["../server/config", "../server/safe-write", "../server/computer/shots",
    "../server/computer/agent-browser", "../server/computer/uia-worker"]) {
    delete require.cache[require.resolve(m)];
  }
  configMod = require("../server/config");
  shots = require("../server/computer/shots");
  ab = require("../server/computer/agent-browser");
  uia = require("../server/computer/uia-worker");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-computer-"));
  process.env.PANCODE_DATA_DIR = tmpDir;
  freshRequire();
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 已被自己清掉 */ }
  delete process.env.PANCODE_DATA_DIR;
});

describe("agent-browser 协议解析", () => {
  it("剥掉每个响应都重复带的 lifecycle，省的是按 token 计价的噪声", () => {
    expect(ab.stripNoise({ lifecycle: { launchHash: "1" }, url: "u" })).toEqual({ url: "u" });
  });

  it("snapshot 文本里已写 [ref=eN]，就丢下重复的 refs 映射表（同一页信息不付两遍钱）", () => {
    const r = ab.stripNoise({ lifecycle: {}, snapshot: '- button "保存" [ref=e3]', refs: { e3: { role: "button" } } });
    expect(r.snapshot).toBeDefined();
    expect(r.refs).toBeUndefined();
  });

  it("没有 snapshot 文本时不能丢 refs —— 那是唯一的数据", () => {
    expect(ab.stripNoise({ refs: { e3: 1 } }).refs).toEqual({ e3: 1 });
  });

  it("取最后一行能解析的 JSON：前置日志、ANSI 噪声都不该把结果顶掉", () => {
    expect(ab.parseJsonLine('daemon started\n{"success":true,"data":{"a":1}}')).toEqual({ success: true, data: { a: 1 } });
    expect(ab.parseJsonLine('{"success":false,"error":"boom"}')).toEqual({ success: false, error: "boom" });
  });

  it("纯文本输出不当 JSON 硬解（read 这类子命令打印正文）", () => {
    expect(ab.parseJsonLine("plain text only")).toBeNull();
    expect(ab.parseJsonLine("{not json")).toBeNull();
  });

  it("会话名按 convId 派生：洗掉路径字符、加前缀、限长", () => {
    expect(ab.sessionName("default")).toBe("pc-default");
    expect(ab.sessionName("conv:1/../x")).toBe("pc-conv1x");
    expect(ab.sessionName("a:b")).not.toBe(ab.sessionName("a-c"));
    expect(ab.sessionName("x".repeat(200)).length).toBeLessThanOrEqual(27);
  });
});

describe("浏览器来源的优先级", () => {
  it("配置显式 chromePath 压过自动探测（用户指定了就照他说的来）", () => {
    const args = ab.globalArgs({ computer: { chromePath: "D:\\My\\browser.exe", autoDetectBrowser: true } });
    expect(args).toEqual(["--executable-path", "D:\\My\\browser.exe"]);
  });

  it("允许域名是硬约束：非空才拼，空数组等于不加限制", () => {
    expect(ab.globalArgs({ computer: { allowedDomains: ["a.com", "b.com"] } })).toContain("a.com,b.com");
    expect(ab.globalArgs({ computer: { allowedDomains: [] } })).not.toContain("--allowed-domains");
  });

  it("headed 只在显式 true 时开（默认无头，不会往用户桌面盖窗口）", () => {
    expect(ab.globalArgs({ computer: {} })).not.toContain("--headed");
    expect(ab.globalArgs({ computer: { headed: true } })).toContain("--headed");
  });

  it("自动探测探到的是本机已装浏览器的真实路径，而不是留空触发 150MB 下载", () => {
    const p = ab.detectBrowser();
    if (process.platform === "win32") expect(typeof p).toBe("string");
    else if (p) expect(fs.existsSync(p)).toBe(true);
  });
});

describe("截图目录的路径边界", () => {
  it("文件名洗掉路径字符但保留中文，且一律以时间戳开头", () => {
    const n = shots.fileName("首页 截图/../../etc/passwd.png", "png");
    expect(n).toMatch(/^\d{10,}-/);
    expect(n).not.toContain("/");
    expect(n).not.toContain("..");
    expect(n.endsWith(".png")).toBe(true);
    expect(n).toContain("首页");
  });

  it("不给名字也有可读的回退名", () => {
    expect(shots.fileName(null, "png")).toMatch(/-shot\.png$/);
  });

  it("resolveRel 只认截图目录内的相对路径：.. 逃逸与绝对路径一律 null", () => {
    const w = shots.writeBuffer(Buffer.from("x"), "conv1", "t");
    expect(shots.resolveRel(w.rel)).toBeTruthy();
    expect(shots.resolveRel("../../server/config.js")).toBeNull();
    expect(shots.resolveRel("conv1/../../server/config.js")).toBeNull();
    expect(shots.resolveRel("C:\\Windows\\win.ini")).toBeNull();
    expect(shots.resolveRel("/etc/passwd")).toBeNull();
    expect(shots.resolveRel("")).toBeNull();
  });

  it("会话目录名里不留点：纯 .. 的会话名会拼出截图目录的上一级", () => {
    const w = shots.writeBuffer(Buffer.from("x"), "..", "t");
    const abs = path.resolve(shots.root(), w.rel);
    expect(abs.startsWith(path.resolve(shots.root()) + path.sep)).toBe(true);
  });

  it("截图一律不落工作区（落进去就会被 Git 基线当成用户改动）", () => {
    const w = shots.writeBuffer(Buffer.from("x"), "c", "t");
    expect(path.resolve(w.abs).startsWith(path.resolve(configMod.ROOT, ".pancode", "shots"))).toBe(true);
  });

  it("TTL 只删超期的，新图不动；目录里的散文件不该把清理打断", () => {
    const now = Date.now();
    const old = shots.writeBuffer(Buffer.from("x"), "c1", "old");
    const keep = shots.writeBuffer(Buffer.from("x"), "c1", "new");
    fs.utimesSync(path.resolve(shots.root(), old.rel), new Date(now - 30 * 86400000), new Date(now - 30 * 86400000));
    fs.writeFileSync(path.join(shots.root(), "notadir"), "x");
    const r = shots.prune(7);
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.resolve(shots.root(), keep.rel))).toBe(true);
    expect(fs.existsSync(path.join(shots.root(), "notadir"))).toBe(true);
  });

  it("TTL 配成 0 或负数退回默认天数，而不是把所有截图当场删光", () => {
    const w = shots.writeBuffer(Buffer.from("x"), "c2", "t");
    expect(shots.prune(0).removed).toBe(0);
    expect(fs.existsSync(path.resolve(shots.root(), w.rel))).toBe(true);
  });
});

describe("UIA 脚本落盘", () => {
  it("副本带 UTF-8 BOM —— PS 5.1 读无 BOM 的 UTF-8 脚本会按 936 代码页解析，中文注释能把整份脚本打成 ParserError", () => {
    const p = uia.materialize();
    const bytes = fs.readFileSync(p);
    expect(bytes[0]).toBe(0xEF);
    expect(bytes[1]).toBe(0xBB);
    expect(bytes[2]).toBe(0xBF);
  });

  it("副本落在数据根而不是 asar 里（powershell.exe 不认 asar，给它 asar 路径就是找不到文件）", () => {
    const p = uia.materialize();
    expect(p.startsWith(path.resolve(configMod.ROOT))).toBe(true);
    expect(p).not.toContain("app.asar");
  });

  it("内容没变就不重写（否则每次开机都改时间戳，探针也分不清到底写没写）", () => {
    const p = uia.materialize();
    const t1 = fs.statSync(p).mtimeMs;
    const t2 = uia.materialize();
    expect(t2).toBe(p);
    expect(Math.abs(fs.statSync(t2).mtimeMs - t1)).toBeLessThan(60);
  });

  it("仓库里那份源脚本自身不带 BOM（git/编辑器友好），补 BOM 只发生在落盘这一步", () => {
    const src = fs.readFileSync(path.join(__dirname, "../server/computer/uia.ps1"));
    expect(src[0]).not.toBe(0xEF);
  });

  it("支持的命令都在派发表里，漏一个的名字会报错而不是静默返回空", () => {
    const ps = fs.readFileSync(path.join(__dirname, "../server/computer/uia.ps1"), "utf8");
    for (const cmd of ["ping", "screen", "windows", "tree", "act", "click_point", "type", "keys", "scroll", "window", "shot"]) {
      expect(ps).toContain("  " + cmd + " = {");
    }
  });

  it("非 Windows 平台直接判不可用，不去 spawn 一个不存在的 powershell", () => {
    expect(uia.supported()).toBe(process.platform === "win32");
  });
});

describe("computer 配置段", () => {
  it("handler 与 worker 读到的键，默认值一个都不能少（少一个就是运行时 undefined）", () => {
    const d = configMod.load().computer;
    for (const k of ["browser", "desktop", "autoDetectBrowser", "chromePath", "agentBrowserExe",
      "allowedDomains", "headed", "shotsTtlDays", "snapshotMaxChars"]) {
      expect(d).toHaveProperty(k);
    }
  });

  it("默认开：这是产品能力，不是要用户手动改配置才生效的实验特性", () => {
    const d = configMod.load().computer;
    expect(d.browser).toBe(true);
    expect(d.desktop).toBe(true);
    expect(d.autoDetectBrowser).toBe(true);
  });

  it("allowedDomains 默认空数组而不是 undefined（拼旗标处直接 .filter 会炸）", () => {
    expect(Array.isArray(configMod.load().computer.allowedDomains)).toBe(true);
  });
});
