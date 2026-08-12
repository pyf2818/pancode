// Clean final verification for Plan Mode backend round-trip.
const path = require("path");
const fs = require("fs");
const cfgPath = path.join(__dirname, "..", "pancode.config.json");
const backup = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;

const PORT = 8841;
process.env.PORT = String(PORT);
process.env.NO_AUTH = "1"; // simplify auth for the test

const server = require("../server/index.js");

let USER_TOKEN = "";
function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["x-user-token"] = token;
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: urlPath, method, headers },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  await new Promise((r) => setTimeout(r, 1500)); // boot
  let ok = true;
  const fail = (m) => { ok = false; console.log("FAIL: " + m); };

  // register a fresh test user (whitelisted, no auth needed)
  const ts = Date.now();
  const reg = await req("POST", "/api/auth/register", { username: "pmtest" + ts, password: "pmtest123" });
  const rj = JSON.parse(reg.body);
  if (!(reg.status === 200 && rj.ok && rj.token)) { fail("register failed: " + reg.body); process.exit(1); }
  USER_TOKEN = rj.token;
  console.log("OK registered user, got token");

  // initial
  let g = await req("GET", "/api/agent-settings", null, USER_TOKEN);
  let j = JSON.parse(g.body);
  if (j.planMode !== false) fail("initial planMode should be false, got " + j.planMode);
  else console.log("OK initial planMode=false");

  // set true
  let p = await req("POST", "/api/agent-settings", { planMode: true }, USER_TOKEN);
  j = JSON.parse(p.body);
  if (!(p.status === 200 && j.ok && j.agent && j.agent.planMode === true)) fail("POST true failed: " + p.body);
  else console.log("OK POST planMode=true -> " + JSON.stringify(j.agent.planMode));

  // get true
  g = await req("GET", "/api/agent-settings", null, USER_TOKEN);
  j = JSON.parse(g.body);
  if (j.planMode !== true) fail("GET after set true should be true, got " + j.planMode);
  else console.log("OK GET planMode=true persisted");

  // set false
  p = await req("POST", "/api/agent-settings", { planMode: false }, USER_TOKEN);
  j = JSON.parse(p.body);
  if (!(p.status === 200 && j.ok && j.agent && j.agent.planMode === false)) fail("POST false failed: " + p.body);
  else console.log("OK POST planMode=false -> " + JSON.stringify(j.agent.planMode));

  console.log(ok ? "\nPLAN OK=true" : "\nPLAN OK=false");

  // restore config
  if (backup !== null) fs.writeFileSync(cfgPath, backup);
  else if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
  server.close ? server.close() : null;
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
