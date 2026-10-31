/* ============================================================
   「在文件夹中显示 / 打开文件夹」的路径闸门

   为什么单测这一层：渲染端能递任意字符串，而 shell.openPath / showItemInFolder
   会老老实实打开被递进来的路径。词法拦不住软链，真实路径必须再解一次。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveInRoot } = require("../electron/shell-paths");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-shell-paths-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pc-shell-outside-"));
afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch (e) {}
});

describe("resolveInRoot：工作区路径闸门", () => {
  it("正常相对路径解析到根内", () => {
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    const r = resolveInRoot(root, "a.txt");
    expect(r.error).toBeUndefined();
    expect(r.abs).toBe(path.join(path.resolve(root), "a.txt"));
  });

  it("反斜杠写法与子目录也能解析", () => {
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "b.txt"), "x");
    const r = resolveInRoot(root, "sub\\b.txt");
    expect(r.error).toBeUndefined();
    expect(r.abs).toBe(path.join(path.resolve(root), "sub", "b.txt"));
  });

  it("根目录自身允许（打开工作区）", () => {
    const r = resolveInRoot(root, ".");
    expect(r.error).toBeUndefined();
    expect(r.abs).toBe(path.resolve(root));
  });

  it(".. 逃逸被驳回", () => {
    expect(resolveInRoot(root, "../secret.txt").error).toMatch(/越界/);
    expect(resolveInRoot(root, "sub/../../secret.txt").error).toMatch(/越界/);
  });

  it("绝对路径被驳回", () => {
    const abs = path.join(outside, "x.txt");
    expect(resolveInRoot(root, abs).error).toMatch(/越界/);
  });

  it("空路径与 NUL 被驳回", () => {
    expect(resolveInRoot(root, "").error).toBeTruthy();
    expect(resolveInRoot(root, "a\0b").error).toBeTruthy();
  });

  it("根未就绪时明确报错", () => {
    expect(resolveInRoot("", "a.txt").error).toBeTruthy();
  });

  it("指向工作区外的软链被驳回", () => {
    fs.writeFileSync(path.join(outside, "o.txt"), "x");
    const link = path.join(root, "link-out.txt");
    try { fs.symlinkSync(path.join(outside, "o.txt"), link, "file"); }
    catch (e) { return; }   // Windows 非管理员可能建不了文件软链；本机建不了就只验词法三层
    const r = resolveInRoot(root, "link-out.txt");
    expect(r.error).toMatch(/软链|越界/);
  });
});
