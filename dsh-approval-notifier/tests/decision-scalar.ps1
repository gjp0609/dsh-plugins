# 决定路径的「标量」自检（不需要 WebView2、不弹窗）：
# 外壳多吐对象时不炸、Invoke-CardApproval 只返回一个对象、取自窗口的数值都是标量。
# 跑法：pwsh -NoProfile -File tests\decision-scalar.ps1
#
# 守的是 2026-11-02 真机缺陷（DECISIONS D-04）：
#   点按钮 → 决定回传 → 写结果文件这条链上，外壳的返回值曾被 OnShown 回调的输出污染成
#   Object[]，`[int]$window.ContentWidth` 收到 @($null, 680) 抛
#   「Cannot convert the "System.Object[]" value ... to type "System.Int32"」，
#   决定没有写出去，宿主只能继续等网页那张卡。
#
# 这里把「外壳吐数组」这个形态直接喂给 Invoke-CardApproval（假窗口，不开窗口）：
#   1. 不炸、决定类型正确；2. 返回值只有一个对象；3. contentWidth / contentHeight 是 [int]、
#   windowBounds 是 [string]；4. 源码契约：外壳接住回调输出，插件回调不再吐返回值。
#
# 严格模式与 prompt.ps1 完全一致：card.ps1 开 StrictMode，入口再关掉。
# 这个「关掉」是现场的一部分——严格模式下数组缺属性会先报 property 错，
# 宽松模式下才会走到 [int] 强转、报出真机那条 Int32 错。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = Split-Path -Parent $PSScriptRoot
$uiDir = Join-Path $pluginRoot 'scripts\ui'

. (Join-Path $uiDir 'environment.ps1')
. (Join-Path $uiDir 'card.ps1')
Set-StrictMode -Off

$failures = 0
function Check([string]$Name, [scriptblock]$Body) {
    try {
        $result = & $Body
        if ($result -eq $true) { "ok  $Name" }
        else { "FAIL $Name → $result"; $script:failures++ }
    } catch {
        "FAIL $Name → 抛异常：$($_.Exception.Message)"; $script:failures++
    }
}

# 与真实审批同一份载荷形状（index.js 组装的 payload）。
$card = [ordered]@{
    windowTitle    = 'DSH 审批请求 · pwsh'
    metaCaption    = '工作区'
    meta           = 'C:\work\dsh-plugins'
    reasonCaption  = '模型给出的理由：'
    reason         = '这条命令是刻意触发的审批样本。'
    commandCaption = '模型请求执行的内容（原文）：'
    command        = 'Get-Date'
    sound          = $false
    armDelayMs     = 1000
    closeAfterMs   = 600000
}

# ---- 假窗口：把「外壳返回数组」这个形态原样交出去 -------------------------------
#
# 真机上数组是 OnShown 回调的输出泄漏造成的（外壳没接住 & $OnShown 的返回值）。
# 这里不重演泄漏，直接让外壳返回数组，验证消费端（Invoke-CardApproval）不会被数组喂死。

function Show-CardWindow {
    param(
        [Parameter(Mandatory)][string]$Html,
        [int]$Width = 680, [int]$MaxHeight = 0, [int]$TimeoutMs = 0, [string]$DataDir = '',
        [string]$Position = 'corner', [int]$SlotIndex = 0, [int]$SlotCount = 1,
        [int]$CornerRadius = 0, [string]$WindowTitle = 'DSH', [string]$WindowBackground = '',
        [switch]$TopMost, [switch]$Activate,
        [scriptblock]$OnShown = $null, [scriptblock]$OnRendered = $null
    )
    $script:MockCall = @{ Width = $Width; SlotIndex = $SlotIndex; SlotCount = $SlotCount }
    $script:MockWindow
}

# 外壳的返回值被污染时的第一个元素：Invoke-TaskbarFlash 的会话对象（没有 ContentWidth）。
$leak = [pscustomobject]@{ StopAfterMs = 2500; Watch = $null }

