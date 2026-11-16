# 卡片适配层自检（不需要 WebView2、不弹窗）：外壳定位 + 载荷结构 + 结果映射 + 假窗口端到端。
# 跑法：pwsh -NoProfile -File tests\card-select.ps1
#
# 断言的是「审批的业务差异有没有正确落到载荷字段上」：
#   - 抬头（工具名 · 提权审批 / 工作目录）、说明句（进命令块的第一行注释，不在框外另摆一块）、
#     命令块（只有原文 + comment，没有 caption）；
#   - 两个按钮（拒绝 = rejected、允许一次 = allowed-once primary）与防误点/自动关闭时序；
#   - 载荷只有数据、没有 HTML 片段；窗口参数（宽度/限高）不进载荷；
#   - 协议 → 业务结果的映射（allowed-once / rejected / closed / expired，认不出来一律 closed）；
#   - 插件没有再带外壳副本，dot-source 之后也不覆盖外壳的同名函数。
# 真弹窗、出图需要提权，不在这里做（见 tests\popup-visibility.ps1 与 tests\card-click.ps1）。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $pluginRoot
$uiDir = Join-Path $pluginRoot 'scripts\ui'

# 与 prompt.ps1 相同的加载顺序：先插件环境，再由 card.ps1 引外壳。
# 这个顺序正是「同名函数会静默覆盖」的现场，所以下面专门有一条断言守着。
. (Join-Path $uiDir 'environment.ps1')
. (Join-Path $uiDir 'card.ps1')

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
    windowTitle    = 'DSH 审批请求 · Write'
    metaCaption    = '工作区'
    meta           = 'C:\work\dsh-plugins'
    reasonCaption  = '模型给出的理由（模型自己撰写，请以命令原文为准）：'
    reason         = '需要把这次的审批结果写进插件的会话数据目录，下一轮还要接着用。'
    commandCaption = '模型请求执行的内容（原文，只读）：'
    command        = '$ Set-Content -LiteralPath "out.json" -Value 1'
    sound          = $false
    armDelayMs     = 1000
    closeAfterMs   = 600000
}

$payload = New-ApprovalCardPayload -Data $card

function Get-CardCopy {
    $copy = [ordered]@{}
    foreach ($key in $card.Keys) { $copy[$key] = $card[$key] }
    $copy
}

# ---- 外壳定位与「只有一份」 -------------------------------------------------------

Check '外壳定位：从插件 scripts\ui 上溯找到仓库根 shared/ui-card' {
    $dir = Get-ApprovalCardShellDir
    if ($dir -eq '') { return '找不到 shared/ui-card' }
    foreach ($name in @('card-html.ps1', 'webview2.ps1', 'webview2-runtime.ps1', 'dist\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $dir $name))) { return "外壳缺 $name" }
    }
    if ((Split-Path -Leaf (Split-Path -Parent $dir)) -ne 'shared') { return "命中的不是 shared/ui-card：$dir" }
    $true
}

Check '外壳缺失时抛明确错误（不静默生成一张空卡）' {
    $saved = $script:ApprovalCardShellDir
    try {
        $script:ApprovalCardShellDir = ''
        $message = ''
        try { $null = New-ApprovalCardPayload -Data $card } catch { $message = $_.Exception.Message }
        if ($message -eq '') { return '没有抛异常' }
        if (-not $message.Contains('shared/ui-card')) { return "错误里没写清缺什么：$message" }
        $true
    } finally {
        $script:ApprovalCardShellDir = $saved
    }
}

Check '插件没有外壳副本（card 目录 / card-html.ps1 / webview2.ps1 都不在）' {
    foreach ($relative in @('scripts\ui\card', 'scripts\ui\card-html.ps1', 'scripts\ui\webview2.ps1')) {
        if (Test-Path -LiteralPath (Join-Path $pluginRoot $relative)) { return "插件里还有 $relative" }
    }
    $true
}

Check '插件没有 vendor\webview2（DLL 只有仓库根一份）' {
    if (Test-Path -LiteralPath (Join-Path $pluginRoot 'vendor\webview2')) { return '插件里还有 vendor\webview2' }
    $vendor = Join-Path $repoRoot 'vendor\webview2'
    foreach ($name in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $vendor $name))) { return "仓库根 vendor\webview2 缺 $name" }
    }
    $true
}

