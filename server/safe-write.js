/* ============================================================
   pancode 安全写入工具（Phase 3 · A5 并发安全）
   - atomicWrite：写临时文件 → rename 顶替，进程崩溃也不会截断 JSON
   - enqueueWrite：按"绝对路径"串行化写入，防止并发请求 / async 窗口覆盖丢更新
   ============================================================ */
"use strict";
const fs = require("fs");
const log = require("./logger");
const path = require("path");

const queues = new Map(); // 绝对路径 -> Promise chain
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* atomicWrite 最坏情况下的退避总跨度（ms）。
   导出它，是为了让「等落盘」的测试预算从实现里推导，而不是在测试里另写一个魔数
   —— 后者必然漂移：实现把重试次数或系数一调，测试就变成一个随机失败的 flake
   （实测踩过：预算写 4000ms，而 ladder 最坏 ~10.9s，全量并发跑时偶发失败）。 */
const RETRY_BASE_MS = 100, RETRY_FACTOR = 3, RETRY_ATTEMPTS = 6;
const WORST_CASE_WRITE_MS = RETRY_ATTEMPTS <= 1 ? 0 :
  Math.round(RETRY_BASE_MS * (Math.pow(RETRY_FACTOR, RETRY_ATTEMPTS - 1) - 1) / (RETRY_FACTOR - 1));

/* 原子写（async）：临时文件写成功后 rename 顶替目标文件；rename 失败（如覆盖已存在文件）降级直写。
   Windows 下「刚创建即被改写」常撞上杀软/句柄瞬时锁（EPERM，可持续数秒）→
   异步指数退避重试（100/300/900/2400/7200ms，总跨度 ~10.9s），不阻塞事件循环。
   永不抛错：成功返回 true，最终失败返回 false（调用方按需校验），杜绝 unhandled rejection。 */
async function atomicWrite(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, attempt - 1));
    const tmp = p + "." + process.pid + ".tmp";
    try {
      fs.writeFileSync(tmp, data, "utf8");
      try {
        fs.renameSync(tmp, p);
      } catch (e) {
        fs.writeFileSync(p, data, "utf8");   // 降级：直接覆盖写（牺牲原子性保成功）
      }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}  // 尽力清理临时文件
      return true;
    } catch (e) {
      lastErr = e; // tmp 写与降级写均被锁 → 退避后重试
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    }
  }
  log.tag("safe-write").error("写入失败（重试后仍被锁）: " + p, { err: lastErr && lastErr.message });
  return false;
}

/* 按路径串行化：同一文件的多次写入排队执行，避免交错覆盖。fn 可为异步。
   键走 path.resolve：同一个文件的两种写法（相对 / 反斜杠 / 大小写盘符）以前会落到两条队列上，
   于是"串行"名不副实；hasPending 也依赖这个键才能问得准。 */
const qkey = (p) => path.resolve(p);
function enqueueWrite(p, fn) {
  const k = qkey(p);
  const prev = queues.get(k) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (queues.get(k) === next) queues.delete(k);
  });
  queues.set(k, next);
  return next;
}

/* 这个路径上还有没有"已入队但没跑完"的写？
   给 config.readJsonSafe 用：在途写意味着盘上那份一定是旧的，
   拿 mtime 猜不如直接问队列（见 server/config.js 的注释）。 */
function hasPending(p) { try { return queues.has(qkey(p)); } catch (e) { return false; } }

/* 便捷方法：序列化 → 串行 → 原子落盘（resolve 后可读己之写） */
function saveJson(p, obj) {
  let data;
  try { data = JSON.stringify(obj, null, 2); }
  catch (e) { log.tag("safe-write").error("序列化失败: " + p, e); return Promise.resolve(); }
  return enqueueWrite(p, async () => { await atomicWrite(p, data); });
}

/* ============================================================
   孤儿临时文件清理（修 S-H4）
   atomicWrite 的临时名是 "<目标名>.<pid>.tmp"（见 :22），所以任何
   走 safe-write 的落盘点都可能留下孤儿——实测 .pancode/{skills,memory,
   progression,automations/*} 下就躺着 7 个。原先的清理只认根目录一个模式
   （pancode.config.json.<pid>.tmp），其余全部漏掉，等于没清。

   按 pid 判活，而不是按文件名模式无脑删：并发跑着的另一个 pancode 实例
   正在用它自己的 .tmp，删了会打断它的原子写（表现为"另一个窗口保存失败"）。
   只有确认写它的进程已经不在了，才是孤儿。
   ============================================================ */
const TMP_RE = /\.\d+\.tmp$/;

/* pid 是否还活着。EPERM = 进程存在但本用户无权发信号，同样算活着；
   ESRCH = 确已退出，才是可清的孤儿。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

/* 递归收集 root 下的孤儿 .tmp。depth 有限（分片目录不深，3 层足够），
   maxFiles 兜底防止误指到超大目录时把内存吃满。 */
function sweepTmpOrphans(root, opts) {
  const o = opts || {};
  const maxDepth = o.maxDepth == null ? 3 : o.maxDepth;
  const maxFiles = o.maxFiles == null ? 500 : o.maxFiles;
  const removed = [];
  const kept = [];
  let scanned = 0;

  function walk(dir, depth) {
    if (depth > maxDepth || scanned >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }                       // 目录不可读/不存在：跳过，不算失败
    for (const ent of entries) {
      if (scanned >= maxFiles) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, depth + 1); continue; }
      scanned++;
      if (!TMP_RE.test(ent.name)) continue;
      // 从尾巴抠 pid：….<pid>.tmp
      const m = /\.(\d+)\.tmp$/.exec(ent.name);
      const pid = m ? Number(m[1]) : NaN;
      if (pidAlive(pid)) { kept.push(full); continue; }
      try { fs.unlinkSync(full); removed.push(full); }
      catch (e) { kept.push(full); }             // 被锁住就留着，下次启动再试
    }
  }
  walk(root, 0);
  return { removed, kept, scanned };
}

module.exports = { atomicWrite, enqueueWrite, hasPending, saveJson, sweepTmpOrphans, pidAlive, WORST_CASE_WRITE_MS };
