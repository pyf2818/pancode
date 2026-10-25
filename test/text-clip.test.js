/* clipText：注入/落盘文本的截断口径。
   ————————————————————————————————————————————
   两处以前各自 .slice() 留下的坑，都是"模型看到的和看到的对不上"那一类：
   1) .slice() 按 UTF-16 码元切。emoji 与 CJK 扩展 B（𠀀）正好跨在切口上时留下半个代理，
      交出去的是 U+FFFD 乱码，写进长期记忆的正文还带着这个坏字符出不去。
   2) 截在 markdown 代码围栏中间时那个 ``` 永远不闭合，紧随其后拼接的那一段
      （编排把白板条目接在结论后、记忆把索引接在常驻后）会被渲染进代码块里。
   单行文本不补围栏：调用点刚 replace(/\s+/g," ") 过，硬塞换行会把一行拆成两行。 */
const { clipText } = require("../server/text-clip");

describe("代理对不许劈开", () => {
  it("切口落在 emoji 的两个码元之间时退一格", () => {
    const s = "ab😀cd";                       // a b \uD83D \uDE00 c d
    expect(clipText(s, 3)).toBe("ab");
    expect(clipText(s, 4)).toBe("ab😀");
    expect(clipText(s, 5)).toBe("ab😀c");
  });

  it("CJK 扩展 B（𠀀）同样不切半", () => {
    const s = "𠀀𠀀";
    expect(clipText(s, 1)).toBe("");
    expect(clipText(s, 3)).toBe("𠀀");
    expect(clipText(s, 3).charCodeAt(2)).not.toBe(0xd840);
  });

  it("普通文本按上限给满，不多不少", () => {
    expect(clipText("abcdefghij", 4)).toBe("abcd");
    expect(clipText("abc", 10)).toBe("abc");
    expect(clipText(null, 10)).toBe("");
    expect(clipText("abc", undefined)).toBe("abc");   // 没给上限就不截
  });
});

describe("未闭合的代码围栏要收口", () => {
  const S = "前文\n```js\nconst a = 1;\n```\n后文";

  it("截在围栏内部时补一行结束，后面拼接的内容才不会被吞进代码块", () => {
    const out = clipText(S, 15);
    expect(out.endsWith("\n```")).toBe(true);
    expect((out.match(/^\s{0,3}```/gm) || []).length % 2).toBe(0);
  });

  it("截在围栏之外（配对已闭合）时不许多补一行", () => {
    const out = clipText(S, 25);                      // 正好到闭合的 ``` 为止
    expect(out).toBe("前文\n```js\nconst a = 1;\n```");
    expect((out.match(/^\s{0,3}```/gm) || []).length).toBe(2);
  });

  it("单行文本不补围栏（编排的每步结论是被压成一行后截的）", () => {
    const one = "```js const a = 1; const b = 2;";
    expect(clipText(one, 10)).toBe("```js cons");
  });

  it("显式关掉围栏检查时原样截断", () => {
    expect(clipText(S, 15, { fence: false })).toBe(S.slice(0, 15));
  });
});