Check 'dot-source 之后外壳同名函数没被插件覆盖（Get-DpiScale / Invoke-TaskbarFlash）' {
    # 函数的 Source 对 dot-source 进来的脚本是空的，所以按实现特征判：外壳那套走 DshUiCard，
    # 插件自己那份走 DshApprovalNotifier——两者混了就是插件抢了外壳的函数。
    $markers = [ordered]@{
        'Get-DpiScale'         = 'Initialize-CardNative'
        'Invoke-TaskbarFlash'  = 'DshUiCard.Native'
        'New-CardRegion'       = 'GraphicsPath'
        'Invoke-CardForceShow' = 'visibleAfter'
    }
    foreach ($name in $markers.Keys) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -eq $command) { return "外壳函数 $name 不见了" }
        if (-not $command.ScriptBlock.ToString().Contains($markers[$name])) {
            return "$name 已不是外壳的实现（缺 $($markers[$name])）"
        }
    }
    # 插件这一层只剩自检/验收用的能力：DPI、完整性级别、可写性、截屏。
    foreach ($name in @('Get-ApprovalDpiScale', 'Initialize-ApprovalNative', 'Save-ScreenCapture',
            'Get-ProcessIntegrity', 'Test-WritableDir')) {
        if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) { return "缺少插件函数 $name" }
    }
    $true
}

Check '源码契约：生产代码里没有 antdui / native-card（旧的自绘卡已删除）' {
    if (Test-Path -LiteralPath (Join-Path $pluginRoot 'scripts\ui\native-card.ps1')) { return 'native-card.ps1 还在' }
    if (Test-Path -LiteralPath (Join-Path $pluginRoot 'vendor')) { return '插件里还有 vendor 目录（DLL 只该在仓库根）' }
    # 只扫生产代码：tests\ 里出现这两个词是「断言它们不存在」，本身就是守卫；
    # README 里出现是「说明删了什么」，属于文档职责（B-01 管的是产品代码，不是文档）。
    $roots = @((Join-Path $pluginRoot 'scripts'), (Join-Path $pluginRoot 'locale'))
    $files = @(foreach ($root in $roots) {
            Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue
        })
    foreach ($name in @('index.js', 'package.json')) {
        $files += Get-Item -LiteralPath (Join-Path $pluginRoot $name) -ErrorAction SilentlyContinue
    }
    $hits = @()
    foreach ($file in @($files)) {
        foreach ($needle in @('antdui', 'native-card')) {
            $lines = @(Select-String -LiteralPath $file.FullName -Pattern $needle -SimpleMatch -ErrorAction SilentlyContinue)
            foreach ($match in $lines) { $hits += ('{0}:{1} [{2}]' -f $file.Name, $match.LineNumber, $needle) }
        }
    }
    if ($hits.Count -eq 0) { $true } else { '残留 ' + ($hits -join '; ') }
}

Check '渲染通道：prompt.ps1 只接受 auto / card（没有 native 分支）' {
    $source = Get-Content -LiteralPath (Join-Path $pluginRoot 'scripts\prompt.ps1') -Raw
    if ($source -notmatch "ValidateSet\('auto', 'card'\)") { return 'Renderer 的取值集合不是 auto/card' }
    if ($source -match '-Renderer\s+native') { return '还留着 -Renderer native 的用法' }
    $true
}

# ---- 载荷结构 -------------------------------------------------------------------

