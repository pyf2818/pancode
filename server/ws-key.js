/* ============================================================
   工作区分片键的唯一来源。

   动因：同一个目录在磁盘上曾经有两套名字——
     A 套 md5(resolve(ROOT, cfg.workspace))：会话上下文、目标、代码索引、进化树
     B 套 base36(31 项多项式哈希)(WS_DIR)：记忆、Skill、计划、灵魂、进度、自动化、编排历史
   于是 `E:\...\ai-ppt-generator` 同时是 fgkhkc 和 c36f404111c95fb6692df88668f5cb20，
   灵魂/计划各存了两份，UI 读一份、Agent 写另一份，功能静默错位。

   现在只有一个函数产键：md5(规范化绝对路径)。规范化 = 绝对化 + 去尾分隔符 + Windows 忽略大小写，
   所以 "E:\P" / "e:\p\\" / 相对路径解析后的同一个目录必得同一个键。

   老键不删不改内容：forWorkspace().file() 在 canonical 缺席时把 legacy 改名成 canonical（纯 move），
   两边都在时保持 canonical 不动，把冲突记进 drift 让挂载方告警，交给人裁决。
   ============================================================ */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const IS_WIN = process.platform === "win32";

/* B 套哈希原样保留：只用于 hello 下发的 wsId（前端 localStorage 会话存储 key）。
   那是浏览器里的键，换算法等于让所有老用户的历史列表看不见，跟磁盘分片无关。 */
function legacyStorageId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }

function toAbs(p, root) {
  const s = String(p == null ? "" : p).trim();
  if (!s) return path.resolve(root || process.cwd());
  return path.isAbsolute(s) ? path.resolve(s) : path.resolve(root || process.cwd(), s);
}

/* 同一个目录的多种写法收敛成同一个串 */
function normalizeDir(p, root) {
  let abs = toAbs(p, root).replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(abs)) abs += path.sep;      // 盘根去掉分隔符会变成"盘符相对路径"，不是合法键料
  return IS_WIN ? abs.toLowerCase() : abs;
}

/* 唯一的分片键 */
function shardKey(p, root) { return md5(normalizeDir(p, root)); }

/* 历史上真的往磁盘上写过的名字（A 套的未规范化变体 + B 套），按出现过的输入形态枚举 */
function legacyKeys(p, root) {
  const raw = toAbs(p, root);
  const noSep = raw.replace(/[\\/]+$/, "");
  const forms = new Set([raw, noSep]);
  if (IS_WIN) { forms.add(raw.toLowerCase()); forms.add(noSep.toLowerCase()); }
  const canon = shardKey(p, root);
  const out = [];
  for (const form of forms) {
    for (const k of [md5(form), legacyStorageId(form)]) {
      if (k !== canon && out.indexOf(k) < 0) out.push(k);
    }
  }
  return out;
}

/* 挂载期间累计的迁移结果，供 index.js 一次性告警（按内容去重：每次请求都会重新解析路径） */
const migrated = [];
const drift = [];
const seenDrift = new Set();
function noteDrift(rec) {
  const k = rec.dir + "|" + rec.live + "|" + (rec.leftovers || []).join(",") + "|" + (rec.error || "");
  if (seenDrift.has(k)) return;
  seenDrift.add(k);
  drift.push(rec);
}
function drainMigrated() { const a = migrated.slice(); migrated.length = 0; return a; }
/* 取走即清空去重表：同一次挂载里每个请求都会重新解析路径，不能报刷屏；
   但换工作区再换回来时，冲突该再提醒一次。 */
function drainDrift() { const a = drift.slice(); drift.length = 0; seenDrift.clear(); return a; }

function existsSafe(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function mtimeOf(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } }

/* dir/ 下把某个 legacy 名字搬成 canonical。规矩：不删、不盖、不静默丢内容。
   - canonical 已在：一个都不动，老文件原样留在磁盘，记 drift（读哪份是既成事实，交给人裁决）
   - 只有 legacy：把最新的这份改名成 canonical —— 最新的正是应用当前在展示的那份，
     搬键名不改内容，用户看不到变化；同目录还留着别的老键名就记 drift 等人工合并
   - 改名失败（占用/权限）退回那份 legacy 继续读写，绝不因迁移让挂载失败 */
function migrateInto(dir, canonicalName, legacyNames) {
  const target = path.join(dir, canonicalName);
  const found = legacyNames.map((n) => path.join(dir, n)).filter(existsSafe);
  if (!found.length) return target;
  found.sort((a, b) => mtimeOf(b) - mtimeOf(a));
  const pick = found[0];
  const leftovers = found.slice(1).map((p) => path.basename(p));

  if (existsSafe(target)) {
    noteDrift({ dir, live: canonicalName, leftovers: found.map((p) => path.basename(p)) });
    return target;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(pick, target);
    migrated.push({ from: pick, to: target });
  } catch (e) {
    noteDrift({ dir, live: path.basename(pick), error: e.message });
    return pick;
  }
  if (leftovers.length) noteDrift({ dir, live: canonicalName, leftovers });
  return target;
}

/* 一个工作区一份键料：把 key/legacy 的重复计算收在这层，调用点只说"我要哪个目录下的哪个文件" */
function forWorkspace(wsDir, root) {
  const key = shardKey(wsDir, root);
  const legacy = legacyKeys(wsDir, root);
  return {
    key,
    legacy,
    /* 分片文件：decorate(key) 决定最终文件名。conversations 的 "<key>__<userKey>.json" 这类
       带后缀的形态也走这里，legacy 同样按 decorate 展开，才不会漏掉老用户的上下文。 */
    file(dir, decorate) {
      const dec = decorate || ((k) => k + ".json");
      return migrateInto(dir, dec(key), legacy.map(dec));
    },
    /* 分片子目录（automations/<key>/） */
    subdir(dir) {
      return migrateInto(dir, key, legacy.slice());
    },
  };
}

module.exports = {
  shardKey, legacyKeys, normalizeDir, forWorkspace,
  legacyStorageId,
  drainMigrated, drainDrift,
};
