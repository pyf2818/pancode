/* ============================================================
   审查项 F06：文档预览的链接清洗必须和浏览器的口径对得上
   旧实现是 `trim()` + 一个 `^scheme:` 正则 —— 而浏览器解析 URL 时会自己吃掉
   实体与制表/换行，于是 `jav&#x0a;ascript:` 在正则眼里是"没有冒号前缀的相对路径"、
   放行，在浏览器眼里却是 javascript:。这一组判据钉的就是这一类分歧。
   ============================================================ */
const { sanitizePreviewHtml, auditPreview, normalizeUrl } = require("../server/preview-sanitize");

/* 把清洗结果里所有 href 抠出来，便于逐条断言 */
const hrefs = (html) => [...sanitizePreviewHtml(html).matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const one = (html) => hrefs(html)[0];

describe("协议判定与浏览器对齐", () => {
  it("明文 javascript: 被摘掉", () => {
    expect(one('<a href="javascript:alert(1)">x</a>')).toBe("#");
  });
  it("大小写混排不行骗（JaVaScRiPt:）", () => {
    expect(one('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe("#");
  });
  /* 这三条是旧实现真漏掉的那一类：正则看到的是"没有 scheme 的字符串"，
     浏览器解出来是 javascript:。 */
  it("换行实体夹在 scheme 中间 → 仍然判为危险", () => {
    expect(one('<a href="jav&#x0a;ascript:alert(1)">x</a>')).toBe("#");
  });
  it("制表符实体夹在 scheme 中间 → 仍然判为危险", () => {
    expect(one('<a href="java&tab;script:alert(1)">x</a>')).toBe("#");
  });
  it("十进制实体编码首字母 → 仍然判为危险", () => {
    expect(one('<a href="&#106;avascript:alert(1)">x</a>')).toBe("#");
  });
  it("属性里直接塞裸控制字符 → 仍然判为危险", () => {
    expect(one('<a href="java\tscript:alert(1)">x</a>')).toBe("#");
    expect(one('<a href="java\nscript:alert(1)">x</a>')).toBe("#");
  });
  it("vbs / data:text/html 这类非白名单 scheme 一律摘掉", () => {
    expect(one('<a href="vbscript:msgbox(1)">x</a>')).toBe("#");
    expect(one('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe("#");
  });
  it("归一化函数本身可单测：它把 scheme 前的干扰字符都清掉", () => {
    expect(normalizeUrl(" java\tsc&#x0a;ript:x ")).toBe("javascript:x");
  });
});

describe("正常内容不能被清洗误伤", () => {
  it("http(s)/mailto 原样放行，且保留大小写（签名参数是大小写敏感的）", () => {
    expect(one('<a href="https://example.com/PaTh?Token=AbC">x</a>')).toBe("https://example.com/PaTh?Token=AbC");
    expect(one('<a href="mailto:me@example.com">x</a>')).toBe("mailto:me@example.com");
  });
  it("放行的是原样而不是小写化那一份", () => {
    expect(one('<a href="http://e.com/A_b">x</a>')).toBe("http://e.com/A_b");
  });
  it("文档内指向同目录另一份文件的相对链接收成 #（预览在应用源里，相对路径会打到自家接口）", () => {
    expect(one('<a href="appendix.docx">x</a>')).toBe("#");
    expect(one('<a href="/etc/passwd">x</a>')).toBe("#");
  });
  it("正文与排版标签都留着（清洗不该把内容一起吃掉）", () => {
    const out = sanitizePreviewHtml("<h1>标题</h1><p>正文<strong>加粗</strong></p><ul><li>一</li></ul>");
    expect(out).toContain("标题");
    expect(out).toContain("<strong>加粗</strong>");
    expect(out).toContain("<li>一</li>");
  });
  it("表格与合并单元格这类排版属性保留", () => {
    const out = sanitizePreviewHtml('<table><tr><td colspan="2" rowspan="3">格</td></tr></table>');
    expect(out).toContain('colspan="2"');
    expect(out).toContain('rowspan="3"');
  });
  it("mammoth 的内嵌图片（data:image）不被当成外联丢掉", () => {
    const out = sanitizePreviewHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="图">');
    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(out).toContain('alt="图"');
  });
  it("排版 style 留着，外联/表达式的 style 丢掉", () => {
    expect(sanitizePreviewHtml('<p style="text-align:center">中</p>')).toContain("text-align:center");
    expect(sanitizePreviewHtml('<p style="background:url(javascript:alert(1))">中</p>')).not.toContain("url(");
    expect(sanitizePreviewHtml('<p style="width:expression(alert(1))">中</p>')).not.toContain("expression");
  });
});

describe("能执行的东西一个都不留", () => {
  it("script / style / iframe / object / form 整块丢掉", () => {
    const out = sanitizePreviewHtml(
      "<script>alert(1)</script><style>p{color:red}</style>"
      + '<iframe src="https://evil.example"></iframe><object data="x"></object>'
      + '<form action="/api/auth/auto"><input name="a"></form>');
    expect(out.toLowerCase()).not.toMatch(/<script|<style|<iframe|<object|<form|<input/);
    expect(out).not.toContain("alert(1)");
  });
  it("丢掉整块之后，后面的正文照旧在（不是「遇到 script 就截断」）", () => {
    const out = sanitizePreviewHtml("<p>前面</p><script>alert(1)</script><p>后面</p>");
    expect(out).toContain("前面");
    expect(out).toContain("后面");
    expect(out).not.toContain("alert");
  });
  it("on* 事件属性一律丢弃", () => {
    const out = sanitizePreviewHtml('<p onclick="alert(1)" onmouseover="x()">正文</p>');
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out).toContain("正文");
  });
  it("img 的外链 src 丢掉（跟踪面），只留 data:image", () => {
    expect(sanitizePreviewHtml('<img src="https://track.example/i.png?u=1">')).not.toContain("track.example");
  });
  it("未闭合与嵌套错乱的标签不会把后面的内容变成属性", () => {
    const out = sanitizePreviewHtml('<a href="https://ok.example">点我</a><p>没关的段落');
    expect(out).toContain("没关的段落");
    expect((out.match(/<a /g) || []).length).toBe(1);
  });
  it("属性值里带引号也不能提前闭合标签", () => {
    const out = sanitizePreviewHtml('<a href=\'https://ok.example" onload="alert(1)\'>x</a>');
    expect(out.toLowerCase()).not.toContain("onload=\"alert");
    expect((out.match(/<a /g) || []).length).toBe(1);
  });
});

describe("改写要可数（清洗不能是静默的）", () => {
  it("auditPreview 报出被改写的条数与样本", () => {
    const a = auditPreview('<a href="https://ok">a</a><a href="javascript:bad">b</a><a href="jav&#x0a;ascript:bad">c</a>');
    expect(a.links).toBe(3);
    expect(a.rewritten).toBe(2);
    expect(a.samples.length).toBeLessThanOrEqual(3);
  });
  it("全是正常链接时 rewritten 为 0（不虚报）", () => {
    expect(auditPreview('<a href="https://ok.example/x">a</a>').rewritten).toBe(0);
  });
});
