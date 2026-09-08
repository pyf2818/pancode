/* ============================================================
   files.js 单元测试
   - safePath 防目录逃逸（核心安全命门）
   - isBinaryPath 扩展名检测
   - langOf 语言映射
   - FileStore CRUD 基本正确性（在临时目录中）
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { FileStore, langOf, isBinaryPath } = require("../server/files");

/* 临时工作区根目录，每个用例独立子目录 */
let tmpRoot;
function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-test-"));
  return d;
}

describe("isBinaryPath — 扩展名检测", () => {
  const binary = ["a.png", "b.jpg", "c.zip", "d.exe", "e.pdf", "f.docx", "x.dll", "y.wasm", "z.sqlite"];
  for (const f of binary) {
    it(`识别二进制: ${f}`, () => {
      expect(isBinaryPath(f)).toBe(true);
    });
  }
  const text = ["a.js", "b.ts", "c.json", "d.md", "e.html", "f.css", "g.py", "README", "Makefile", ".gitignore"];
  for (const f of text) {
    it(`识别文本: ${f}`, () => {
      expect(isBinaryPath(f)).toBe(false);
    });
  }
  it("大小写不敏感", () => {
    expect(isBinaryPath("PHOTO.PNG")).toBe(true);
    expect(isBinaryPath("Archive.ZIP")).toBe(true);
  });
});

describe("langOf — 语言映射", () => {
  const cases = [
    ["app.js", "javascript"],
    ["app.ts", "typescript"],
    ["f.jsx", "javascript"],
    ["f.tsx", "typescript"],
    ["p.json", "json"],
    ["p.html", "html"],
    ["p.htm", "html"],
    ["s.css", "css"],
    ["r.md", "markdown"],
    ["x.py", "python"],
    ["x.sh", "shell"],
    ["x.yml", "yaml"],
    ["x.yaml", "yaml"],
    ["x.txt", "plaintext"],
    ["Makefile", "plaintext"],
    ["x.unknownext", "plaintext"],
  ];
  for (const [f, expected] of cases) {
    it(`${f} → ${expected}`, () => {
      expect(langOf(f)).toBe(expected);
    });
  }
});

describe("FileStore.safePath — 防目录逃逸", () => {
  let store;
  beforeEach(() => {
    tmpRoot = freshDir();
    store = new FileStore(tmpRoot);
  });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  it("正常相对路径放行并返回绝对路径", () => {
    const abs = store.safePath("src/app.js");
    expect(abs).toBe(path.resolve(tmpRoot, "src/app.js"));
  });

  it("带子目录的深层路径放行", () => {
    const abs = store.safePath("a/b/c/d.txt");
    expect(abs).toBe(path.resolve(tmpRoot, "a/b/c/d.txt"));
  });

  it("空字符串抛错", () => {
    expect(() => store.safePath("")).toThrow();
  });

  it("非字符串抛错", () => {
    expect(() => store.safePath(null)).toThrow();
    expect(() => store.safePath(undefined)).toThrow();
    expect(() => store.safePath(123)).toThrow();
  });

  it("NUL 字节抛错", () => {
    expect(() => store.safePath("foo\0bar")).toThrow();
  });

  it("Unix 目录逃逸 ../ 拦截", () => {
    expect(() => store.safePath("../etc/passwd")).toThrow();
    expect(() => store.safePath("../../etc/passwd")).toThrow();
  });

  it("Windows 目录逃逸 ..\\ 拦截", () => {
    expect(() => store.safePath("..\\..\\Windows\\System32")).toThrow();
    expect(() => store.safePath("foo\\..\\..\\bar")).toThrow();
  });

  it("绝对路径拦截", () => {
    expect(() => store.safePath("/etc/passwd")).toThrow();
    expect(() => store.safePath("C:\\Windows\\System32")).toThrow();
  });

  it("工作区根自身放行（safePath('.')）", () => {
    expect(() => store.safePath(".")).not.toThrow();
  });
});

describe("FileStore CRUD — 临时目录真实读写", () => {
  let store;
  beforeEach(() => {
    tmpRoot = freshDir();
    store = new FileStore(tmpRoot);
  });
  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  });

  it("write + read 往返一致", () => {
    store.write("hello.txt", "你好世界");
    expect(store.read("hello.txt")).toBe("你好世界");
  });

  it("write 自动创建父目录", () => {
    store.write("src/deep/nested.js", "module.exports = 1;");
    expect(store.read("src/deep/nested.js")).toBe("module.exports = 1;");
  });

  it("exists 正确反映文件存在性", () => {
    expect(store.exists("nope.js")).toBe(false);
    store.write("yes.js", "1");
    expect(store.exists("yes.js")).toBe(true);
  });

  it("create 拒绝覆盖已有文件", () => {
    store.create("a.txt", "first");
    expect(() => store.create("a.txt", "second")).toThrow();
  });

  it("remove 删除文件", () => {
    store.write("tmp.txt", "x");
    expect(store.exists("tmp.txt")).toBe(true);
    store.remove("tmp.txt");
    expect(store.exists("tmp.txt")).toBe(false);
  });

  it("remove 拒绝删除工作区根", () => {
    expect(() => store.remove(".")).toThrow();
  });

  it("rename 移动文件", () => {
    store.write("old.js", "content");
    store.rename("old.js", "new.js");
    expect(store.exists("old.js")).toBe(false);
    expect(store.read("new.js")).toBe("content");
  });

  it("rename 拒绝覆盖已有目标", () => {
    store.write("a.js", "1");
    store.write("b.js", "2");
    expect(() => store.rename("a.js", "b.js")).toThrow();
  });

  it("list 返回相对路径列表", () => {
    store.write("a.js", "1");
    store.write("b/c.js", "2");
    const list = store.list();
    expect(list).toContain("a.js");
    expect(list).toContain("b/c.js");
  });

  it("search 命中包含查询串的行", () => {
    store.write("app.js", "function foo() {\n  return 'TARGET_TOKEN';\n}");
    const results = store.search("TARGET_TOKEN");
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("app.js");
    expect(results[0].line).toBe(2);
  });

  it("read 拒绝二进制文件（按扩展名）", () => {
    store.write("img.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("binary"));
    expect(() => store.read("img.png")).toThrow();
  });
});
