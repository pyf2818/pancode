"use strict";
/* ============================================================
   编排内共享白板（P5）
   ------------------------------------------------------------
   以前同一次编排里的步骤之间只有一条通道：把上一步的原文（截到 8000 字）塞进下一步的
   prompt。三个后果：
     · 贵 —— 每加一个下游步骤就重付一遍上游全文的 token；
     · 没结构 —— "改了哪几个文件 / 哪条路走不通"埋在散文里，下游模型自己找，找不到就重做；
     · 兄弟之间完全看不见彼此 —— 两个并行分支把同一段代码各调研一遍，还可能给出互相矛盾的结论。
   白板就是补这条通道：一次编排一份，只在本次运行内活着，子智能体用 board 工具读写，
   编排器在派发下游步骤时把白板条目一起给它（比原文便宜一个数量级）。
   刻意不落盘：这是运行内便签，不是长期记忆（跨会话沉淀走 memory / decisions）。
   ============================================================ */

const MAX_ENTRIES = 60;      // 白板是便签不是档案，写满就滚掉最旧的
const MAX_TEXT = 600;        // 单条上限：超过这个长度的内容该进文件，不该进白板
const MAX_RENDER_CHARS = 1800;   // 注入给下游步骤的白板总字数上限
const KINDS = ["finding", "blocker", "question", "note"];
const KIND_CN = { finding: "结论", blocker: "走不通", question: "待答", note: "备注" };
const { clipText } = require("./text-clip");

class Blackboard {
  constructor(runId) {
    this.runId = String(runId || "run");
    this.items = [];
  }

  /* 记一条。from 是"谁写的"（步骤 id / 子智能体标签），渲染时按它排除自己。 */
  post(from, kind, key, text) {
    const body = String(text == null ? "" : text).trim();
    if (!body) return { ok: false, why: "empty" };
    const k = KINDS.includes(kind) ? kind : "note";
    /* 截断按 text-clip 的口径：白板条目是拼进下游 prompt 的一段一段文本，
       切口落在 emoji 半个代理上、或落在条目自己写的 ``` 围栏中间时，
       下游看到的是一条坏字符 + 后面全部被吞进代码块。 */
    const clipped = clipText(body, MAX_TEXT);
    this.items.push({
      from: clipText(from, 40),
      kind: k,
      key: clipText(key, 80),
      text: clipped,
      ts: Date.now(),
    });
    while (this.items.length > MAX_ENTRIES) this.items.shift();
    return { ok: true, n: this.items.length, truncated: clipped !== body };
  }

  /* exceptFrom：排除某一步自己写的条目。下游要看别人的结论，把自己刚写的那条再读一遍是纯浪费。 */
  read(exceptFrom) {
    if (!exceptFrom) return this.items.slice();
    return this.items.filter((i) => i.from !== exceptFrom);
  }

  /* 注入用文本：从最新往回收，收满字数上限就停，保证下游一定看到最近这几条
     （整段砍尾巴会把最新的结论砍掉，那正是最有用的部分）。 */
  render(exceptFrom) {
    const list = this.read(exceptFrom);
    if (!list.length) return "";
    const out = [];
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      const line = "- [" + (KIND_CN[it.kind] || it.kind) + "] " + (it.from || "?")
        + (it.key ? " · " + it.key : "") + "：" + it.text;
      if (n + line.length > MAX_RENDER_CHARS) break;
      n += line.length;
      out.unshift(line);
    }
    const hidden = list.length - out.length;
    if (hidden > 0) out.unshift("（更早的 " + hidden + " 条未列出，需要就用 board action=read 取）");
    return out.join("\n");
  }

  /* 这一步自己写了什么（收进结构化汇报，让父智能体看得见子智能体的判断，不只是它的散文） */
  from(stepId) {
    return this.items.filter((i) => i.from === stepId);
  }
}

module.exports = { Blackboard, KINDS, KIND_CN, MAX_ENTRIES, MAX_TEXT, MAX_RENDER_CHARS };
