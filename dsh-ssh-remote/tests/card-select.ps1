# 卡片适配层自检（不需要 WebView2、不弹窗）：外壳定位 + 载荷结构 + 结果映射 + 假窗口端到端。
# 跑法：pwsh -NoProfile -File tests/card-select.ps1
#
# 断言的是「ssh 的业务差异有没有正确落到载荷字段上」：
#   - 一行一个可选行：label + 原因 + 命令 + cwd/超时（meta）+ 覆盖警告（warn）；
#   - 按钮语义（跳过 = skip、提交 = submit，提交必须至少选一行并按数量显示）；
#   - 载荷只有数据、没有 HTML 片段；窗口参数（宽度/限高）不进载荷；没有固定句 title；
#   - 协议 checked 的读取（有就按下标映射标签，没有就别读这个键）；
#   - 插件目录里不再有旧的 AntdUI / 自绘控件文件与引用（卡片是唯一渲染路径）。
# 真弹窗、出图需要提权，不在这里做。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = Split-Path -Parent $PSScriptRoot
$uiDir = Join-Path $pluginRoot 'scripts\ui'
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

# 与真实审批同一份载荷形状（admin.mjs 的 rows.json）：label / why / text / meta。
$fixture = Join-Path $PSScriptRoot 'fixtures\ssh-rows.json'
$rows = @(Get-Content -Raw -LiteralPath $fixture | ConvertFrom-Json)
$payload = New-SshCardPayload -Rows $rows -ProjectDir 'C:\proj\demo'

# ---- 外壳定位 -------------------------------------------------------------------

Check '外壳定位：从插件 scripts\ui 上溯找到仓库根 shared/ui-card' {
    $dir = Get-SshCardShellDir
    if ($dir -eq '') { return '找不到 shared/ui-card' }
    foreach ($name in @('card-html.ps1', 'webview2.ps1', 'webview2-runtime.ps1', 'dist\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $dir $name))) { return "外壳缺 $name" }
    }
    if ((Split-Path -Leaf (Split-Path -Parent $dir)) -ne 'shared') { return "命中的不是 shared/ui-card：$dir" }
    $true
}

Check '外壳缺失时抛明确错误（不静默生成一张空卡）' {
    $saved = $script:SshCardShellDir
    try {
        $script:SshCardShellDir = ''
        $message = ''
        try { $null = New-SshCardPayload -Rows $rows } catch { $message = $_.Exception.Message }
        if ($message -eq '') { return '没有抛异常' }
        if (-not $message.Contains('shared/ui-card')) { return "错误里没写清缺什么：$message" }
        $true
    } finally {
        $script:SshCardShellDir = $saved
    }
}

Check '插件没有自带 vendor\webview2（外壳去仓库根 vendor 找 DLL）' {
    if (Test-Path -LiteralPath (Join-Path $pluginRoot 'vendor\webview2')) { return '插件里还有 vendor\webview2' }
    $vendor = Join-Path (Split-Path -Parent $pluginRoot) 'vendor\webview2'
    foreach ($name in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $vendor $name))) { return "仓库根 vendor\webview2 缺 $name" }
    }
    $true
}

