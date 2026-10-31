"use strict";
/* 渲染端「在文件夹中显示 / 打开文件夹」的路径闸门。
   渲染端只能递工作区相对路径：词法上拦绝对路径与 .. 逃逸，
   真实路径上再拦软链 —— 工作区里一个指向外面的链，
   startsWith 是看不出来的，文件管理器却会老老实实跟过去。 */
const fs = require("fs");
const path = require("path");

function resolveInRoot(root, rel) {
  if (!root) return { error: "工作区还没就绪" };
  const raw = String(rel == null ? "" : rel).replace(/\\/g, "/");
  if (!raw || raw.includes("\0")) return { error: "路径不能为空" };
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, raw);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { error: "路径越界: " + raw };
  try {
    const relReal = path.relative(fs.realpathSync(rootAbs), fs.realpathSync(abs));
    if (relReal === ".." || relReal.startsWith(".." + path.sep) || path.isAbsolute(relReal)) {
      return { error: "路径经由软链指向工作区外: " + raw };
    }
  } catch (e) { /* 目标不存在：交给调用方按自己的语义报错（reveal 要求存在，openFolder 可接受文件） */ }
  return { abs: abs };
}

module.exports = { resolveInRoot };
