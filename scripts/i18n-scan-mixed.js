/* 半英半中检查：同一行里既有 t("…") 键化结果、又留着没键化的中文显示字面量。
   为什么单独查：这种行的英文界面会渲染成 "Loaded 5 片段" —— 比整句还是中文更难看起来，
   而 DOM 扫描只在"这一屏恰好打开"时才看得见它。
   搜索关键词实参（"browser 浏览器 网页 自动化 playwright"）是故意中英混排的，必须跳过：
   判据 = 词数多且含多个纯 ASCII 词，那是给搜索用的词表，不是给人读的句子。 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CJK = /[㐀-䶿一-鿿]/;
const KEYED = /t\("[A-Za-z]\w*(?:T|C)\d+"\)/;

/* 搜索关键词表（"model 模型 id"、"browser 浏览器 网页"）是故意中英混排的，翻它就毁了搜索。
   判据：多词 + 含纯 ASCII 词 + 没有句子标点 —— 真文案会有标点或是一个整句。 */
const isKeywordList = (s) => {
  const toks = s.trim().split(/\s+/).filter(Boolean);
  if (toks.length < 3) return false;
  const ascii = toks.filter((t) => /^[A-Za-z0-9_.\/:-]+$/.test(t)).length;
  const han = toks.filter((t) => CJK.test(t)).length;
  return ascii >= 1 && han >= 1 && !/[，。：；？！,.:;?!、（）()「」]/.test(s);
};

/* 两类中文不算"半英半中"，必须显式豁免，否则这个检查会因为假阳性被关掉：
   ① 值已经在字典里（LANGS.zh 有该项）——渲染处过 tr()，英文界面会翻；
   ② 发给模型的提示词（expand: / aiFileAction / aiCurrentFile / msg: / prompt:）——
      那是 Agent 的输入不是界面文案，翻译它等于改产品行为。 */
const dictZh = new Set();
try {
  const src = fs.readFileSync(path.join(ROOT, "public", "i18n.js"), "utf8");
  const zhBlock = src.slice(src.indexOf("zh: {"), src.indexOf("en: {"));
  for (const m of zhBlock.matchAll(/^\s{4}[A-Za-z]\w*\s*:\s*"((?:[^"\\]|\\.)*)"/gm)) {
    let v; try { v = JSON.parse('"' + m[1] + '"'); } catch (e) { continue; }
    dictZh.add(v);
  }
} catch (e) { /* 读不到字典就退化成不豁免，宁可多报 */ }
const MODEL_PROMPT = /aiFileAction\(|aiCurrentFile\(|expand:\s*|prompt:\s*|msg:\s*|SLASH_COMMANDS/;

const files = ["public/app.js"]
  .concat(fs.readdirSync(path.join(ROOT, "public/js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f));
const rows = [];
for (const rel of files) {
  const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, "");
    if (!CJK.test(code) || !KEYED.test(code)) return;
    if (/^\s*(?:\*|\/\*)/.test(l)) return;
    if (MODEL_PROMPT.test(code)) return;
    const lits = [...code.matchAll(/(["'])((?:(?!\1)[^\n])*)\1/g)]
      .map((m) => m[2])
      .filter((v) => CJK.test(v) && !isKeywordList(v) && !/^[A-Za-z]\w*(?:T|C)\d+$/.test(v) && !dictZh.has(v));
    if (!lits.length) return;
    rows.push(rel + ":" + (i + 1) + "  残留 " + lits.length + " 段 → " + JSON.stringify(lits[0]).slice(0, 70));
  });
}
console.log("半英半中行数：" + rows.length);
rows.slice(0, Number(process.argv[2] || 40)).forEach((r) => console.log("  " + r));
if (rows.length > 40) console.log("  …其余 " + (rows.length - 40) + " 行（加参数看全部：node 本脚本 999）");
const fail = rows.length > 0;
console.log(fail ? "FAIL 有 " + rows.length + " 行半英半中" : "OK 没有半英半中的行");
process.exit(fail ? 1 : 0);