Check '结构：抬头 / 标题路径 / 命令块 / 两个按钮（没有固定句 title）' {
    if ([string]$payload.eyebrow -ne 'Write · 提权审批') { return "eyebrow=$($payload.eyebrow)" }
    if ($payload.Contains('title')) { return '载荷里还有 title 死字段（B-16）' }
    if (-not ([string]$payload.titleHtml).Contains('card__title-path')) { return '工作目录没有用标题第二行的样式' }
    if (-not ([string]$payload.titleHtml).Contains('C:\work\dsh-plugins')) { return '工作目录没进标题' }
    if (@($payload.body).Count -ne 1) { return "正文块 $((@($payload.body)).Count) 个，应为 1（说明进命令框，不再单占一块）" }
    if ($payload.body[0].kind -ne 'code') { return '唯一的正文块不是命令块' }
    if ($payload.buttons.Count -ne 2) { return "按钮数 $($payload.buttons.Count)" }
    $true
}

Check '说明进命令框（B-33）：理由出现在 code 块的 comment 里，body 里不再有同一句' {
    $comment = [string](Get-CardItemValue $payload.body[0] 'comment' '')
    if ($comment -eq '') { return '命令块没有 comment（说明句还在框外）' }
    if (-not $comment.Contains('需要把这次的审批结果写进插件的会话数据目录')) {
        return "comment 里没有那句说明：$comment"
    }
    if ($comment.StartsWith('# ')) { return 'comment 自己加了 # 前缀（外壳还会再加一次）' }
    # 同一句说明不许在框外重复：旧行为是 body 里单独一块 note。
    $outside = @()
    foreach ($block in @($payload.body)) {
        if ([string]$block['kind'] -eq 'code') { continue }
        $outside += [string](Get-CardItemValue $block 'text' '')
    }
    if (($outside -join "`n").Contains('需要把这次的审批结果写进插件的会话数据目录')) {
        return '框外仍然重复了一遍说明（同一句说明只许出现一处）'
    }
    $true
}

Check '命令块：只放原文（不带 caption），说明走 comment 而不是正文' {
    if ([string]$payload.body[0].command -ne '$ Set-Content -LiteralPath "out.json" -Value 1') { return '命令原文被改了' }
    if ([string]$payload.body[0].lang -ne 'sh') { return '语言标记丢了' }
    if ($payload.body[0].Contains('caption')) { return '代码块还带 caption（B-14：不写「判断以此为准」）' }
    if ($payload.body[0].Contains('text')) { return '命令块里还有 text 字段（说明该走 comment）' }
    $true
}

Check '说明不截断：超长理由原样进 comment（不补省略号、不改写）' {
    $copy = Get-CardCopy
    $copy.reason = '这一段说明会很长：' + ('命令要写进数据目录。' * 120) + '末尾标记'
    $long = New-ApprovalCardPayload -Data $copy
    $comment = [string](Get-CardItemValue $long.body[0] 'comment' '')
    if ($comment -ne $copy.reason) { return "comment 与原文不一致（$($comment.Length) / $($copy.reason.Length) 字符）" }
    if ($comment.EndsWith('…') -or $comment.EndsWith('...')) { return '末尾被补了省略号' }
    $true
}

Check '说明换行：折成一行注释（框里其他行会被读成命令）' {
    $copy = Get-CardCopy
    $copy.reason = "第一行说明`r`n第二行说明"
    $multi = New-ApprovalCardPayload -Data $copy
    $comment = [string](Get-CardItemValue $multi.body[0] 'comment' '')
    if ($comment.Contains("`n") -or $comment.Contains("`r")) { return 'comment 里还有换行' }
    if ($comment -ne '第一行说明 第二行说明') { return "折行结果不对：$comment" }
    $true
}

Check '说明为空：不出 comment、也不留占位块（命令自己就是主体）' {
    $copy = Get-CardCopy
    $copy.reason = ''
    $empty = New-ApprovalCardPayload -Data $copy
    if (@($empty.body).Count -ne 1) { return "正文块数 $((@($empty.body)).Count)，应为 1" }
    if ($empty.body[0].Contains('comment')) { return '没有说明却写了 comment' }
    if ([string]$empty.body[0].command -ne $copy.command) { return '命令原文被改了' }
    $true
}

