/* ============================================================
   P1-B3 · 测试运行器（检测 / 收窄 / 解析）

   为什么单独一层：模型跑测试今天只能 run_command("npm test")，然后自己读一坨原始输出。
   代价是真实的——`test:verify` 那种 && 链一断，模型看到的最后一行往往是某个探针的
   半句中文，而不是"哪个文件的哪一行挂了"。这一层把三件事固定下来：
     1) detect   从 package.json 认出可跑的测试命令（并知道它是哪种框架）
     2) build    按框架语法把"只跑这几个文件"拼进命令；拼不了的如实说拼不了
     3) parse    把 stdout 解析成 { 通过数, 失败数, failures:[file:line] }
   不起 shell 进程（只有把绝对路径折回工作区坐标时会 stat 一下磁盘）——
   所以能被纯单测钉住（test/p1-testrunner.test.js），真跑那一段在 scripts/_verify_testrunner.js。
   ============================================================ */
"use strict";
const fs = require("fs");

/* ANSI 转义与盒线字符：vitest/jest 在 TTY 下会带色，管道里也可能留 \u001b[…m。
   不剥的话 "^ ❯" 这类行首判定全成猜测。 */
function stripAnsi(s) {
  return String(s == null ? "" : s)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "");
}

/* 框架语法表：scoped = 能否把文件列表拼进去；join 决定拼接形状。
   detectRe 用来认出脚本属于哪种框架（看 command 文本，不看依赖名——依赖里有 vitest
   不代表 scripts.test 跑的是它）。 */
const FRAMEWORKS = {
  vitest: { label: "vitest", detectRe: /\b(vitest|vitest\s+run)\b/, scoped: true },
  jest: { label: "jest", detectRe: /\bjest\b/, scoped: true },
  "node-test": { label: "node --test", detectRe: /node\s+(--test|--experimental-test-module-maps\s+--test)/, scoped: true },
  pytest: { label: "pytest", detectRe: /(^|\s)(python\s+-m\s+)?pytest(\s|$)/, scoped: true },
  generic: { label: "通用", detectRe: null, scoped: false },
};

/* 一个脚本键是不是测试入口：test / test:unit / test:lsp 都算，"test:verify" 也算
   （它就是 pancode 自己的回归链）。pretest/posttest 不算。 */
const SCRIPT_KEY_RE = /^(test$|test[:\-])/;
const NOT_A_TEST_KEY_RE = /^(pre|post)test$/;

/* detect(pkgJson) → { scripts:[{key,command,framework,chained}], primary }
   primary 取 key==="test"，没有则取第一个 test* 脚本。 */
function detect(pkgJson) {
  const scripts = (pkgJson && pkgJson.scripts) || {};
  const list = [];
  for (const key of Object.keys(scripts)) {
    if (!SCRIPT_KEY_RE.test(key) || NOT_A_TEST_KEY_RE.test(key)) continue;
    const command = String(scripts[key] || "");
    list.push({ key, command, framework: frameworkOf(command), chained: /&&|\|\|/.test(command) });
  }
  if (!list.length) return { scripts: [], primary: null };
  const exact = list.find((s) => s.key === "test");
  return { scripts: list, primary: exact || list[0] };
}

function frameworkOf(command) {
  /* && 串起来的多段命令（pancode 自己的 test:verify 就是）不认框架：
     它的输出是好几段拼起来的，而且追加文件参数会拼到**最后一段**尾巴上
     （"vitest run && npm run lint" + " a.test.js" 变成给 lint 传参）。整串跑、按通用解析。 */
  if (/&&|\|\|/.test(command)) return "generic";
  for (const id of ["vitest", "jest", "node-test", "pytest"]) {
    if (FRAMEWORKS[id].detectRe.test(command)) return id;
  }
  return "generic";
}

/* build(detected, { files, script, command }) → { command, framework, scoped, script, note }
   优先级：显式 command > 显式 script > primary。选项名与工具的参数名一致（script），
   别在这里再叫一个别的名字——写测试时就因为 build 收 scriptKey、工具传 script 而误判过一次。 */
