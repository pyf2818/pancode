/* ============================================================
   静态扫描：JS 字符串字面量里硬编码的界面属性中文
   ------------------------------------------------------------
   为什么单独有这一条：运行期 DOM 扫描只能扫到"探针打得开的界面"。
   脏标记的 title、审批卡上的按钮、模型下拉里的刷新键、技能市场那一页……
   这些节点要么要有未保存改动才存在，要么要有真引擎/真网络才渲染。
   探针报 0 残留，和"这些字符串已经键化"，是两件事。
   所以这一条不看可达性，只看源码：属性名 = "含中文的字面量" 一律算漏翻。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
/* 界面文案的四个属性位；alt 也算（图片替代文字是读屏软件念出来的） */
const ATTR = "title|placeholder|aria-label|alt";
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

function publicFiles() {
  const out = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith(".js") && f !== "i18n.js") out.push(p);
    }
  };
  walk(path.join(ROOT, "public"));
  return out;
}

/* 一行里可能连着好几段拼接：title="' + n + ' 次"。
   所以从属性名往后取一段窗口，把窗口内每个引号片段都查一遍。 */
function scanLine(line) {
  const hits = [];
  const re = new RegExp("(?:" + ATTR + ")\\s*=\\s*[\"']", "g");
  let m;
  while ((m = re.exec(line))) {
    const win = line.slice(m.index, m.index + 160);
    const parts = win.match(/["']([^"']*)["']/g) || [];
    for (const raw of parts) {
      const v = raw.slice(1, -1);
      if (CJK.test(v)) { hits.push(v.replace(/\s+/g, " ").trim().slice(0, 48)); break; }
    }
  }
  return hits;
}

const uniq = [];
const seen = new Set();
/* index.html 也走同一把尺：静态标签上的中文属性必须配 data-i18n-*，否则切语言不会跟着变。
   （实测漏过一条：#cmdkInput 的 aria-label="命令搜索" 有 data-i18n-ph 却没有 data-i18n-aria，
     运行期扫描在修好"命令面板其实一直是隐藏的"之后才第一次扫到它。） */
const ATTR2KEY = { title: "data-i18n-title", placeholder: "data-i18n-ph", "aria-label": "data-i18n-aria", alt: "data-i18n-alt" };
function scanHtml(html, file) {
  const out = [];
  const tagRe = /<[a-zA-Z][^>]*>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    for (const a of Object.keys(ATTR2KEY)) {
      const am = new RegExp("\\b" + a + "\\s*=\\s*\"([^\"]*)\"").exec(tag);
      if (!am || !CJK.test(am[1])) continue;
      if (tag.indexOf(ATTR2KEY[a]) >= 0) continue;
      out.push({ file, line: html.slice(0, m.index).split("\n").length, text: am[1].replace(/\s+/g, " ").trim().slice(0, 48) });
    }
  }
  return out;
}
const htmlPath = path.join(ROOT, "public", "index.html");
if (fs.existsSync(htmlPath)) {
  for (const h of scanHtml(fs.readFileSync(htmlPath, "utf8"), "public\\index.html")) {
    const key = h.file + ":" + h.line + ":" + h.text;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(h);
  }
}
for (const f of publicFiles()) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/data-i18n-(title|ph|aria)|^\s*(\/\/|\*)/.test(line)) return;
    for (const text of scanLine(line)) {
      const key = path.relative(ROOT, f) + ":" + (i + 1) + ":" + text;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push({ file: path.relative(ROOT, f), line: i + 1, text });
    }
  });
}

console.log("硬编码中文界面属性：" + uniq.length + " 处");
const byFile = {};
for (const h of uniq) (byFile[h.file] = byFile[h.file] || []).push(h);
Object.keys(byFile).sort((a, b) => byFile[b].length - byFile[a].length).forEach((f) => {
  console.log("  " + String(byFile[f].length).padStart(3) + "  " + f);
  byFile[f].forEach((h) => console.log("        " + String(h.line).padStart(4) + "  " + h.text));
});
/* 零容忍：这一条查的是源码，与"探针打不打得开那个界面"无关，所以没有阈值可留 */
process.exit(uniq.length === 0 ? 0 : 1);
