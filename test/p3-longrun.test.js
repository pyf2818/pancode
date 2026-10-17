/* ============================================================
   长任务能不能跑住（8 小时那一档）的三条判据：
     · server/run-watchdog.js —— 停滞 + 墙钟兜底，判据抽出来才能不真等 6 分钟
     · electron/task-watch.js —— 托盘分组：卡住要批的排最前，点一条能回现场
     · server/agent-base.js  —— pushChanges 的增量缓存：以前每个改盘工具都对全部脏文件
                                逐个起 git 子进程，成本随任务时长线性涨到卡死
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { decideWatchdog, stallMsOf, wallMsOf, DEFAULT_STALL_MS, DEFAULT_WALL_MS } = require("../server/run-watchdog");
const { traySections, trayLine, fmtShort, TRAY_MAX_PER_GROUP } = require("../electron/task-watch");
const { AgentBase } = require("../server/agent-base");

const MIN = 60 * 1000;

describe("看门狗：跑得多久不是问题，停着不动才是", () => {
  it("默认是 6 分钟停滞 + 8 小时兜底（七八小时的长任务是设计目标）", () => {
    expect(stallMsOf({})).toBe(DEFAULT_STALL_MS);
    expect(wallMsOf({})).toBe(DEFAULT_WALL_MS);
    expect(DEFAULT_WALL_MS).toBeGreaterThanOrEqual(8 * 60 * MIN);
  });

  it("刚跑 31 分钟、一直在出进展 —— 旧写法会在这里掐死任务，新判据不许动", () => {
    const now = 1_000_000_000_000;
    const why = decideWatchdog({ now, startedAt: now - 31 * MIN, lastProgress: now - 1000, cfg: {} });
    expect(why).toBe(null);
  });

  it("连续 7 分钟毫无进展 → 中断，并且说清停了多久", () => {
    const now = 1_000_000_000_000;
    const why = decideWatchdog({ now, startedAt: now - 20 * MIN, lastProgress: now - 7 * MIN, cfg: {} });
    expect(why).toMatch(/连续 7 分钟没有任何进展/);
  });

  it("工具刚跑完也算进展（哪怕循环自己没打点）", () => {
    const now = 1_000_000_000_000;
    expect(decideWatchdog({ now, startedAt: now - MIN, lastProgress: now - 7 * MIN, lastToolAt: now - 5000, cfg: {} })).toBe(null);
  });

  it("墙钟到点仍然中断（防真失控的死循环一直烧钱）", () => {
    const now = 1_000_000_000_000;
    const why = decideWatchdog({ now, startedAt: now - DEFAULT_WALL_MS - 1000, lastProgress: now - 1000, cfg: {} });
    expect(why).toMatch(/最长运行时长 8 小时/);
  });

  it("非法/过小的配置值退回下限，不是一刀切 0 分钟", () => {
    expect(stallMsOf({ agentStallMs: 10 })).toBe(60000);
    expect(wallMsOf({ agentMaxMs: "abc" })).toBe(DEFAULT_WALL_MS);
    expect(stallMsOf({ agentStallMs: 10 * MIN })).toBe(10 * MIN);
  });
});

const row = (x) => Object.assign({ convId: "c", title: "", status: "running", origin: "chat", startedAt: Date.now() - 90000, lastEventAt: Date.now(), endedAt: 0, tools: 0, waitingFor: "", error: "" }, x);

describe("托盘分组：等你动手的排最前", () => {
  it("四类都有内容时，顺序是 等你批 → 在跑 → 上次没跑完 → 最近收口", () => {
    const secs = traySections([
      row({ convId: "a", status: "done" }), row({ convId: "b", status: "running" }),
      row({ convId: "c", status: "waiting", waitingFor: "rm -rf build" }), row({ convId: "d", status: "interrupted" }),
    ]);
    expect(secs.map((s) => s.key)).toEqual(["waiting", "running", "unfinished", "settled"]);
    expect(secs[0].title).toBe("等你批 1");
  });

  it("waiting 那条把要批什么写在菜单上，点它 = 回那条会话", () => {
    const secs = traySections([row({ convId: "zz", title: "删除 build 目录", status: "waiting", waitingFor: "rm -rf build" })]);
    expect(secs[0].items[0].label).toContain("等你批：rm -rf build");
    expect(secs[0].items[0].convId).toBe("zz");
  });

  it("failed 要带原因；自动化要标出来", () => {
    const secs = traySections([
      row({ convId: "f", title: "跑测试", status: "failed", error: "3 个用例仍失败", endedAt: Date.now() }),
      row({ convId: "g", title: "每日回归", status: "queued", origin: "automation" }),
    ]);
    const flat = secs.flatMap((s) => s.items.map((i) => i.label));
    expect(flat.join("|")).toContain("出错：3 个用例仍失败");
    expect(flat.join("|")).toContain("自动化");
  });

  it("每组封顶若干条，多出来的合并成一行而不是把菜单撑爆", () => {
    const many = [];
    for (let i = 0; i < TRAY_MAX_PER_GROUP + 4; i++) many.push(row({ convId: "r" + i, title: "任务 " + i, status: "running" }));
    const secs = traySections(many);
    expect(secs[0].items.length).toBe(TRAY_MAX_PER_GROUP + 1);
    expect(secs[0].items[secs[0].items.length - 1].disabled).toBe(true);
    expect(secs[0].items[secs[0].items.length - 1].label).toContain("还有 4 条");
  });

  it("空表就是空分组（菜单只剩状态行与固定项），不造出假任务", () => {
    expect(traySections([])).toEqual([]);
    expect(traySections(null)).toEqual([]);
  });

  it("耗时格式：秒 / 分秒 / 小时都排得下", () => {
    expect(fmtShort(9000)).toBe("9s");
    expect(fmtShort(134000)).toBe("2m14s");
    expect(fmtShort(3720000)).toBe("1h02m");
    expect(fmtShort(0)).toBe("0s");
  });

  it("标题里的换行会被压掉（菜单项不许换行，会把整块菜单撑歪）", () => {
    expect(trayLine(row({ title: "第一行\n第二行" }))).not.toMatch(/\n/);
  });
});

describe("pushChanges 增量缓存：脏文件越多，越不该每次都全量重算", () => {
  let root, base, calls, list;
  function mk() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-push-"));
    base = {}; calls = {}; list = [];
    for (const p of ["src/a.js", "src/b.js", "src/c.js"]) {
      const abs = path.join(root, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "line1\nline2\n", "utf8");
      base[p] = "line1\n";
    }
  }
  const engine = () => {
    const events = [];
    const a = new AgentBase({
      emit: (e) => events.push(e),
      files: { safePath: (rel) => path.join(root, rel), read: (rel) => fs.readFileSync(path.join(root, rel), "utf8") },
      git: {
        changes: async () => list.slice(),
        baseline: async (rel) => { calls[rel] = (calls[rel] || 0) + 1; return base[rel]; },
      },
      term: null, roots: null,
    });
    a._currentConv = "c1";
    return { a, events };
  };
  const dirty = (...ps) => { list = ps.map((p) => ({ path: p, status: "M" })); };

  beforeEach(mk);
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

  it("第一次每个脏文件各取一次基线，第二次一个都不重取（这就是省下来的时间）", async () => {
    dirty("src/a.js", "src/b.js", "src/c.js");
    const { a, events } = engine();
    const first = await a.pushChanges(false);
    expect(Object.keys(calls).sort().join(",")).toBe("src/a.js,src/b.js,src/c.js");
    calls = {};
    const second = await a.pushChanges(false);
    expect(calls).toEqual({});
    expect(second.length).toBe(3);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));   // 结果逐字相同，只是没再起子进程
    expect(events[events.length - 1].type).toBe("changes");
  });

  it("文件真的变了 → 那一个重算，其余仍走缓存", async () => {
    dirty("src/a.js", "src/b.js");
    const { a } = engine();
    await a.pushChanges(false);
    calls = {};
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(root, "src/b.js"), "line1\nline2\nline3-new\n", "utf8");
    const list2 = await a.pushChanges(false);
    expect(Object.keys(calls)).toEqual(["src/b.js"]);
    const b = list2.find((x) => x.path === "src/b.js");
    expect(b.add).toBe(2);   // 基线只有 line1，现在多了 line2 和 line3-new
    expect(b.del).toBe(0);
    const a2 = list2.find((x) => x.path === "src/a.js");
    expect(a2.add).toBe(1);  // 没被碰过的那条走缓存，结果与第一次逐字相同
  });

  it("hintPaths 强制重算（刚写过的文件 mtime 撞上缓存戳也不能被跳过）", async () => {
    dirty("src/a.js");
    const { a } = engine();
    await a.pushChanges(false);
    calls = {};
    await a.pushChanges(false, ["src/a.js"]);
    expect(calls["src/a.js"]).toBe(1);
  });

  it("脏文件变少（外部 commit 了）时缓存条目一起掉，不留下已经不改的文件", async () => {
    dirty("src/a.js", "src/b.js", "src/c.js");
    const { a } = engine();
    await a.pushChanges(false);
    dirty("src/a.js");
    const list2 = await a.pushChanges(false);
    expect(list2.map((x) => x.path)).toEqual(["src/a.js"]);
  });

  it("读不到的文件不炸整张表，只少那一条", async () => {
    dirty("src/a.js", "src/gone.js");
    base["src/gone.js"] = null;
    const { a } = engine();
    const list2 = await a.pushChanges(false);
    expect(list2.map((x) => x.path)).toEqual(["src/a.js"]);
  });
});

describe("托盘跳会话这条链：三处字面量必须一模一样", () => {
  /* 主进程 send("pc-open-conv") / preload 监听同一个串 / app.js 只认 onOpenConv ——
     三处任意一处改名，运行期一声不响：菜单照样能点、窗口照样唤回，就是停在原会话。
     桌面探针（_verify_desktop.js）验到"主进程发出去了"，浏览器探针（_verify_trayjump.js）验
     "真页面收到后跳得对"，中间那道 IPC 的串只能在这里钉住。 */
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const main = read("electron/main.js");
  const preload = read("electron/preload.js");
  const app = read("public/app.js");

  it("主进程 send 的通道名与 preload 监听的通道名一致", () => {
    const sent = main.match(/send\("(pc-[a-z-]+)",\s*convId\)/);
    expect(sent).not.toBeNull();
    expect(preload).toContain('ipcRenderer.on("' + sent[1] + '"');
  });

  it("preload 把这条通道包成 onOpenConv，app.js 注册的正是这个名字", () => {
    expect(preload).toMatch(/onOpenConv:\s*\(fn\)/);
    expect(app).toMatch(/window\.pancodeWin\.onOpenConv\(/);
  });

  it("渲染端不许把 openConv 的失败悄悄吞掉（吞了就等于探针白测）", () => {
    const handler = app.slice(app.indexOf("window.pancodeWin.onOpenConv("));
    const body = handler.slice(0, handler.indexOf("\n}"));
    expect(body).toMatch(/console\.warn\("\[ui\] 托盘跳会话失败/);
  });

  it("探针脚本挂进了回归链（新加的验收层不挂进去等于没有）", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["test:verify"]).toContain("_verify_trayjump.js");
    expect(pkg.scripts["verify:all"]).toContain("_verify_desktop.js");
  });
});
