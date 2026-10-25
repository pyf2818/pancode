"use strict";
/* ============================================================
   电脑控制工具族：走 UI Automation 读窗口与控件，动作优先用控件模式。

   默认交给模型的是一律是文本（元素树 / 控件文本），截图只落盘给用户看。
   例外只有一个，且必须显式：desktop_screenshot 带 for_model:true 且配置 llm.vision 已开时，
   这张 PNG 才作为像素随下一次请求交给模型 —— 给的是"自绘界面读不到控件"那种死角用的，
   正常窗口仍然优先元素树（理由见 server/computer/uia.ps1 顶部与 server/computer/vision.js）。

   优先 UIA 模式、坐标点击只作兜底，这一点很重要：
   InvokePattern / TogglePattern / ValuePattern 点的是控件对象本身，
   不移动光标、不抢焦点（SetValue 那条甚至不用窗口在前台），
   所以不会把用户正在用的鼠标打到一半抢走；而坐标点击会 —— 它单独标 danger:"high"。
   ============================================================ */
const path = require("path");
const worker = require("../computer/uia-worker");
const shots = require("../computer/shots");
const vision = require("../computer/vision");

const MAX_TEXT = 12000;

/* 总开关按引擎自己的 cfg 判（与 browser 家族同一套：ab.status(agent.cfg)）。
   判在 handler 而不是 worker：worker 是进程级单例，看不见"谁在调"，
   让它去读盘上的配置就会出现"界面里关了但工具照跑"这种最难查的偏差。 */
function off(agent) {
  const c = (agent.cfg || {}).computer || {};
  if (c.desktop === false) return "电脑控制已关闭（配置 computer.desktop=false）。要用的话去 设置 → 电脑控制 打开。";
  if (!worker.supported()) return "电脑控制只在 Windows 上可用（走 UI Automation），当前运行平台不支持。";
  return null;
}

function clip(s, n) {
  const str = String(s == null ? "" : s);
  const lim = n || MAX_TEXT;
  return str.length <= lim ? str : str.slice(0, lim) + "\n…（已截断，共 " + str.length + " 字符。用 max_nodes/max_depth 收窄，或按标题缩小到某个窗口）";
}

function err(t, r, cmd) {
  t.done(false, "失败");
  const e = r.error || "桌面控制没有返回";
  /* worker 没起来时不要骗用户说"命令失败"——把"为什么起不来"直说，才知道去装/去开。 */
  return "桌面控制 " + cmd + " 失败：" + e
    + (/powershell|未就绪|退出了/.test(e) ? "（桌面控制进程没能启动。它是常驻的 powershell.exe 子进程，只在 Windows 上可用；确认 设置 → 电脑控制 已打开。）" : "");
}

