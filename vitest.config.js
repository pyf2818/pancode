import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    globals: true,
    /* 串行跑文件。这不是审美问题，是实测：这台 Windows 上默认并行 5 个 worker 时
       同一份代码 35 文件里红 10 个（13 条），改成串行 651 通过 / 1 跳过 / 0 失败。
       红的那些全是"真起 git 子进程"或"等异步落盘"那一类——worker 抢 CPU 时
       子进程要 5s+、saveJson 队列排到几秒之后，判据就按超时/时间戳先后误判。
       一个会随机红的大门禁等于没有门禁，宁可慢一点。 */
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});