/* 键化改造的体检：字典本身 + 源码引用 + 服务端 labelKey 三方对齐。
   为什么单独做成脚本：t() 找不到键时返回键名本身，界面会直接显示 "wbRootsGroupC1" 这种字符串——
   比留中文更难看，而运行时不会抛任何错，探针的"无 JS 报错"断言也看不见。 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

global.window = {};
global.localStorage = { getItem: function () { return "zh"; }, setItem: function () {} };
global.document = {
  querySelectorAll: function () { return []; }, getElementById: function () { return null; },
  addEventListener: function () {}, readyState: "complete", body: { appendChild: function () {} },
};
let LANGS;
try { LANGS = new Function(read("public/i18n.js") + "\nreturn LANGS;")(); }
catch (e) { console.log("FAIL i18n.js 求值失败：" + e.message); process.exit(1); }

const zh = Object.keys(LANGS.zh), en = Object.keys(LANGS.en);
const zhSet = new Set(zh), enSet = new Set(en);
const zhOnly = zh.filter((k) => !enSet.has(k));
const enOnly = en.filter((k) => !zhSet.has(k));
const dupZh = (() => {
  const seen = {}, out = [];
  for (const k of zh) { const v = LANGS.zh[k]; if (seen[v]) out.push(v + " = " + seen[v] + " / " + k); else seen[v] = k; }
  return out;
})();

const files = ["public/app.js", "public/index.html", "public/store.js"]
  .concat(fs.readdirSync(path.join(ROOT, "public/js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f))
  .concat(fs.readdirSync(path.join(ROOT, "server")).filter((f) => f.endsWith(".js")).map((f) => "server/" + f))
  .concat(fs.readdirSync(path.join(ROOT, "server/tools")).filter((f) => f.endsWith(".js")).map((f) => "server/tools/" + f));
const missing = [], srvUntranslated = [];
for (const rel of files) {
  const s = read(rel);
  const isSrv = rel.indexOf("server/") === 0;
  const patterns = isSrv ? [/labelKey:\s*"([A-Za-z_]\w*)"/g]
    : [/\bt\(\s*"([A-Za-z_]\w*)"/g, /\bt\(\s*'([A-Za-z_]\w*)'/g, /data-i18n(?:-[a-z]+)?="([A-Za-z_]\w*)"/g, /labelKey:\s*"([A-Za-z_]\w*)"/g];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) if (!zhSet.has(m[1])) missing.push(m[1] + "  @" + rel);
  }
  /* 服务端发出的中文 label：前端靠 tr() 反查字典，查不到就还是中文。列出来给"运行时提示全翻"验收。 */
  if (!isSrv) continue;
  for (const m of s.matchAll(/label:\s*"([^"]*[㐀-䶿一-鿿][^"]*)"/g)) {
    const hit = zh.some((k) => LANGS.zh[k] === m[1]);
    if (!hit) srvUntranslated.push(m[1] + "  @" + rel);
  }
}

console.log("字典：zh " + zh.length + " / en " + en.length + " 键");
console.log("  zh 有 en 没有：" + zhOnly.length + (zhOnly.length ? "  " + zhOnly.slice(0, 8).join(",") : ""));
console.log("  en 有 zh 没有：" + enOnly.length + (enOnly.length ? "  " + enOnly.slice(0, 8).join(",") : ""));
console.log("  zh 同文案多键（tr 反查会取第一个，仅提示）：" + dupZh.length);
console.log("  源码引用但不存在的键：" + missing.length);
missing.slice(0, 20).forEach((x) => console.log("    ! " + x));
console.log("  服务端中文 label 无字典对应（英文界面会留中文）：" + srvUntranslated.length);
srvUntranslated.slice(0, 30).forEach((x) => console.log("    · " + x));
const fail = zhOnly.length || enOnly.length || missing.length;
console.log(fail ? "FAIL 键化体检不通过" : "OK 键化体检通过");
process.exit(fail ? 1 : 0);
