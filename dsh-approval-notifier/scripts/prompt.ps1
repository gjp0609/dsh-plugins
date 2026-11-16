param(
  [Parameter(Mandatory = $true)][string]$PayloadFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  # 仅供自检：给了路径就渲染成 PNG 后立刻关窗，再按「未做决定」收尾。
  # 调外观时用它，改一版看一眼，不用反复弹窗。外壳没有「挪到屏幕外」这个模式，
  # 所以卡片会在右下角闪一下（外壳侧要提权跑，受限令牌下 WebView2 起不来）。
  [string]$RenderTo = '',
  # 仅供自检：选渲染通道。只有一条路——card（WebView2 卡片）。
  # auto 保留是为了兼容既有自检命令，两者等价：auto 不再表示「先卡片、失败再换一条路」。
  [ValidateSet('auto', 'card')][string]$Renderer = 'auto',
  # 仅供自检：窗口显示之后把屏幕上的真实样子抓成 PNG。
  # 为什么要它：IsWindowVisible 只能证明窗口「该显示」，证明不了内容真的画到了屏幕上
  # （自绘卡就出过「离屏渲染正常、屏幕上纯白」的毛病）。离屏截图看不出那种问题。
  [string]$ScreenShot = ''
)

# dsh-approval-notifier 的审批弹窗（入口层）。
#
# 由 Host 半边用 ctx.subprocess.spawn 拉起：
#   pwsh -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File prompt.ps1 -PayloadFile <json> -OutFile <json>
#
# 本文件只管：参数、入参/结果的文件协议、渲染通道的选择、诊断记录、进程退出码。
# 界面只有一条路径，在 scripts\ui\card.ps1：适配仓库根 shared/ui-card（插件不再自带外壳副本）。
#
# 渲染源只有仓库根 shared/ui-card 一份：结构、样式、窗口、消息协议都在那边；
# 这里只把审批数据按外壳的插槽/参数摆好，再把页面回传的结果翻成宿主认识的结果类型。
#
# 卡片起不来（找不到外壳 / 缺 DLL / 没运行时 / 起窗口失败）就**如实写 error 结果并 exit 1**：
# 宿主把它当「没做决定」，请求继续等浏览器那张卡。这里不设第二条渲染通道——旧的自绘卡已经删掉，
# 回退能力由宿主的浏览器审批承担（那是宿主既有能力，不是 UI 技术选型）。
#
# 交互约定（按用户决定，改动前先看插件 README.md）：
#   - 只靠鼠标就能完成：外壳本来会绑 Esc/Enter，但本插件的适配层显式传了 -Keyboard none 关掉
#     （回车误批一次提权不可挽回，宁可少一个快捷键）；
#   - 卡片出现后 armDelayMs 毫秒内两个按钮保持禁用，避免用户正在别处连点时被吃掉一次点击；
#   - 固定出现在主屏工作区右下角，不主动抢焦点；
#   - 到 closeAfterMs 自行关闭，且【不做任何决定】（不自动接受、也不自动拒绝）；
#   - 点 ✕ 也是「不做决定」：请求继续等浏览器；
#   - 只读写宿主指定的这两个文件：入参 payload、结果 OutFile（先写 .tmp 再改名）。

$ErrorActionPreference = 'Stop'

# WinForms + WebView2 都要 STA。宿主已经带了 -STA；这里是给「自检里直接跑」兜底。
# 子进程直接继承本进程的 stdout/stderr 句柄，所以结果标记行不需要在这边转抄一遍
# （受限沙箱里也照样成立：那边根本不许 PowerShell 去捕获 native 输出）。
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
  $forward = @(
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
    '-PayloadFile', $PayloadFile, '-OutFile', $OutFile, '-Renderer', $Renderer
  )
  if ($RenderTo -ne '') { $forward += @('-RenderTo', $RenderTo) }
  if ($ScreenShot -ne '') { $forward += @('-ScreenShot', $ScreenShot) }
  $self = (Get-Process -Id $PID).Path
  & $self @forward
  if ($null -eq $LASTEXITCODE) { exit 1 }
  exit $LASTEXITCODE
}

