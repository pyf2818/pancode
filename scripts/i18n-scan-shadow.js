/* i18n 键化之后必查：全局翻译函数 t() 有没有被同名局部变量遮住。
   codemod 把中文字面量换成 t("key")，而渲染回调里常见 rows.forEach((t) => …) 这种参数名（t 代表 item）。
   遮住的后果是运行时 TypeError，但分区渲染外层有 try/catch，错误被吞成"这一页加载失败"，
   探针的"全程无 JS 报错"断言看不见 —— 所以必须静态查，不能靠跑。 */
"use strict";
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const ROOT = path.resolve(__dirname, "..");
const files = ["public/app.js", "public/store.js", "public/icons.js"]
  .concat(fs.readdirSync(path.join(ROOT, "public/js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f));

let bad = 0;
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: "script" }); }
  catch (e) { console.log("PARSE FAIL " + rel + "  " + e.message); bad++; continue; }
  const hits = [];
  const lineOf = (pos) => src.slice(0, pos).split("\n").length;

  /* 收集一个函数体内（含嵌套）出现的所有标识符使用点，判断 t(...) 里的 t 解析到哪一层：
     只要从当前节点往外走作用域链，第一个绑定的不是全局函数 t，就是遮蔽。 */
  function scopesOf(path_) { return path_; }

  function walk(node, scope) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "t") {
      const owner = scopeChain(scope).find((s) => s.locals.has("t"));
      if (owner && owner.kind !== "global") {
        hits.push("line " + lineOf(node.start) + "  t() 被 " + owner.kind + "（line " + owner.line + " 的形参/变量 t）遮住  →  " +
          src.slice(node.start, Math.min(node.end, node.start + 70)).replace(/\s+/g, " "));
      }
    }
    for (const k in node) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, scope));
      else if (v && typeof v === "object" && v.type) walk(v, scope);
    }
  }
  function scopeChain(s) { const out = []; for (let c = s; c; c = c.parent) out.push(c); return out; }

  /* 简化版作用域：函数节点建一层，块级 const/let 记在最近的函数层上（足够判定 t 这种单字母名）。 */
  const globalScope = { kind: "global", line: 0, locals: new Set(["t"]), parent: null };
  function walkScopes(node, scope) {
    if (!node || typeof node !== "object") return;
    let inner = scope;
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      inner = { kind: "function", line: lineOf(node.start), locals: new Set(), parent: scope };
      (node.params || []).forEach((p) => collectNames(p).forEach((n) => inner.locals.add(n)));
      if (node.id) inner.locals.add(node.id.name);
    }
    if ((node.type === "VariableDeclaration") && (node.kind === "const" || node.kind === "let")) {
      collectNames(node.id || node).forEach((n) => scope.locals.add(n));
      (node.declarations || []).forEach((d) => collectNames(d.id).forEach((n) => scope.locals.add(n)));
    }
    /* 函数声明的函数名也进本层（function t(){} 会让本文件里的 t 不再是全局翻译函数） */
    if (node.type === "FunctionDeclaration" && node.id) scope.locals.add(node.id.name);
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "t") {
      const owner = scopeChain(inner).find((s) => s.locals.has("t"));
      if (owner && owner.kind !== "global") {
        hits.push("line " + lineOf(node.start) + "  t() 被 line " + owner.line + " 的局部 " + owner.kind + " 遮住  →  " +
          src.slice(node.start, Math.min(node.end, node.start + 64)).replace(/\s+/g, " "));
      }
    }
    for (const k in node) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((x) => walkScopes(x, inner));
      else if (v && typeof v === "object" && v.type) walkScopes(v, inner);
    }
  }
  function collectNames(pat, out) {
    out = out || [];
    if (!pat) return out;
    if (pat.type === "Identifier") out.push(pat.name);
    else if (pat.type === "ObjectPattern") pat.properties.forEach((p) => collectNames(p.value || p.left, out));
    else if (pat.type === "ArrayPattern") pat.elements.forEach((e) => collectNames(e, out));
    else if (pat.type === "AssignmentPattern") collectNames(pat.left, out);
    else if (pat.type === "RestElement") collectNames(pat.argument, out);
    else if (pat.type === "Property") collectNames(pat.value, out);
    return out;
  }
  walkScopes(ast, globalScope);
  if (hits.length) { console.log(rel + "  (" + hits.length + ")"); console.log("  " + hits.join("\n  ")); bad++; }
}
console.log(bad ? "FAIL " + bad + " 处遮蔽" : "OK 没有局部变量遮住全局 t()");
process.exit(bad ? 1 : 0);