Check '说明为空：载荷里根本没有 comment 键（不是空字符串，序列化后也不出现）' {
    $copy = Get-CardCopy
    $copy.reason = ''
    $empty = New-ApprovalCardPayload -Data $copy
    $block = $empty.body[0]
    # 负向断言：键必须在，值是空串也算失败——页面按「字段在不在」决定画不画那行灰色 `#`。
    if ($block.Contains('comment')) { return "没有说明却写了 comment 键（值：[$($block['comment'])]）" }
    if ($null -ne $block.PSObject.Properties['comment']) { return '块上有 comment 属性（空字符串也不行）' }
    $json = ConvertTo-CardPayloadJson -Payload $empty
    if ($json -match '"comment"\s*:') { return '载荷 JSON 里出现了 comment 键' }
    $true
}

Check '适配层不再有 comment 补丁：说明由 New-CardCodeBlock -Comment 直出' {
    # 补丁函数已删：外壳自己有 -Comment，载荷拼好之后不该再有人往块上补字段。
    if ($null -ne (Get-Command Add-ApprovalCodeComment -ErrorAction SilentlyContinue)) {
        return 'Add-ApprovalCodeComment 还在（外壳已支持 -Comment，补丁函数应当删掉）'
    }
    # 直出的证据是载荷结果：建块时给的说明原样过来，不经过任何二次加工。
    $block = New-CardCodeBlock -Command 'echo hi' -Lang 'sh' -Comment '一句说明'
    $direct = New-CardPayload -Body @($block)
    if ([string]$direct.body[0].comment -ne '一句说明') { return "建块时给的说明没进载荷：$($direct.body[0].comment)" }
    $json = ConvertTo-CardPayloadJson -Payload $direct
    if ($json -notmatch '"comment":"一句说明"') { return '序列化后 comment 与建块时给的不一致' }
    $true
}

Check '没有命令：说明退回正文块，不硬塞 comment（纯说明卡）' {
    $copy = Get-CardCopy
    $copy.command = ''
    $noCommand = New-ApprovalCardPayload -Data $copy
    if (@($noCommand.body).Count -ne 1) { return "正文块数 $((@($noCommand.body)).Count)，应为 1" }
    if ($noCommand.body[0].kind -ne 'note') { return '没有命令时应当退回正文块' }
    if ($noCommand.body[0].Contains('comment')) { return '没有命令却有 comment' }
    if (-not ([string]$noCommand.body[0].text).Contains('审批结果写进插件的会话数据目录')) { return '说明丢了' }
    $true
}

Check '没有工作目录：不出标题行，也不再有固定句标题' {
    $copy = Get-CardCopy
    $copy.meta = ''
    $fallback = New-ApprovalCardPayload -Data $copy
    if ($fallback.Contains('title')) { return '没有标题路径却又写了 title 死字段（B-16）' }
    if ($fallback.Contains('titleHtml')) { return '没有路径却写了 titleHtml' }
    $true
}

Check '转义：说明/命令里的 HTML 字符由 JSON 承载，不当标签用' {
    $copy = Get-CardCopy
    $copy.reason = '<b>不该变粗</b> & 别的'
    $copy.meta = 'C:\a<b>&"c"'
    $escaped = New-ApprovalCardPayload -Data $copy
    $json = ConvertTo-CardPayloadJson -Payload $escaped
    if ($json.Contains('<b>')) { return '说明里的尖括号没有转义' }
    $back = $json | ConvertFrom-Json
    if ([string]$back.body[0].comment -ne '<b>不该变粗</b> & 别的') { return "说明解回来不对：$($back.body[0].comment)" }
    if (-not ([string]$back.titleHtml).Contains('&lt;b&gt;')) { return '标题路径没转义' }
    $true
}

