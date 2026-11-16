# 点击自检：真弹一张卡片，在「真鼠标输入」这一层点下去，再看结果对不对。
#
# 为什么不能用离屏图代替：离屏 PNG 只能证明长相，证明不了
#   ① 按钮真在算出来的那个坐标上（命中区没错位）；
#   ② 防误点计时到期后按钮真的活过来；
#   ③ 点击 → 页面 send() → postMessage → 宿主 → 结果文件 这条链是通的。
# 所以这里用 SetCursorPos + mouse_event 往屏幕上注入一次真实鼠标输入（和手点走同一条输入栈），
# 点完再读结果文件。坐标由窗口矩形推出（见 Get-TargetPoint 的推导），不用肉眼估。
#
# 用法（要在宿主里直接跑，弹窗与宿主继承同一套启动条件）：
#   & <repo>\dsh-approval-notifier\tests\card-click.ps1 -Target allow
#   & ... -Target deny
#   & ... -Target close      # ✕ = 不做决定
# 退出码：0 = 点完得到预期结果，1 = 没弹出来 / 点空 / 结果不对。

[CmdletBinding()]
param(
  [ValidateSet('allow', 'deny', 'close')][string]$Target = 'allow',
  # 窗口出现后等多久再点（必须大于 armDelayMs，否则按钮还没活）。
  # 默认给足 6 秒：弹窗是给人看的，点太快连「它长什么样」都看不清，而且留出时间让人把手从鼠标上拿开。
  [int]$DelayMs = 6000,
  [string]$WorkDir = '',
  [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $pluginRoot 'scripts\prompt.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw "找不到弹窗脚本: $scriptPath" }
. (Join-Path $pluginRoot 'scripts\ui\environment.ps1')

# 本文件只用得到几个输入相关的 P/Invoke，不往插件的 production 代码里塞测试用的东西。
if (-not ('DshClickProbe' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshClickProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
}

if ([string]::IsNullOrWhiteSpace($WorkDir)) {
  $workspaceRoot = Split-Path -Parent $pluginRoot
  $WorkDir = Join-Path $workspaceRoot '.session-files\tmp\card-click'
}
if (-not (Test-Path -LiteralPath $WorkDir)) { [void](New-Item -ItemType Directory -Path $WorkDir -Force) }

# 窗口与按钮的关系（CSS px，乘 DPI 缩放）：
#   卡片铺满窗口，.card 内边距 16；按钮是 antd 默认尺寸（高 32、左右内边距 15），
#   Space 的间距 8。两个按钮按「拒绝、允许一次」的顺序排在页脚右侧：
#     允许一次（4 个汉字 56 + 30）→ 宽 86，中心 = 右边 - 16 - 43 = 右边 - 59
#     拒绝（2 个汉字 28 + 30）→ 宽 58，中心 = 右边 - 16 - 86 - 8 - 29 = 右边 - 139
#     按钮竖直中心 = 底边 - 16 - 32/2 = 底边 - 32
#     ✕ 中心 = 右边 - 16 - 24/2 = 右边 - 28，顶边 20 + 12 = 顶边 + 32
# 这些数字来自 shared/ui-card/app/src/styles.css 与 antd 默认控件尺寸
# （tests/card-shell.ps1 守着「按钮 kind 只有 primary/default」，几何由出图验收兜底）。
# 布局一改（外壳在仓库根，改的是共享文件）这里就该跟着改 —— 不跟着改就会点空，
# 而点空正好说明「按钮不在你以为的地方」，测试失败是有意义的信号。
function Get-TargetPoint {
  param([System.Drawing.Rectangle]$Rect, [double]$Scale, [string]$Kind)
  $unit = { param($v) [int][Math]::Round($v * $Scale) }
  switch ($Kind) {
    'allow' { return @{ X = $Rect.Right - (& $unit 59); Y = $Rect.Bottom - (& $unit 32) } }
    'deny' { return @{ X = $Rect.Right - (& $unit 139); Y = $Rect.Bottom - (& $unit 32) } }
    # ✕ = 抬头右上角 24x24 图标按钮的中心。
    'close' { return @{ X = $Rect.Right - (& $unit 28); Y = $Rect.Top + (& $unit 32) } }
  }
}

function Find-OwnWindow {
  $hits = New-Object 'System.Collections.Generic.List[System.IntPtr]'
  $callback = [DshClickProbe+EnumProc]{
    param($hwnd, $lparam)
    [uint32]$owner = 0
    [void][DshClickProbe]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($owner -eq $PID -and [DshClickProbe]::IsWindowVisible($hwnd)) { $hits.Add($hwnd) }
    return $true
  }
  [void][DshClickProbe]::EnumWindows($callback, [IntPtr]::Zero)
  if ($hits.Count -eq 0) { return [IntPtr]::Zero }
  return $hits[0]
}

$stamp = Get-Date -Format 'HHmmss'
$payloadFile = Join-Path $WorkDir "payload-$stamp.json"
$outFile = Join-Path $WorkDir "result-$stamp.json"
$shotFile = Join-Path $WorkDir "before-click-$stamp.png"
$payload = [ordered]@{
  windowTitle = "DSH 审批请求 · 点击自检 $stamp"
  metaCaption = '工作区'
  meta = 'C:\work\dsh-plugins'
  reasonCaption = '模型给出的理由：'
  reason = '允许本次操作使用 danger-full-access 权限：点一下按钮，看结果文件里是不是真的写下了决定。'
  commandCaption = '模型请求执行的内容（原文）：'
  command = 'pwsh -NoProfile -Command Get-Date'
  sound = $false
  armDelayMs = 800
  closeAfterMs = 30000
  slot = 0
}
Set-Content -LiteralPath $payloadFile -Value ($payload | ConvertTo-Json -Depth 4) -Encoding utf8 -ErrorAction Stop
Remove-Item -LiteralPath $outFile, "$outFile.diag" -Force -ErrorAction SilentlyContinue

$scale = Get-ApprovalDpiScale
$clickInfo = @{ clicked = $false; point = ''; windowRect = ''; error = ''; cursorAfterMove = ''; attempts = 0 }

# 用 WinForms 定时器在弹窗自己的消息循环里注入点击：ShowDialog / Application.Run 期间它照样触发。
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(200, $DelayMs)
$timer.Add_Tick({
    $timer.Stop()
    try {
      $hwnd = Find-OwnWindow
      if ($hwnd -eq [IntPtr]::Zero) { $clickInfo.error = '找不到本进程的可见窗口'; return }
      $rect = [DshClickProbe+RECT]::new()
      [void][DshClickProbe]::GetWindowRect($hwnd, [ref]$rect)
      $r = [System.Drawing.Rectangle]::FromLTRB($rect.Left, $rect.Top, $rect.Right, $rect.Bottom)
      $clickInfo.windowRect = "$($r.Left),$($r.Top) $($r.Width)x$($r.Height)"
      $pt = Get-TargetPoint -Rect $r -Scale $scale -Kind $Target
      $clickInfo.point = "$($pt.X),$($pt.Y)"
      # 点之前先确认这个点落在弹窗矩形里 —— 否则宁可不点（会点到别的东西）。
      if ($pt.X -lt $r.Left -or $pt.X -gt $r.Right -or $pt.Y -lt $r.Top -or $pt.Y -gt $r.Bottom) {
        $clickInfo.error = '算出来的点不在窗口矩形里，放弃点击'
        return
      }
      $saved = [DshClickProbe+POINT]::new()
      [void][DshClickProbe]::GetCursorPos([ref]$saved)
      # 点之前必须先“移过去”再按下：只 SetCursorPos 不产生输入事件，Chromium 会拿上一次
      # 已知的指针位置去命中，点击就落到别处（实测：只 SetCursorPos 时拒绝按钮点不动）。
      # 这里用绝对坐标的 MOVE（0x8001 = MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE，
      # 坐标按主屏归一化到 0..65535），这才是和手点一样的输入序列。
      $screenW = [DshClickProbe]::GetSystemMetrics(0)
      $screenH = [DshClickProbe]::GetSystemMetrics(1)
      $nx = [int][Math]::Round($pt.X * 65535.0 / [Math]::Max(1, $screenW - 1))
      $ny = [int][Math]::Round($pt.Y * 65535.0 / [Math]::Max(1, $screenH - 1))

      # 落地校验：人可能正握着鼠标（弹窗一出现就把光标挪走了），那样点下去就是「瞎点」。
      # 所以移动后回读光标，偏超过 4px 就重试，三次都不行就放弃点击并说明原因。
      $onTarget = $false
      $afterMove = [DshClickProbe+POINT]::new()
      for ($i = 1; $i -le 3; $i++) {
        [DshClickProbe]::mouse_event(0x8001, $nx, $ny, 0, [UIntPtr]::Zero)   # MOVE (absolute)
        Start-Sleep -Milliseconds 200
        [void][DshClickProbe]::GetCursorPos([ref]$afterMove)
        $clickInfo.cursorAfterMove = "$($afterMove.X),$($afterMove.Y)"
        $clickInfo.attempts = $i
        if ([Math]::Abs($afterMove.X - $pt.X) -le 4 -and [Math]::Abs($afterMove.Y - $pt.Y) -le 4) {
          $onTarget = $true
          break
        }
      }
      if (-not $onTarget) {
        $clickInfo.error = "光标没能停在目标点上（要 $($pt.X),$($pt.Y)，实际 $($clickInfo.cursorAfterMove)），放弃点击"
        [void][DshClickProbe]::SetCursorPos($saved.X, $saved.Y)
        return
      }
      [DshClickProbe]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)       # LEFTDOWN
      Start-Sleep -Milliseconds 40
      [DshClickProbe]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)       # LEFTUP
      Start-Sleep -Milliseconds 80
      [void][DshClickProbe]::SetCursorPos($saved.X, $saved.Y)
      $clickInfo.clicked = $true
    } catch {
      $clickInfo.error = $_.Exception.Message
    }
  })

$timer.Start()
try {
  # 不传 -Renderer：走正式默认路径（auto，等于 card）。-ScreenShot 抓一张点之前的真实屏幕。
  & $scriptPath -PayloadFile $payloadFile -OutFile $outFile -ScreenShot $shotFile
} finally {
  $timer.Stop()
  $timer.Dispose()
}

$resultText = if (Test-Path -LiteralPath $outFile) { (Get-Content -LiteralPath $outFile -Raw).Trim() } else { $null }
$kind = $null
if ($resultText) { $kind = ($resultText | ConvertFrom-Json).kind }

$expected = switch ($Target) { 'allow' { 'allowed-once' } 'deny' { 'rejected' } 'close' { 'closed' } }

$summary = [ordered]@{
  target = $Target
  expectedKind = $expected
  actualKind = $kind
  result = $resultText
  clicked = $clickInfo.clicked
  clickPoint = $clickInfo.point
  cursorAfterMove = $clickInfo.cursorAfterMove
  moveAttempts = $clickInfo.attempts
  windowRect = $clickInfo.windowRect
  clickError = $clickInfo.error
  dpiScale = $scale
  screenshot = if (Test-Path -LiteralPath $shotFile) { $shotFile } else { $null }
  screenshotBytes = if (Test-Path -LiteralPath $shotFile) { (Get-Item -LiteralPath $shotFile).Length } else { $null }
  diagFile = "$outFile.diag"
}
$summary | ConvertTo-Json -Depth 4

if (-not $KeepArtifacts) { Remove-Item -LiteralPath $payloadFile -Force -ErrorAction SilentlyContinue }
if ($kind -ne $expected) { exit 1 }
exit 0
