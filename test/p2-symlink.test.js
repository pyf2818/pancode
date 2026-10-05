/* ============================================================
   阶段一-3 FileStore 软链越界防护回归。

   迁移前 safePath 只有词法判定（resolve + startsWith），全仓 0 处 realpath/lstat。
   于是工作区里一个指向外部的目录软链（或 Windows junction）会被当成"根内路径"：
     list() 用 statSync 跟随它遍历 → 把 C:\Users\<you>\.ssh 里的文件名读出来，
     read() 同理能读到内容。
   单根时这是低概率隐患；桌面端要鼓励用户"把常用目录授权进来"，它就是主路径。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { FileStore } = require("../server/files");

let root, outside, store;

/* Windows 下建符号链接需要特权；目录用 junction 不需要，且同样会被 realpath 展开。 */
function linkDir(target, linkPath) {
  try { fs.symlinkSync(target, linkPath, "dir"); return "symlink"; } catch (e) {}
  try { fs.symlinkSync(target, linkPath, "junction"); return "junction"; } catch (e) { return null; }
}
function linkFile(target, linkPath) {
  try { fs.symlinkSync(target, linkPath); return true; } catch (e) { return false; }
}

/* 能力探测：这台机器建不了某种软链时，对应用例必须是「跳过」而不是「通过」——
   否则报告上是绿的、实际一行都没验证过（本文件第一版就犯过这个错）。 */
function probe(probeFn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fs-probe-"));
  try { return probeFn(d); } catch (e) { return false; }
  finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
}
const CAN_FILE_LINK = probe((d) => {
  fs.writeFileSync(path.join(d, "t.txt"), "x", "utf8");
  fs.symlinkSync(path.join(d, "t.txt"), path.join(d, "l.txt"));
  return true;
});
const CAN_DIR_LINK = probe((d) => linkDir(d, path.join(d, "l")) !== null);
const itIf = (cond) => (cond ? it : it.skip);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fs-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "pc-fs-out-"));
  store = new FileStore(root, null);
});
afterEach(() => {
  for (const d of [root, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

describe("正常路径不受影响", () => {
  it("根内嵌套路径、新建到不存在的子目录都照常放行", () => {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.js"), "x", "utf8");
    expect(fs.existsSync(store.safePath("src/a.js"))).toBe(true);
    expect(store.exists("src/a.js")).toBe(true);
    expect(store.read("src/a.js")).toBe("x");
    // 目标不存在（要新建）：祖先链上第一个真实存在的是根本身 → 仍在根内
    expect(store.safePath("src/new/deep/b.js")).toBe(path.resolve(root, "src/new/deep/b.js"));
  });

  it("根目录本身可以作为路径解析", () => {
    expect(store.safePath(".")).toBe(path.resolve(root));
  });

  it("词法越界照旧拒绝", () => {
    for (const p of ["../outside.txt", "src/../../x", path.resolve(outside, "x.txt")]) {
      expect(() => store.safePath(p), p).toThrow();
    }
  });

  it("空串与 NULL 字节仍被挡", () => {
    expect(() => store.safePath("")).toThrow();
    expect(() => store.safePath("a\0b")).toThrow();
  });
});

describe("软链指向根外：拒绝", () => {
  const mustLink = (kind) => {
    if (!kind) throw new Error("能力探测说能建，实际建不出来——用例的前提破了，别当通过");
    return kind;
  };

  itIf(CAN_DIR_LINK)("目录链接：read / write / list 都不放过它", () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "机密", "utf8");
    mustLink(linkDir(outside, path.join(root, "link")));
    // 1) 读：词法在根内、真实在根外
    expect(() => store.read("link/secret.txt")).toThrow(/软链|工作区外/);
    // 2) 写：同样拒绝（原来会直接写到外面）
    expect(() => store.write("link/evil.txt", "x")).toThrow(/软链|工作区外/);
    // 3) exists 不抛异常，按"不存在"回答
    expect(store.exists("link/secret.txt")).toBe(false);
    // 4) list 根本不跟随：外部文件的名字不该出现在结果里
    expect(store.list().filter((p) => /secret\.txt/.test(p))).toEqual([]);
  });

  itIf(CAN_FILE_LINK)("文件链接同样被拒；且不进入 list 结果", () => {
    const target = path.join(outside, "t.txt");
    fs.writeFileSync(target, "外面", "utf8");
    if (!linkFile(target, path.join(root, "f.txt"))) throw new Error("探测说能建文件链接，实际失败");
    expect(() => store.read("f.txt")).toThrow(/软链|工作区外/);
    expect(store.list()).not.toContain("f.txt");
  });

  itIf(CAN_DIR_LINK)("嵌套在子目录里的逃逸链接也拦得住", () => {
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(outside, "k.txt"), "k", "utf8");
    mustLink(linkDir(outside, path.join(root, "pkg", "l")));
    expect(() => store.read("pkg/l/k.txt")).toThrow(/软链|工作区外/);
    expect(store.list().filter((p) => /pkg\/l\//.test(p))).toEqual([]);
  });

  itIf(CAN_DIR_LINK)("指向根内的合法链接不被误伤（list 不跟随它，但显式读写允许）", () => {
    fs.mkdirSync(path.join(root, "real"), { recursive: true });
    fs.writeFileSync(path.join(root, "real", "a.txt"), "A", "utf8");
    mustLink(linkDir(path.join(root, "real"), path.join(root, "alias")));
    // 真实路径仍在根内 → safePath 放行
    expect(store.read("alias/a.txt")).toBe("A");
    // 但 list 不跟随，避免同一份内容被列两遍
    expect(store.list().filter((p) => /^alias\//.test(p))).toEqual([]);
    expect(store.list()).toContain("real/a.txt");
  });

  it("探测结果本身要报告出来（绿的用例数必须等于真的验过的能力）", () => {
    const report = { dirLink: CAN_DIR_LINK, fileLink: CAN_FILE_LINK };
    // 至少目录链接要能验：它是本防护的主场景（junction 在 Windows 无需特权）
    if (!report.dirLink && !report.fileLink) {
      throw new Error("本平台既建不了目录链接也建不了文件链接，防护完全没被验证过");
    }
    expect(report.dirLink || report.fileLink).toBe(true);
  });
});

describe("遍历不会被软链绕死", () => {
  itIf(CAN_DIR_LINK)("自引用目录链接：list 有界返回，不栈溢出也不超时", () => {
    if (!linkDir(root, path.join(root, "self"))) throw new Error("探测说能建，实际失败");
    const t0 = Date.now();
    const out = store.list();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(out).not.toContain("self");
  });
});

describe("性能：realpath 校验在满配额遍历时不显著拖慢", () => {
  it("500 个文件的 list 仍在 3s 内完成", () => {
    fs.mkdirSync(path.join(root, "bulk"), { recursive: true });
    for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(root, "bulk", "f" + i + ".js"), "x", "utf8");
    const t0 = Date.now();
    const out = store.list();
    const ms = Date.now() - t0;
    expect(out.length).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(3000);
  });
});
