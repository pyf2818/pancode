/* 端到端验证：外部文件夹作为工作区后，新建文件 + 运行项目是否真实生效 */
"use strict";
const WebSocket = require("ws");
const fs = require("fs");

const PORT = process.env.PORT || 8768;
const EXT = "D:/claw-workpace/my-real-project";
const ws = new WebSocket("ws://127.0.0.1:" + PORT);
let phase = 0;
const termOut = [];

function fail(msg) { console.log("✗ FAIL: " + msg); process.exit(1); }

const timer = setTimeout(() => fail("超时"), 20000);

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "hello" && phase === 0) {
    phase = 1;
    if (!m.workspace.replace(/\\/g, "/").includes("my-real-project")) fail("工作区不对: " + m.workspace);
    console.log("✓ hello: 工作区 = " + m.workspace + "，加载 " + Object.keys(m.files).length + " 个文件");
    // 1) 新建文件
    ws.send(JSON.stringify({ type: "file.create", path: "created-by-ui.txt", content: "这是通过界面新建的文件" }));
  }
  if (m.type === "fs.sync" && phase === 1) {
    phase = 2;
    const onDisk = fs.existsSync(EXT + "/created-by-ui.txt");
    if (!onDisk) fail("新建文件没有落盘");
    console.log("✓ 新建文件已真实写入磁盘: " + EXT + "/created-by-ui.txt");
    // 2) 终端在该目录运行项目
    ws.send(JSON.stringify({ type: "term.exec", cmd: "node src/main.js && cd" }));
  }
  if (m.type === "term.line" && phase === 2) termOut.push(m.text);
  if (m.type === "term.exit" && phase === 2) {
    const all = termOut.join("\n");
    if (!all.includes("hello from my real project")) fail("运行项目输出不对: " + all);
    if (!all.replace(/\\/g, "/").includes("my-real-project")) fail("终端 cwd 不在外部目录: " + all);
    console.log("✓ 终端在外部目录真实运行: " + all.split("\n").join(" | "));
    clearTimeout(timer);
    console.log("\n全部通过：打开本地文件 ✓ 新建文件 ✓ 运行项目 ✓");
    process.exit(0);
  }
});
ws.on("error", (e) => fail(String(e)));