Check '按钮：拒绝 = rejected(default)、允许一次 = allowed-once(primary)' {
    if ($payload.buttons[0].label -ne '拒绝' -or $payload.buttons[0].action -ne 'rejected') { return '拒绝按钮不对' }
    if ($payload.buttons[0].kind -ne 'default') { return '拒绝不是普通按钮' }
    if ($payload.buttons[1].label -ne '允许一次' -or $payload.buttons[1].action -ne 'allowed-once') { return '允许按钮不对' }
    if ($payload.buttons[1].kind -ne 'primary') { return '允许不是主按钮' }
    if ((@($payload.buttons | Where-Object { $_.kind -eq 'primary' })).Count -ne 1) { return '主按钮不是唯一' }
    $true
}

Check '时序：armMs / closeMs 进载荷，键盘整张卡关掉' {
    if ([int]$payload.armMs -ne 1000) { return "armMs=$($payload.armMs)" }
    if ([int]$payload.closeMs -ne 600000) { return "closeMs=$($payload.closeMs)" }
    if ([string]$payload.keyboard -ne 'none') { return "keyboard=$($payload.keyboard)" }
    $true
}

Check '窗口参数不进载荷（宽度/限高/圆角是窗口独占的）' {
    foreach ($key in @('width', 'maxHeight', 'position', 'cornerRadius')) {
        if ($payload.Contains($key)) { return "载荷里出现了窗口参数 $key" }
    }
    $true
}

