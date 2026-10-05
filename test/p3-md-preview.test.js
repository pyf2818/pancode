/* ============================================================
   预览面板的 Markdown 渲染器回归（#42：点「预览」右侧整块白、界面点不动）

   根因不是"内容没渲染出来"，是渲染函数**出不来**：段落分支用 while 收集行，
   停止条件却比上面的分支表宽——`#标题`（井号后没空格）、`#`、`##没有空格`、
   `-- 不是分隔线` 这些行既没被任何块级分支接住，也不被段落吃掉，
   于是 i 永远不前进 → 死循环 → srcdoc 根本没机会赋值，
   而它跑在渲染进程主线程上，所以顺带把整个界面钉死。
   用户报的现象（预览按钮是激活的、面板一片白）就是这么来的。

   判据分两层：
   1. 终止性：每个用例单独开一个子进程 + 4s 看门狗。放在同进程里跑不行——
      一次死循环就把测试进程一起带走，既拿不到"是哪个用例"也拿不到汇总。
   2. 结构：GFM 表格要真出 <table>（旧版把 | a | b | 当段落原样吐出来，
      用户那份带「API 摘要」表格的 README 看着就像"没显示内容"）。

   负控已实测：拿 HEAD 那份跑同一批用例，6 个挂死（井号后无空格、二级井号无空格、
   两个短横、井号独占一行、井号七个、混合垃圾），表格两例只出 44/52 字节的段落。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const APP = path.join(REPO, "public", "app.js");

/* 渲染器是一整块（正则常量 + 三个小工具 + 主函数）。只切主函数体的话那些常量成了未定义，
   所有用例一起抛错——看着像"全坏"，其实是抽取错。 */
function extractRenderer() {
  const src = fs.readFileSync(APP, "utf8");
  const head = src.indexOf("/* 预览用的 Markdown 渲染器");
  const from = head >= 0 ? head : src.indexOf("function renderMarkdown(src) {");
  const body = src.indexOf("function renderMarkdown(src) {", from);
  const code = src.slice(from, src.indexOf("\n}\n", body) + 3);
  if (from < 0 || !/return out\.join/.test(code)) {
    throw new Error("抽取失败：public/app.js 里预览渲染器那块的结构变了，判据要跟着改");
  }
  return code;
}

const CASES = {
  "正常标题+段落": "# 标题\n\n正文一段。\n",
  "井号后无空格": "# 标题\n\n#没有空格的标题\n\n正文\n",
  "二级井号无空格": "##没有空格\n\n正文\n",
  "井号独占一行": "#\n正文\n",
  "井号七个": "####### 七级不存在\n",
  "两个短横": "-- 不是分隔线\n",
  "三短横": "---\n正文\n",
  "引用后无空格": ">引用没有空格\n\n正文\n",
  "表格": "| 方法 | 路径 | 说明 |\n| --- | --- | --- |\n| GET | /todos | 列表 |\n",
  "对齐表格": "| a | b |\n|:---|---:|\n| 1 | 2 |\n",
  "表格后接段落": "| a | b |\n| - | - |\n| 1 | 2 |\n\n段落\n",
  "代码块": "```bash\nnpm i\n```\n正文\n",
  "未闭合代码块": "```bash\nnpm i\n后面全没了\n",
  "任务列表": "- [x] 完成\n- [ ] 待办\n",
  "有序列表": "1. 一\n2. 二\n",
  "星号列表无空格": "*列表项\n\n正文\n",
  "setext": "标题\n---\n正文\n",
  "行首井号在句中": "见 #1 号问题\n",
  "混合垃圾": "#\n--\n|\n* \n1.\n>\n```\n#\n--\n",
  "空输入": "",
  "只有换行": "\n\n\n",
  "CRLF": "# 标题\r\n\r\n正文\r\n",
  "长段落": "行一\n行二\n行三\n\n结束\n",
  "图片": "![alt](./a.png)\n\n正文\n",
  "链接": "详情见 [README](https://example.com/r)。\n",
};

const code = extractRenderer();

/* 一个用例一个子进程：死循环会把跑它的那个进程一起带走，
   分开跑才能既判"挂没挂"，又不影响后面用例的判定。 */
