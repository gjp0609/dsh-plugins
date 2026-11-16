# 弹窗可见性自检（回归测试）。
#
# 为什么需要它：DSH 的进程创建层（@deepseek-ai/dsh-win32-process）拉起子进程时会把
# STARTUPINFO 设成 { dwFlags: 257, wShowWindow: 0 }（STARTF_USESHOWWINDOW + SW_HIDE），
# Windows 会用这个 SW_HIDE 顶替该进程【第一次】ShowWindow 调用的参数 —— 于是窗口建好、
# 消息循环在跑，却一直不可见。弹窗脚本用「显示后再显式 ShowWindow + SetWindowPos」抵消它，
# 本脚本负责量出来。
#
# 关键：必须在**宿主 spawn 出来的进程里**运行本脚本（例如在 DSH 里把
# `& <repo>\dsh-approval-notifier\tests\popup-visibility.ps1` 整条当命令执行），
# 这样弹窗与宿主进程继承同一套启动条件。嵌套的 `Start-Process` 不会继承 SW_HIDE。
# 本脚本自己不做嵌套启动：它就在当前进程里跑弹窗脚本。
#
# 只量一条通道：卡片（WebView2）。旧的自绘卡已删除，-Renderer 只剩 auto / card 两个值。
#
# 顺带量位置：summary 里的 windowBounds / slotRank / slotCount 用来回归「右下角」。
# 加 -SimulateSibling 会埋一个「另一个弹窗还在场」的登记，用来量多窗错开是否生效。
# 加 -ScreenShot 会在窗口显示后抓一张真实屏幕图 —— IsWindowVisible 证明不了「画上去了」。
#
# 判定依据是弹窗进程自己量的 IsWindowVisible（WS_VISIBLE 位），不是肉眼：
#   visibleBefore=false, visibleAfter=true  → 命中 SW_HIDE 且修法有效
#   visibleBefore=true,  visibleAfter=true  → 该环境本来就不隐藏（也算通过）
# 退出码：0 = 通过，1 = 窗口没显示出来或自检记录缺失。

[CmdletBinding()]
param(
  # 载荷与结果的落点，必须是当前受限进程可写的目录（默认放工作区 .session-files\tmp）。
  [string]$WorkDir = '',
  [int]$CloseAfterMs = 4000,
  # auto / card 现在等价（只有一条渲染路径）；保留 auto 是为了既有命令不改。
  [ValidateSet('auto', 'card')][string]$Renderer = 'auto',
  # 假装「另一个弹窗还在场」：埋一个指向活进程的登记文件，量错开是否生效。
  [switch]$SimulateSibling,
  # 元信息行里显示的工作目录（默认给个真实路径，可传超长路径量截断）。
  [string]$MetaValue = 'C:\work\dsh-plugins',
  # 把窗口显示后的真实屏幕样子抓成 PNG（看「屏幕上是不是真的画出来了」）。
  [string]$ScreenShot = '',
  [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $pluginRoot 'scripts\prompt.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw "找不到弹窗脚本: $scriptPath" }

if ([string]::IsNullOrWhiteSpace($WorkDir)) {
  $workspaceRoot = Split-Path -Parent $pluginRoot
  $WorkDir = Join-Path $workspaceRoot '.session-files\tmp\popup-visibility'
}
if (-not (Test-Path -LiteralPath $WorkDir)) { [void](New-Item -ItemType Directory -Path $WorkDir -Force) }
if ($ScreenShot -ne '' -and -not [System.IO.Path]::IsPathRooted($ScreenShot)) {
  $ScreenShot = Join-Path $WorkDir $ScreenShot
}

$stamp = Get-Date -Format 'HHmmss'
$marker = "DSH 审批请求 · 可见性自检 $stamp"
$payloadFile = Join-Path $WorkDir "payload-$stamp.json"
$outFile = Join-Path $WorkDir "result-$stamp.json"
$diagFile = "$outFile.diag"

# 理由里故意带上宿主那句固定前缀：卡片要把它去掉（权限名每个请求都一样，没有信息量）。
$payload = [ordered]@{
  windowTitle = $marker
  metaCaption = '工作区'
  meta = $MetaValue
  reasonCaption = '模型给出的理由：'
  reason = '允许本次操作使用 danger-full-access 权限：验证宿主 STARTUPINFO 里的 SW_HIDE 不会吃掉弹窗的第一次 ShowWindow。'
  commandCaption = '模型请求执行的内容（原文）：'
  command = 'pwsh -NoProfile -Command Get-Date'
  sound = $false
  armDelayMs = 1000
  closeAfterMs = $CloseAfterMs
  slot = 0
}
Set-Content -LiteralPath $payloadFile -Value ($payload | ConvertTo-Json -Depth 4) -Encoding utf8 -ErrorAction Stop
Remove-Item -LiteralPath $outFile, $diagFile -Force -ErrorAction SilentlyContinue

# 埋一个「在场」登记：文件名的 Ticks 段全 0，保证排在本进程登记的前面（= 本进程是第 2 个）。
$siblingClaim = $null
if ($SimulateSibling) {
  $sibling = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID } | Select-Object -First 1
  if ($null -eq $sibling) { throw '找不到可用来模拟「另一个在场弹窗」的活进程' }
  $siblingClaim = Join-Path $WorkDir ("popup-slot-{0}-{1}.claim" -f '0000000000000000000', $sibling.Id)
  Set-Content -LiteralPath $siblingClaim -Value 'simulated' -Encoding utf8 -ErrorAction Stop
}

# 在当前进程里跑弹窗：不嵌套、不新开进程，继承本进程真实的启动条件。
$apartment = [System.Threading.Thread]::CurrentThread.GetApartmentState()
$popupArgs = @{
  PayloadFile = $payloadFile
  OutFile = $outFile
  Renderer = $Renderer
}
if ($ScreenShot -ne '') { $popupArgs['ScreenShot'] = $ScreenShot }
& $scriptPath @popupArgs

$resultText = if (Test-Path -LiteralPath $outFile) { (Get-Content -LiteralPath $outFile -Raw).Trim() } else { $null }
$diagRecords = @()
if (Test-Path -LiteralPath $diagFile) {
  foreach ($line in (Get-Content -LiteralPath $diagFile)) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try { $diagRecords += ($line | ConvertFrom-Json) } catch { }
  }
}
$shown = $diagRecords | Where-Object { $_.stage -eq 'shown' } | Select-Object -First 1
$rendered = $diagRecords | Where-Object { $_.stage -eq 'card-rendered' } | Select-Object -First 1
$unavailable = $diagRecords | Where-Object { $_.stage -in @('card-unavailable', 'card-failed', 'card-shell-missing') } | Select-Object -First 1

