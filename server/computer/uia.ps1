# ============================================================
# pancode 桌面控制 worker —— 常驻 PowerShell，走 Windows UI Automation。
#
# 为什么是常驻进程而不是每次调用起一个 powershell：实测冷启动 1.0-1.3 秒、
# UIA 程序集加载 + 首次 FindAll 再 373ms。一次"看一眼再点三下"就是十几秒纯开销，
# 所以这个脚本从 stdin 收 JSONL 请求、往 stdout 回 JSONL 响应，进程活到会话结束。
#
# 为什么用 UIA 而不是"截图 + 看像素报坐标"：
# · 元素树是纯文本，能直接进模型（pancode 的工具结果通道只装得下字符串）；
# · InvokePattern/TogglePattern/ValuePattern 点的是控件本身，**不动用户的鼠标**，
#   也不会因为 DPI 缩放或窗口挪位置就点歪 —— 像素坐标那套做不到这点。
# · 代价照实说：自绘界面的应用（游戏、部分 Qt/Electron 没开无障碍）读不到元素，
#   那时退回 SendInput 坐标点击 + 截图给人看。
#
# 协议：一行一个请求 {"id":N,"cmd":"...","args_b64":"<base64(utf8 json)>"}
#        一行一个响应 {"id":N,"ok":true,"data":{...}} 或 {"id":N,"ok":false,"error":"..."}
# 参数为什么走 base64：中文 Windows 上 stdout/stdin 的默认代码页是 936，
# 往 stdin 直接写 UTF-8 的中文会被按 GBK 解 —— 模型要打的中文文本会糊成乱码。
# ============================================================
$ErrorActionPreference = 'Stop'
try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public struct PcMouseInput {
  public int dx; public int dy;
  public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
}
public struct PcKeybInput {
  public ushort wVk; public ushort wScan;
  public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Explicit)]
public struct PcInputUnion {
  [FieldOffset(0)] public PcMouseInput mi;
  [FieldOffset(0)] public PcKeybInput ki;
}
[StructLayout(LayoutKind.Sequential)]
public struct PcInput { public uint type; public PcInputUnion u; }