function New-MockWindowResult {
    param([string]$Action, [string]$Message = '', [string]$ErrorText = '')
    [pscustomobject]@{
        Action = $Action; Message = $Message; Error = $ErrorText
        ContentWidth = 680; ContentHeight = 213
        WindowBounds = '1162,851 680x213'
        ShowInfo = $null; Fields = $null
    }
}

# ---- 决定路径：数字必须是标量 -----------------------------------------------------

Check '决定路径：外壳返回数组（回调输出泄漏的形态）时不炸，决定类型正确' {
    $script:MockWindow = @($leak, (New-MockWindowResult -Action 'message' -Message '{"type":"decision","value":"allowed-once"}'))
    $r = Invoke-CardApproval -Data $card
    if ($r.kind -ne 'allowed-once') { return "kind=$($r.kind)" }
    if ($r.error -ne '') { return "error=$($r.error)" }
    $true
}

Check '返回对象只有一个：prompt.ps1 拿到的 $cardResult 不会是 Object[]' {
    $script:MockWindow = @($leak, (New-MockWindowResult -Action 'message' -Message '{"type":"decision","value":"allowed-once"}'))
    $out = @(Invoke-CardApproval -Data $card)
    if ($out.Count -ne 1) { return "返回 $($out.Count) 个对象（应当只有结果对象）" }
    if ($out[0] -is [array]) { return '唯一的输出仍然是数组' }
    $true
}

Check '决定路径上取自窗口的数值都是标量（[int] / [string]，不是 Object[]）' {
    $script:MockWindow = @($leak, (New-MockWindowResult -Action 'message' -Message '{"type":"decision","value":"rejected"}'))
    $r = Invoke-CardApproval -Data $card
    if ($r.contentWidth -isnot [int]) { return "contentWidth=$($r.contentWidth.GetType().FullName)" }
    if ($r.contentHeight -isnot [int]) { return "contentHeight=$($r.contentHeight.GetType().FullName)" }
    if ($r.windowBounds -isnot [string]) { return "windowBounds=$($r.windowBounds.GetType().FullName)" }
    if ($r.kind -isnot [string]) { return "kind=$($r.kind.GetType().FullName)" }
    if ($r.error -isnot [string]) { return "error=$($r.error.GetType().FullName)" }
    if ($r.contentWidth -ne 680 -or $r.contentHeight -ne 213) { return "尺寸不对：$($r.contentWidth)x$($r.contentHeight)" }
    $true
}

Check '外壳只返回一个对象时行为不变（新的取值方式不许把正常路径吃掉）' {
    $script:MockWindow = New-MockWindowResult -Action 'message' -Message '{"type":"decision","value":"rejected"}'
    $r = Invoke-CardApproval -Data $card
    if ($r.kind -ne 'rejected') { return "kind=$($r.kind)" }
    if ($script:MockCall.SlotIndex -ne 0 -or $script:MockCall.Width -ne 680) { return '窗口参数没透传' }
    $true
}

Check '数组形态下 failed 也照样把原因交出去（新的取值方式不许吞掉失败信息）' {
    $script:MockWindow = @($leak, (New-MockWindowResult -Action 'failed' -ErrorText '模拟缺 DLL'))
    $r = Invoke-CardApproval -Data $card
    if ($r.error -ne '模拟缺 DLL') { return "error=$($r.error)" }
    if ($r.kind -ne 'closed') { return "kind=$($r.kind)" }
    $true
}

Check '数组形态下 cancel / 到点 都不算作答' {
    $script:MockWindow = @($leak, (New-MockWindowResult -Action 'message' -Message '{"type":"cancel"}'))
    $cancel = Invoke-CardApproval -Data $card
    $script:MockWindow = @($leak, (New-MockWindowResult -Action 'timeout'))
    $timeout = Invoke-CardApproval -Data $card
    if ($cancel.kind -ne 'closed') { return "cancel=$($cancel.kind)" }
    if ($timeout.kind -ne 'expired') { return "timeout=$($timeout.kind)" }
    $true
}

