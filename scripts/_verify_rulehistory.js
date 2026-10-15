/* ============================================================
   P1-B5 回归：规则版本化（写前快照 / 列表 / diff / 回滚）
   全程起一个真服务（独立数据根 + 独立工作区 + 独立端口），断言都走 HTTP，
   不去读磁盘——一是 server 的落盘是排队异步的，读盘会和刚写的响应赛跑；
   二是"面板看到的就是盘上的"这件事本身也该由接口来证。

   三条最值钱的断言：
     1) 历史目录绝不能被规则加载器扫到（混进去等于把旧规则也注入模型上下文）；
     2) 删除规则后仍能从历史恢复出文件本体（"删了"不该是不可逆的）；
     3) 回滚这一步自己也要留版（否则误滚一次就回不去了）。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "rulehist",
  wsFiles: { "README.md": "# 规则版本化探针工作区\n", "src/a.js": "console.log(1)\n", "docs/b.md": "#b\n" },
});

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.RULEHIST_PORT || 8823);
let TOKEN = "";

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  " + detail : "")); }
  else { fail++; fails.push(name); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? "  " + detail : "")); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (TOKEN) headers["x-user-token"] = TOKEN;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 20000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf.slice(0, 200) }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}

function boot() {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")],
    { cwd: path.join(__dirname, ".."), env: SANDBOX.env({ PORT: String(PORT) }), stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  child.stdout.on("data", (d) => { tail += d.toString(); if (tail.length > 8000) tail = tail.slice(-8000); });
  child.stderr.on("data", (d) => { tail += d.toString(); if (tail.length > 8000) tail = tail.slice(-8000); });
  return { child, tail: () => tail };
}
async function untilUp(b) {
  for (let i = 0; i < 80; i++) {
    try { const r = await req("GET", "/api/health"); if (r.json && r.json.ok) return true; } catch (e) {}
    await wait(250);
  }
  return false;
}

(async () => {
  console.log("[P1-B5] 规则版本化验证（真服务 + 真接口）");
  const b = boot();
  if (!(await untilUp(b))) { b.child.kill(); console.error(b.tail()); throw new Error("服务未就绪"); }

  const reg = await req("POST", "/api/auth/register", { username: "rulehist", password: "rh-pass-1" });
  TOKEN = (reg.json && reg.json.token) || "";
  ok("正向对照：沙箱里能建账号并拿到 token", !!TOKEN, JSON.stringify(reg.json).slice(0, 60));

  const RULE = ".pancode/rules/测试规则.md";
  const V1 = "所有新增文件都必须带注释头。";
  const V2 = "所有新增文件都必须带注释头，且禁止使用 var。";
  const V3 = "所有新文件必须带注释头；禁止 var；导出函数要有类型。";

  /* ---------- 1. 新建不留版（没有"旧内容"可留） ---------- */
  let r = await req("POST", "/api/rules", { title: "测试规则", content: V1 });
  ok("新建规则成功", r.json.ok === true && r.json.file === RULE, r.json.file || JSON.stringify(r.json));
  let h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  ok("新建时历史为空（不是造一条假版本凑数）", h.json.ok === true && (h.json.versions || []).length === 0, "版本 " + (h.json.versions || []).length);

  /* ---------- 2. 改一次留一版，内容是改之前那份 ---------- */
  r = await req("PUT", "/api/rules", { file: RULE, content: V2 });
  ok("更新规则成功", r.json.ok === true, JSON.stringify(r.json).slice(0, 60));
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  let vs = h.json.versions || [];
  ok("更新后留下 1 版历史", vs.length === 1, JSON.stringify(vs.map((v) => v.op)));
  ok("这一版标着 update（改前快照）", vs[0] && vs[0].op === "update");
  let d = await req("GET", "/api/rules/diff?file=" + encodeURIComponent(RULE) + "&ts=" + (vs[0] ? vs[0].ts : 0));
  ok("diff 能看出这一版与当前版的差别", d.json.ok === true && d.json.lines.some((l) => l.t === "-" ) && d.json.lines.some((l) => l.t === "+"),
    JSON.stringify((d.json.lines || []).slice(0, 3)));

  /* ---------- 3. toggle 也留版（frontmatter 变了也是规则变了） ---------- */
  r = await req("POST", "/api/rules/toggle", { file: RULE, enabled: false });
  ok("停用规则成功", r.json.ok === true && r.json.enabled === false);
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  vs = h.json.versions || [];
  ok("停用后累积到 2 版，最新一版标 toggle", vs.length === 2 && vs[0].op === "toggle", JSON.stringify(vs.map((v) => v.op)));
  ok("版本按时间倒序（最新在最前，面板直接画）", vs[0].ts >= vs[1].ts);

  /* ---------- 4. 关键：历史没混进规则清单 ---------- */
  const listed = await req("GET", "/api/rules");
  const names = (listed.json.rules || []).map((x) => x.file);
  ok("规则清单里只有那一条，历史文件没被当成规则注入", names.filter((f) => f.indexOf("测试规则") >= 0).length === 1,
    names.filter((f) => /测试规则|history/.test(f)).join(","));
  ok("清单里没有任何 rules-history 路径", !names.some((f) => /rules-history/.test(f)));

  /* ---------- 5. 删除后还能从历史恢复 ---------- */
  const tsBeforeDelete = (h.json.versions || [])[1].ts;
  r = await req("DELETE", "/api/rules", { file: RULE });
  ok("删除规则成功", r.json.ok === true);
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  vs = h.json.versions || [];
  ok("删除前也留了版（标 delete）", vs[0] && vs[0].op === "delete", JSON.stringify(vs.map((v) => v.op)));
  r = await req("POST", "/api/rules/restore", { file: RULE, ts: vs[0].ts });
  ok("从「删除前那一版」恢复出文件", r.json.ok === true, JSON.stringify(r.json).slice(0, 70));
  let content = await req("GET", "/api/rules/content?file=" + encodeURIComponent(RULE));
  ok("恢复回来的正文与删除前一致", content.json.ok === true && String(content.json.body || "").indexOf(V2) >= 0,
    String(content.json.body || "").slice(0, 40));
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  ok("恢复一个「已被删除」的规则时不造 pre-restore 空版（没东西可保，不硬凑一行）",
    !(h.json.versions || []).some((v) => v.op === "pre-restore"), JSON.stringify((h.json.versions || []).map((v) => v.op)));

  /* ---------- 6. 回滚到指定旧版 ---------- */
  r = await req("PUT", "/api/rules", { file: RULE, content: V3 });
  ok("再改一次成功", r.json.ok === true);
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  vs = h.json.versions || [];
  const v3Snap = vs.find((v) => v.op === "update");      // 这次改动前那份 = V2
  r = await req("POST", "/api/rules/restore", { file: RULE, ts: v3Snap.ts });
  content = await req("GET", "/api/rules/content?file=" + encodeURIComponent(RULE));
  ok("回滚到指定版本后正文确实是那一版", r.json.ok === true && String(content.json.body || "").indexOf(V2) >= 0,
    String(content.json.body || "").slice(0, 46));
  ok("回滚用的是当时那一版的 ts（不是「最新一版」顺手代填）", tsBeforeDelete !== v3Snap.ts);
  /* 真正的"回滚也要留版"发生在覆盖一份存在的文件时：用户手滑滚错了，
     还得能再滚回来——所以回滚前的那份当前内容必须先存档。 */
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  ok("关键：覆盖式回滚会先把当前那份存成 pre-restore（误滚一次还能滚回去）",
    (h.json.versions || []).some((v) => v.op === "pre-restore"), JSON.stringify((h.json.versions || []).map((v) => v.op).slice(0, 4)));
  const backAgain = (h.json.versions || []).find((v) => v.op === "pre-restore");
  r = await req("POST", "/api/rules/restore", { file: RULE, ts: backAgain.ts });
  content = await req("GET", "/api/rules/content?file=" + encodeURIComponent(RULE));
  ok("再滚一次能回到回滚前那一版（V3）", r.json.ok === true && String(content.json.body || "").indexOf(V3) >= 0,
    String(content.json.body || "").slice(0, 46));

  /* ---------- 7. 版本数被按住（防目录无限长） ---------- */
  const keep = h.json.keep || 20;
  for (let i = 0; i < keep + 4; i++) await req("PUT", "/api/rules", { file: RULE, content: V1 + " 第 " + i + " 次改动。" });
  h = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  ok("连改 " + (keep + 4) + " 次后版本数封顶在 " + keep, (h.json.versions || []).length === keep, "实际 " + (h.json.versions || []).length);
  /* 封顶数够还不够：同毫秒的两次改动曾经撞同一个文件名，后一份把前一份顶掉，
     于是列表里莫名其妙少一版。时间戳去重后仍等于 keep 才说明没丢。 */
  const tss = new Set((h.json.versions || []).map((v) => v.ts));
  ok("保留的版本时间戳互不相同（同毫秒连改没有互相顶掉）", tss.size === keep, "去重后 " + tss.size);

  /* ---------- 8. 非法规则路径不写历史也不写盘 ---------- */
  for (const bad of ["../etc/passwd", ".pancode/rules/../../x.md", ".cursor/rules/a.mdc", "AGENTS.md"]) {
    const rr = await req("PUT", "/api/rules", { file: bad, content: "x" });
    ok("写入被拒：" + bad, rr.json.ok === false, JSON.stringify(rr.json).slice(0, 50));
  }
  const anyHist = await req("GET", "/api/rules/history?file=" + encodeURIComponent("../../etc/passwd"));
  ok("历史接口也不接受越界路径", anyHist.json.ok === false || (anyHist.json.versions || []).length === 0, JSON.stringify(anyHist.json).slice(0, 60));

  /* ---------- 9. 未鉴权读不到历史（花销之外的另一份隐私：团队规则内容） ---------- */
  TOKEN = "";
  const anon = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RULE));
  ok("匿名读历史被拒（401）", anon.status === 401, "status " + anon.status);

  b.child.kill();
  console.log("\n[P1-B5] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