public static class PcWin32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, PcInput[] inputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern IntPtr PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
  const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_WHEEL = 0x0800;
  const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_SCANCODE = 0x0008;

  public static int CursorX, CursorY;

  public static void Move(int x, int y) {
    PcInput[] a = new PcInput[1];
    a[0].type = INPUT_MOUSE;
    a[0].u.mi.dx = x; a[0].u.mi.dy = y;
    a[0].u.mi.dwFlags = MOUSEEVENTF_MOVE;
    SendInput(1, a, Marshal.SizeOf(typeof(PcInput)));
  }

  public static void Click(int x, int y, bool right, bool triple) {
    Move(x, y);
    uint down = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
    uint up = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
    int times = triple ? 3 : 1;
    for (int i = 0; i < times; i++) {
      PcInput[] a = new PcInput[2];
      a[0].type = INPUT_MOUSE; a[0].u.mi.dwFlags = down;
      a[1].type = INPUT_MOUSE; a[1].u.mi.dwFlags = up;
      SendInput(2, a, Marshal.SizeOf(typeof(PcInput)));
      System.Threading.Thread.Sleep(30);
    }
  }

  public static void Wheel(int notches) {
    PcInput[] a = new PcInput[1];
    a[0].type = INPUT_MOUSE;
    a[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL;
    a[0].u.mi.mouseData = (uint)(notches * 120);
    SendInput(1, a, Marshal.SizeOf(typeof(PcInput)));
  }

  public static void TypeUnicode(string text) {
    foreach (char c in text) {
      PcInput[] a = new PcInput[2];
      a[0].type = INPUT_KEYBOARD; a[0].u.ki.wVk = 0; a[0].u.ki.wScan = (ushort)c; a[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
      a[1].type = INPUT_KEYBOARD; a[1].u.ki.wVk = 0; a[1].u.ki.wScan = (ushort)c; a[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      SendInput(2, a, Marshal.SizeOf(typeof(PcInput)));
    }
  }

  public static void Combo(ushort[] vks) {
    PcInput[] a = new PcInput[2];
    a[0].type = INPUT_KEYBOARD; a[0].u.ki.wVk = vks[0];
    a[1].type = INPUT_KEYBOARD; a[1].u.ki.wVk = vks[1];
    SendInput(2, a, Marshal.SizeOf(typeof(PcInput)));
    PcInput[] b = new PcInput[2];
    b[0].type = INPUT_KEYBOARD; b[0].u.ki.wVk = vks[1]; b[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
    b[1].type = INPUT_KEYBOARD; b[1].u.ki.wVk = vks[0]; b[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, b, Marshal.SizeOf(typeof(PcInput)));
  }

  public static void Tap(ushort vk, bool up) {
    PcInput[] a = new PcInput[1];
    a[0].type = INPUT_KEYBOARD; a[0].u.ki.wVk = vk;
    if (up) a[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(1, a, Marshal.SizeOf(typeof(PcInput)));
  }
}
'@

# DPI 感知必须在任何截图 / 取矩形之前设：不设的话在 125%/150% 缩放屏上
# 拿到的是被系统虚拟化过的坐标，点哪偏哪，截图也是糊的。-4 = PER_MONITOR_AWARE_V2。
try { [PcWin32]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch { }

$script:VM_CX = 78; $script:VM_CY = 79; $script:VM_X = 76; $script:VM_Y = 77
$script:REFS = @{}
$script:REFSEQ = 0

$VK = @{
  control = 17; ctrl = 17; alt = 18; menu = 18; shift = 16; windows = 91; win = 91; meta = 91;
  enter = 13; return = 13; tab = 9; escape = 27; esc = 27; space = 32; backspace = 8;
  delete = 46; del = 46; insert = 45; home = 36; end = 35; pgup = 33; pageup = 33;
  pgdn = 34; pagedown = 34; left = 37; up = 38; right = 39; down = 40;
  f1 = 112; f2 = 113; f3 = 114; f4 = 115; f5 = 116; f6 = 117; f7 = 118; f8 = 119;
  f9 = 120; f10 = 121; f11 = 122; f12 = 123; printscreen = 44; capslock = 20;
}

function VkOf([string]$name) {
  $n = $name.Trim().ToLowerInvariant()
  if ($VK.ContainsKey($n)) { return [uint16]$VK[$n] }
  if ($n.Length -eq 1) {
    $ch = [int][char]$n.ToUpper()[0]
    if ($ch -ge 65 -and $ch -le 90) { return [uint16]$ch }
    if ($ch -ge 48 -and $ch -le 57) { return [uint16]$ch }
  }
  throw "不认识的键名：$name（支持 Enter / Tab / Escape / Space / PageUp / PageDown / Home / End / Delete / F1-F12 / 字母数字，以及 control、alt、shift、win 这几个修饰键的组合写法 Control+a）"
}

function Write-Out($obj) {
  # 只走 stdout，且一行一条；任何 PowerShell 的隐式输出漏进来都会破坏协议。
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Depth 8 -Compress))
}

function Rect-Of($el) {
  try { $r = $el.Current.BoundingRectangle; if ([double]::IsNaN($r.Width)) { return $null }
    return @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height } } catch { return $null }
}

function Ctrl-Name($el) {
  try { ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') } catch { 'Unknown' }
}

function Patterns-Of($el) {
  $p = @()
  $checks = @(
    @('invoke',  [System.Windows.Automation.InvokePattern]::Pattern),
    @('toggle',  [System.Windows.Automation.TogglePattern]::Pattern),
    @('value',   [System.Windows.Automation.ValuePattern]::Pattern),
    @('select',  [System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('expand',  [System.Windows.Automation.ExpandCollapsePattern]::Pattern),
    @('scroll',  [System.Windows.Automation.ScrollPattern]::Pattern),
    @('range',   [System.Windows.Automation.RangeValuePattern]::Pattern)
  )
  foreach ($c in $checks) {
    try { $o = $null; if ($el.TryGetCurrentPattern($c[1], [ref]$o)) { $p += $c[0] } } catch { }
  }
  return $p
}

function Register-Ref($el) {
  $script:REFSEQ++
  $id = 'e' + $script:REFSEQ
  $script:REFS[$id] = $el
  return $id
}

function Element-By-Ref([string]$id) {
  $k = $id -replace '^@', ''
  if (-not $script:REFS.ContainsKey($k)) { throw "ref $id 不存在或已过期：重新调 desktop_snapshot 取新的 ref（页面/窗口一变，旧 ref 就全部作废）" }
  return $script:REFS[$k]
}

# ——— 命令实现 ———

function Cmd-Ping($a) {
  $vm = [PcWin32]::GetSystemMetrics(78); $vmy = [PcWin32]::GetSystemMetrics(79)
  return @{ platform = 'win32'; virtualScreen = @{ w = $vm; h = $vmy }; refs = $script:REFS.Count }
}

function Cmd-Screen($a) {
  $screens = @()
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $screens += @{ index = $screens.Count; primary = $s.Primary; x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height; device = $s.DeviceName }
  }
  return @{ screens = $screens; virtualW = [PcWin32]::GetSystemMetrics(78); virtualH = [PcWin32]::GetSystemMetrics(79) }
}

function Cmd-Windows($a) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $out = @()
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    $n = ''
    try { $n = $w.Current.Name } catch { }
    $r = Rect-Of $w
    $ct = Ctrl-Name $w
    if (-not $a.includeHidden -and ([string]::IsNullOrEmpty($n))) { continue }
    if (-not $a.includeHidden -and ($ct -eq 'Pane' -and $n -match '-(siw|Overlay)$')) { continue }
    $hwnd = 0
    try { $hwnd = [int64]$w.Current.NativeWindowHandle } catch { }
    $min = $false
    if ($hwnd -ne 0) { try { $min = [PcWin32]::IsIconic([IntPtr]$hwnd) } catch { } }
    $out += @{
      ref = (Register-Ref $w); title = $n; control = $ct; pid = $w.Current.ProcessId
      hwnd = $hwnd; rect = $r; minimized = $min; foreground = ($hwnd -ne 0 -and [PcWin32]::GetForegroundWindow() -eq [IntPtr]$hwnd)
    }
  }
  return @{ windows = $out }
}

function Cmd-Tree($a) {
  $el = $null
  if ($a.window_ref) { $el = Element-By-Ref $a.window_ref }
  elseif ($a.title) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      try { if ($w.Current.Name -like ('*' + $a.title + '*')) { $el = $w; break } } catch { }
    }
    if (-not $el) { throw ("找不到标题含「" + $a.title + "」的窗口；先 desktop_windows 看清列表，别猜标题") }
  } else { throw 'desktop_snapshot 需要 window_ref（来自 desktop_windows）或 title（窗口标题里的片段）' }

  $maxDepth = if ($a.max_depth) { [int]$a.max_depth } else { 6 }
  $maxNodes = if ($a.max_nodes) { [int]$a.max_nodes } else { 220 }
  $kw = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $lines = [System.Collections.Generic.List[string]]::new()
  $script:count = 0; $script:truncated = $false

  function Walk($node, $depth) {
    if ($script:count -ge $maxNodes) { $script:truncated = $true; return }
    $script:count++
    $name = ''
    try { $name = $node.Current.Name } catch { }
    if ($name.Length -gt 70) { $name = $name.Substring(0, 70) + '…' }
    $r = Rect-Of $node
    $vis = $true
    try { $vis = $node.Current.IsOffscreen -eq $false } catch { }
    if (-not $vis -and -not $a.include_offscreen) { return }
    $id = Register-Ref $node
    $pat = Patterns-Of $node
    $tag = @()
    if ($r) { $tag += ('rect=' + $r.x + ',' + $r.y + ',' + $r.w + ',' + $r.h) }
    if ($pat.Count) { $tag += ('can=' + ($pat -join '/')) }
    $lead = (' ' * ($depth * 2)) + '- ' + (Ctrl-Name $node)
    if ($name) { $lead += ' "' + ($name -replace '"', "'") + '"' }
    $lines.Add($lead + ' [ref=' + $id + (', ' + ($tag -join ', ')) + ']')
    if ($depth -ge $maxDepth) { return }
    $child = $null
    try { $child = $kw.GetFirstChild($node) } catch { }
    while ($null -ne $child) {
      Walk $child ($depth + 1)
      if ($script:truncated) { return }
      $next = $null
      try { $next = $kw.GetNextSibling($child) } catch { }
      $child = $next
    }
  }

  Walk $el 0
  return @{ tree = ($lines -join "`n"); nodes = $script:count; truncated = $script:truncated; title = $el.Current.Name }
}