Check '文档：只有 React 产物一个渲染源（载荷标签外没有按钮/结构）' {
    $document = New-CardDocument -Payload $payload
    if ($document.Contains('<button')) { return '文档里还有 PowerShell 拼的按钮' }
    $inner = [regex]::Match($document, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    if (-not $inner.Contains('allowed-once')) { return '载荷没进文档' }
    $true
}

Check '方形：CornerRadius 只有一个来源，且窗口那半边走同一个常量' {
    if ($script:ApprovalCardCornerRadius -ne 0) { return "CornerRadius=$($script:ApprovalCardCornerRadius)" }
    $body = (Get-Command Invoke-CardApproval).ScriptBlock.ToString()
    if (-not $body.Contains('-CornerRadius $script:ApprovalCardCornerRadius')) { return '窗口那半边没走同一个来源' }
    $true
}

# ---- 消息 → 业务结果 -------------------------------------------------------------

Check '映射：decision(allowed-once / rejected) → 同名结果' {
    $a = ConvertTo-ApprovalDecision -Action 'message' -Message '{"type":"decision","value":"allowed-once"}'
    $r = ConvertTo-ApprovalDecision -Action 'message' -Message '{"type":"decision","value":"rejected"}'
    if ($a -eq 'allowed-once' -and $r -eq 'rejected') { $true } else { "allow=$a reject=$r" }
}

Check '映射：cancel / timeout / 关窗 都不算决定' {
    $c = ConvertTo-ApprovalDecision -Action 'message' -Message '{"type":"cancel"}'
    $t = ConvertTo-ApprovalDecision -Action 'timeout' -Message ''
    $x = ConvertTo-ApprovalDecision -Action 'closed' -Message ''
    if ($c -eq 'closed' -and $t -eq 'expired' -and $x -eq 'closed') { $true } else { "cancel=$c timeout=$t closed=$x" }
}

Check '映射：到点 → expired；出图 → shot' {
    $e = ConvertTo-ApprovalDecision -Action 'message' -Message '{"type":"expired"}'
    $s = ConvertTo-ApprovalDecision -Action 'shot' -Message ''
    if ($e -eq 'expired' -and $s -eq 'shot') { $true } else { "expired=$e shot=$s" }
}

Check '映射：认不出来的一律不算答（宁可不执行）' {
    $bad = ConvertTo-ApprovalDecision -Action 'message' -Message 'not json'
    $unknown = ConvertTo-ApprovalDecision -Action 'message' -Message '{"type":"decision","value":"maybe"}'
    $noType = ConvertTo-ApprovalDecision -Action 'message' -Message '{"value":"allowed-once"}'
    $empty = ConvertTo-ApprovalDecision -Action 'message' -Message ''
    if ($bad -eq 'closed' -and $unknown -eq 'closed' -and $noType -eq 'closed' -and $empty -eq 'closed') { $true }
    else { "bad=$bad unknown=$unknown noType=$noType empty=$empty" }
}

# ---- 窗口契约（不建窗，只验源码契约） ---------------------------------------------

Check '契约：Invoke-CardApproval 的返回对象一定带全部字段（StrictMode 下读不抛）' {
    $body = (Get-Command Invoke-CardApproval).ScriptBlock.ToString()
    $need = @('kind = ''closed''', 'error = ''''', 'contentWidth = 0', 'contentHeight = 0', 'windowBounds = ''''')
    $missing = @($need | Where-Object { -not $body.Contains($_) })
    if ($missing.Count -eq 0) { $true } else { '返回对象里缺 ' + ($missing -join ',') }
}

Check '契约：外壳返回 failed 时把原因放进 error（prompt 靠它写 error 结果并退出），不抛' {
    $body = (Get-Command Invoke-CardApproval).ScriptBlock.ToString()
    if (-not $body.Contains("Action -eq 'failed'")) { return '没有判 failed' }
    if (-not $body.Contains('$out.error = [string]$window.Error')) { return 'failed 时没把 error 交出去' }
    $true
}

# ---- 端到端（假窗口）：弹一次 → 翻译答案 -------------------------------------------
#
# 这里用同名函数盖住外壳的 Show-CardWindow，只验证「弹一次 → 翻译答案」这段业务代码；
# 真起窗需要提权，不在单测里做。必须放在文件末尾：盖掉之后不能再指望真窗口。

function Show-CardWindow {
    param(
        [Parameter(Mandatory)][string]$Html,
        [int]$Width = 680, [int]$MaxHeight = 0, [int]$TimeoutMs = 0, [string]$DataDir = '',
        [string]$Position = 'corner', [int]$SlotIndex = 0, [int]$SlotCount = 1,
        [int]$CornerRadius = 0, [string]$WindowTitle = 'DSH', [string]$WindowBackground = '',
        [switch]$TopMost, [switch]$Activate,
        [scriptblock]$OnShown = $null, [scriptblock]$OnRendered = $null
    )
    $script:MockCall = @{
        Html          = $Html
        Width         = $Width
        MaxHeight     = $MaxHeight
        CornerRadius  = $CornerRadius
        WindowTitle   = $WindowTitle
        TimeoutMs     = $TimeoutMs
        TopMost       = $TopMost.IsPresent
        Activate      = $Activate.IsPresent
        SlotIndex     = $SlotIndex
        SlotCount     = $SlotCount
        HasOnRendered = ($null -ne $OnRendered)
    }
    $script:MockWindow
}

Check '端到端（假窗口）：decision → 结果类型，且窗口参数来自业务配置' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'message'; Error = ''; ContentWidth = 680; ContentHeight = 400; WindowBounds = '0,0 680x400'
        ShowInfo = $null
        Message = '{"type":"decision","value":"allowed-once","checked":[]}'
    }
    $r = Invoke-CardApproval -Data $card -SlotIndex 2 -SlotCount 3
    if ($r.kind -ne 'allowed-once') { return "kind=$($r.kind)" }
    if ($r.error -ne '') { return "error=$($r.error)" }
    if ($script:MockCall.Width -ne 680 -or $script:MockCall.CornerRadius -ne 0) { return '宽度/圆角不是业务配置' }
    if ($script:MockCall.WindowTitle -ne 'DSH 审批请求 · Write') { return "窗口标题=$($script:MockCall.WindowTitle)" }
    if ($script:MockCall.TopMost -ne $false) { return '又在设 WinForms 的 TopMost（层级只由外壳 SetWindowPos 决定，见 DECISIONS D-39）' }
    if ($script:MockCall.Activate -ne $false) { return '传了 -Activate（SW_RESTORE 会抢前台）' }
    if ($script:MockCall.SlotIndex -ne 2 -or $script:MockCall.SlotCount -ne 3) { return '在场次序没透传' }
    if ($script:MockCall.TimeoutMs -ne 615000) { return "兜底超时=$($script:MockCall.TimeoutMs)" }
    if ($script:MockCall.HasOnRendered) { return '正式路径不该带截图回调' }
    if ([int]$script:MockCall.MaxHeight -le 0) { return '限高没交给窗口' }
    $true
}

