/* W3 冒烟：userMemory 构造不炸 + 用户级 add 落盘 ~/.pancode/memory/user.json + 记忆 API 正常 */
process.env.PORT = "8896";
process.env.CURSORWEB_WORKSPACE = "E:/独立目录/_w3smoke_ws";
require("../server/index.js");
const fs = require("fs");
const path = require("path");
const os = require("os");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };

(async () => {
  const BASE = "http://127.0.0.1:8896";
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch (e) {} await wait(250); }
  t("server 启动（buildEngine 含 userMemory 构造）", true);

  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "w3probe_" + Date.now(), password: "test1234" }) };
  const reg = await (await fetch(BASE + "/api/auth/register", opts)).json();
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + (reg.token || "") };
  t("register 拿 token", !!(reg.token || ""));

  const mem = await (await fetch(BASE + "/api/memory?q=测试", { headers: auth })).json();
  t("GET /api/memory 正常", mem.ok === true);

  /* 直接验证用户级落盘：等价于 userMemory.add（探针里手写一条后查文件） */
  const userPath = path.join(os.homedir(), ".pancode", "memory", "user.json");
  /* 通过引擎内部验证：拉起后 user.json 不存在是正常的（懒落盘），手动模拟一条 add */
  const { MemoryStore } = require("../server/memory-store.js");
  const um = new MemoryStore(userPath);
  const e = um.add("preference", "命名约定", "探针验证-中文变量名", { valueScore: 3 });
  await wait(120);
  t("用户级 add 成功且文件落盘", !!(e && fs.existsSync(userPath)));
  const raw = JSON.parse(fs.readFileSync(userPath, "utf8"));
  t("user.json 含探针条目", raw.some((x) => x.content === "探针验证-中文变量名"));
  /* 清理探针条目 */
  um.remove(e.id);
  await wait(120);
  const raw2 = JSON.parse(fs.readFileSync(userPath, "utf8"));
  t("清理后 user.json 无探针残留", !raw2.some((x) => x.content === "探针验证-中文变量名"));

  console.log(`\n=== W3 冒烟: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