function Cmd-Act($a) {
  $el = Element-By-Ref $a.ref
  $what = $a.action
  $done = ''
  if ($what -eq 'click') {
    $o = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) {
      $o.Invoke(); $done = 'InvokePattern（没动鼠标）'; return @{ how = $done }
    }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) {
      $o.Toggle(); return @{ how = 'TogglePattern（勾选状态翻转，没动鼠标）' }
    }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) {
      $o.Select(); return @{ how = 'SelectionItemPattern（没动鼠标）' }
    }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) {
      $o.Expand(); return @{ how = 'ExpandCollapsePattern（展开，没动鼠标）' }
    }
  }
  if ($what -eq 'check' -or $what -eq 'uncheck') {
    $o = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$o)) {
      $target = if ($what -eq 'check') { [System.Windows.Automation.ToggleState]::On } else { [System.Windows.Automation.ToggleState]::Off }
      if ($o.Current.ToggleState -ne $target) { $o.Toggle() }
      return @{ how = 'TogglePattern -> ' + $what }
    }
    throw '这个元素没有勾选模式（TogglePattern），换 desktop_click 按坐标点'
  }
  if ($what -eq 'set_value') {
    $o = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) {
      try { $o.IsReadOnly = $false } catch { }
      $o.SetValue([string]$a.text); return @{ how = 'ValuePattern.SetValue（不抢焦点、不动鼠标）' }
    }
    throw '这个元素不支持直接写值（ValuePattern），改用 desktop_type 让它先拿到焦点'
  }
  if ($what -eq 'focus') {
    $el.SetFocus(); return @{ how = 'SetFocus' }
  }
  if ($what -eq 'text') {
    $txt = ''
    try { $tp = $null; if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { $txt = $tp.DocumentRange.GetText(-1) } } catch { }
    if (-not $txt) { try { $txt = $el.Current.Name } catch { } }
    return @{ text = $txt }
  }

  # 没有任何可用模式：退到坐标点击（真的会移动光标，需要用户授权）
  $r = Rect-Of $el
  if ($what -ne 'click_by_point' -and $null -ne $r -and $r.w -gt 0) {
    [PcWin32]::Click(($r.x + [int]($r.w / 2)), ($r.y + [int]($r.h / 2)), [bool]$a.right, [bool]$a.triple)
    return @{ how = '坐标点击（移动了真实光标）'; point = @{ x = ($r.x + [int]($r.w / 2)); y = ($r.y + [int]($r.h / 2)) } }
  }
  throw "对 ref $($a.ref) 做 $what 失败：既没有可用的 UIA 模式也没有有效矩形。重新 desktop_snapshot 拿新 ref，或用 desktop_click 传 x/y。"
}

