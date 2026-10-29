/* ============================================================
   pancode-cli · 交互提示（审批 / 选择 / 输入）
   ------------------------------------------------------------
   用 @inquirer/prompts 实现，对齐前端 patch 审阅 + 工具审批 +
   ask_choice 选择。所有提示带 ANSI 着色，与 render.js 风格一致。
   ============================================================ */
"use strict";

const inq = require("@inquirer/prompts");
const S = require("./style");

/* ---------- 工具调用审批 ----------
   ev: { id, name, target, summary, risk }
   返回 true/false，由 cli.js 回传 engine.resolveApproval(id, bool) */
async function approval(ev) {
  const risk = ev.risk || "low";
  const riskColor = risk === "high" ? S.err : risk === "medium" ? S.warn : S.ok;
  const head = S.box("工具审批", [
    S.c.bold(ev.name || "tool") + (ev.target ? " " + S.dim(ev.target) : ""),
    "",
    ev.summary || "",
    "",
    S.dim("风险：") + riskColor(risk),
  ].join("\n"), { titleColor: S.warn });

  process.stdout.write(head + "\n");
  const ans = await inq.select({
    message: "是否批准执行？",
    choices: [
      { name: S.ok("✓ 批准（本次）"), value: "once" },
      { name: S.ok("✓ 批准（本会话同类）"), value: "session" },
      { name: S.err("✗ 拒绝"), value: "no" },
      { name: S.dim("✗ 拒绝并停止"), value: "stop" },
    ],
  });
  if (ans === "stop") return { ok: false, stop: true };
  return { ok: ans !== "no", session: ans === "session" };
}

/* ---------- 补丁审阅 ----------
   ev: { id, files: [{ path, diff, status }] }
   逐文件接受/拒绝，返回 { id, decisions: [{ path, accept }] } */
async function patchReview(ev) {
  const decisions = [];
  process.stdout.write(S.box("补丁审阅", S.c.bold(ev.files.length + " 个文件待审"), { titleColor: S.accent }) + "\n");
  for (const f of ev.files) {
    process.stdout.write(S.colorizeDiff(f.diff || "") + "\n");
    const ans = await inq.select({
      message: S.c.bold(f.path) + " — 接受？",
      choices: [
        { name: S.ok("✓ 接受"), value: true },
        { name: S.err("✗ 拒绝"), value: false },
        { name: S.dim("⏭ 全部接受剩余"), value: "all" },
        { name: S.dim("⏭ 全部拒绝剩余"), value: "none" },
      ],
    });
    if (ans === "all") { decisions.push({ path: f.path, accept: true }); for (const g of ev.files.slice(ev.files.indexOf(f) + 1)) decisions.push({ path: g.path, accept: true }); break; }
    if (ans === "none") { decisions.push({ path: f.path, accept: false }); for (const g of ev.files.slice(ev.files.indexOf(f) + 1)) decisions.push({ path: g.path, accept: false }); break; }
    decisions.push({ path: f.path, accept: ans });
  }
  return { id: ev.id, decisions };
}

/* ---------- ask_choice 选择 ----------
   ev: { id, prompt, choices: [{ label, value }], multi }
   返回 { id, value } */
async function choice(ev) {
  const choices = (ev.choices || []).map((c) => ({ name: c.label || c.value, value: c.value }));
  if (ev.multi) {
    const vals = await inq.checkbox({ message: ev.prompt || "选择", choices });
    return { id: ev.id, value: vals };
  }
  const val = await inq.select({ message: ev.prompt || "选择", choices });
  return { id: ev.id, value: val };
}

/* ---------- 多行输入 ----------
   用于 REPL 主输入。支持 \n 换行（Shift+Enter 在多数终端难绑，
   退而求其次：空行结束或 / 提交）。这里用简单 input + 续行约定。 */
async function multiline(prompt) {
  const first = await inq.input({ message: prompt });
  if (!first.endsWith("\\")) return first;
  let acc = first.slice(0, -1) + "\n";
  while (true) {
    const line = await inq.input({ message: S.dim("… ") });
    if (line === "") break;
    acc += line + "\n";
  }
  return acc.trimEnd();
}

/* ---------- 确认 ---------- */
async function confirm(msg, def) {
  return inq.confirm({ message: msg, default: !!def });
}

module.exports = { approval, patchReview, choice, multiline, confirm };