function ref(v) {
  const raw = String(v == null ? "" : v);
  const named = raw.match(/ref=([A-Za-z0-9]+)/);
  const s = (named ? named[1] : raw.replace(/^[\s@["']*|[\s"'\]]*$/g, "").replace(/^@/, "")).trim();
  if (!/^[A-Za-z0-9]{1,12}$/.test(s)) {
    const e = new Error('ref 要的是 desktop_snapshot / desktop_windows 里 ref=eN 的那个 N，收到：' + raw.slice(0, 40));
    e.badRef = true;
    throw e;
  }
  return s;
}

const HANDLERS = {
  desktop_screenshot: async (agent, args) => {
    const forModel = args.for_model === true;
    const t = agent.tool("tool", "桌面·截图", args.window_ref ? "某个窗口" : "整屏" + (forModel ? " · 交给模型" : ""));
    let abs;
    try { abs = path.join(shots.convDir(agent._convIdNow()), shots.fileName(args.name || "screen", "png")); }
    catch (e) { t.done(false, "落盘失败"); return "截图无法落盘：" + e.message; }
    const a = { path: abs };
    if (args.window_ref) { try { a.ref = ref(args.window_ref); } catch (e) { t.done(false, "参数不对"); return "desktop_screenshot 参数不对：" + e.message; } }
    const r = await worker.request("shot", a, 40000);
    if (!r.ok) return err(t, r, "截图");
    const rel = path.relative(shots.root(), abs).split(path.sep).join("/");
    if (t.image) t.image(rel);
    t.body("截图：" + rel + "（" + r.data.w + "×" + r.data.h + "）");
    const cap = String(args.caption || args.name || "桌面截图").slice(0, 120);
    const vis = forModel ? vision.attach(agent, { abs, rel, caption: cap }) : null;
    t.done(true, vis && vis.v.ok ? "已截图·已交模型" : "已截图");
    const geo = "已截图 " + r.data.w + "×" + r.data.h + "，存到 " + rel + "（界面里这张卡片下方可直接看到）。\n";
    /* 桌面截图是 PNG（worker 直接写字节），没法就地转 jpeg；整屏那张常常超 3MB 喂不上去，
       所以把"只截某个窗口"这条出路写在回执里，而不是让它撞一次失败再猜。 */
    if (vis) return geo + vis.note + (vis.v.ok ? "" : "\n（桌面截图通常是整屏分辨率，试着带 window_ref 只截目标窗口会小很多。）");
    return geo + "注意：这张图只有用户能看见，模型不看像素 —— 要判断屏幕状态请继续用 desktop_windows / desktop_snapshot 的元素树。" +
      "自绘界面的窗口可能截得到、但读不到控件，那属正常；那种情况带 for_model:true（并先开配置 llm.vision）把像素交给我。";
  },

  desktop_windows: async (agent, args) => {
    const t = agent.tool("tool", "桌面·列窗口", args.include_hidden ? "含无名窗口" : "只标题可见的");
    const r = await worker.request("windows", { includeHidden: !!args.include_hidden }, 40000);
    if (!r.ok) return err(t, r, "列窗口");
    const list = (r.data && r.data.windows) || [];
    const lines = list.map((w) => {
      const rect = w.rect ? w.rect.x + "," + w.rect.y + " " + w.rect.w + "×" + w.rect.h : "(无矩形)";
      /* 与控件树同一形状（[ref=eN]），模型两套工具里认一个模式就够 */
      return "- [ref=" + w.ref + "] " + (w.title || "(无标题)") + " · " + w.control
        + (w.minimized ? " · 已最小化" : "") + (w.foreground ? " · 当前前台" : "")
        + " · pid=" + w.pid + " · " + rect;
    });
    const body = lines.join("\n") || "(没枚举到窗口)";
    t.body(clip(body, 3000));
    t.done(true, list.length + " 个窗口");
    return "桌面窗口 " + list.length + " 个（[ref=eN] 可交给 desktop_snapshot / desktop_window / desktop_screenshot）：\n"
      + body + "\n\n下一步：对目标窗口调 desktop_snapshot 取它内部的控件树。";
  },

  desktop_snapshot: async (agent, args) => {
    const t = agent.tool("tool", "桌面·读窗口", args.title || args.window_ref || "(缺目标)");
    const a = {};
    if (args.window_ref) { try { a.window_ref = ref(args.window_ref); } catch (e) { t.done(false, "参数不对"); return "desktop_snapshot 参数不对：" + e.message; } }
    if (args.title) a.title = String(args.title);
    if (args.max_depth) a.max_depth = Number(args.max_depth);
    if (args.max_nodes) a.max_nodes = Number(args.max_nodes);
    if (args.include_offscreen) a.include_offscreen = true;
    const r = await worker.request("tree", a, 90000);
    if (!r.ok) return err(t, r, "读窗口");
    const tree = (r.data && r.data.tree) || "";
    if (!tree.trim()) { t.body("(这个窗口里没有可读控件)"); t.done(true, "空"); return "窗口 " + (r.data && r.data.title) + " 里没有可读控件。自绘界面的应用（游戏、部分 Qt / 没开无障碍的 Electron）就是这种 —— 只能用 desktop_screenshot 给人看 + 坐标点击，坐标点击会真的移动用户鼠标。"; }
    t.body(clip(tree, 3000));
    t.done(true, r.data.nodes + " 个控件");
    return "窗口「" + (r.data.title || "") + "」的控件树 " + r.data.nodes + " 个"
      + (r.data.truncated ? "（已到 max_nodes 上限被截断，用 max_depth/max_nodes 收窄或加 include_offscreen 看隐藏的）" : "")
      + "，[ref=eN] 可交给 desktop_click / desktop_type / desktop_read；can=… 说明这个控件支持哪些动作（invoke/toggle/value/select/expand/scroll/range）。\n"
      + clip(tree);
  },

  desktop_read: async (agent, args) => {
    const t = agent.tool("tool", "桌面·取文本", args.ref);
    let a;
    try { a = { ref: ref(args.ref), action: "text" }; } catch (e) { t.done(false, "参数不对"); return "desktop_read 参数不对：" + e.message; }
    const r = await worker.request("act", a, 40000);
    if (!r.ok) return err(t, r, "取文本");
    const text = (r.data && r.data.text) || "";
    t.body(clip(text, 2000));
    t.done(true, text.length + " 字符");
    return clip(text);
  },

  desktop_click: async (agent, args) => {
    const byPoint = (typeof args.x === "number" && typeof args.y === "number");
    const t = agent.tool("tool", "桌面·点击", byPoint ? (args.x + "," + args.y) : args.ref);
    const gate = await agent._gate("desktop_click", { ref: args.ref, x: args.x, y: args.y, right: !!args.right }, byPoint ? "high" : "medium");
    if (gate.blocked) { t.done(false, "被拒绝规则拦截"); return "desktop_click 被拒绝规则拦截，未执行：" + (gate.reason || ""); }
    if (!gate.approved) { t.done(false, "用户拒绝"); return "用户拒绝了这次桌面点击，未执行。"; }
    let r;
    if (byPoint) {
      r = await worker.request("click_point", { x: Number(args.x), y: Number(args.y), right: !!args.right, triple: !!args.triple }, 30000);
      if (!r.ok) return err(t, r, "坐标点击");
      t.body("已点 " + args.x + "," + args.y);
      t.done(true, "已点击（移动了光标）");
      return "已在坐标 (" + args.x + "," + args.y + ") 点击 —— 这一次**移动了用户的真实光标**。优先改用 desktop_snapshot 拿控件 ref 来点，那条路不动鼠标。";
    }
    let a;
    try { a = { ref: ref(args.ref), action: "click", right: !!args.right, triple: !!args.triple }; }
    catch (e) { t.done(false, "参数不对"); return "desktop_click 参数不对：" + e.message; }
    r = await worker.request("act", a, 30000);
    if (!r.ok) return err(t, r, "点击");
    const how = (r.data && r.data.how) || "已点击";
    t.body(how);
    t.done(true, "已点击");
    return "已对 " + args.ref + " 完成点击（" + how + "）。界面状态大概变了 —— 需要看结果就重新 desktop_snapshot，别沿用旧 ref。";
  },

  desktop_type: async (agent, args) => {
    const t = agent.tool("tool", "桌面·输入", args.ref || "当前焦点");
    const text = String(args.text == null ? "" : args.text);
    if (!text.length) { t.done(false, "空的"); return "desktop_type 需要 text。"; }
    if (text.length > 2000) { t.done(false, "太长"); return "desktop_type 一次最多 2000 字符（收到 " + text.length + "），请分段。"; }
    const gate = await agent._gate("desktop_type", { ref: args.ref, length: text.length }, "medium");
    if (gate.blocked) { t.done(false, "被拒绝规则拦截"); return "desktop_type 被拒绝规则拦截，未输入。"; }
    if (!gate.approved) { t.done(false, "用户拒绝"); return "用户拒绝了这次输入，未发送任何按键。"; }
    let a = { text };
    if (args.ref) { try { a.ref = ref(args.ref); } catch (e) { t.done(false, "参数不对"); return "desktop_type 参数不对：" + e.message; } }
    if (args.enter) a.enter = true;
    if (args.use_value === false) a.use_value = false;
    const r = await worker.request("type", a, 60000);
    if (!r.ok) return err(t, r, "输入");
    const how = (r.data && r.data.how) || "已输入";
    t.body(how + " " + text.length + " 字符");
    t.done(true, "已输入");
    return "已输入 " + text.length + " 个字符（" + how + (r.data && r.data.took_focus ? "，这次需要窗口拿到焦点" : "，没抢焦点") + "）。";
  },

  desktop_press: async (agent, args) => {
    const t = agent.tool("tool", "桌面·按键", args.keys);
    const gate = await agent._gate("desktop_press", { keys: args.keys }, "medium");
    if (gate.blocked) { t.done(false, "被拒绝规则拦截"); return "desktop_press 被拒绝规则拦截，未执行。"; }
    if (!gate.approved) { t.done(false, "用户拒绝"); return "用户拒绝了这次按键，未执行。"; }
    const r = await worker.request("keys", { keys: String(args.keys) }, 30000);
    if (!r.ok) return err(t, r, "按键");
    t.body("已按 " + args.keys);
    t.done(true, args.keys);
    return "已发送按键 " + args.keys + "。按键是发给当前焦点窗口的 —— 先 desktop_window 传 activate 把目标窗口带到前台，否则可能按到别的窗口上。";
  },

  desktop_scroll: async (agent, args) => {
    const t = agent.tool("tool", "桌面·滚动", String(args.notches || 3));
    const gate = await agent._gate("desktop_scroll", { notches: args.notches }, "medium");
    if (gate.blocked) { t.done(false, "被拒绝规则拦截"); return "desktop_scroll 被拒绝规则拦截，未执行。"; }
    if (!gate.approved) { t.done(false, "用户拒绝"); return "用户拒绝了这次滚动，未执行。"; }
    const n = Number(args.notches) || 3;
    const r = await worker.request("scroll", { amount: n }, 30000);
    if (!r.ok) return err(t, r, "滚动");
    t.body("已滚动 " + n);
    t.done(true, "已滚动");
    return "已滚动 " + n + " 格（负数向上）。滚动的目标是鼠标位置下的窗口 —— 若没生效，先 desktop_window activate 目标窗口。";
  },

  desktop_window: async (agent, args) => {
    const t = agent.tool("tool", "桌面·窗口操作", args.action);
    const gate = await agent._gate("desktop_window", { action: args.action, ref: args.ref }, args.action === "close" ? "high" : "medium");
    if (gate.blocked) { t.done(false, "被拒绝规则拦截"); return "desktop_window 被拒绝规则拦截，未执行：" + (gate.reason || ""); }
    if (!gate.approved) { t.done(false, "用户拒绝"); return "用户拒绝了对这个窗口的操作（" + args.action + "），未执行。"; }
    let a;
    try { a = { ref: ref(args.ref), action: String(args.action) }; } catch (e) { t.done(false, "参数不对"); return "desktop_window 参数不对：" + e.message; }
    if (args.action === "move") { a.x = Number(args.x); a.y = Number(args.y); }
    if (args.action === "resize") { a.w = Number(args.w); a.h = Number(args.h); }
    const r = await worker.request("window", a, 30000);
    if (!r.ok) return err(t, r, "窗口操作");
    const title = (r.data && r.data.title) || "(标题读不到了)";
    t.body(args.action + "：" + title);
    t.done(true, args.action);
    if (args.action === "close") return "已请求关闭窗口「" + title + "」" + (args.ref ? "（ref=" + args.ref + "）" : "") + "，走 WM_CLOSE，等同用户点标题栏的叉：有未保存内容的会弹它自己的保存提示，不会强杀。";
    return "已对窗口「" + title + "」执行 " + args.action + "。";
  },
};

/* 统一前置总开关：九条 handler 各写一遍必漏一条，而漏的那条会在"用户已经关掉电脑控制"时照样动桌面。
   卡片在这里就建好并标灰，界面上一条"未启用"比静默返回更有解释力。 */
module.exports = Object.keys(HANDLERS).reduce((out, name) => {
  out[name] = async (agent, args) => {
    const offMsg = off(agent);
    if (offMsg) {
      const t = agent.tool("tool", name, "");
      t.done(false, "未启用");
      return offMsg;
    }
    return HANDLERS[name](agent, args);
  };
  return out;
}, {});