Check '源码契约：插件代码里没有 AntdUI / 自绘控件（卡片是唯一渲染路径）' {
    # 旧技术整体删除：文件、依赖、加载器、原生落位/强制显示，一个都不许留。
    foreach ($relative in @('vendor\antdui', 'scripts\ui\controls.ps1', 'scripts\ui\codeblock.ps1',
            'scripts\ui\environment.ps1')) {
        if (Test-Path -LiteralPath (Join-Path $pluginRoot $relative)) { return "还有 $relative" }
    }

    # 只扫正式代码（测试文件里会写这些名字做断言，不算残留；
    # README 里写「删掉了 AntdUI」是文档职责，B-01 管的是产品代码）。
    $patterns = @('AntdUI', 'antdui', 'New-UiLabel', 'New-UiButton', 'New-UiCheckbox', 'New-UiCodeBlock',
        'Find-AntdDll', 'Get-NativeCardOrigin', 'Invoke-SshForceShow', 'Initialize-SshNative')
    $files = @()
    $files += @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'scripts') -Recurse -File -Filter '*.ps1')
    foreach ($relative in @('index.js')) {
        $path = Join-Path $pluginRoot $relative
        if (Test-Path -LiteralPath $path) { $files += Get-Item -LiteralPath $path }
    }
    $files += @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'lib') -File -Filter '*.mjs')
    $hits = @()
    foreach ($file in $files) {
        foreach ($pattern in $patterns) {
            $match = Select-String -LiteralPath $file.FullName -Pattern $pattern -SimpleMatch -List -ErrorAction SilentlyContinue
            if ($null -ne $match) { $hits += "$($file.Name):$pattern" }
        }
    }
    if ($hits.Count -gt 0) { return '还有引用 -> ' + ($hits -join '; ') }
    $true
}

Check '源码契约：没有 New-Object 里混用逗号与加号的写法（会被拆成多参）' {
    # 真事：New-Object System.Drawing.Size($w, $cursor + $h + $m) 里逗号比加号优先，
    # 解析成 4 个参数，运行时才炸「Cannot find an overload for "Size"」。
    $bad = @()
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'scripts') -Recurse -File -Filter '*.ps1')) {
        $line = 0
        foreach ($text in [System.IO.File]::ReadAllLines($file.FullName)) {
            $line++
            if ($text -match 'New-Object\s+[\w.]+\([^)]*,[^)]*\+[^)]*\)') {
                $bad += "$($file.Name):$line"
            }
        }
    }
    if ($bad.Count -gt 0) { return '未加括号的算术参数 -> ' + ($bad -join '; ') }
    $true
}

# ---- 载荷结构 -------------------------------------------------------------------

