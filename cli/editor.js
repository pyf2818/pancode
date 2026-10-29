/* ============================================================
   pancode-cli · 外部编辑器（Ctrl+X E）
   ------------------------------------------------------------
   调用 $EDITOR / $VISUAL 编辑临时文件，读取内容返回。
   吸收自 openanlan chat:externalEditor 动作。
   ============================================================ */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const S = require("./style");

function getEditor() {
  return process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
}

async function externalEditor(initial) {
  const tmp = path.join(os.tmpdir(), `pancode-edit-${Date.now()}.md`);
  fs.writeFileSync(tmp, initial || "", "utf8");

  const editor = getEditor();
  process.stdout.write(S.dim("  启动 " + editor + " …（退出编辑器后自动读取）\n"));

  try {
    /* 暂停 raw mode 让终端回到正常模式 */
    try { process.stdin.setRawMode(false); } catch (_) {}
    execSync(editor + ' "' + tmp + '"', { stdio: "inherit", shell: true });
  } catch (e) {
    process.stdout.write(S.err("  编辑器启动失败：" + e.message + "\n"));
    try { fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }

  let content = "";
  try { content = fs.readFileSync(tmp, "utf8"); } catch (_) {}
  try { fs.unlinkSync(tmp); } catch (_) {}

  /* 去掉末尾换行 */
  content = content.replace(/\n+$/, "");
  return content;
}

module.exports = { externalEditor, getEditor };
