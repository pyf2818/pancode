/* ============================================================
   pancode-cli · 配置模块加载器
   自动检测模式：有 ../server/config.js → 完整模式；否则 → 自包含模式
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const HAS_SERVER = fs.existsSync(path.join(__dirname, "..", "server", "config.js"));

let configMod;
if (HAS_SERVER) {
  configMod = require("../server/config");
} else {
  configMod = require("./lib/config");
}

module.exports = configMod;
module.exports.HAS_SERVER = HAS_SERVER;