Check '映射函数只返回一个字符串（消息 → 结果类型，不是数组）' {
    $out = @(ConvertTo-ApprovalDecision -Action 'message' -Message '{"type":"decision","value":"allowed-once"}')
    if ($out.Count -ne 1) { return "返回 $($out.Count) 个对象" }
    if ($out[0] -isnot [string]) { return "类型=$($out[0].GetType().FullName)" }
    if ($out[0] -ne 'allowed-once') { return "值=$($out[0])" }
    $true
}

Check '外壳没吐结果对象时抛明确错误（不静默当成「没决定」）' {
    # 只剩泄漏对象、没有窗口结果：必须 fail-closed 地报错，而不是一路走到 'closed'。
    $script:MockWindow = @($leak)
    try {
        $null = Invoke-CardApproval -Data $card
        '没有抛异常（会被当成「没决定」，决定丢了都不知道）'
    } catch {
        if ($_.Exception.Message -notmatch '窗口结果对象') { return "错误文案不认识：$($_.Exception.Message)" }
        $true
    }
}

# ---- 源码契约：泄漏的那一头必须被接住 ---------------------------------------------

$shellDir = Get-ApprovalCardShellDir
$windowText = if ($shellDir -ne '') { Get-Content -Raw -LiteralPath (Join-Path $shellDir 'webview2.ps1') } else { '' }
$promptText = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'scripts\prompt.ps1')
$cardText = Get-Content -Raw -LiteralPath (Join-Path $uiDir 'card.ps1')

Check '外壳契约：OnShown / OnRendered 的返回值被接住（不再漏进 Show-CardWindow 的返回值）' {
    if ($windowText -eq '') { return '找不到 shared/ui-card/webview2.ps1' }
    if ($windowText -notmatch '\$null\s*=\s*&\s*\$OnShown') { return '外壳没有接住 OnShown 的输出' }
    if ($windowText -notmatch '\$null\s*=\s*&\s*\$OnRendered') { return '外壳没有接住 OnRendered 的输出' }
    $true
}

Check '插件契约：OnShown 里的 Invoke-TaskbarFlash 接住返回值；窗口结果按 Action 取，不按位置' {
    # 泄漏源头：回调里直接调用 Invoke-TaskbarFlash 会把会话对象吐进外壳的返回值。
    if ($promptText -notmatch '\$null\s*=\s*Invoke-TaskbarFlash') { return '调用 Invoke-TaskbarFlash 没接住返回值' }
    # 消费端：从外壳的多个输出里按「有没有 Action」认出唯一结果对象（不依赖输出顺序）。
    if ($cardText -notmatch '\$outputs\s*=\s*@\(\s*Show-CardWindow') { return '没有把外壳输出收进 $outputs' }
    if ($cardText -notmatch "PSObject\.Properties\['Action'\]") { return '没有按 Action 认出结果对象' }
    if ($cardText -notmatch '\$window\s*=\s*\$windows\[0\]') { return '$window 不是从唯一结果对象取的' }
    $true
}

Check '诊断契约：card-failed 带 ScriptStackTrace，且截断到 4000 字符以内' {
    if ($promptText -notmatch "stage\s+'card-failed'") { return '找不到 card-failed 诊断' }
    if ($promptText -notmatch 'stack\s*=\s*\$stack') { return 'card-failed 没记 stack 字段' }
    if ($promptText -notmatch '\.Length\s*-gt\s*4000') { return 'stack 没有按 4000 字符截断' }
    if ($promptText -notmatch 'Substring\(0,\s*4000\)') { return 'stack 的截断长度不是 4000' }
    $true
}

if ($failures -gt 0) {
    ""
    "失败 $failures 项"
    exit 1
}
""
"全部通过"

# 成功也必须显式给退出码：进程退出时继承的是最后一条原生命令的 $LASTEXITCODE。
exit 0
