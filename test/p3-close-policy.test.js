/* ============================================================
   关窗去向（#41）：判据 + 偏好落盘

   为什么单独测这一层：主进程里的 dialog / hide / quit 在 Node 侧跑不到，
   而"什么时候绝不能挂后台"恰恰是错了最难发现的那类——没有托盘还挂后台，
   用户看到的就是一个看不见、又杀不掉的后台进程（这正是"关窗 ≠ 退出"这条承诺唯一的破口）。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { decideClose, closeDialog, normalizePref } = require("../electron/close-policy");
const { WORST_CASE_WRITE_MS } = require("../server/safe-write");

const ask = (choice, remember) => decideClose({ pref: "ask", trayOk: true, choice, remember });

describe("decideClose：关窗判据", () => {
  it("已经决定要退（托盘退出 / OS 退出）时不再问，直接放行", () => {
    const d = decideClose({ pref: "ask", quitting: true, trayOk: true, choice: 0 });
    expect(d).toEqual({ action: "allow", rememberPref: null });
  });

  it("没有托盘时一律放行关闭 —— 挂后台会变成看不见又关不掉的进程", () => {
    for (const pref of ["ask", "background", "quit"]) {
      expect(decideClose({ pref, quitting: false, trayOk: false, choice: 0 }).action).toBe("allow");
    }
  });

  it("偏好是 background：不弹框，直接隐藏", () => {
    expect(decideClose({ pref: "background", trayOk: true })).toEqual({ action: "hide", rememberPref: null });
  });

  it("偏好是 quit：不弹框，走真正的退出", () => {
    expect(decideClose({ pref: "quit", trayOk: true })).toEqual({ action: "quit", rememberPref: null });
  });

  it("偏好不认识（旧配置 / 手改坏了）退回询问，而不是猜一个", () => {
    expect(normalizePref("whatever")).toBe("ask");
    expect(normalizePref("")).toBe("ask");
    expect(normalizePref(undefined)).toBe("ask");
    expect(decideClose({ pref: "whatever", trayOk: true }).action).toBe("cancel");
  });

  it("询问：0 挂后台 / 1 退出 / 2 与按 Esc 都算取消", () => {
    const ask = (choice, remember) => decideClose({ pref: "ask", trayOk: true, choice, remember });
    expect(ask(0).action).toBe("hide");
    expect(ask(1).action).toBe("quit");
    expect(ask(2).action).toBe("cancel");
    expect(ask(undefined).action).toBe("cancel");   // 对话框没答完也不能顺手关掉
  });

  it("只有勾了「记住我的选择」才写偏好，且写的是这一次实际选的那条", () => {
    expect(ask(0, true)).toEqual({ action: "hide", rememberPref: "background" });
    expect(ask(1, true)).toEqual({ action: "quit", rememberPref: "quit" });
    expect(ask(0, false).rememberPref).toBe(null);
    expect(ask(1, false).rememberPref).toBe(null);
    expect(ask(2, true).rememberPref).toBe(null);   // 取消不该记住任何东西
  });
});

describe("closeDialog：文案要说清「挂后台会怎样」", () => {
  it("有任务在跑时，把「中断几个」写在按钮上", () => {
    const box = closeDialog(3);
    expect(box.buttons[1]).toContain("中断 3 个任务");
    expect(box.detail).toContain("当前有 3 个任务在跑");
    expect(box.detail).toContain("收口时弹系统通知");
  });

  it("没任务时不许吓唬人", () => {
    const box = closeDialog(0);
    expect(box.buttons.join("|")).not.toMatch(/中断/);
    expect(box.detail).not.toMatch(/当前有 0 个/);
  });

  it("默认停在「挂到后台」，取消是安全出口（Esc 等价于取消）", () => {
    const box = closeDialog(1);
    expect(box.defaultId).toBe(0);
    expect(box.cancelId).toBe(2);
    expect(box.checkboxLabel).toContain("记住");
    // 记完之后要说清去哪改主意，否则"记住"变成"再也改不了"
    expect(box.detail).toContain("设置");
    expect(box.detail).toContain("关闭窗口");
  });
});

/* ---------- 偏好的落盘：只认三个值，写坏了不能把配置搅乱 ---------- */
let root = "";
let cfgMod = null;
function freshConfig(dataDir) {
  for (const m of ["../server/config", "../server/safe-write"]) delete require.cache[require.resolve(m)];
  process.env.PANCODE_DATA_DIR = dataDir;
  return require("../server/config");
}
async function readDisk(pred, ms) {
  /* 预算从 safe-write 的重试阶梯推导，不在这里另写魔数：
     写撞上 EPERM 时最坏要退避 ~10.9s，预算小于它就变成随机 flake。 */
  const budget = ms || (WORST_CASE_WRITE_MS + 3000);
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, "pancode.config.json"), "utf8"));
      if (pred(j)) return j;
    } catch (e) { /* saveJson 是排队异步落盘的，读不到就再等 */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

describe("config.saveDesktop：偏好写盘", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-closepref-"));
    fs.writeFileSync(path.join(root, "pancode.config.json"), JSON.stringify({ workspace: "." }), "utf8");
    cfgMod = freshConfig(root);
  });
  afterEach(() => {
    delete process.env.PANCODE_DATA_DIR;
    cfgMod = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  });

  it("默认值是 ask（第一次用一定会被问一次）", () => {
    expect(cfgMod.load().desktop.closeAction).toBe("ask");
  });

  it("三个合法值都写得进去，也真的落到盘上", async () => {
    const cfg = cfgMod.load();
    for (const v of ["background", "quit", "ask"]) {
      expect(cfgMod.saveDesktop(cfg, { closeAction: v }).closeAction).toBe(v);
      expect(cfg.desktop.closeAction).toBe(v);
      const onDisk = await readDisk((j) => j.desktop && j.desktop.closeAction === v);
      expect(onDisk).toBeTruthy();
    }
  });

  it("不认识的值一律不改，也不写坏已有配置", () => {
    const cfg = cfgMod.load();
    cfgMod.saveDesktop(cfg, { closeAction: "background" });
    expect(cfgMod.saveDesktop(cfg, { closeAction: "rm -rf" }).closeAction).toBe("background");
    expect(cfgMod.saveDesktop(cfg, {}).closeAction).toBe("background");
    expect(cfgMod.saveDesktop(cfg, null).closeAction).toBe("background");
  });

  it("写 desktop 不许顺手抹掉配置里别的段", async () => {
    const cfg = cfgMod.load();
    cfg.context.budgetTokens = 123456;
    cfgMod.saveAgentSettings(cfg, { permissions: { mode: "auto" } });
    cfgMod.saveDesktop(cfg, { closeAction: "quit" });
    const j = await readDisk((x) => x.desktop && x.desktop.closeAction === "quit");
    expect(j).toBeTruthy();
    expect(j.permissions.mode).toBe("auto");
    expect(j.context.budgetTokens).toBe(123456);
  });

  /* 上一条靠时序碰运气：全量跑 50 个测试文件时它随机失败过一次，失败形态正是
     "permissions 整段被 desktop 写回抹掉"。这一条把那个时序钉死成确定状态——
     盘上还是老那份，而它的 mtime 与刚入队那次写落在同一毫秒
     （Windows 时间戳粒度粗，装机上是常态不是巧合）。
     只比 mtime 的读回缓存在这种状态下会误信磁盘，改判"有没有在途写"才不会吞。 */
  it("在途写还没落盘时不许误信磁盘旧内容（同毫秒连存的确定复现）", async () => {
    const p = path.join(root, "pancode.config.json");
    const cfg = cfgMod.load();
    cfg.context.budgetTokens = 654321;
    cfgMod.saveAgentSettings(cfg, { permissions: { mode: "auto" } });
    fs.writeFileSync(p, JSON.stringify({ workspace: "." }), "utf8");
    const same = new Date();
    fs.utimesSync(p, same, same);
    cfgMod.saveDesktop(cfg, { closeAction: "quit" });
    const j = await readDisk((x) => x.desktop && x.desktop.closeAction === "quit");
    expect(j).toBeTruthy();
    expect(j.permissions && j.permissions.mode).toBe("auto");
    expect(j.context && j.context.budgetTokens).toBe(654321);
  });
});

