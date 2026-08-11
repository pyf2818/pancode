/* 验证「会话沉淀」后端：GET 读 → POST 规则 → POST 记忆 → GET 读回 */
const PORT = process.env.PANCODE_TEST_PORT || 8766;
const BASE = "http://127.0.0.1:" + PORT;
let pass = true;
const check = (n, c) => { console.log((c ? "PASS" : "FAIL") + " - " + n); if (!c) pass = false; };

(async () => {
  /* 注册临时用户拿 userToken（A2 认证升级后 bootstrap AUTH_TOKEN 不再用于业务 API） */
  let tok;
  try {
    const reg = await fetch(BASE + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "_verify_sediment_" + Date.now(), password: "test1234" }),
    }).then((x) => x.json());
    if (!reg || !reg.token) throw new Error("注册失败: " + (reg && reg.error || "unknown"));
    tok = reg.token;
  } catch (e) {
    console.error("FAIL: 无法注册测试用户访问服务（" + BASE + "）。本脚本需先启动服务（npm start）后运行。\n", e.message);
    process.exit(1);
  }
  const H = { "Content-Type": "application/json", authorization: "Bearer " + tok };
  const gt = () => fetch(BASE + "/api/sediment", { headers: { authorization: "Bearer " + tok } }).then((x) => x.json());
  const pt = (b) => fetch(BASE + "/api/sediment", { method: "POST", headers: H, body: JSON.stringify(b) }).then((x) => x.json());

  let r = await gt();
  check("GET /api/sediment 初始返回 ok", r.ok === true);

  // 沉淀为「项目规则」
  r = await pt({ target: "rule", title: "接口规范", content: "所有接口统一返回 {code,data,msg}；分页用 page/size。" });
  check("POST 规则返回 ok", r.ok === true && r.target === "rule");

  // 沉淀为「项目记忆」
  r = await pt({ target: "memory", title: "约定", content: "用户偏好用中文注释；禁止在控制器里写 SQL。" });
  check("POST 记忆返回 ok", r.ok === true && r.target === "memory");

  // 读回确认持久化
  r = await gt();
  const rulesHit = Array.isArray(r.rules) && r.rules.some((x) => x && x.content && x.content.includes("统一返回 {code,data,msg}"));
  const memHit = typeof r.memory === "string" && r.memory.includes("禁止在控制器里写 SQL");
  check("规则已写入 user-rules.md 并可读回", rulesHit);
  check("记忆已写入并可读回", memHit);

  // 空内容应被拒绝
  r = await pt({ target: "rule", content: "   " });
  check("空内容被拒绝", r.ok === false);

  console.log(pass ? "\nALL PASS" : "\nHAS FAIL");
  process.exit(pass ? 0 : 1);
})();
