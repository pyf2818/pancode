/* 验证静态资源完整性（Monaco 本地 vendor + index.html 不引用 CDN）。
   服务未运行时优雅失败（exit 1），供 CI 使用。 */
const http = require("http");
const urls = [
  "/vendor/monaco/vs/loader.js",
  "/vendor/monaco/worker.js",
  "/vendor/monaco/vs/base/worker/workerMain.js",
  "/vendor/monaco/vs/editor/editor.main.js",
  "/index.html",
];
let i = 0, fail = 0;
function next() {
  if (i >= urls.length) {
    if (fail) { console.error("FAIL: " + fail + " 个静态资源异常"); process.exit(1); }
    console.log("ALL PASS: 静态资源完整，无 CDN 依赖");
    process.exit(0);
    return;
  }
  const u = urls[i++];
  http
    .get({ host: "127.0.0.1", port: Number(process.env.PANCODE_TEST_PORT || 8766), path: u }, (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        console.log(u, "=>", r.statusCode, "| ct:", r.headers["content-type"], "| bytes:", buf.length);
        if (r.statusCode !== 200) { fail++; }
        else if (u === "/index.html") {
          if (/cdn\.jsdelivr|unpkg\.com|cdnjs/.test(buf)) { console.log("  !! index 引用了 CDN（应本地）"); fail++; }
          else console.log("  index references CDN? NO (good, local)");
        }
        else if (u === "/vendor/monaco/worker.js") {
          if (!/importScripts\(['"]\/vendor\/monaco/.test(buf)) { console.log("  !! worker.js 引用路径异常"); fail++; }
          else console.log("  worker.js ok? yes");
        }
        next();
      });
    })
    .on("error", (e) => {
      console.log(u, "ERR", e.message, "（服务未运行？本脚本需先 npm start）");
      fail++;
      next();
    });
}
next();
