# -*- coding: utf-8 -*-
# W4 patch: public/index.html — 自动化任务入口按钮 + 弹窗 + script
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "public", "index.html")
src = io.open(p, "r", encoding="utf-8").read()
applied = []

def patch_once(name, old, new):
    global src
    n = src.count(old)
    assert n == 1, "%s: expect 1 occurrence, got %d" % (name, n)
    src = src.replace(old, new)
    applied.append(name)

# ---- 1. 工具栏按钮（紧跟 btnWorkflow 之后） ----
patch_once(
    "toolbar-btn",
    '<button id="btnWorkflow" class="tb-icon-btn" data-i18n-title="workflow" title="工作流"><i data-ico="tasklist"></i></button>',
    '<button id="btnWorkflow" class="tb-icon-btn" data-i18n-title="workflow" title="工作流"><i data-ico="tasklist"></i></button>\n'
    '      <button id="btnAutomations" class="tb-icon-btn" title="自动化任务（定时跑测试 / 依赖审计 / 健康报告）"><i data-ico="clock"></i></button>',
)

# ---- 2. 弹窗（插在 Skill 创建弹窗注释之前） ----
modal = '''<!-- ======================= W4 自动化任务弹窗 ======================= -->
<div id="automationsModal" style="display:none">
  <div class="set-box" style="max-width:680px">
    <div class="set-head"><span><i data-ico="clock"></i> 自动化任务</span><button id="automationsClose"><i data-ico="close"></i></button></div>
    <div class="set-body">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <button id="btnAutoNew" class="set-btn" style="background:var(--accent);color:#fff">＋ 新建任务</button>
        <button class="set-btn auto-tpl" data-tpl="0">🕘 定时跑测试</button>
        <button class="set-btn auto-tpl" data-tpl="1">🔐 夜间依赖审计</button>
        <button class="set-btn auto-tpl" data-tpl="2">📈 每周代码健康</button>
      </div>
      <div id="autoForm" style="display:none;border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
        <div class="set-row"><label>任务名称 *</label><input id="autoName" type="text" placeholder="如：定时跑测试"></div>
        <div class="set-row"><label>任务提示词（到点交给子智能体执行）*</label><textarea id="autoPrompt" rows="3" placeholder="如：运行 npm test 并汇总失败用例，不要修复"></textarea></div>
        <div class="set-row" style="display:flex;gap:8px">
          <div style="flex:1"><label>调度类型</label>
            <select id="autoType" style="width:100%;padding:6px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--text)">
              <option value="cron">周期（cron 表达式）</option>
              <option value="once">一次性（指定时间）</option>
            </select></div>
          <div id="autoCronRow" style="flex:1"><label>Cron 表达式（分 时 日 月 周）</label><input id="autoCron" type="text" placeholder="0 */2 * * *"></div>
          <div id="autoAtRow" style="flex:1;display:none"><label>执行时间</label><input id="autoAt" type="datetime-local"></div>
        </div>
        <div id="autoStatus" class="set-status"></div>
        <div class="set-row" style="display:flex;justify-content:flex-end"><button id="btnAutoSave" class="set-btn" style="background:var(--accent);color:#fff">创建任务</button></div>
      </div>
      <div id="autoList"></div>
    </div>
  </div>
</div>

<!-- ======================= Skill 创建弹窗 ======================= -->'''
patch_once("modal", "<!-- ======================= Skill 创建弹窗 ======================= -->", modal)

# ---- 3. script 标签（紧跟 skill-market.js） ----
patch_once(
    "script-tag",
    '<script src="js/skill-market.js"></script>',
    '<script src="js/skill-market.js"></script>\n  <script src="js/automations.js"></script>',
)

newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("index.html -> .new written:", ", ".join(applied))
