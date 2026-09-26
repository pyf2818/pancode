/* ============================================================
   W4 · cron-lite — 轻量 crontab 表达式解析与下次执行时间计算
   ------------------------------------------------------------
   支持标准 5 字段子集：分 时 日 月 周
   - 每字段：*  |  数字  |  a-b  |  * /n  |  a-b/n  |  逗号列表
   - 周：0-6（0=周日），7 归一化为 0
   - 日(dom) 与周(dow) 同时受限时按 Vixie cron 语义取「或」：
     只有其一为受限（非 *）时才要求同时匹配。
   纯函数无依赖，供 scheduler.js 与单测使用。
   ============================================================ */
"use strict";

const RANGES = { min: [0, 59], hour: [0, 23], dom: [1, 31], mon: [1, 12], dow: [0, 6] };

/* 解析单个字段 → 排序去重的数字数组；非法返回 null */
function parseField(field, lo, hi) {
  field = String(field || "").trim();
  if (field === "") return null;
  const out = new Set();
  for (const part of field.split(",")) {
    if (part === "") return null;
    let body = part;
    let step = 1;
    const si = part.indexOf("/");
    if (si !== -1) {
      body = part.slice(0, si);
      step = parseInt(part.slice(si + 1), 10);
      if (!Number.isInteger(step) || step < 1) return null;
    }
    let a = lo, b = hi;
    if (body !== "*" && body !== "") {
      const ri = body.indexOf("-");
      if (ri !== -1) {
        a = parseInt(body.slice(0, ri), 10);
        b = parseInt(body.slice(ri + 1), 10);
      } else {
        a = b = parseInt(body, 10);
      }
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      if (a > b) return null;
    } else if (si === -1) {
      // 纯 "*"
      a = lo; b = hi;
    }
    // 仅周字段（dow）做 7→0 归一化（周日）；分钟等其他 lo=0 字段的 7 是合法值
    const norm = (v) => (hi === 6 && v === 7 ? 0 : v);
    if (norm(a) < lo || norm(a) > hi || norm(b) < lo || norm(b) > hi) return null;
    for (let v = a; v <= b; v += step) out.add(norm(v));
  }
  if (!out.size) return null;
  return Array.from(out).sort((x, y) => x - y);
}

/* 解析完整 5 字段表达式 → {min,hour,dom,mon,dow}；非法返回 null */
function parseCron(expr) {
  const parts = String(expr || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const min = parseField(parts[0], RANGES.min[0], RANGES.min[1]);
  const hour = parseField(parts[1], RANGES.hour[0], RANGES.hour[1]);
  const dom = parseField(parts[2], RANGES.dom[0], RANGES.dom[1]);
  const mon = parseField(parts[3], RANGES.mon[0], RANGES.mon[1]);
  const dow = parseField(parts[4], RANGES.dow[0], RANGES.dow[1]);
  if (!min || !hour || !dom || !mon || !dow) return null;
  const isFull = (arr, lo, hi) => arr.length === hi - lo + 1;
  return {
    min, hour, mon, dow,
    dom,
    domFull: isFull(dom, 1, 31) && parts[2].trim() === "*",
    dowFull: isFull(dow, 0, 6) && parts[4].trim() === "*",
  };
}

/* 某分钟时刻是否命中表达式 */
function cronMatches(c, d) {
  if (!c.mon.includes(d.getMonth() + 1)) return false;
  if (!c.hour.includes(d.getHours())) return false;
  if (!c.min.includes(d.getMinutes())) return false;
  const domHit = c.dom.includes(d.getDate());
  const dowHit = c.dow.includes(d.getDay());
  if (!c.domFull && !c.dowFull) return domHit || dowHit; // Vixie cron「或」语义
  if (!c.domFull) return domHit;
  if (!c.dowFull) return dowHit;
  return true;
}

/* 从 from 起算下一次执行时间（不含 from 本身，精确到分钟，秒清零）。
   逐分钟扫描，上限 366 天（不可命中组合如 2 月 30 日 → 返回 null）。 */
function cronNext(expr, from) {
  const c = parseCron(expr);
  if (!c) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const cap = 366 * 24 * 60;
  for (let i = 0; i < cap; i++) {
    if (cronMatches(c, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

module.exports = { parseCron, parseField, cronNext, cronMatches };
