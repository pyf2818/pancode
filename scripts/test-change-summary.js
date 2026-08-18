/* change-summary 纯函数单测：node scripts/test-change-summary.js */
"use strict";
const assert = require("assert");
const { classify, summarize, docDraft } = require("../server/change-summary");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } }

/* ---- classify ---- */
ok("src: server/git.js", classify("server/git.js") === "src");
ok("src: public/app.tsx", classify("public/app.tsx") === "src");
ok("src: a/b.vue", classify("a/b.vue") === "src");
ok("test: tests/foo.test.js", classify("tests/foo.test.js") === "test");
ok("test: src/x_spec.ts", classify("src/x_spec.ts") === "test");
ok("test: __tests__/a.js", classify("__tests__/a.js") === "test");
ok("doc: docs/arch.md", classify("docs/arch.md") === "doc");
ok("doc: README.md", classify("README.md") === "doc");
ok("doc: CHANGELOG", classify("CHANGELOG") === "doc");
ok("config: package.json", classify("package.json") === "config");
ok("config: .github/workflow/ci.yml", classify(".github/workflow/ci.yml") === "config");
ok("config: tsconfig.json", classify("tsconfig.json") === "config");
ok("config: .env", classify(".env") === "config");
ok("other: logo.png", classify("logo.png") === "other");
ok("other: data.csv", classify("data.csv") === "other");

/* ---- summarize ---- */
const changes = [
  { path: "server/git.js", status: "M" },
  { path: "server/change-summary.js", status: "A" },
  { path: "tests/git.test.js", status: "A" },
  { path: "docs/guide.md", status: "M" },
  { path: "package.json", status: "M" },
  { path: "old.js", status: "D" },
];
const s = summarize(changes);
ok("total = 6", s.total === 6);
ok("stat.A = 2", s.stat.A === 2);
ok("stat.M = 3", s.stat.M === 3);
ok("stat.D = 1", s.stat.D === 1);
ok("groups.src len 3", s.groups.src.length === 3);
ok("groups.test len 1", s.groups.test.length === 1);
ok("groups.doc len 1", s.groups.doc.length === 1);
ok("groups.config len 1", s.groups.config.length === 1);
ok("groups.other len 0", s.groups.other.length === 0);
ok("overview is string", typeof s.overview === "string" && s.overview.length > 0);
ok("suggestions is array", Array.isArray(s.suggestions) && s.suggestions.length > 0);
ok("changelog has 源码(3)", s.changelog.includes("源码（3）"));
ok("changelog has [新增] tag", s.changelog.includes("[新增]"));
ok("changelog has [删除] tag", s.changelog.includes("[删除]"));
ok("suggestion mentions 删除", s.suggestions.some((t) => t.includes("删除")));
ok("suggestion mentions 测试", s.suggestions.some((t) => t.includes("测试")));

/* ---- commitMsg ---- */
ok("commitMsg exists", typeof s.commitMsg === "string" && s.commitMsg.length > 0);
ok("commitMsg has 源码（3）", s.commitMsg.includes("源码（3）"));
ok("commitMsg has [新增]", s.commitMsg.includes("[新增]"));
ok("commitMsg no draft header", !s.commitMsg.includes("草稿 · 由 pancode"));

/* ---- docDraft ---- */
const d = docDraft(changes);
ok("docDraft has 🆕", d.includes("🆕"));
ok("docDraft has 🗑️", d.includes("🗑️"));
ok("docDraft has 新增", d.includes("新增"));
ok("docDraft has 移除", d.includes("移除"));
ok("docDraft lists new module", d.includes("server/change-summary.js"));

/* ---- empty ---- */
const e = summarize([]);
ok("empty total 0", e.total === 0);
ok("empty suggestions placeholder", e.suggestions[0].includes("暂无"));
ok("empty changelog", e.changelog.includes("共 0 个文件"));

console.log("\nchange-summary 单测：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