function runOne(input) {
  const r = spawnSync(process.execPath, ["-e",
    "const c=" + JSON.stringify(code) + ";" +
    "const f=new Function(c+'\\nreturn renderMarkdown;')();" +
    "process.stdout.write(f(" + JSON.stringify(input) + "));",
  ], { timeout: 4000, encoding: "utf8" });
  if (r.error && /ETIMEDOUT|MAXBUFFER/.test(String(r.error.code || r.error))) return { hung: true };
  if (r.status !== 0) return { err: (r.stderr || "").split("\n")[0], html: "" };
  return { html: r.stdout || "" };
}

describe("预览 Markdown 渲染器：任何输入都必须返回", () => {
  test.each(Object.entries(CASES))("%s 不死循环、不抛错", (_name, md) => {
    const r = runOne(md);
    expect(r.hung).toBeFalsy();
    expect(r.err).toBeUndefined();
  });
});

describe("预览 Markdown 渲染器：块级语义", () => {
  const html = (md) => runOne(md).html;

  test("井号后没空格按 CommonMark 当普通文本，不猜它是标题", () => {
    expect(html("#没有空格\n")).toBe("<p>#没有空格</p>");
  });

  test("井号带空格才出标题，六级封顶", () => {
    expect(html("# 一级\n")).toBe("<h1>一级</h1>");
    expect(html("###### 六级\n")).toBe("<h6>六级</h6>");
    expect(html("####### 七级\n")).toBe("<p>####### 七级</p>");
  });

  test("GFM 表格出 <table>，表头在 thead，对齐按分隔行", () => {
    const t = html("| 方法 | 路径 | 说明 |\n| --- | :---: | ---: |\n| GET | /todos | 列表 |\n");
    expect(t).toContain("<table><thead><tr>");
    expect(t).toContain("<tbody><tr>");
    expect(t).toContain('<th style="text-align:center">路径</th>');
    expect(t).toContain('<td style="text-align:right">列表</td>');
    // 前提断言：真的是"三列"，不是把整行塞进一个格
    expect((t.match(/<th /g) || []).length).toBe(3);
  });

  test("表格吃完接得住后面的段落", () => {
    const t = html("| a | b |\n| - | - |\n| 1 | 2 |\n\n段落\n");
    expect(t).toContain("</table>");
    expect(t).toContain("<p>段落</p>");
  });

  test("引用、列表、代码块、分隔线各自归位", () => {
    expect(html(">没有空格的引用\n")).toBe("<blockquote>没有空格的引用</blockquote>");
    expect(html("- 甲\n- 乙\n")).toBe("<ul><li>甲</li><li>乙</li></ul>");
    expect(html("1. 甲\n2. 乙\n")).toBe("<ol><li>甲</li><li>乙</li></ol>");
    expect(html("```bash\nnpm i\n```\n")).toBe("<pre><code>npm i</code></pre>");
    expect(html("---\n")).toBe("<hr>");
  });

  test("未闭合围栏把剩下的都当代码，不吞出异常", () => {
    expect(html("```bash\nnpm i\n没收尾\n")).toBe("<pre><code>npm i\n没收尾\n</code></pre>");
  });

  test("行内：代码优先于强调，链接只认 http(s)", () => {
    expect(html("`a*b*c`\n")).toBe("<p><code>a*b*c</code></p>");
    expect(html("先 `x*y*` 再 `z*w*`\n")).toBe("<p>先 <code>x*y*</code> 再 <code>z*w*</code></p>");
    expect(html("**粗** 和 *斜*\n")).toBe("<p><b>粗</b> 和 <i>斜</i></p>");
    expect(html("[外链](https://example.com/a)\n")).toContain('<a href="https://example.com/a"');
    expect(html("[本地](./b.md)\n")).toBe("<p>[本地](./b.md)</p>");
  });

  test("HTML 一律转义，预览文档里不会混进可执行标签", () => {
    expect(html("<img src=x onerror=alert(1)>\n")).not.toContain("<img src=x");
    expect(html("<script>alert(1)<\/script>\n")).not.toContain("<script>");
  });
});