# 结果只写一次；任何路径都通过这个开关防止后写覆盖前写。
$script:decided = $false
# 这次实际走的渲染通道（诊断里要看得出来；只有 card 一个值）。
$activeRenderer = ''

function Write-Outcome {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [string]$Detail = ''
  )
  $record = [ordered]@{ kind = $Kind; at = (Get-Date).ToString('o') }
  if ($Detail -ne '') { $record['detail'] = $Detail }
  $json = $record | ConvertTo-Json -Compress

  # 通道 1：结果文件（宿主默认读它）。
  $fileState = 'ok'
  try {
    $temp = "$OutFile.tmp"
    Set-Content -LiteralPath $temp -Value $json -Encoding utf8 -NoNewline -ErrorAction Stop
    Move-Item -LiteralPath $temp -Destination $OutFile -Force -ErrorAction Stop
  } catch {
    # 受限令牌只能写「授权根目录」，插件的 dataDir 常常不在其中：写不出去不是致命问题。
    $fileState = $_.Exception.Message
  }

  # 通道 2：stdout。管道句柄由宿主创建并在收集，不受沙箱文件权限影响，
  # 因此即使结果文件写不出去，宿主也能拿到这次决定。
  $stdoutState = 'ok'
  try {
    [Console]::Out.WriteLine("@@DSH-APPROVAL-NOTIFIER-RESULT@@ $json")
    [Console]::Out.Flush()
  } catch {
    $stdoutState = $_.Exception.Message
  }

  Write-Diag -Stage 'outcome' -Extra ([ordered]@{
      kind = $Kind
      detail = $Detail
      renderer = $activeRenderer
      resultFile = $OutFile
      resultFileWrite = $fileState
      stdoutWrite = $stdoutState
    })
}

