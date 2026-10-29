/* ============================================================
   pancode-cli · .env 加载器（零依赖，自包含版）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

function loadDotEnv(envPath) {
  const p = envPath || path.join(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function setEnvVar(key, value, envPath) {
  const p = envPath || path.join(process.cwd(), ".env");
  let lines = [];
  if (fs.existsSync(p)) {
    lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
  }
  const val = String(value);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq !== -1 && line.slice(0, eq).trim() === key) {
      lines[i] = key + "=" + val;
      found = true;
      break;
    }
  }
  if (!found) lines.push(key + "=" + val);
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
  if (val) process.env[key] = val; else delete process.env[key];
}

module.exports = { loadDotEnv, setEnvVar };