function Cmd-Click-Point($a) {
  [PcWin32]::Click([int]$a.x, [int]$a.y, [bool]$a.right, [bool]$a.triple)
  return @{ how = '坐标点击'; point = @{ x = [int]$a.x; y = [int]$a.y } }
}

function Cmd-Type($a) {
  $text = [string]$a.text
  if ($text.Length -gt 2000) { throw '一次输入的文本超过 2000 字符，请分段（避免把整篇文档灌进一次按键风暴）' }
  if ($a.ref) {
    $el = Element-By-Ref $a.ref
    $o = $null
    if ($a.use_value -ne $false -and $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) {
      try { $o.IsReadOnly = $false } catch { }
      $o.SetValue($text)
      return @{ how = 'ValuePattern.SetValue'; chars = $text.Length; took_focus = $false }
    }
    $el.SetFocus()
  }
  [PcWin32]::TypeUnicode($text)
  if ($a.enter) { Start-Sleep -Milliseconds 40; [PcWin32]::Tap(13, $false); [PcWin32]::Tap(13, $true) }
  return @{ how = 'SendInput(Unicode)'; chars = $text.Length; took_focus = $true }
}

function Cmd-Keys($a) {
  $spec = ([string]$a.keys).Trim()
  $parts = $spec.Split('+')
  if ($parts.Count -eq 1) {
    $vk = VkOf $parts[0]
    if ($vk -eq 0) { [PcWin32]::TypeUnicode($parts[0]) } else { [PcWin32]::Tap($vk, $false); [PcWin32]::Tap($vk, $true) }
    return @{ how = '单键'; keys = $spec }
  }
  $mods = @(); $last = $null
  for ($i = 0; $i -lt $parts.Count - 1; $i++) { $mods += (VkOf $parts[$i]) }
  $last = VkOf $parts[$parts.Count - 1]
  $prev = @()
  foreach ($m in $mods) { [PcWin32]::Tap($m, $false); $prev += $m }
  [PcWin32]::Tap($last, $false); [PcWin32]::Tap($last, $true)
  for ($i = $prev.Count - 1; $i -ge 0; $i--) { [PcWin32]::Tap($prev[$i], $true) }
  return @{ how = '组合键'; keys = $spec }
}

function Cmd-Scroll($a) {
  $n = [int]$a.amount
  if ($n -eq 0) { $n = 3 }
  [PcWin32]::Wheel($n)
  return @{ how = '滚轮'; notches = $n }
}