# 从 ConvertFrom-Json 得到的对象里安全取字段（缺字段/为 null 时用默认值）。
function Get-Field {
  param($Object, [Parameter(Mandatory = $true)][string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Format-Duration {
  param([double]$Milliseconds)
  $totalSeconds = [Math]::Max(0, [Math]::Floor($Milliseconds / 1000))
  $minutes = [Math]::Floor($totalSeconds / 60)
  $seconds = $totalSeconds % 60
  return ('{0}:{1:d2}' -f [int]$minutes, [int]$seconds)
}

# ---- 诊断 ----------------------------------------------------------------------
# 本机实测：宿主拉起本进程时会把 STARTUPINFO 设成 { dwFlags: 257, wShowWindow: 0 }
# （STARTF_USESHOWWINDOW + SW_HIDE，见 @deepseek-ai/dsh-win32-process），
# Windows 会用这个 SW_HIDE 顶替本进程【第一次】ShowWindow 调用的参数。
# 下面这个自检把「修前/修后」和权限、目录可写性都记下来；三条落点能写哪个写哪个。

function Write-Diag {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    $Extra = $null
  )
  try {
    $record = [ordered]@{ stage = $Stage; at = (Get-Date).ToString('o'); pid = $PID }
    if ($null -ne $Extra) {
      foreach ($key in @($Extra.Keys)) { $record[$key] = $Extra[$key] }
    }
    $json = $record | ConvertTo-Json -Compress -Depth 5
    # stderr：宿主在「没有决定」时会把 stderr 记进日志，这条通道不依赖任何文件权限。
    try { [Console]::Error.WriteLine("DSH-APPROVAL-DIAG $json"); [Console]::Error.Flush() } catch { }
    # 结果文件旁边 + 本会话私有 temp（两者都可能写不出去，无所谓）。
    try { Add-Content -LiteralPath "$OutFile.diag" -Value $json -Encoding utf8 -ErrorAction Stop } catch { }
    try { Add-Content -LiteralPath (Join-Path $env:TEMP 'dsh-approval-notifier-diag.jsonl') -Value $json -Encoding utf8 -ErrorAction Stop } catch { }
  } catch {
  }
}

# 读取入参；失败就直接回一个 error 结果，绝不静默。
$payload = $null
try {
  $payload = Get-Content -LiteralPath $PayloadFile -Raw -Encoding utf8 | ConvertFrom-Json
} catch {
  Write-Outcome -Kind 'error' -Detail "读取 payload 失败: $($_.Exception.Message)"
  exit 1
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Outcome -Kind 'error' -Detail "无法加载 WinForms: $($_.Exception.Message)"
  exit 1
}

$windowTitle = [string](Get-Field $payload 'windowTitle' 'DSH 审批请求')
$metaCaption = [string](Get-Field $payload 'metaCaption' '工作区')
$metaText = [string](Get-Field $payload 'meta' '')
$reasonCaption = [string](Get-Field $payload 'reasonCaption' '模型给出的理由：')
$reasonText = [string](Get-Field $payload 'reason' '(未提供理由)')
# 宿主会在理由前面固定加一句「允许本次操作使用 <权限> 权限：」（日志里的 displayReasonZh）。
# 权限名每个请求都一样，摆在卡片上只占一行、没有信息量，显示时去掉；完整原文仍留在宿主日志里。
$reasonPrefix = '^\s*允许本次操作使用\s+\S+\s+权限：\s*'
if ($reasonText -match $reasonPrefix) {
  $stripped = $reasonText -replace $reasonPrefix, ''
  if ($stripped.Trim() -ne '') { $reasonText = $stripped }
}
$commandCaption = [string](Get-Field $payload 'commandCaption' '模型请求执行的内容（原文）：')
$commandText = [string](Get-Field $payload 'command' '（未取到参数）')
$sound = [bool](Get-Field $payload 'sound' $true)
$armDelayMs = [int](Get-Field $payload 'armDelayMs' 1000)
$closeAfterMs = [int](Get-Field $payload 'closeAfterMs' 600000)
$slotFromHost = [int](Get-Field $payload 'slot' 0)

# 卡片要用的这份数据，字段名固定（StrictMode 下读不到属性会抛异常）。
$Card = [ordered]@{
  windowTitle    = $windowTitle
  metaCaption    = $metaCaption
  meta           = $metaText
  reasonCaption  = $reasonCaption
  reason         = $reasonText
  commandCaption = $commandCaption
  command        = $commandText
  sound          = $sound
  armDelayMs     = $armDelayMs
  closeAfterMs   = $closeAfterMs
}

. (Join-Path $PSScriptRoot 'ui\environment.ps1')

# ---- 在场登记：用来错开「此刻还开着的」弹窗 -------------------------------------
# 宿主给的计数在插件进程里，弹窗被强杀时它也不知道；所以这里自己实测一次：
# 在结果文件同目录登记本进程，登记文件的先后 = 在场次序，窗口关掉即交还。
# 这样「只有我一个」的时候永远回到右下角，不会越弹越高。
function Get-PopupSlot {
  param([string]$Directory, [int]$Fallback = 0, [int]$MaxSlots = 5)
  $claimFile = $null
  try {
    if ((Test-WritableDir $Directory) -ne 'ok') {
      return [pscustomobject]@{ Rank = [Math]::Max(0, $Fallback); Count = 1; Source = 'payload'; Claim = $null }
    }
    # 文件名前缀是 UtcNow 的 Ticks：同一时间刻度里同时启动也有确定的先后（生杀只看文件名排序）。
    $claimFile = Join-Path $Directory ("popup-slot-{0}-{1}.claim" -f [DateTime]::UtcNow.Ticks, $PID)
    [System.IO.File]::WriteAllText($claimFile, (Get-Date).ToString('o'))

    $alive = New-Object System.Collections.ArrayList
    foreach ($file in @(Get-ChildItem -LiteralPath $Directory -Filter 'popup-slot-*.claim' -ErrorAction SilentlyContinue)) {
      $match = [regex]::Match($file.Name, '^popup-slot-\d+-(\d+)\.claim$')
      if ($match.Success) {
        $owner = [int]$match.Groups[1].Value
        if ($owner -ne $PID) {
          $running = $true
          # 被宿主强杀（或崩溃）的弹窗找不到进程了，顺手清掉，不让它一直占着位置。
          try { [void](Get-Process -Id $owner -ErrorAction Stop) } catch { $running = $false }
          $ageSeconds = ([DateTime]::UtcNow - $file.LastWriteTimeUtc).TotalSeconds
          # 刚出生的登记先当它活着：兄弟弹窗可能正在启动，误删会让两个窗口叠在一起。
          if (-not $running -and $ageSeconds -gt 2) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
            continue
          }
        }
      }
      [void]$alive.Add($file)
    }
    if ($alive.Count -eq 0) { [void]$alive.Add((Get-Item -LiteralPath $claimFile)) }
    $ordered = @($alive | Sort-Object -Property Name)
    $rank = 0
    for ($i = 0; $i -lt $ordered.Count; $i++) {
      if ($ordered[$i].FullName -eq $claimFile) { $rank = $i; break }
    }
    if ($rank -ge $MaxSlots) { $rank = $rank % $MaxSlots }
    return [pscustomobject]@{ Rank = $rank; Count = [Math]::Max(1, $ordered.Count); Source = 'claim'; Claim = $claimFile }
  } catch {
    return [pscustomobject]@{ Rank = [Math]::Max(0, $Fallback); Count = 1; Source = 'payload'; Claim = $claimFile }
  }
}

$slotInfo = Get-PopupSlot -Directory (Split-Path -Parent $OutFile) -Fallback $slotFromHost
$claimFile = $slotInfo.Claim

# ---- 窗口显示之后要做的事：提示音、任务栏闪烁、让卡片开始计时、自检记录 ----------
# 每一步各自兜住异常：自检记录是排查「弹窗没出现」的唯一现场，不能让一句提示音把它带走。
$onShown = {
  param($showInfo, $form, $ctrl)

  $integrity = Get-ProcessIntegrity

  if ($Card.sound) {
    try {
      [System.Media.SystemSounds]::Exclamation.Play()
    } catch {
      try { [console]::beep(880, 200) } catch { }
    }
  }
  if ($null -ne $form) {
    # 闪烁用外壳的实现（shared/ui-card/environment.ps1）：插件原来那份是自绘卡的重复实现，已删。
    # `$null =` 不是可省的：Invoke-TaskbarFlash 会返回「多久后停闪」的会话对象，而这个回调的
    # 返回值会被 PowerShell 接进 Show-CardWindow 的返回值。泄漏之后 $window 变成 Object[]，
    # 调用方 [int]$window.ContentWidth 收到 @($null, 680) 就抛
    # 「Cannot convert System.Object[] to System.Int32」——2026-11-02 真机点按钮后
    # card-failed、决定没写出去，就是这一条（见 DECISIONS D-04）。
    try { $null = Invoke-TaskbarFlash -Handle $form.Handle } catch { }
  }

  # 计时不在这里启动：外壳在调用本回调之前已经调过页面的 dshCardShown()，
  # 防误点与自动关闭都从「窗口真的可见」那一刻算起。

  # 自检：抓一张「屏幕上真实长什么样」。放在计时启动之后、并且多等一会儿，
  # 这样抓到的是合成完的第一帧带状态行的样子，而不是刚 Show 出来那张空壳。
  if ($ScreenShot -ne '') {
    try {
      Start-Sleep -Milliseconds 400
      [System.Windows.Forms.Application]::DoEvents()
      if ($null -ne $form) { [void](Save-ScreenCapture -Handle $form.Handle -Path $ScreenShot) }
    } catch { }
  }

  $sessionId = $null
  try { $sessionId = (Get-Process -Id $PID).SessionId } catch { }
  Write-Diag -Stage 'shown' -Extra ([ordered]@{
      renderer          = $activeRenderer
      visibleBefore     = $showInfo.visibleBefore
      visibleAfter      = $showInfo.visibleAfter
      showWindowCall    = $showInfo.showWindow
      setWindowPosCall  = $showInfo.setWindowPos
      forceShowError    = $showInfo.error
      integrityRid      = $integrity.Rid
      integrity         = $integrity.Label
      userInteractive   = [System.Environment]::UserInteractive
      sessionId         = $sessionId
      tempDir           = $env:TEMP
      tempWritable      = (Test-WritableDir $env:TEMP)
      resultDir         = (Split-Path -Parent $OutFile)
      resultDirWritable = (Test-WritableDir (Split-Path -Parent $OutFile))
      payloadDir        = (Split-Path -Parent $PayloadFile)
      payloadDirWritable = (Test-WritableDir (Split-Path -Parent $PayloadFile))
      windowBounds      = "$($form.Left),$($form.Top) $($form.Width)x$($form.Height)"
      slotRank          = $slotInfo.Rank
      slotCount         = $slotInfo.Count
      slotSource        = $slotInfo.Source
      windowTitle       = [string]$Card.windowTitle
    })
}

# ---- 渲染：只有 WebView2 卡片这一条路径 -----------------------------------------
# 卡片外壳在仓库根 shared/ui-card（插件里没有副本）。外壳缺失、缺 DLL / 没运行时 / 起窗口失败
# 都只做一件事：把原因写进 error 结果并 exit 1。宿主据此认为「这次没拿到决定」，请求继续等浏览器
# 那张卡——回退能力是宿主既有的，这里不需要第二套渲染实现。
$kind = ''
$renderError = ''
try {
  . (Join-Path $PSScriptRoot 'ui\card.ps1')
  # shared.ps1 给适配层开了 StrictMode（它自己的代码按严格模式写，tests\card-select.ps1 也这么跑）。
  # 入口这一层要读大量宿主给的、可能缺字段的数据（Get-Field 兜住缺字段），所以还原成宽松模式。
  Set-StrictMode -Off
  $activeRenderer = 'card'
  # 启动自检：外壳不自包含，缺失时必须写清原因，不要静默失败。
  $cardShellDir = Get-ApprovalCardShellDir
  if ($cardShellDir -eq '') {
    $renderError = '找不到共享卡片外壳 shared/ui-card（插件不再自带副本）'
    Write-Diag -Stage 'card-shell-missing' -Extra ([ordered]@{ reason = $renderError })
  } else {
    # WebView2 的缓存目录放在数据目录里（结果文件在 <dataDir>\tmp\，上一级就是 dataDir）。
    $webViewDataDir = Join-Path (Split-Path -Parent (Split-Path -Parent $OutFile)) 'webview2'
    $cardResult = Invoke-CardApproval -Data $Card -SlotIndex $slotInfo.Rank -SlotCount $slotInfo.Count `
      -RenderTo $RenderTo -DataDir $webViewDataDir -OnShown $onShown
    if ($cardResult.error -eq '') {
      $kind = [string]$cardResult.kind
      Write-Diag -Stage 'card-rendered' -Extra ([ordered]@{
          shellDir      = $cardShellDir
          windowBounds  = $cardResult.windowBounds
          contentWidth  = $cardResult.contentWidth
          contentHeight = $cardResult.contentHeight
        })
    } else {
      $renderError = [string]$cardResult.error
      Write-Diag -Stage 'card-unavailable' -Extra ([ordered]@{ reason = $renderError })
    }
  }
} catch {
  $renderError = $_.Exception.Message
  # 只记 Message 时「打在哪一行、从哪个函数出来」全靠猜（2026-11-02 那次就是如此，多花了一轮）。
  # ScriptStackTrace 是调用栈文本，截到 4000 字符以内：一条诊断行不该比一次审批还长。
  $stack = [string]$_.ScriptStackTrace
  if ($stack.Length -gt 4000) { $stack = $stack.Substring(0, 4000) }
  Write-Diag -Stage 'card-failed' -Extra ([ordered]@{ error = $renderError; stack = $stack })
}

# 交还在场登记：下一个弹窗据此回到右下角（正常关窗、点按钮、被强杀以外的所有路径都走到这）。
if ($claimFile) {
  try { Remove-Item -LiteralPath $claimFile -Force -ErrorAction SilentlyContinue } catch { }
}

# ---- 落盘 ----------------------------------------------------------------------
# 放在所有 try 外面：卡已经答过，就绝不能因为写文件之类的异常再问一次、把答案丢掉。
if ($kind -eq 'shot') {
  # 自检出的图：按「没做决定」收尾，宿主照旧等浏览器。
  Write-Outcome -Kind 'expired' -Detail 'render-only'
  exit 0
}

if ($kind -eq '' -or $kind -eq 'error') {
  # 如实写 error（不静默、也不假装用户拒绝）：宿主据此把请求继续等浏览器那张卡。
  $detail = if ($renderError -ne '') { $renderError } else { '卡片没有给出结果' }
  Write-Outcome -Kind 'error' -Detail $detail
  exit 1
}

Write-Outcome -Kind $kind
exit 0
