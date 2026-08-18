/* ============================================================
   pancode 轻量 .env 加载器（零依赖）
   - loadDotEnv(): 启动时将项目根 .env 注入 process.env（已存在的 env 优先）
   - setEnvVar(key, value): 更新/追加 .env 某一行（用于 UI 持久化密钥，避免写入配置文件明文）
   注意：.env 已被 .gitignore 忽略，不会提交到仓库。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

// 数据根：打包态(__dirname 落在只读 app.asar)必须指向可写目录，由桌面端 main.js 注入 PANCODE_DATA_DIR(=userData)
const ROOT = process.env.PANCODE_DATA_DIR || path.join(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");

function loadDotEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const text = fs.readFileSync(ENV_PATH, "utf8");
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

function setEnvVar(key, value) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
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
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

module.exports = { loadDotEnv, setEnvVar, ENV_PATH };
