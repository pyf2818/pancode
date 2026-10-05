/* ============================================================
   CSS 自定义属性回归（#35：顶部项目切换下拉打开是一块透明的，看不清）

   根因不是配色，是拼写：`.ws-dropdown` / `#filePalette` / `#inlineEditBox`
   的 background 读的是 var(--bg-elev)，而这个 token 全仓库从来没定义过。
   CSS 遇到未定义的 var() 会静默丢掉「整条声明」——不报错、不降级、
   开发工具里也看不出来，结果面板变成一块透明玻璃，字压在页面上一片糊。
   同批扫出来的还有 --sans（真名 --ui）、--error（真名 --err）、
   --bg-hover（真名 --hover）共 6 个名字 20 处，全都一直在静默失效：
   认证页/选项卡丢 sans 字体、停止按钮 hover 没有红、悬浮态没有底色。

   这类 bug 读代码是看不出来的（名字看着挺合理），所以判据必须是机扫。
   反向断言：随便写一个 var(--never-defined) 进来，本文件必须变红。
   ============================================================ */
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const CSS = path.join(REPO, "public", "styles.css");
// vendor/ 里是 Monaco 自带的 --vscode-* 体系，与我们无关，不参与校验
const OWNED = [
  path.join(REPO, "public", "styles.css"),
  path.join(REPO, "public", "index.html"),
  ...fs.readdirSync(path.join(REPO, "public", "js"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(REPO, "public", "js", f)),
];

function definedTokens() {
  const css = fs.readFileSync(CSS, "utf8");
  return new Set([...css.matchAll(/--([A-Za-z0-9-]+)(?=\s*:)/g)].map((m) => m[1]));
}

function undefinedUsages() {
  const def = definedTokens();
  const out = [];
  for (const file of OWNED) {
    const text = fs.readFileSync(file, "utf8");
    [...text.matchAll(/var\(\s*--([A-Za-z0-9-]+)/g)].forEach((m) => {
      if (!def.has(m[1])) {
        const line = text.slice(0, m.index).split("\n").length;
        out.push(`${path.relative(REPO, file)}:${line} var(--${m[1]})`);
      }
    });
  }
  return out;
}

describe("styles.css 里 var(--x) 引用的 token 必须真的定义过", () => {
  it("扫到了足够多的定义（只扫出三两条说明正则坏了）", () => {
    expect(definedTokens().size).toBeGreaterThan(60);
  });

  it("自有资产（styles.css / index.html / js）没有未定义 token", () => {
    expect(undefinedUsages()).toEqual([]);
  });

  it("反向自证：临时插一个未定义 token，扫描必须抓到", () => {
    const p = path.join(REPO, "public", "styles.css");
    const orig = fs.readFileSync(p, "utf8");
    try {
      fs.writeFileSync(p, orig + "\n.__probe__{color:var(--this-token-does-not-exist)}\n");
      const hits = undefinedUsages().filter((h) => h.includes("--this-token-does-not-exist"));
      expect(hits.length).toBe(1);
      expect(hits[0]).toContain("styles.css");
    } finally {
      fs.writeFileSync(p, orig);
    }
  });

  it("浮层面三兄弟的底色确实有定义（就是这次坏掉的那三个）", () => {
    const css = fs.readFileSync(CSS, "utf8");
    for (const sel of [".ws-dropdown", "#filePalette", "#inlineEditBox"]) {
      const rule = css.split("\n").find((l) => l.startsWith(sel + "{"));
      expect(rule, sel + " 规则行没找到").toBeTruthy();
      expect(rule).toContain("var(--bg-elev)");
    }
    expect(definedTokens().has("bg-elev")).toBe(true);
  });
});

describe("层级值不许再散落魔法数", () => {
  it("z-index 不用 99999 这类一次性魔法数", () => {
    const bad = [];
    for (const file of OWNED) {
      const text = fs.readFileSync(file, "utf8");
      // 个位数的 z-index 是组件内部的相对叠放，合法；三位及以上必须走 --z-* token
      [...text.matchAll(/z-index:\s*(\d+)/g)].forEach((m) => {
        if (Number(m[1]) >= 100) bad.push(`${path.relative(REPO, file)}:${text.slice(0, m.index).split("\n").length} z-index:${m[1]}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