function build(detected, opts) {
  const o = opts || {};
  const files = (o.files || []).filter((f) => typeof f === "string" && safeRelPath(f));
  const dropped = (o.files || []).length - files.length;
  if (o.command) return { command: String(o.command), framework: frameworkOf(String(o.command)), scoped: false, dropped, note: "用了显式命令" };

  const pick = o.script ? detected.scripts.find((s) => s.key === o.script) : detected.primary;
  if (!pick) {
    return {
      command: "", framework: "generic", scoped: false, missing: true, dropped,
      note: detected.scripts.length
        ? "没有名为 " + o.script + " 的测试脚本，可选：" + detected.scripts.map((s) => s.key).join("、")
        : "package.json 里没有 test 脚本",
    };
  }

  const fw = pick.framework;
  if (files.length && fw !== "generic" && !pick.chained) {
    /* 收窄写法按框架各自来，三家的位置参数都放在命令尾巴上：
       vitest / jest 收文件路径子串匹配，node --test 收文件，pytest 收文件。 */
    return { command: pick.command + " " + files.map(quoteArg).join(" "), framework: fw, scoped: true, files, script: pick.key, dropped, note: "" };
  }
  return {
    command: pick.command, framework: fw, scoped: false, script: pick.key, dropped,
    note: files.length
      ? (pick.chained ? "这是 && 串起来的多段命令，追加文件只会拼到最后一段，所以整串跑" : "该测试命令不认识文件参数，只能整串跑")
      : "",
  };
}

/* 文件名必须是"工作区内的相对路径样子"，且不含任何 shell 元字符：
   这条命令最终交给 cmd.exe /c 执行，参数来自模型，等于一个注入点。
   run_command 有命令黑名单兜底，这里不收那条链——测试文件路径本来就没有奇怪字符，
   出现 ; & | ` $ 就应当视为异常输入而不是"照跑"。 */