$summary = [ordered]@{
  popupScript = $scriptPath
  rendererRequested = $Renderer
  rendererUsed = if ($shown) { $shown.renderer } else { $null }
  apartment = [string]$apartment
  windowTitle = $marker
  result = $resultText
  visibleBefore = if ($shown) { $shown.visibleBefore } else { $null }
  visibleAfter = if ($shown) { $shown.visibleAfter } else { $null }
  windowBounds = if ($shown) { $shown.windowBounds } else { $null }
  cardContent = if ($rendered -and $null -ne $rendered.contentWidth) { "$($rendered.contentWidth)x$($rendered.contentHeight)" } else { $null }
  slotRank = if ($shown) { $shown.slotRank } else { $null }
  slotCount = if ($shown) { $shown.slotCount } else { $null }
  slotSource = if ($shown) { $shown.slotSource } else { $null }
  integrity = if ($shown) { $shown.integrity } else { $null }
  sessionId = if ($shown) { $shown.sessionId } else { $null }
  resultDirWritable = if ($shown) { $shown.resultDirWritable } else { $null }
  tempWritable = if ($shown) { $shown.tempWritable } else { $null }
  fallbackReason = if ($unavailable) { $unavailable.reason } else { $null }
  screenshot = $ScreenShot
  screenshotBytes = if ($ScreenShot -ne '' -and (Test-Path -LiteralPath $ScreenShot)) { (Get-Item -LiteralPath $ScreenShot).Length } else { $null }
  claimLeftBehind = if ($siblingClaim) { Test-Path -LiteralPath $siblingClaim } else { $false }
  # 弹窗退出时应交还自己的登记；-SimulateSibling 时剩下那个是脚本自己埋的。
  claimFilesLeft = @(Get-ChildItem -LiteralPath $WorkDir -Filter 'popup-slot-*.claim' -ErrorAction SilentlyContinue).Count
  diagFile = $diagFile
}
$summary | ConvertTo-Json -Depth 4

if (-not $KeepArtifacts) {
  Remove-Item -LiteralPath $payloadFile -Force -ErrorAction SilentlyContinue
  if ($siblingClaim) { Remove-Item -LiteralPath $siblingClaim -Force -ErrorAction SilentlyContinue }
}

if ($null -eq $shown -or $shown.visibleAfter -ne $true) { exit 1 }
# 强制走某条通道时，那条通道必须真的用上了（否则「通过」是假的）。
if ($Renderer -ne 'auto' -and $summary.rendererUsed -ne $Renderer) { exit 1 }
exit 0
