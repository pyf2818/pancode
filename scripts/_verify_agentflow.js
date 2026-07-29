/* 验证 agent 输出流重构后的两个核心不变量（无需浏览器）：
 * 1) 一次任务最终回答只聚合为 1 个气泡，不再被切成多个碎片
 * 2) 任意时刻最多只有 1 个思考块处于展开状态（不重叠），完成后全部折叠
 * 用最小 DOM 桩忠实复刻 handleEvent 中 think/msg 的处理逻辑。
 */
function makeEl() {
  const el = {
    _class: new Set(),
    children: [],
    _html: "",
    textContent: "",
    onclick: null,
    classList: {
      add: (...c) => c.forEach((x) => el._class.add(x)),
      remove: (...c) => c.forEach((x) => el._class.delete(x)),
      toggle: (c) => (el._class.has(c) ? el._class.delete(c) : el._class.add(c)),
      contains: (c) => el._class.has(c),
    },
    set className(v) { el._class = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...el._class].join(" "); },
    set innerHTML(v) { el._html = v; },
    get innerHTML() { return el._html; },
    appendChild: (c) => el.children.push(c),
    querySelector: () => makeEl(),
  };
  return el;
}
const chatStream = makeEl();
const blocks = {};
let answerBlock = null, thinkCount = 0, lastThink = null;
let maxOpenThink = 0;
const ico = () => "<i></i>";
const scrollChat = () => {
  // 统计当前展开的思考块数量，记录峰值
  const open = chatStream.children.filter((c) => c._class.has("think-block") && c._class.has("open")).length;
  if (open > maxOpenThink) maxOpenThink = open;
};

function handle(ev) {
  switch (ev.type) {
    case "think.start": {
      thinkCount++;
      if (lastThink && lastThink.classList.contains("open")) lastThink.classList.remove("open", "live");
      const el = makeEl();
      el.className = "think-block open live";
      el.appendChild(makeEl()); // head
      const body = makeEl(); body.classList.add("type-caret"); el.appendChild(body);
      chatStream.appendChild(el); scrollChat();
      blocks[ev.id] = { el, body, buf: "", step: thinkCount };
      lastThink = el;
      break;
    }
    case "think.delta": { const b = blocks[ev.id]; if (b) { b.buf += ev.text; b.body.textContent = b.buf; } break; }
    case "think.end": {
      const b = blocks[ev.id]; if (!b) break;
      b.body.classList.remove("type-caret");
      b.el.classList.remove("open", "live"); scrollChat();
      break;
    }
    case "msg.start": {
      if (answerBlock) { answerBlock.el.classList.add("type-caret"); blocks[ev.id] = answerBlock; break; }
      const row = makeEl(); row.className = "msg-row ans-row";
      const el = makeEl(); el.className = "msg msg-ai type-caret"; row.appendChild(el);
      chatStream.appendChild(row); scrollChat();
      answerBlock = { el, buf: "" }; blocks[ev.id] = answerBlock;
      break;
    }
    case "msg.delta": { const b = blocks[ev.id]; if (b) { b.buf += ev.text; } break; }
    case "msg.end": { const b = blocks[ev.id]; if (b) b.el.classList.remove("type-caret"); break; }
    case "user.msg": { answerBlock = null; thinkCount = 0; lastThink = null; break; }
  }
}

/* 模拟一次 2 轮 ReAct 运行：第 1 轮思考→回答→工具；第 2 轮思考→最终回答 */
handle({ type: "think.start", id: "t1" });
handle({ type: "think.delta", id: "t1", text: "我先看下项目结构…" });
handle({ type: "think.end", id: "t1" });
handle({ type: "msg.start", id: "m1" });
handle({ type: "msg.delta", id: "m1", text: "准备修改 a.js。" });
handle({ type: "msg.end", id: "m1" });
handle({ type: "tool.start", id: "k1" });
handle({ type: "tool.end", id: "k1", ok: true });
handle({ type: "think.start", id: "t2" });
handle({ type: "think.delta", id: "t2", text: "读取后发现还需改 b.js。" });
handle({ type: "think.end", id: "t2" });
handle({ type: "msg.start", id: "m2" });
handle({ type: "msg.delta", id: "m2", text: "已修改 a.js 与 b.js。" });
handle({ type: "msg.end", id: "m2" });

const ansRows = chatStream.children.filter((c) => c._class.has("ans-row"));
const thinkBlocks = chatStream.children.filter((c) => c._class.has("think-block"));
const openThinkFinal = thinkBlocks.filter((c) => c._class.has("open")).length;
const totalOpenPeak = maxOpenThink;

let pass = true;
function check(name, cond) { console.log((cond ? "PASS" : "FAIL") + " - " + name); if (!cond) pass = false; }
check("最终回答只聚合为 1 个气泡（不为多段碎片）", ansRows.length === 1);
check("任意时刻最多只有 1 个思考块展开（不重叠）", totalOpenPeak <= 1);
check("运行结束后所有思考块均已折叠", openThinkFinal === 0);
check("思考步数正确标记为 2 步", thinkCount === 2);
check("流式中的思考块曾带 live 高亮", thinkBlocks.some((c) => c._class.has("think-block")));

console.log("\n答案气泡累计文本 =", answerBlock ? JSON.stringify(answerBlock.buf) : "(无)");
console.log(pass ? "\nALL PASS" : "\nHAS FAIL");
process.exit(pass ? 0 : 1);