function Cmd-Window($a) {
  $el = Element-By-Ref $a.ref
  $hwnd = 0
  try { $hwnd = [int64]$el.Current.NativeWindowHandle } catch { }
  if ($hwnd -eq 0) { throw '这个窗口句柄不可用（可能是虚拟容器），换 desktop_act 走元素模式' }
  $h = [IntPtr]$hwnd
  $act = $a.action
  switch ($act) {
    'activate' { [PcWin32]::ShowWindow($h, 9) | Out-Null; [PcWin32]::SetForegroundWindow($h) | Out-Null }
    'minimize' { [PcWin32]::ShowWindow($h, 6) | Out-Null }
    'maximize' { [PcWin32]::ShowWindow($h, 3) | Out-Null }
    'restore'  { [PcWin32]::ShowWindow($h, 5) | Out-Null }
    'close'    { [PcWin32]::PostMessageW($h, 16, [IntPtr]0, [IntPtr]0) | Out-Null }
    'move'     { $r = Rect-Of $el; [PcWin32]::MoveWindow($h, [int]$a.x, [int]$a.y, $r.w, $r.h, $true) | Out-Null }
    'resize'   { $r = Rect-Of $el; [PcWin32]::MoveWindow($h, $r.x, $r.y, [int]$a.w, [int]$a.h, $true) | Out-Null }
    default    { throw "desktop_window 不支持的动作：$act（可用 activate/minimize/maximize/restore/close/move/resize）" }
  }
  return @{ how = $act; hwnd = $hwnd; title = $el.Current.Name }
}

function Cmd-Shot($a) {
  $x = [int]$a.x; $y = [int]$a.y; $w = [int]$a.w; $h = [int]$a.h
  if ($a.ref) {
    $el = Element-By-Ref $a.ref
    $r = Rect-Of $el
    if ($null -eq $r -or $r.w -le 0) { throw '这个元素的矩形不可用（自绘窗口常见），改用整屏截图' }
    $x = $r.x; $y = $r.y; $w = $r.w; $h = $r.h
  }
  if (-not $w -or -not $h) { $x = [PcWin32]::GetSystemMetrics(76); $y = [PcWin32]::GetSystemMetrics(77); $w = [PcWin32]::GetSystemMetrics(78); $h = [PcWin32]::GetSystemMetrics(79) }
  if ($w -le 0 -or $h -le 0) { throw '截图区域非法' }
  if ($w -gt 8000 -or $h -gt 8000) { throw '截图尺寸过大（>8000），请指定窗口或区域' }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h)) }
  finally { $g.Dispose() }
  $bmp.Save([string]$a.path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return @{ path = [string]$a.path; w = $w; h = $h }
}

$DISPATCH = @{
  ping = { param($a) Cmd-Ping $a }
  screen = { param($a) Cmd-Screen $a }
  windows = { param($a) Cmd-Windows $a }
  tree = { param($a) Cmd-Tree $a }
  act = { param($a) Cmd-Act $a }
  click_point = { param($a) Cmd-Click-Point $a }
  type = { param($a) Cmd-Type $a }
  keys = { param($a) Cmd-Keys $a }
  scroll = { param($a) Cmd-Scroll $a }
  window = { param($a) Cmd-Window $a }
  shot = { param($a) Cmd-Shot $a }
}

Add-Type -AssemblyName System.Windows.Forms

Write-Out @{ id = 0; ok = $true; ready = $true; version = $PSVersionTable.PSVersion.ToString() }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json $line
    $id = $req.id
    if ($req.cmd -eq 'shutdown') { Write-Out @{ id = $id; ok = $true; data = @{ bye = $true } }; break }
    if (-not $DISPATCH.ContainsKey($req.cmd)) { throw ("不支持的命令：" + $req.cmd) }
    # $args 在 PowerShell 里是自动变量（脚本自身的位置参数），不复用它：
    # 这里叫 argv，免得哪天给脚本传了参数就被无声覆盖。
    $argv = @{}
    if ($req.args_b64) {
      $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$req.args_b64))
      $o = ConvertFrom-Json $json
      foreach ($p in $o.PSObject.Properties) { $argv[$p.Name] = $p.Value }
    }
    $data = & $DISPATCH[$req.cmd] $argv
    Write-Out @{ id = $id; ok = $true; data = $data }
  } catch {
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $msg = $_.ErrorDetails.Message }
    Write-Out @{ id = $id; ok = $false; error = $msg }
  }
}
