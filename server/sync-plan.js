/* ============================================================
   外部改盘之后该广播什么（纯函数，单独成文件就是为了能单测）

   判据只有一个问题：**文件集合变了吗**。
     · 没变（在别的编辑器里改内容、测试写回既有文件、格式化插件跑一遍）→ 只读被点名的那几个路径；
     · 变了（新增 / 删除 / 改名）→ 必须全量，因为前端的增量分支只覆盖传入路径、
       不会删掉消失的文件（public/app.js 的 syncFiles），漏一次删除界面上就还留着一个点得开的幽灵文件。
   以前这里不看事件说了什么，一律全量：≤500 个文件逐个 readFileSync + 整包 JSON 广播给所有连接。
   ============================================================ */
"use strict";

/* paths：防抖窗口内所有事件给出的相对路径（空串 = fs.watch 只说了"某个目录动了"，说不清改了谁）
   prevSet：前端此刻手里那份文件集合（上一次广播出去的全量集合）
   curSet：现在磁盘上的文件集合 */
function planSync(paths, prevSet, curSet) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : [];
  const setLike = (s) => !!s && typeof s.has === "function" && typeof s.size === "number";
  if (!list.length || list.indexOf("") >= 0) return { mode: "full", changed: [] };
  if (!setLike(prevSet) || !setLike(curSet)) return { mode: "full", changed: [] };
  if (prevSet.size !== curSet.size) return { mode: "full", changed: [] };
  for (const p of prevSet) if (!curSet.has(p)) return { mode: "full", changed: [] };
  const changed = [];
  for (const p of list) if (curSet.has(p) && changed.indexOf(p) < 0) changed.push(p);
  /* 只动了目录、或动的是没进过快照的大文件/被忽略的路径：界面上没有任何东西需要改。 */
  if (!changed.length) return { mode: "none", changed: [] };
  return { mode: "incremental", changed };
}

module.exports = { planSync };
