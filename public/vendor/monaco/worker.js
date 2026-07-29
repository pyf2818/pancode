// 本地 Monaco Web Worker 引导文件（同源 / 无需 CDN / 无跨域 CORS 问题）
// Monaco 通过 MonacoEnvironment.getWorkerUrl 拿到本文件 URL 后，会以 classic worker 方式加载它，
// 本文件再 importScripts 真正的 workerMain，并由它按 baseUrl 解析各语言 worker（ts/json/css/html…）。
self.MonacoEnvironment = {
  baseUrl: "/vendor/monaco/",
};
importScripts("/vendor/monaco/vs/base/worker/workerMain.js");