Check '搬运行（D-37）：正文两行 Source/Target、lang=text，why 原文不带 #，框底仍是体积/标志' {
    # 与 items.mjs 的 itemsToRows 逐字同形（案由：说明文字被当成 shell 命令渲染，反引号露出来）。
    $copyRows = @(
        @{
            label = '192.168.1.11:22 · Web 1 → WSL(Debian)'
            why   = '把发布包送到本机 WSL 里验证'
            text  = "Source: /srv/app.tar`nTarget: /home/me/app.tar"
            meta  = '文件 2.0 KB · ⚠ 覆盖'
            lang  = 'text'
        }
    )
    $copy = New-SshCardPayload -Rows $copyRows
    $row = $copy.rows[0]
    if (-not $row.Contains('lang')) { return 'lang 没透传到载荷（行会退回 sh 高亮）' }
    if ([string]$row.lang -ne 'text') { return "lang=$($row.lang)" }
    if ([string]$row.text -ne "Source: /srv/app.tar`nTarget: /home/me/app.tar") { return "正文被改了：$($row.text)" }
    if (([string]$row.text).Contains('`')) { return '正文里还有反引号' }
    if (-not ([string]$row.text).StartsWith('Source: ')) { return '第一行不是 Source:' }
    if (([string]$row.text -split "`n").Count -ne 2) { return "正文不是两行：$(([string]$row.text -split "`n").Count)" }
    if (([string]$row.why).Contains('#')) { return 'why 里带 #（说明按原文渲染、外壳不再拼 #，带 # 会显示成假的注释符）' }
    if (([string]$row.why) -ne '把发布包送到本机 WSL 里验证') { return "原因被改了：$($row.why)" }
    if (-not ([string]$row.meta).Contains('文件 2.0 KB')) { return "框底的体积丢了：$($row.meta)" }
    if ([string]$row.warn -ne '覆盖') { return "覆盖标志丢了：$($row.warn)" }
    $true
}

Check 'run 行（D-37）：载荷里没有 lang 键（缺省按 sh 高亮），命令原文一字不改' {
    # 行 `text` 是真命令时必须继续按 sh 高亮，所以缺省不能写 lang 键。
    foreach ($row in $payload.rows) {
        if ($row.Contains('lang')) { return "run 行出现了 lang：$($row.label)" }
        if ([string]::IsNullOrWhiteSpace([string]$row.text)) { return "run 行没有命令：$($row.label)" }
    }
    $true
}

Check '结构：一行一个可选行，命令/原因留在行里（不浮到正文）' {
    $bodyProp = $payload.PSObject.Properties['body']
    if ($null -ne $bodyProp -and @($bodyProp.Value | Where-Object { $_.kind -eq 'code' }).Count -ne 0) { return '正文还有代码块，命令被拆出勾选行' }
    if ($payload.rows.Count -ne 3) { return "可选行 $($payload.rows.Count) 个，应为 3" }
    $true
}

Check '行：原因与命令原文一字不改（不做高亮、不加 HTML）' {
    foreach ($pair in @(@(0, '只读检查'), @(1, '部署后确认'), @(2, '覆盖前先备份'))) {
        $why = [string]$payload.rows[$pair[0]].why
        if (-not $why.Contains($pair[1])) { return "第 $($pair[0]) 行的原因不对：$why" }
    }
    if ($payload.rows[0].text -ne 'uname -a') { return "命令被改了：$($payload.rows[0].text)" }
    foreach ($row in $payload.rows) {
        foreach ($key in @('html', 'className')) {
            if ($row.Contains($key)) { return "行里出现了非载荷字段 $key" }
        }
    }
    $true
}

Check '可选行：标签 + cwd/超时（框底）+ 覆盖警告（主机行）各就各位' {
    $labels = @($payload.rows | ForEach-Object { $_.label })
    if (($labels -join ',') -ne 'WSL(Debian),192.168.1.11,192.168.1.14') { return "标签顺序不对：$($labels -join ',')" }
    if (-not ([string]$payload.rows[0].meta).Contains('工作目录 /root')) { return '元信息丢了' }
    # 「覆盖」这类警告不跟 cwd/超时混在框底：它单独进 warn，渲染在主机那一行。
    if ([string]$payload.rows[2].warn -ne '覆盖') { return "warn=$($payload.rows[2].warn)" }
    if (([string]$payload.rows[2].meta).Contains('覆盖')) { return "meta 里还有覆盖：$($payload.rows[2].meta)" }
    if (-not ([string]$payload.rows[2].meta).Contains('工作目录 /etc/nginx')) { return '覆盖行丢了 cwd' }
    $true
}

Check '抬头：eyebrow / 工作目录（命令来源）各就各位，没有固定句 title' {
    if ([string]$payload.eyebrow -ne 'SSH · 执行确认') { return "eyebrow=$($payload.eyebrow)" }
    if ($payload.Contains('title')) { return '载荷里还有 title 死字段（B-16）' }
    if (-not ([string]$payload.titleHtml).Contains('card__title-path')) { return '工作目录没有用标题第二行的样式' }
    if (-not ([string]$payload.titleHtml).Contains('C:\proj\demo')) { return '工作目录没进标题' }
    $true
}

Check '按钮：两个，跳过=skip、提交=submit（要求至少选一行 + 计数模板）' {
    if ($payload.buttons.Count -ne 2) { return "按钮数 $($payload.buttons.Count)，应为 2" }
    if ($payload.buttons[0].action -ne 'skip' -or $payload.buttons[0].kind -ne 'default') { return '跳过按钮不对' }
    $submit = $payload.buttons[1]
    if ($submit.action -ne 'submit' -or $submit.kind -ne 'primary') { return '提交按钮不对' }
    if ($submit.requiresChecked -ne $true) { return '提交没有要求至少选一行' }
    if ($submit.labelCount -ne '提交 {n} 项') { return '计数模板丢了' }
    if ($submit.label -ne '提交') { return '按钮文字丢了' }
    $true
}

Check '时序与窗口参数：armMs 进载荷，宽度/限高不进载荷（窗口独占）' {
    if ([int]$payload.armMs -ne 1000) { return "armMs=$($payload.armMs)" }
    foreach ($key in @('width', 'maxHeight', 'position', 'cornerRadius')) {
        if ($payload.Contains($key)) { return "载荷里出现了窗口参数 $key" }
    }
    $true
}

Check '方形：CornerRadius 只有一个来源，且窗口那半边走同一个常量' {
    if ($script:SshCardCornerRadius -ne 0) { return "CornerRadius=$($script:SshCardCornerRadius)" }
    $body = (Get-Command Invoke-SshCardSelect).ScriptBlock.ToString()
    if (-not $body.Contains('-CornerRadius $script:SshCardCornerRadius')) { return '窗口那半边没走同一个来源' }
    $true
}

Check '转义：命令/原因里的 < & " 由 JSON 承载，不会被当成 HTML' {
    $escaped = ConvertTo-CardPayloadJson -Payload (New-SshCardPayload -Rows @(
            @{ label = 'x'; why = 'a<b'; text = 'echo 1 & echo "<2>"'; meta = '' }))
    if ($escaped.Contains('<b>')) { return '尖括号没有转义' }
    $back = $escaped | ConvertFrom-Json
    if ($back.rows[0].text -ne 'echo 1 & echo "<2>"') { return "命令解回来不对：$($back.rows[0].text)" }
    if (-not $back.rows[0].why.Contains('a<b')) { return '原因没保留原文' }
    $true
}

Check 'Options 覆盖标签：可选行改用 Options，顺序不变' {
    $custom = New-SshCardPayload -Rows $rows -Options @('甲主机', '乙主机', '丙主机')
    $labels = @($custom.rows | ForEach-Object { $_.label })
    if (($labels -join ',') -ne '甲主机,乙主机,丙主机') { return "labels=$($labels -join ',')" }
    $true
}

Check '只有 Detail（没有 Rows）：一块正文、没有可选行' {
    $detail = New-SshCardPayload -Detail 'uname -a'
    if (@($detail.body).Count -ne 1) { return '正文块数不对' }
    if ($detail.Contains('rows')) { return '不该有可选行' }
    if ([string]$detail.body[0].command -ne 'uname -a') { return 'Detail 没进命令块' }
    $true
}

Check '文档：载荷被写进 payload 标签，页面壳只有一个渲染源' {
    $document = New-CardDocument -Payload $payload
    $inner = [regex]::Match($document, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    if (-not $inner.Contains('"rows"')) { return '文档里没有可选行' }
    if ($inner.Contains('card__row')) { return '载荷里混进了 HTML 结构' }
    if ($document.Contains('<button')) { return '文档里还有 PowerShell 拼的按钮' }
    $true
}

# ---- 消息 → 业务结果 -------------------------------------------------------------

Check '映射：decision + submit + checked → 勾选行的标签（按下标）' {
    $r = ConvertTo-SshDecision -Action 'message' -Labels @('a', 'b', 'c') `
        -Message '{"type":"decision","value":"submit","checked":[false,true,false]}'
    if ($r.answered -ne $true) { return 'answered 不是 true' }
    if (($r.selected -join ',') -ne 'b') { return "selected=$($r.selected -join ',')" }
    if ($r.action -ne 'submit') { return "action=$($r.action)" }
    $true
}

Check '映射：没有 checked 键时不读它、按没选处理（不抛异常）' {
    $r = ConvertTo-SshDecision -Action 'message' -Labels @('a') -Message '{"type":"decision","value":"submit"}'
    if ($r.answered -ne $false -or $r.selected.Count -ne 0) { return "answered=$($r.answered) selected=$($r.selected.Count)" }
    $true
}

Check '映射：checked 全是 false / 下标越界 → 不算答，也不抛' {
    $none = ConvertTo-SshDecision -Action 'message' -Labels @('a', 'b') `
        -Message '{"type":"decision","value":"submit","checked":[false,false]}'
    if ($none.answered -ne $false) { return '全没选却算答了' }
    $short = ConvertTo-SshDecision -Action 'message' -Labels @('a') `
        -Message '{"type":"decision","value":"submit","checked":[true,true]}'
    if (($short.selected -join ',') -ne 'a') { return "越界下标被算进来了：$($short.selected -join ',')" }
    $true
}

Check '映射：跳过（skip）即使带了 checked 也不算答' {
    $r = ConvertTo-SshDecision -Action 'message' -Labels @('a') `
        -Message '{"type":"decision","value":"skip","checked":[true]}'
    if ($r.answered -ne $false -or $r.selected.Count -ne 0) { return "answered=$($r.answered)" }
    if ($r.action -ne 'skip') { return "action=$($r.action)" }
    $true
}

Check '映射：cancel / expired / closed / timeout 一律不算答' {
    $cancel = ConvertTo-SshDecision -Action 'message' -Message '{"type":"cancel"}' -Labels @('a')
    $expired = ConvertTo-SshDecision -Action 'message' -Message '{"type":"expired"}' -Labels @('a')
    $closed = ConvertTo-SshDecision -Action 'closed' -Message '' -Labels @('a')
    $timeout = ConvertTo-SshDecision -Action 'timeout' -Message '' -Labels @('a')
    foreach ($r in @($cancel, $expired, $closed, $timeout)) {
        if ($r.answered -ne $false -or $r.selected.Count -ne 0) { return '有空动作被当成已答' }
    }
    if ($cancel.action -ne 'cancel' -or $expired.action -ne 'expired') { return '动作名没翻译对' }
    if ($timeout.action -ne 'expired') { return "timeout 应翻成 expired，得到 $($timeout.action)" }
    $true
}

Check '映射：协议解析不了按「没答」处理，不抛' {
    $r = ConvertTo-SshDecision -Action 'message' -Message '这不是 JSON' -Labels @('a')
    if ($r.answered -ne $false -or $r.selected.Count -ne 0) { return '解析失败却给了答案' }
    $true
}

Check '契约：原生密码框已删除（没有 password.ps1 / UseSystemPasswordChar）' {
    if (Test-Path -LiteralPath (Join-Path $uiDir 'password.ps1')) { return '还有 scripts\ui\password.ps1' }
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'popup-visibility.ps1')) { return '还有 tests\popup-visibility.ps1' }
    $hits = @()
    foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'scripts') -Recurse -File -Filter '*.ps1')) {
        if (Select-String -LiteralPath $file.FullName -Pattern 'UseSystemPasswordChar' -SimpleMatch -List -ErrorAction SilentlyContinue) {
            $hits += $file.Name
        }
    }
    if ($hits.Count -gt 0) { return '还有原生掩码控件 -> ' + ($hits -join '; ') }
    $true
}

Check '源码契约：卡片显示由外壳 Invoke-CardForceShow 保证' {
    $shellDir = Get-SshCardShellDir
    if ($shellDir -eq '') { return '找不到外壳' }
    $webview = Get-Content -Raw -LiteralPath (Join-Path $shellDir 'webview2.ps1')
    if (-not $webview.Contains('Invoke-CardForceShow')) { return '外壳没有强制显示（SW_HIDE 会顶掉第一次 ShowWindow）' }
    $environment = Get-Content -Raw -LiteralPath (Join-Path $shellDir 'environment.ps1')
    if (-not $environment.Contains('function Invoke-CardForceShow')) { return '外壳里没有 Invoke-CardForceShow 实现' }
    $true
}

Check '契约：Invoke-SshCardSelect 的返回对象一定带 shot（StrictMode 下读不抛）' {
    $body = (Get-Command Invoke-SshCardSelect).ScriptBlock.ToString()
    if (-not $body.Contains('shot     = $false')) { return '返回对象里没写 shot' }
    $sample = [pscustomobject]@{ answered = $true; selected = @('a'); action = 'submit'; shot = $false }
    if ($sample.shot -eq $false -and $sample.answered -eq $true) { $true } else { 'shot 读取异常' }
}

Check '契约：外壳返回 failed 时抛异常（dialog 靠它写 stderr 并非零退出）' {
    $body = (Get-Command Invoke-SshCardSelect).ScriptBlock.ToString()
    if (-not $body.Contains("Action -eq 'failed'")) { return '没有判 failed' }
    if (-not $body.Contains('throw')) { return 'failed 时没有抛异常' }
    $true
}

Check '契约：弹窗失败写明确 stderr 并非零退出（不返回空答案冒充「跳过」）' {
    $dialog = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'scripts\dialog.ps1')
    if (-not $dialog.Contains("[Console]::Error.Write('弹窗起不来：'")) { return '失败时没有写明确原因' }
    if (-not $dialog.Contains('exit 1')) { return '失败时没有非零退出' }
    if ($dialog.Contains('answered = $false')) { return '失败分支里出现了伪造的空答案' }
    $true
}

Check '高度：卡片最高不超过 760、不低于 420（弹窗不是全屏面板）' {
    $max = Get-CardMaxHeight -Requested 0 -WorkAreaHeight 1080 -Scale 1
    if ($max -ne 669) { return "1080p 得到 $max，应为 669" }
    if ((Get-CardMaxHeight -Requested 500) -ne 500) { return '显式值被改掉了' }
    if ((Get-CardMaxHeight -Requested 2000) -ne 760) { return '上限没夹住' }
    $true
}

# ---- 端到端（假窗口）：Invoke 的三个分支 -------------------------------------------
#
# 这里用同名函数盖住外壳的 Show-CardWindow，只验证「弹一次 → 翻译答案」这段业务代码；
# 真起窗需要提权，不在单测里做。必须放在文件末尾：盖掉之后不能再指望真窗口。

function Show-CardWindow {
    param(
        [Parameter(Mandatory)][string]$Html,
        [int]$Width = 680, [int]$MaxHeight = 0, [int]$TimeoutMs = 0, [string]$DataDir = '',
        [string]$Position = 'center', [int]$SlotIndex = 0, [int]$SlotCount = 1,
        [int]$CornerRadius = 0, [string]$WindowTitle = 'DSH', [string]$WindowBackground = '',
        [switch]$TopMost, [switch]$Activate,
        [scriptblock]$OnShown = $null, [scriptblock]$OnRendered = $null
    )
    $script:MockLastHtml = $Html
    $script:MockCall = [pscustomobject]@{
        Width        = $Width
        MaxHeight    = $MaxHeight
        TimeoutMs    = $TimeoutMs
        CornerRadius = $CornerRadius
        HasOnRendered = ($null -ne $OnRendered)
        Activate     = $Activate.IsPresent
    }
    $script:MockWindow
}

Check '端到端（假窗口）：外壳返回 failed → 抛异常（dialog 靠它写 stderr）' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'failed'; Message = ''; Error = '模拟缺 DLL'; ContentWidth = 0; ContentHeight = 0
        WindowBounds = ''; ShowInfo = $null
    }
    $message = ''
    try { $null = Invoke-SshCardSelect -Rows $rows } catch { $message = $_.Exception.Message }
    if ($message -eq '') { return '没有抛异常' }
    if (-not $message.Contains('模拟缺 DLL')) { return "异常里没有外壳给的原因：$message" }
    $true
}

Check '端到端（假窗口）：decision+checked → 勾选标签，shot=false' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'message'; Error = ''; ContentWidth = 680; ContentHeight = 400; WindowBounds = ''; ShowInfo = $null
        Message = '{"type":"decision","value":"submit","checked":[true,false]}'
    }
    $r = Invoke-SshCardSelect -Rows $rows
    if (($r.selected -join ',') -ne 'WSL(Debian)') { return "selected=$($r.selected -join ',')" }
    if ($r.answered -ne $true -or $r.shot -ne $false) { return "answered=$($r.answered) shot=$($r.shot)" }
    $true
}

Check '端到端（假窗口）：弹的是文档（payload 标签里有这次的行），宽度/限高/圆角都交给窗口' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'closed'; Message = ''; Error = ''; ContentWidth = 680; ContentHeight = 400
        WindowBounds = ''; ShowInfo = $null
    }
    $null = Invoke-SshCardSelect -Rows $rows -Width 640 -MaxHeight 600
    $inner = [regex]::Match($script:MockLastHtml, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    $sent = $inner | ConvertFrom-Json
    if (@($sent.rows).Count -ne 3) { return "文档里的行数不对：$(@($sent.rows).Count)" }
    if ([int]$script:MockCall.Width -ne 640) { return "宽度没交给窗口：$($script:MockCall.Width)" }
    if ([int]$script:MockCall.MaxHeight -ne 600) { return "限高没交给窗口：$($script:MockCall.MaxHeight)" }
    if ([int]$script:MockCall.CornerRadius -ne 0) { return "圆角没交给窗口：$($script:MockCall.CornerRadius)" }
    $true
}

Check '端到端（假窗口）：关闭窗口 → 一行都不选（未勾选不执行）' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'closed'; Message = ''; Error = ''; ContentWidth = 680; ContentHeight = 400
        WindowBounds = ''; ShowInfo = $null
    }
    $r = Invoke-SshCardSelect -Rows $rows
    if ($r.answered -ne $false -or $r.selected.Count -ne 0) { return '关闭窗口被当成答了' }
    $true
}

Check '端到端（假窗口）：-ShotPath 走验收分支，返回 shot=true 且不算作答' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'closed'; Message = ''; Error = ''; ContentWidth = 680; ContentHeight = 400
        WindowBounds = ''; ShowInfo = $null
    }
    $png = Join-Path ([System.IO.Path]::GetTempPath()) ('ssh-card-shot-' + [guid]::NewGuid().ToString('N') + '.png')
    $r = Invoke-SshCardSelect -Rows $rows -ShotPath $png
    if ($r.shot -ne $true) { return "shot=$($r.shot)" }
    if ($r.answered -ne $false -or $r.selected.Count -ne 0) { return '出图被当成作答' }
    if (-not $script:MockCall.HasOnRendered) { return '出图时没把回调交给外壳' }
    $true
}

Check '契约：确认卡与表单卡已删除（B-47：ssh 的弹窗只剩勾选卡＝审批）' {
    # 用户 2026-11-16：「ssh相关的弹窗 只剩 审批」「勾选执行就是审批啊 包括执行和复制」。
    # 新增/改密码/改备注/删除主机都在插件设置页做，会话侧连卡片构造函数都不许留。
    foreach ($name in @('Invoke-SshCardConfirm', 'Invoke-SshCardForm', 'New-SshConfirmPayload', 'New-SshFormPayload', 'ConvertTo-SshConfirmDecision', 'ConvertTo-SshFormDecision')) {
        if (Get-Command $name -ErrorAction SilentlyContinue) { return "$name 还能被解析到" }
    }
    foreach ($relative in @('scripts\ui\card.ps1', 'scripts\ui\shared.ps1', 'scripts\dialog.ps1')) {
        $text = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot $relative)
        foreach ($name in @('Invoke-SshCardConfirm', 'Invoke-SshCardForm', 'New-SshConfirmPayload', 'New-SshFormPayload')) {
            if ($text.Contains($name)) { return "$relative 里还有 $name" }
        }
    }
    $dialog = Get-Content -Raw -LiteralPath (Join-Path $pluginRoot 'scripts\dialog.ps1')
    if (-not $dialog.Contains("ValidateSet('select')")) { return 'dialog.ps1 的 Mode 白名单不是只有 select' }
    if ($dialog -match "'confirm'|'form'") { return 'dialog.ps1 还收 confirm / form 模式' }
    $true
}

Check '不自超时（2026-11-10）：勾选卡不传 -TimeoutMs / -CloseMs，链路里没有 AutoCloseMs' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'closed'; Message = ''; Error = ''; ContentWidth = 680; ContentHeight = 400
        WindowBounds = ''; ShowInfo = $null
    }

    $null = Invoke-SshCardSelect -Rows $rows
    if ([int]$script:MockCall.TimeoutMs -ne 0) { return "勾选卡的窗口超时=$($script:MockCall.TimeoutMs)，应为 0（一直等）" }
    $sent = [regex]::Match($script:MockLastHtml, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value | ConvertFrom-Json
    if ($null -ne $sent.PSObject.Properties['closeMs']) { return '勾选卡载荷里还有 closeMs（页面会倒计时自己关）' }



    # 产品源码里连这个名字都不许剩：参数、透传、Get-SshWindowTimeoutMs 都删干净。
    $productFiles = @()
    $productFiles += @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'scripts') -Recurse -File -Filter '*.ps1')
    $productFiles += @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'lib') -File -Filter '*.mjs')
    $left = @($productFiles | Where-Object {
            (Get-Content -Raw -LiteralPath $_.FullName) -match 'AutoCloseMs|Get-SshWindowTimeoutMs'
        })
    if ($left.Count -gt 0) { return 'AutoCloseMs 链还有残留：' + (($left | ForEach-Object { $_.Name }) -join ', ') }
    # 运行路径用的是产物：源码删干净了、bundle 没重建，行为就还停在老版本上。
    # `tests/plugin-bundle.ps1` 只看 mtime（产物比 lib 旧），判不出「内容里还留着 AutoCloseMs」，
    # 所以这里直接扫产物的内容。
    $bundle = Join-Path $pluginRoot 'index.bundle.js'
    if (-not (Test-Path -LiteralPath $bundle)) { return '缺 index.bundle.js（运行路径的产物）' }
    if ((Get-Content -Raw -LiteralPath $bundle).Contains('AutoCloseMs')) {
        return 'index.bundle.js 里还有 AutoCloseMs（源码删了但产物没重建）'
    }
    if (Get-Command Get-SshWindowTimeoutMs -ErrorAction SilentlyContinue) { return 'Get-SshWindowTimeoutMs 还能被解析到' }
    $true
}

Check '不抢前台（D-39）：勾选卡不传 -Activate（SW_RESTORE 会抢前台）' {
    $script:MockWindow = [pscustomobject]@{
        Action = 'closed'; Message = ''; Error = ''; ContentWidth = 680; ContentHeight = 400
        WindowBounds = ''; ShowInfo = $null
    }
    $null = Invoke-SshCardSelect -Rows $rows
    if ($script:MockCall.Activate -ne $false) { return '勾选卡传了 -Activate' }

    # 只扫「代码」：注释里写清「不传 -Activate / 为什么不用 topmost」是结论，不是用法。
    # 之前没剥注释，能过全靠注释里用了全角标点（`-Activate` 后面跟的是「）」而不是空白），
    # 等于把结果赌在措辞上；这里与 tests/card-shell.ps1 同口径：先剥注释再扫。
    $codeOf = {
        param([string]$path)
        $text = [regex]::Replace((Get-Content -Raw -LiteralPath $path), '(?s)<#.*?#>', '')
        (@($text -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
    }
    $offenders = @(Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'scripts') -Recurse -File -Filter '*.ps1' |
        Where-Object { (& $codeOf $_.FullName) -match '(?<![\w$])-Activate(?=[\s`]|$)' })
    if ($offenders.Count -gt 0) { return '源码里还有 -Activate 实参：' + (($offenders | ForEach-Object { $_.Name }) -join ', ') }
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