/* 集成点守卫：判据单测全绿，"记住我的选择"照样坏了很久 —— 因为主进程读的是
   res.checkboxValue，而 Electron 的返回值字段叫 checkboxChecked。原生模态框没人能
   自动化点它，所以对这条路径唯一可行的静态守卫就是：读 main.js 的源码，认它接的是哪个字段。 */
describe("electron/main.js 的接线：字段名错了，判据再对也没用", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "electron", "main.js"), "utf8");

  it("remember 取的是 checkboxChecked，不是 checkboxValue", () => {
    expect(src).toMatch(/remember:\s*res\.checkboxChecked/);
    expect(src).not.toMatch(/checkboxValue/);
  });

  it("真对话框和探针注入共用同一个处理函数（不许两条路径各写一份判据）", () => {
    expect(src).toMatch(/const handleCloseAnswer = \(res\) =>/);
    expect(src).toMatch(/showMessageBox\(host, box\)\)\.then\(handleCloseAnswer\)/);
    expect(src).toMatch(/PANCODE_PROBE_CLOSE_ANSWER/);
    expect(src.match(/handleCloseAnswer/g).length).toBeGreaterThanOrEqual(3);
  });

  it("记住之后真的写偏好，且写的是这一次实际选的那条", () => {
    expect(src).toMatch(/if \(dec\.rememberPref\) \{\s*setDesktopPref\(dec\.rememberPref\)/);
  });

  /* 后端与主进程同进程：同步模态会把正在流式的任务整段卡住。
     这条路径没有自动化 UI 可点，只能钉源码里的对话框形态。 */
  it("退出确认用异步对话框，且带重入闸", () => {
    /* 只禁真调用：注释里点名这个 API 说明"为什么不用"是正当的 */
    expect(src).not.toMatch(/showMessageBoxSync\s*\(/);
    expect(src).toMatch(/async function quitWithTasks\(\)/);
    expect(src).toMatch(/if \(quitting \|\| quitDialogOpen\) return;/);
    expect(src).toMatch(/await dialog\.showMessageBox\(/);
  });
});
