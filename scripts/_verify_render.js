// 独立验证 renderChatMD / htmlToMarkdown 的纯逻辑（不依赖浏览器 DOM）
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderChatMD(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listBuf = [], inList = false, inOrdered = false;
  const flushList = () => {
    if (!listBuf.length) return;
    const tag = inOrdered ? "ol" : "ul";
    html += "<" + tag + ">" + listBuf.map((x) => "<li>" + inlineMD(x) + "</li>").join("") + "</" + tag + ">";
    listBuf = []; inList = false; inOrdered = false;
  };
  const inlineMD = (t) => {
    let h = esc(t);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return h;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushList();
      const lang = fence[1] || "";
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      html += '<div class="code-block"><div class="code-head"><span class="code-lang">' + esc(lang || "code") +
        '</span><button class="copy-btn" type="button">复制</button></div><pre class="' + esc(lang) +
        '">' + esc(code.join("\n")) + "</pre></div>";
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushList(); const lv = h[1].length; html += "<h" + lv + ">" + inlineMD(h[2]) + "</h" + lv + ">"; i++; continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushList(); html += "<blockquote>" + inlineMD(bq[1]) + "</blockquote>"; i++; continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (!inList || inOrdered) { flushList(); inList = true; inOrdered = false; } listBuf.push(ul[1]); i++; continue; }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) { if (!inList || !inOrdered) { flushList(); inList = true; inOrdered = true; } listBuf.push(ol[1]); i++; continue; }
    if (line.trim() === "") { flushList(); i++; continue; }
    flushList();
    html += "<p>" + inlineMD(line) + "</p>";
    i++;
  }
  flushList();
  return html;
}

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log("  FAIL: " + name); } }

// 1. 代码块 + 复制按钮
let h = renderChatMD("```js\nconst a = 1;\n```");
ok("code-block div", h.includes('class="code-block"'));
ok("copy button", h.includes('class="copy-btn"'));
ok("code content escaped", h.includes("const a = 1;") && h.includes("<pre"));
ok("no stray fence markers", !h.includes("```"));

// 2. 标题
h = renderChatMD("# 标题一\n## 标题二");
ok("h1", h.includes("<h1>标题一</h1>"));
ok("h2", h.includes("<h2>标题二</h2>"));

// 3. 列表
h = renderChatMD("- a\n- b\n\n1. x\n2. y");
ok("ul", h.includes("<ul><li>a</li><li>b</li></ul>"));
ok("ol", h.includes("<ol><li>x</li><li>y</li></ol>"));

// 4. 行内样式
h = renderChatMD("这是 **粗体** 和 `代码` 与 *斜体*");
ok("bold", h.includes("<b>粗体</b>"));
ok("inline code", h.includes("<code>代码</code>"));
ok("italic", h.includes("<i>斜体</i>"));

// 5. 引用
h = renderChatMD("> 引用内容");
ok("blockquote", h.includes("<blockquote>引用内容</blockquote>"));

// 6. 链接
h = renderChatMD("见 [官网](https://example.com)");
ok("link", h.includes('<a href="https://example.com" target="_blank" rel="noreferrer">官网</a>'));

// 7. 流式未闭合代码块（EOF 无结束 ```）应安全渲染
h = renderChatMD("```python\nprint('hi')");
ok("open fence safe", h.includes("<pre") && h.includes("print('hi')"));

// 8. HTML 转义防注入
h = renderChatMD("测试 <script>alert(1)</script>");
ok("escaped script", h.includes("&lt;script&gt;") && !h.includes("<script>"));

console.log("renderChatMD 验证: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