function safeRelPath(p) {
  const s = String(p || "");
  if (!s || s.length > 240) return false;
  if (/[;&|`$<>"'\\\n\r\t]/.test(s)) return false;
  if (/^[|]/.test(s) || /[=*?]$/.test(s)) return false;
  if (/^(\.\.[\/\\]|\/|\\|[A-Za-z]:)/.test(s)) return false;      // 上级 / 绝对 / 盘符一律拒
  return true;
}
function quoteArg(p) {
  const s = String(p).replace(/[\r\n]/g, "");
  return /[\s^()\[\]{}%]/.test(s) ? '"' + s + '"' : s;
}

/* ---------- 解析 ---------- */

/* 从一行里抠出 "file:line:col" 或 "file(line,col)"；返回相对路径（去掉 ./）。 */
function locFromLine(line) {
  const s = String(line || "").trim();
  let m = /^(?:[^\s(]*\s+)?([\w./\\-]+\.[A-Za-z]{1,5}):(\d+)(?::(\d+))?/.exec(s);
  if (m) return { file: normRel(m[1]), line: parseInt(m[2], 10), col: m[3] ? parseInt(m[3], 10) : 0 };
  m = /\(([\w./\\-]+\.[A-Za-z]{1,5}):(\d+)(?::(\d+))?\)/.exec(s);
  if (m) return { file: normRel(m[1]), line: parseInt(m[2], 10), col: m[3] ? parseInt(m[3], 10) : 0 };
  m = /File "([^"]+)", line (\d+)/.exec(s);                              // pytest
  if (m) return { file: normRel(m[1]), line: parseInt(m[2], 10), col: 0 };
  return null;
}
function normRel(p) {
  /* 两种输入形状都要收成同一种：
     - POSIX/Windows 单反斜杠："C:\a\b.js" → "C:/a/b.js"
     - YAML 里双写的（node --test 的 tap location 就是这样）："C:\\a\\b.js" → 也要得到 "C:/a/b.js"
     只剥开头的 "./"，不动开头的 "/"：绝对路径留给 relativize 那一步按 cwd 折，
     在这里剥掉斜杠就等于把 "/work/x.js" 说成相对路径 "work/x.js"。 */
  return String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^(?:\.\/)+/, "");
}
/* 把 failures 里的绝对路径按 cwd 折成相对；折不动就原样留着（宁可给绝对路径，也别给错）。 */
function relativizeToCwd(out, cwd) {
  const norm = (p) => {
    const s = String(p || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    return { s, low: s.toLowerCase() };
  };
  const real = (p) => { try { return fs.realpathSync.native(p); } catch (e) { return p; } };
  const base = norm(real(cwd));
  const rel = (p) => {
    if (!p) return p;
    const direct = norm(p);
    if (base.low && (direct.low === base.low || direct.low.startsWith(base.low + "/"))) return direct.s.slice(base.s.length + 1) || direct.s;
    const expanded = norm(real(p));                    // 8.3 短名 → 长名，两种写法在此对上
    if (base.low && (expanded.low === base.low || expanded.low.startsWith(base.low + "/"))) return expanded.s.slice(base.s.length + 1) || expanded.s;
    return direct.s;
  };
  out.failures.forEach((f) => {
    f.file = rel(f.file);
    if (f.at) f.at.file = rel(f.at.file);
  });
}

/* 计数行里的 "3 failed" / "20 passed" / "1 skipped"。 */
function countsFrom(line) {
  const g = (re) => { const m = re.exec(line); return m ? parseInt(m[1], 10) : null; };
  return {
    failed: g(/\b(\d+)\s+failed/i),
    passed: g(/\b(\d+)\s+passed/i),
    skipped: g(/\b(\d+)\s+(skipped|todo|pending)/i),
  };
}
function durationFrom(line) {
  /* "Duration  292ms" / "Time: 1.234 s" / "in 12.5ms"：冒号与数字之间的空格数各家不同，
     写成 (Duration|Time:)([\d.]+) 会一个都命中不了（实测 vitest 是两个空格）。 */
  const m = /(?:Duration|Time:)\s*([\d.]+)\s*(ms|s|seconds)?/i.exec(line) || /\bin\s+([\d.]+)\s*(ms|s)\b/i.exec(line);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === "ms" ? n : n * 1000;
}

/* parse(framework, rawOutput, code) →
   { framework, ok, code, passed, failed, files, failures:[{file,line,test,message}], durationMs, tail }
   解析只许"锦上添花"：认不出来时仍要给出退出码 + 末尾输出，绝不能因为解析失败而谎报通过。
   ok 一律以退出码为准（解析到 0 failed 但退出码非 0，仍然是失败）。 */
function parse(framework, raw, code, opts) {
  const o = opts || {};
  const text = stripAnsi(raw);
  const lines = text.split("\n");
  const out = {
    framework: framework || "generic", code: Number(code) || 0,
    ok: (Number(code) || 0) === 0,
    passed: null, failed: null, total: null, files: null, filesFailed: null, skipped: null, durationMs: null,
    failures: [], tail: lines.slice(-40).join("\n").slice(-4000),
  };
  const seen = new Set();
  const addFail = (f) => {
    const k = (f.file || "") + ":" + (f.line || 0) + ":" + (f.test || "");
    if (seen.has(k)) return;
    seen.add(k);
    out.failures.push(f);
  };

  if (out.framework === "vitest") parseVitest(lines, out, addFail);
  else if (out.framework === "jest") parseJest(lines, out, addFail);
  else if (out.framework === "node-test") parseNodeTest(lines, out, addFail);
  else if (out.framework === "pytest") parsePytest(lines, out, addFail);
  else parseGeneric(lines, out, addFail);

  /* node --test 输出的是绝对路径，而 IDE 与模型说的都是工作区相对坐标。
     不折回来的话 file:line 点不动，回执上写的位置对模型等于"另一个坐标系"。
     ⚠ Windows 上同一目录有两种写法（8.3 短名 C:\Users\ANLAN0~1\… 与长名），
     node 打出来的常常是短名而 config 里存的是长名 —— 纯字符串比前缀会判成两个地方，
     所以比之前各自试一次 realpathSync.native（这台机器的 GitLayer.sameDir 为同样的坑写过一份）。 */
  if (o.cwd) relativizeToCwd(out, o.cwd);
  /* 收窄拼错时框架只会说"没找到测试文件"，退出码非 0。
     这时候最坏的答复是把它翻译成"测试失败"——模型会去改本来没坏的代码。 */
  if (/No test files found|No tests found|never ran any tests/i.test(text)) out.noTestsFound = true;

  /* 失败列表截到 12 条：再多对模型没有边际价值（它一次只能修一处），
     但会把 6000 字预算吃光，挤掉后面的原始输出。 */
  if (out.failures.length > 12) { out.moreFailures = out.failures.length - 12; out.failures = out.failures.slice(0, 12); }
  return out;
}

/* " Test Files  2 failed | 5 passed (7)" / "      Tests  3 failed | 20 passed (23)" / "   Duration  1.23s"
   ⚠ 这三行在真实输出里都带前导空格（v5 是 1～6 个），^Test Files 这种写法一条都命中不了 ——
   命中不了就等于"失败数报不出来"，回执只剩退出码。 */
function parseVitest(lines, out, addFail) {
  let pendingFile = null;
  for (const l of lines) {
    let m;
    if ((m = /^\s*Test Files\s+(.*)$/.exec(l))) { const c = countsFrom(m[1]); const t = /(\d+)\s*\)/.exec(m[1]); out.files = (c.failed || 0) + (c.passed || 0) || (t ? parseInt(t[1], 10) : null); out.filesFailed = c.failed; }
    if ((m = /^\s*Tests\s+(.*)$/.exec(l))) { const c = countsFrom(m[1]); if (c.failed != null) out.failed = c.failed; if (c.passed != null) out.passed = c.passed; if (c.skipped != null) out.skipped = c.skipped; }
    if (/^\s*Duration\s+/.test(l)) out.durationMs = durationFrom(l);
    /* 失败块表头： "⎯⎯⎯ Failed Tests 3 ⎯⎯⎯" 之后是
       " FAIL  test/a.test.js > suite > case" */
    if ((m = /^\s*FAIL\s+(.+)$/.exec(l))) {
      const parts = m[1].split(/\s*>\s*/);
      const loc = locFromLine(parts[0]);
      pendingFile = { file: loc ? loc.file : normRel(parts[0]), line: loc ? loc.line : 0, test: parts.slice(1).join(" › ") };
      continue;
    }
    if (pendingFile && /^\s*(AssertionError|Error|TypeError|Expect|expected)\b/.test(l.trim())) {
      pendingFile.message = (pendingFile.message ? pendingFile.message + " / " : "") + l.trim().slice(0, 300);
    }
    if (pendingFile && /^\s*→\s/.test(l)) { pendingFile.message = ((pendingFile.message || "") + " " + l.replace(/^\s*→\s*/, "")).trim().slice(0, 300); }
    /* 栈定位行： " ❯ test/a.test.js:12:5" —— 取第一个作为可点击位置 */
    if (pendingFile && !pendingFile.at && /❯\s/.test(l)) {
      const loc = locFromLine(l.replace(/^.*❯\s*/, ""));
      if (loc) { pendingFile.at = loc; }
    }
    if (pendingFile && pendingFile.message && pendingFile.at) { addFail(pendingFile); pendingFile = null; }
  }
  if (pendingFile) addFail(pendingFile);
  if (out.failed == null && !out.failures.length && out.ok === false) {
    const m = /Tests\s+(\d+)\s+failed/.exec(out.tail || "");
    if (m) out.failed = parseInt(m[1], 10);
  }
}

/* jest： "● suite › case" 块 + "Tests: 2 failed, 5 passed, 7 total" + "FAIL path" */
function parseJest(lines, out, addFail) {
  let cur = null;
  for (const l of lines) {
    let m;
    if ((m = /^\s*Tests:\s*(.*)$/.exec(l))) { const c = countsFrom(m[1]); out.failed = c.failed; out.passed = c.passed; out.skipped = c.skipped; }
    if ((m = /^\s*Test Suites:\s*(.*)$/.exec(l))) { const c = countsFrom(m[1]); out.filesFailed = c.failed; out.files = (c.failed || 0) + (c.passed || 0) || null; }
    if (/^\s*Time:/.test(l)) out.durationMs = durationFrom(l);
    /* ● 行在真实输出里带两个前导空格（jest 把失败块缩进在文件头下面），
       写 ^● 就一条都提不出来 —— 与 vitest 那几个 \s* 是同一类坑。 */
    if ((m = /^\s*●\s+(.+)$/.exec(l))) {
      if (cur && cur.message) addFail(cur);
      cur = { file: "", line: 0, test: m[1].trim(), message: "" };
      continue;
    }
    if (cur) {
      const loc = /at\s+.*\(([\w./\\-]+\.\w+):(\d+):(\d+)\)/.exec(l) || /at\s+([\w./\\-]+\.\w+):(\d+):(\d+)/.exec(l);
      if (loc && !cur.at) cur.at = { file: normRel(loc[1]), line: parseInt(loc[2], 10), col: parseInt(loc[3], 10) };
      if (!cur.file && (m = /^\s*FAIL\s+(.+)$/.exec(l))) cur.file = normRel(m[1]);
      if (/(expected|Error|toBe|toEqual|Received)/i.test(l) && !cur.message) cur.message = l.trim().slice(0, 300);
    }
  }
  if (cur && cur.message) addFail(cur);
  if (out.failed == null) { const fm = /^Tests:\s*(\d+)\s+failed/m.exec(stripAnsi(out.tail || "")); if (fm) out.failed = parseInt(fm[1], 10); }
}

/* node --test 的 TAP： "not ok 1 - name" + YAML 里 "location: '/p/f.js:12:5'" + "# fail 2" */
function parseNodeTest(lines, out, addFail) {
  let cur = null;            // 正在攒的失败条目
  let pendingLoc = null;     // spec：刚读到 "test at …"，紧跟的那条 ✖ 才是它的用例
  let inErrBlock = false;    // tap：正在读 "error: |-" 之后的缩进正文
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = String(raw).trim();
    let m, mm;
    /* 计数行：spec 前缀是 ℹ，tap 是 #（"ℹ fail 1" / "# fail 1"） */
    if ((m = /^[ℹ#]\s*(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)/.exec(t))) {
      const k = m[1], v = parseInt(m[2], 10);
      if (k === "pass") out.passed = v;
      else if (k === "fail") out.failed = v;
      else if (k === "tests") out.total = v;
      else out.skipped = (out.skipped || 0) + v;
      if (cur) { addFail(cur); cur = null; }
      continue;
    }
    if ((m = /^[ℹ#]\s*duration_ms\s+([\d.]+)/.exec(t))) { out.durationMs = parseFloat(m[1]); continue; }
    if ((m = /^not ok\s+\d+\s*-\s*(.+)$/.exec(t))) {                 // tap 表头
      if (cur) addFail(cur);
      cur = { file: "", line: 0, test: m[1].trim(), message: "", at: null };
      continue;
    }
    if (cur && (m = /^location:\s*'(.+?):(\d+):(\d+)'/.exec(t))) {    // tap YAML 位置：引号把 路径:行:列 整个包住
      cur.at = { file: normRel(m[1]), line: parseInt(m[2], 10), col: parseInt(m[3], 10) };
      cur.file = cur.file || cur.at.file; cur.line = cur.line || cur.at.line;
      continue;
    }
    if (cur && /^error:\s*\|?-?\s*$/.exec(t)) { inErrBlock = true; continue; }
    if (cur && inErrBlock) {
      if (raw.startsWith(" ") && t) { cur.message = ((cur.message || "") + " " + t).trim().slice(0, 300); continue; }
      inErrBlock = false;
    }
    if (cur && (m = /^expected:\s*(.+)$/.exec(t))) {
      const act = /^actual:\s*(.+)$/.exec(String(lines[i + 1] || "").trim());
      if (act) cur.message = ((cur.message || "") + " 期望 " + m[1].trim() + "，实际 " + act[1].trim()).trim().slice(0, 300);
      continue;
    }
    if ((m = /^test at (.+?):(\d+):(\d+)$/.exec(t))) {               // spec 失败段的位置行
      pendingLoc = { file: normRel(m[1]), line: parseInt(m[2], 10), col: parseInt(m[3], 10) };
      continue;
    }
    if ((m = /^[✖×✗]\s+(.+?)\s*\((?:[\d.]+(?:ms|s))\)\s*$/.exec(t))) {
      if (pendingLoc) {                                              // 顶部树状图里的 ✖ 没有前置位置行，跳过
        if (cur) addFail(cur);
        cur = { file: pendingLoc.file, line: pendingLoc.line, test: m[1].trim(), message: "", at: pendingLoc };
        pendingLoc = null;
      }
      continue;
    }
    if (cur) {
      if ((mm = /at\s+\S.*\((?:"([^"]+)"|([^()]+)):(\d+):(\d+)\)\s*$/.exec(t)) && !cur.at) {
        cur.at = { file: normRel(mm[1] || mm[2]), line: parseInt(mm[3], 10), col: parseInt(mm[4], 10) };
      }
      if (!cur.message && /AssertionError|Error:|Expected|!==/.test(t)) cur.message = t.slice(0, 300);
    }
  }
  if (cur) addFail(cur);
}

/* pytest： "FAILED t/x.py::test_y - AssertionError" + "1 failed, 2 passed" + File "x.py", line N */
function parsePytest(lines, out, addFail) {
  for (const l of lines) {
    const c = countsFrom(l);
    if (/failed/i.test(l) && /\d+\s+failed/.test(l)) {
      if (c.failed != null) out.failed = c.failed;
      if (c.passed != null) out.passed = c.passed;
      if (c.skipped != null) out.skipped = c.skipped;
    }
    let m;
    if ((m = /^FAILED\s+(\S+)(?:::(\S+))?\s*(?:-\s+(.*))?$/.exec(l))) {
      addFail({ file: normRel(m[1]), line: 0, test: (m[2] || "").replace(/\(.+\)$/, ""), message: (m[3] || "").slice(0, 300), at: null });
    }
    if ((m = /^E\s+(AssertionError|Error|Failed)\b.*$/.exec(l)) && out.failures.length) {
      const last = out.failures[out.failures.length - 1];
      if (!last.message) last.message = l.replace(/^E\s+/, "").slice(0, 300);
    }
  }
  /* 每个失败用例的正文块以 "_____ test_name _____" 开头，其后第一条 File "x.py", line N 就是位置 */
  const blocks = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^_+ .+ _+\s*$/.test(l));
  for (const { l, i } of blocks.slice(0, 12)) {
    const m = /^_+\s+(\S+\.py)::(\S+)/.exec(l);
    if (!m) continue;
    const f = out.failures.find((x) => x.test === m[2] || (x.file && x.file.endsWith(m[1])));
    if (f && !f.at) {
      for (let k = i + 1; k < Math.min(i + 40, lines.length); k++) {
        const loc = locFromLine(lines[k]);
        if (loc) { f.at = loc; break; }
      }
    }
  }
}

/* 兜底：认不出框架时不编造计数，只给退出码 + 末尾输出，并把像失败的文件行挑出来。 */
function parseGeneric(lines, out, addFail) {
  let failedHint = 0;
  for (const l of lines) {
    if (/\bFAIL(ED|URE)?\b|\bnot ok\b|✗|×/.test(l) && !/failed\s+0|0 failed/i.test(l)) failedHint++;
    const m = /^\s*(?:FAIL(?:ED)?[:\s])+\s*([\w./\\-]+\.\w+)(?::(\d+))?/.exec(l);
    if (m) addFail({ file: normRel(m[1]), line: m[2] ? parseInt(m[2], 10) : 0, test: "", message: l.trim().slice(0, 200), at: null });
  }
  if (out.failed == null && failedHint) out.failed = failedHint;
  out.unrecognized = true;
}

/* format(res, {command, scoped, budget}) → 给模型看的回执。
   顺序是刻意的：结论 → 能点的 file:line → 下一步 → 原始输出尾巴。
   模型一次只能修一处，所以失败列表在最前，而完整日志压到最后（终端标签页里也有）。 */
function format(res, meta) {
  const m = meta || {};
  const budget = m.budget || 6000;
  const fw = FRAMEWORKS[res.framework] ? FRAMEWORKS[res.framework].label : res.framework;
  const head = res.ok
    ? "【测试通过】" + fw + "：" + (res.passed != null ? res.passed + " 个用例通过" : "退出码 0")
      + (res.skipped ? "，" + res.skipped + " 跳过" : "") + (res.durationMs ? "，用时 " + Math.round(res.durationMs) + "ms" : "") + "。"
    : "【测试未通过】" + fw + "：" + (res.failed != null ? res.failed + " 个失败" : "退出码 " + res.code)
      + (res.passed != null ? "，" + res.passed + " 个通过" : "") + (res.durationMs ? "，用时 " + Math.round(res.durationMs) + "ms" : "") + "。";
  const parts = [head];
  if (res.noTestsFound) {
    parts.push("但这次**一个测试文件都没匹配到**（退出码非 0 来自「没找到测试」，不是来自「测试挂了」）。"
      + "先确认 files 里的路径真存在、且落在框架的收集范围内；找不到就退回不带 files 跑一次全量。");
    if (res.tail) parts.push("——— 原始输出末尾 ———\n" + res.tail);
    return parts.join("\n").slice(0, budget);
  }
  if (m.command) parts.push("命令：" + m.command.slice(0, 200) + (m.scoped ? "" : "（未收窄到指定文件）"));
  if (res.failures && res.failures.length) {
    parts.push("失败位置（按 file:line 直接定位）：");
    res.failures.forEach((f, i) => {
      const loc = (f.at && f.at.file) ? f.at.file + ":" + f.at.line : (f.file ? f.file + (f.line ? ":" + f.line : "") : "");
      parts.push((i + 1) + ") " + (loc || "(未给出位置)") + (f.test ? "  · " + f.test : "") + (f.message ? "\n   " + f.message : ""));
    });
    if (res.moreFailures) parts.push("…另有 " + res.moreFailures + " 条未列出（完整列表见 AI 终端标签页）。");
  } else if (!res.ok) {
    parts.push("没能从输出里解析出具体失败位置（这个框架的位置格式不认识）。不要凭猜改，先看下面的原始输出，或用 run_tests 传 command 换一条更安静的命令。");
  }
  if (!res.ok) parts.push("下一步：按上面的位置修，修完用同一批文件再跑一次 run_tests 确认；连改三轮仍不过就停下来把卡点讲给用户。");
  if (res.tail) parts.push("——— 原始输出末尾 ———\n" + res.tail);
  const s = parts.join("\n");
  return s.length > budget ? s.slice(0, budget) + "\n…（回执过长已截断）" : s;
}

module.exports = {
  FRAMEWORKS, detect, build, parse, format, safeRelPath, stripAnsi, frameworkOf, locFromLine,
};
