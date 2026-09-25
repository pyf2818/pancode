/* ============================================================
   W6 产物系统：会话交付物清单（引用制——工作区文件是唯一真源，
   产物 = 可预览交付文件的"书签"，不做内容复制避免双写不一致）
   存储：.pancode/artifacts/<convId>.json
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

/* 扩展名 → 产物类型（只收可预览的交付物；代码/配置文件不算产物） */
const KIND_MAP = [
  ["html", "html", "HTML"], ["htm", "html", "HTML"],
  ["md", "markdown", "Markdown"], ["markdown", "markdown", "Markdown"],
  ["svg", "svg", "SVG"],
  ["png", "image", "图片"], ["jpg", "image", "图片"], ["jpeg", "image", "图片"],
  ["gif", "image", "图片"], ["webp", "image", "图片"], ["bmp", "image", "图片"], ["ico", "image", "图片"],
  ["pdf", "pdf", "PDF"],
  ["docx", "docx", "Word"],
];

function artifactKind(p) {
  const ext = String((p || "").split(".").pop() || "").toLowerCase();
  for (const [e, kind, label] of KIND_MAP) if (ext === e) return { kind, label };
  return null;
}

/* 会话写过的文件 Map → 产物清单：只留可预览类型，新建置顶，其后按最后写入时间倒序 */
function collectArtifacts(writesMap, existsFn) {
  const out = [];
  for (const [p, info] of writesMap || []) {
    const k = artifactKind(p);
    if (!k) continue;
    if (typeof existsFn === "function" && !existsFn(p)) continue; // 会话中已删除的跳过
    out.push({ path: p, kind: k.kind, label: k.label, isNew: !!(info && info.isNew), ts: (info && info.ts) || 0 });
  }
  out.sort((a, b) => (b.isNew - a.isNew) || (b.ts - a.ts));
  return out;
}

function artifactsDir(ROOT) { return path.join(ROOT, ".pancode", "artifacts"); }

function saveArtifacts(ROOT, convId, list) {
  try {
    const dir = artifactsDir(ROOT);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, convId + ".json.tmp");
    fs.writeFileSync(tmp, JSON.stringify({ convId, ts: Date.now(), list }, null, 2), "utf8");
    fs.renameSync(tmp, path.join(dir, convId + ".json"));
    return true;
  } catch (e) { console.warn("[artifacts] 保存失败:", e.message); return false; }
}

function loadArtifacts(ROOT, convId) {
  try {
    const raw = fs.readFileSync(path.join(artifactsDir(ROOT), String(convId || "default") + ".json"), "utf8");
    const d = JSON.parse(raw);
    return { convId: d.convId || convId, ts: d.ts || 0, list: Array.isArray(d.list) ? d.list : [] };
  } catch (e) { return { convId: convId, ts: 0, list: [] }; }
}

module.exports = { artifactKind, collectArtifacts, saveArtifacts, loadArtifacts };
