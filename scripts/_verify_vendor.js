const http = require("http");
const urls = [
  "/vendor/monaco/vs/loader.js",
  "/vendor/monaco/worker.js",
  "/vendor/monaco/vs/base/worker/workerMain.js",
  "/vendor/monaco/vs/editor/editor.main.js",
  "/index.html",
];
let i = 0;
function next() {
  if (i >= urls.length) return;
  const u = urls[i++];
  http
    .get({ host: "127.0.0.1", port: 8766, path: u }, (r) => {
      let buf = "";
      r.on("data", (c) => (buf += c));
      r.on("end", () => {
        console.log(u, "=>", r.statusCode, "| ct:", r.headers["content-type"], "| bytes:", buf.length);
        if (u === "/index.html") {
          console.log("  index references CDN?", /cdn\.jsdelivr/.test(buf) ? "YES (BAD)" : "NO (good, local)");
        }
        if (u === "/vendor/monaco/worker.js") {
          console.log("  worker.js ok?", /importScripts\('\/vendor\/monaco/.test(buf) ? "yes" : "NO");
        }
        next();
      });
    })
    .on("error", (e) => {
      console.log(u, "ERR", e.message);
      next();
    });
}
next();
