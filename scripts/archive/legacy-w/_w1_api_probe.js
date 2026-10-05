/* W1 API 冒烟：skills/market 审计拒绝 → force 放行 → risk_level 落库 → 用户级 scope */
process.env.PORT = "8793";
process.env.CURSORWEB_WORKSPACE = "E:/独立目录/_w1smoke_ws";
process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e.message); });
require("../server/index.js");

const BASE = "http://127.0.0.1:8793";
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch (e) {}
    await wait(250);
  }
  /* 注册拿 token（鉴权中间件要求） */
  const reg = await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "w1probe", password: "w1probe123" }) });
  const regD = await reg.json();
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + (regD.token || regD.data?.token || "") };
  t("register 拿到 token", !!(regD.token || regD.data?.token));

  /* 预清理：删掉上轮残留（探针幂等化——name 匹配 api-* 的按真实 id 删） */
  const pre = await (await fetch(BASE + "/api/skills/all", { headers: auth })).json();
  for (const sk of (pre.skills || [])) {
    if (String(sk.name).startsWith("api-")) {
      await fetch(BASE + "/api/skills/market/" + sk.id, { method: "DELETE", headers: auth });
      console.log("  (pre-clean removed leftover: " + sk.name + ")");
    }
  }

  /* P0 skill 无 force → 403 + audit.findings */
  const p0 = await fetch(BASE + "/api/skills/market", { method: "POST", headers: auth, body: JSON.stringify({ name: "api-p0-test", description: "危险", body: 'require("child_process").exec("whoami")', category: "test" }) });
  const p0d = await p0.json();
  t("P0 无 force → HTTP 403", p0.status === 403);
  t("403 响应含 audit.level=P0 与 findings", !!(p0d.audit && p0d.audit.level === "P0" && p0d.audit.findings.length >= 1));

  /* force → 200 + risk_level=P0 */
  const f0 = await fetch(BASE + "/api/skills/market", { method: "POST", headers: auth, body: JSON.stringify({ name: "api-p0-test", description: "危险", body: 'require("child_process").exec("whoami")', category: "test", force: true }) });
  const f0d = await f0.json();
  t("P0 + force → HTTP 200", f0.status === 200);
  t("入库 skill.risk_level=P0", !!(f0d.skill && f0d.skill.risk_level === "P0"));

  /* P1 skill → 200 + risk_level=P1 */
  const p1 = await fetch(BASE + "/api/skills/market", { method: "POST", headers: auth, body: JSON.stringify({ name: "api-p1-test", description: "联网", body: "fetch(url)", category: "test" }) });
  const p1d = await p1.json();
  t("P1 → 200 且 risk_level=P1", p1.status === 200 && p1d.skill && p1d.skill.risk_level === "P1");

  /* 用户级 scope=user → id 前缀 user_ */
  const u1 = await fetch(BASE + "/api/skills/market", { method: "POST", headers: auth, body: JSON.stringify({ name: "api-user-test", description: "跨项目", body: "通用步骤", category: "test", scope: "user" }) });
  const u1d = await u1.json();
  t("scope=user → 200 且 id 带 user_ 前缀", u1.status === 200 && u1d.skill && String(u1d.skill.id).startsWith("user_"));
  const userMd = "E:/独立目录" && null; /* 用户级目录在 HOME，不在 workspace —— 验证 list 可见即可 */
  const all = await fetch(BASE + "/api/skills/all", { headers: auth });
  const allD = await all.json();
  const names = (allD.skills || []).map((s) => s.name);
  t("GET /api/skills/all 可见三个测试 skill", ["api-p0-test", "api-p1-test", "api-user-test"].every((n) => names.includes(n)));
  const uHit = (allD.skills || []).find((s) => s.name === "api-user-test");
  t("用户级 skill 带 risk_level 字段（P2）", !!(uHit && uHit.risk_level === "P2"));

  /* 清理：删测试 skills（用 add 返回的真实随机 id，name 不是 id） */
  for (const id of [f0d.skill.id, p1d.skill.id, u1d.skill.id]) {
    const dr = await fetch(BASE + "/api/skills/market/" + id, { method: "DELETE", headers: auth });
    const dj = await dr.json();
    t("DELETE " + id + " → ok=true", dj.ok === true);
  }
  const after = await (await fetch(BASE + "/api/skills/all", { headers: auth })).json();
  t("清理后三个测试 skill 均已移除", !((after.skills || []).some((s) => String(s.name).startsWith("api-"))));

  console.log(`\n=== W1 API 冒烟: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
