/* 外部改盘之后该广播什么（server/sync-plan.js 的纯判据）。
   这一层的错误不会报错，只会静默留下界面上的幽灵文件，或者让 8 小时任务每改一次盘
   就全量重读 ≤500 个文件 —— 两边都必须钉住。 */
const { planSync } = require("../server/sync-plan");

const S = (...ps) => new Set(ps);

describe("planSync：集合没变才许增量", () => {
  it("改一个既有文件的内容 → 只读它那一个", () => {
    expect(planSync(["src/a.js"], S("src/a.js", "src/b.js"), S("src/a.js", "src/b.js")))
      .toEqual({ mode: "incremental", changed: ["src/a.js"] });
  });

  it("防抖窗口里改了好几个 → 增量带上这几个，不是一棵树的", () => {
    const r = planSync(["src/a.js", "src/b.js"], S("src/a.js", "src/b.js", "c.md"), S("src/a.js", "src/b.js", "c.md"));
    expect(r.mode).toBe("incremental");
    expect(r.changed.sort()).toEqual(["src/a.js", "src/b.js"]);
  });

  it("同一路径来两次（change + 属性事件）→ 只算一次", () => {
    expect(planSync(["a.js", "a.js"], S("a.js"), S("a.js")).changed).toEqual(["a.js"]);
  });

  it("新建文件 → 必须全量（增量分支不会把新文件补进前端的集合之外，集合基线也要重记）", () => {
    expect(planSync(["new.js"], S("a.js"), S("a.js", "new.js")).mode).toBe("full");
  });

  it("删除文件 → 必须全量：前端的增量只覆盖传入路径、不删消失的文件，漏一次就留幽灵文件", () => {
    expect(planSync(["a.js"], S("a.js", "b.js"), S("b.js")).mode).toBe("full");
  });

  it("改名（一进一出、总数没变）→ 也必须全量，光比 size 会看漏", () => {
    expect(planSync(["b.js"], S("a.js"), S("b.js")).mode).toBe("full");
  });

  it("fs.watch 只报了\"某个目录动了\"（空串）→ 说不清改了谁，走全量", () => {
    expect(planSync([""], S("a.js"), S("a.js")).mode).toBe("full");
    expect(planSync(["sub", ""], S("a.js"), S("a.js")).mode).toBe("full");
  });

  it("第一次（前端还没有集合基线）→ 全量", () => {
    expect(planSync(["a.js"], null, S("a.js")).mode).toBe("full");
  });

  it("动的文件根本没进过快照（>1MB、被忽略、软链）→ 什么都不广播", () => {
    expect(planSync(["huge.bin"], S("a.js"), S("a.js"))).toEqual({ mode: "none", changed: [] });
  });

  it("空批（没有事件）→ 保守走全量而不是 none，免得把\"没收到事件\"当成\"不用同步\"", () => {
    expect(planSync([], S("a.js"), S("a.js")).mode).toBe("full");
    expect(planSync(undefined, S("a.js"), S("a.js")).mode).toBe("full");
    expect(planSync([null, 3], S("a.js"), S("a.js")).mode).toBe("full");
  });

  it("传进来的不是 Set（别处误用数组）→ 退回全量，不抛错", () => {
    expect(planSync(["a.js"], ["a.js"], ["a.js"]).mode).toBe("full");
  });
});

/* 判据抽出来之后，还剩"调用点真的用了它"这一层 —— 上一轮 agentMaxMs 的教训：
   纯函数有单测、全绿，而主路径上一行都没接。这里用静态断言钉住接线。 */
describe("接线：watch 回调真的按批走判据，并喂语义索引", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  const files = fs.readFileSync(path.join(__dirname, "..", "server", "files.js"), "utf8");
  const body = src.slice(src.indexOf("async function syncAfterExternalChange"));
  const fn = body.slice(0, body.indexOf("\n}\n"));

  it("index.js 的同步函数里接了 planSync / 增量快照 / 语义索引", () => {
    expect(fn).toMatch(/planSync\(/);
    expect(fn).toMatch(/snapshotFilesIncremental\(plan\.changed\)/);
    expect(fn).toMatch(/codeIndex\.queueFileUpdate/);
    expect(fn).toMatch(/incremental:\s*true/);
  });

  it("files.js 把整批路径交给回调，而不是最后一个 rel", () => {
    expect(files).toMatch(/this\._pendingChanges\.add\(rel \|\| ""\)/);
    expect(files).toMatch(/onExternalChange\(batch\)/);
    expect(files).not.toMatch(/onExternalChange\(rel\)/);
  });

  it("hello 之后记下了\"前端手里那份集合\"（否则第一条外部改动永远全量）", () => {
    const hello = src.slice(src.indexOf("async function helloPayload"));
    expect(hello.slice(0, hello.indexOf("\n}\n"))).toMatch(/_syncedPaths = new Set\(Object\.keys\(fileMap\)\)/);
  });
});