Check '端到端（假窗口）：弹的是文档（payload 标签里有这次审批），不是拼出来的 HTML' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'message'; Error = ''; ContentWidth = 680; ContentHeight = 400; WindowBounds = ''
        ShowInfo = $null; Message = '{"type":"decision","value":"allowed-once"}'
    }
    $null = Invoke-CardApproval -Data $card
    $inner = [regex]::Match($script:MockCall.Html, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    $sent = $inner | ConvertFrom-Json
    if ([string]$sent.eyebrow -ne 'Write · 提权审批') { return "文档里的抬头不对：$($sent.eyebrow)" }
    if ([string]$sent.keyboard -ne 'none') { return '文档里没有禁键盘' }
    if (@($sent.buttons).Count -ne 2) { return '文档里的按钮数不对' }
    $true
}

Check '端到端（假窗口）：cancel / 到点 都不算作答' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'message'; Error = ''; ContentWidth = 0; ContentHeight = 0; WindowBounds = ''; ShowInfo = $null
        Message = '{"type":"cancel"}'
    }
    $cancel = Invoke-CardApproval -Data $card
    $script:MockWindow = [pscustomobject]@{
        Action = 'timeout'; Error = ''; ContentWidth = 0; ContentHeight = 0; WindowBounds = ''; ShowInfo = $null
        Message = ''
    }
    $timeout = Invoke-CardApproval -Data $card
    if ($cancel.kind -ne 'closed') { return "cancel=$($cancel.kind)" }
    if ($timeout.kind -ne 'expired') { return "timeout=$($timeout.kind)" }
    $true
}

Check '端到端（假窗口）：failed → error 非空、kind 仍是 closed（不抛）' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'failed'; Error = '模拟缺 DLL'; ContentWidth = 0; ContentHeight = 0; WindowBounds = ''; ShowInfo = $null
        Message = ''
    }
    $r = Invoke-CardApproval -Data $card
    if ($r.error -ne '模拟缺 DLL') { return "error=$($r.error)" }
    if ($r.kind -ne 'closed') { return "kind=$($r.kind)" }
    $true
}

Check '端到端（假窗口）：-RenderTo 走验收分支（shot），且不算作答' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'closed'; Error = ''; ContentWidth = 680; ContentHeight = 400; WindowBounds = ''; ShowInfo = $null
        Message = ''
    }
    $png = Join-Path ([System.IO.Path]::GetTempPath()) ('approval-card-shot-' + [guid]::NewGuid().ToString('N') + '.png')
    $r = Invoke-CardApproval -Data $card -RenderTo $png
    if ($r.kind -ne 'shot') { return "kind=$($r.kind)" }
    if (-not $script:MockCall.HasOnRendered) { return '出图时没把回调交给外壳' }
    $true
}

if ($failures -gt 0) {
    ""
    "失败 $failures 项"
    exit 1
}
""
"全部通过"

# 成功也必须显式给退出码：进程退出时继承的是最后一条原生命令的 $LASTEXITCODE，
# 不写这一行，跑通也会被 CI / 调用方读成失败（实测过：全绿却显示 exit=1）。
exit 0
