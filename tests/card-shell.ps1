# 纯逻辑自检：卡片产物、载荷结构、两阶段协议、宿主契约（不建窗口、不需要提权）。
#
# 跑法：pwsh -NoProfile -File tests\card-shell.ps1
#
# 覆盖：
#   - 产物：dist/index.html 存在、JS/CSS 全内联、payload 标签恰好一个；
#   - New-CardDocument：只替换 payload 标签（构造含占位符的假产物验证），JSON 可解回；
#   - 载荷：New-CardPayload 的字段归一、空字段省略、单主按钮、转义；
#   - 协议：ready/resize/decision/cancel/expired/shown 的形状，ConvertFrom-CardMessage 的解析；
#   - 防回退：shared/ui-card 下不再有旧模板/CSS/.qc- 类名，宿主编译不再量 DOM；
#   - Get-CardMaxHeight 的 62% 比例与 420–760 钳制；
#   - 三个真实载荷样例各生成一次完整文档（字节数在末尾打印，供提权出图用）。

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:CardDir = Join-Path $script:RepoRoot 'shared\ui-card'
$script:Failures = 0
$script:Total = 0

# 注意 dot-source 顺序：demo.ps1 带参数块（Payload/Width/MaxHeight/TimeoutMs），
# 会把当前作用域的同名变量覆盖成默认值，所以先 dot-source，后面不要再用这些名字。
. (Join-Path $script:CardDir 'card-html.ps1')
. (Join-Path $script:CardDir 'webview2.ps1')
. (Join-Path $script:CardDir 'demo\demo.ps1')

function Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )

    $script:Total++
    try {
        $result = & $Body
        if ($result -eq $true) {
            "PASS  $Name"
            return
        }
        "FAIL  $Name -> $result"
        $script:Failures++
    } catch {
        "FAIL  $Name -> 抛异常：$($_.Exception.Message)"
        $script:Failures++
    }
}

function Get-CardShellText {
    param([Parameter(Mandatory = $true)][string]$Name)
    Get-Content -Raw -LiteralPath (Join-Path $script:CardDir $Name) -Encoding utf8
}

# ---- 产物 -----------------------------------------------------------------------

$script:DistPath = $null
Check '产物：dist/index.html 存在' {
    $path = Get-CardDocumentPath
    if (-not (Test-Path -LiteralPath $path)) { return "缺 $path" }
    $script:DistPath = $path
    $true
}

$script:DistHtml = if ($null -ne $script:DistPath) { Get-Content -Raw -LiteralPath $script:DistPath -Encoding utf8 } else { '' }

Check '产物：JS 与 CSS 全部内联（一个 module 脚本、没有外链样式/脚本）' {
    if ($script:DistHtml -eq '') { return '没有产物可查' }
    $modules = ([regex]::Matches($script:DistHtml, '<script type="module"')).Count
    if ($modules -ne 1) { return "内联 module 脚本 $modules 个，应为 1" }
    if ($script:DistHtml.Contains('<link rel="stylesheet"')) { return '还有外链 stylesheet' }
    if ($script:DistHtml -match 'src="/') { return '还有外链脚本 src="/…' }
    if ($script:DistHtml -match '(?i)<script[^>]+src=') { return '还有带 src 的 script 标签' }
    $true
}

Check '产物：payload 标签恰好一个，且内容还是占位符' {
    if ($script:DistHtml -eq '') { return '没有产物可查' }
    $tags = ([regex]::Matches($script:DistHtml, '<script id="dsh-payload"')).Count
    if ($tags -ne 1) { return "payload 标签 $tags 个，应为 1" }
    $inner = [regex]::Match($script:DistHtml, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    if ($inner.Trim() -ne '__DSH_PAYLOAD__') { return "标签内容不是占位符：$($inner.Trim())" }
    $true
}

Check '产物：入口模板带 measure 阶段标记（构建时会进 dist）' {
    $entry = Get-CardShellText 'app\index.html'
    if ($entry -notmatch '<html lang="zh-CN" data-phase="measure">') { return 'app/index.html 没有 data-phase="measure"' }
    if ($entry -notmatch 'id="dsh-payload"') { return 'app/index.html 没有 payload 标签' }
    $true
}

# ---- New-CardDocument：只替换标签 ------------------------------------------------

Check '产物：dist\index.html 不早于 app\src（改了页面就要重新构建）' {
    # 只有产物上屏：改了 app/src 不构建，测试照样全绿，卡片却还是旧的（AGENTS §0「产物与源码同步」）。
    # 判据只比 mtime：签出后两边时间相同（相等不算旧），真改过源码才会一前一后。
    $dist = Join-Path $script:CardDir 'dist\index.html'
    if (-not (Test-Path -LiteralPath $dist)) { return 'dist\index.html 不存在' }
    $distTime = (Get-Item -LiteralPath $dist).LastWriteTimeUtc
    $newest = $null
    $newestName = ''
    foreach ($file in (Get-ChildItem -LiteralPath (Join-Path $script:CardDir 'app\src') -Recurse -File)) {
        if ($null -eq $newest -or $file.LastWriteTimeUtc -gt $newest) {
            $newest = $file.LastWriteTimeUtc
            $newestName = $file.Name
        }
    }
    if ($null -ne $newest -and $distTime -lt $newest) {
        return "dist\index.html 比 app\src\$newestName 旧（构建：cd shared\ui-card\app 后 npm run build）"
    }
    $true
}

Check 'New-CardDocument：只替换 payload 标签，标签外的同名占位符原样保留' {
    $fake = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-card-fake-' + [guid]::NewGuid().ToString('N') + '.html')
    try {
        $source = '<html><body><script id="dsh-payload" type="application/json">__DSH_PAYLOAD__</script>' +
        '<script>const keep = "__DSH_PAYLOAD__";</script></body></html>'
        Set-Content -LiteralPath $fake -Value $source -Encoding utf8 -NoNewline

        $payload = New-CardPayload -Eyebrow '只换标签'
        $document = New-CardDocument -Payload $payload -SourcePath $fake
        if (-not $document.Contains('const keep = "__DSH_PAYLOAD__"')) { return '标签外的占位符被改掉了（整串 Replace？）' }

        $inner = [regex]::Match($document, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
        $parsed = $inner | ConvertFrom-Json
        if ([string]$parsed.eyebrow -ne '只换标签') { return "标签里不是这次载荷：$inner" }
        $true
    } finally {
        Remove-Item -LiteralPath $fake -Force -ErrorAction SilentlyContinue
    }
}

Check 'New-CardDocument：命令里的 </script> 被转义，不会提前闭合标签' {
    $payload = New-CardPayload -Body @(New-CardCodeBlock -Command 'echo </script> & <x>')
    $document = New-CardDocument -Payload $payload
    $inner = [regex]::Match($document, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    if (-not $inner.Contains('\u003c/script\u003e')) { return '没有转义 </script>' }
    $parsed = $inner | ConvertFrom-Json
    if ([string]$parsed.body[0].command -ne 'echo </script> & <x>') { return "解回来不对：$($parsed.body[0].command)" }
    $true
}

Check 'New-CardDocument：产物不存在 / 标签不是恰好一个都抛明确错误' {
    $missing = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-card-missing-' + [guid]::NewGuid().ToString('N') + '.html')
    $message = ''
    try { $null = New-CardDocument -Payload (New-CardPayload) -SourcePath $missing } catch { $message = $_.Exception.Message }
    if ($message -eq '') { return '缺产物时没有抛异常' }
    if (-not $message.Contains('不存在')) { return "错误文案不清楚：$message" }

    $fake = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-card-two-' + [guid]::NewGuid().ToString('N') + '.html')
    try {
        Set-Content -LiteralPath $fake -Value '<script id="dsh-payload">a</script><script id="dsh-payload">b</script>' -Encoding utf8 -NoNewline
        $message = ''
        try { $null = New-CardDocument -Payload (New-CardPayload) -SourcePath $fake } catch { $message = $_.Exception.Message }
        if ($message -eq '') { return '两个 payload 标签时没有抛异常' }
        if (-not $message.Contains('恰好 1 个')) { return "错误文案不清楚：$message" }
    } finally {
        Remove-Item -LiteralPath $fake -Force -ErrorAction SilentlyContinue
    }
    $true
}

Check '产物缺失时给的是「去构建」的路径，而不是一句空话' {
    $message = ''
    try { $null = Get-CardDocumentPath -CardDir (Join-Path $script:RepoRoot 'no-such-card-dir') } catch { $message = $_.Exception.Message }
    if ($message -eq '') { return '没有抛异常' }
    if (-not ($message.Contains('npm run build') -or $message.Contains('dist\index.html'))) { return "错误文案没指向构建：$message" }
    $true
}

# ---- 载荷结构 -------------------------------------------------------------------

Check 'New-CardPayload：字段齐全时顺序与键名符合 types.ts（没有 title 死字段）' {
    $payload = New-CardPayload -Eyebrow '抬头' -TitleHtml (New-CardTitlePath -Text 'C:\path') `
        -Status '状态' -Body @(New-CardNoteBlock -Text '正文') -Rows @(New-CardRow -Label '行' -Meta '元' -Warn '覆盖') `
        -Buttons @(New-CardButton -Label '好' -Action 'ok' -Kind 'primary') -ArmMs 1200 -CloseMs 5000 -Keyboard 'none'
    foreach ($key in @('eyebrow', 'titleHtml', 'status', 'body', 'rows', 'buttons', 'armMs', 'closeMs', 'keyboard')) {
        if (-not $payload.Contains($key)) { return "缺字段 $key" }
    }
    if ($payload.Contains('title')) { return '载荷里还有 title 死字段（B-16）' }
    if ($payload.body[0].kind -ne 'note') { return 'body 不是 note 块' }
    if ($payload.rows[0].label -ne '行' -or $payload.rows[0].meta -ne '元' -or $payload.rows[0].warn -ne '覆盖') {
        return 'rows 没带上 label/meta/warn'
    }
    if ($payload.buttons[0].kind -ne 'primary') { return '按钮 kind 丢了' }
    $true
}

Check 'New-CardPayload：空字段不进载荷（没有区域 ≠ 区域是空的）' {
    $payload = New-CardPayload
    foreach ($key in @('eyebrow', 'title', 'titleHtml', 'status', 'body', 'rows', 'buttons', 'armMs', 'closeMs', 'keyboard')) {
        if ($payload.Contains($key)) { return "不该出现 $key" }
    }
    # 单字段输入区已随 R-12 删除：载荷里**任何情况下**都不该再出现这个键（不是「空的时候才不写」）。
    if ($payload.Contains('input')) { return '载荷里出现了 input（单字段输入区已随 R-12 删除）' }
    if ($payload.Count -ne 0) { return "空载荷应当一个键都没有，实际 $($payload.Keys -join ',')" }
    $true
}

Check 'New-CardNoteBlock：保留换行；空文本给占位而不是留白' {
    $block = New-CardNoteBlock -Text "第一行`r`n第二行"
    if ($block.text.Contains("`r")) { return '没有把 CRLF 归一' }
    if (-not $block.text.Contains("`n")) { return '换行丢了' }
    $empty = New-CardNoteBlock -Text ''
    if ([string]::IsNullOrWhiteSpace([string]$empty.text)) { return '空正文没有占位' }
    if ($empty.muted -ne $true) { return '占位不是 muted' }
    $true
}

Check 'New-CardCodeBlock：命令原文一字不改，只有 lang、没有 caption' {
    $block = New-CardCodeBlock -Command '  df -h / # 保留前导空格' -Lang 'sh'
    if ($block.command -ne '  df -h / # 保留前导空格') { return "命令被改了：'$($block.command)'" }
    if ($block.lang -ne 'sh') { return 'lang 丢了' }
    if ($block.Contains('caption')) { return '代码块还带 caption（B-14）' }
    $true
}

Check '构造函数不再接受 -Title / -Caption（死字段删干净，不留「传了不生效」）' {
    if ((Get-Command New-CardPayload).Parameters.ContainsKey('Title')) { return 'New-CardPayload 还接受 -Title' }
    if ((Get-Command New-CardCodeBlock).Parameters.ContainsKey('Caption')) { return 'New-CardCodeBlock 还接受 -Caption' }
    $true
}

Check 'New-CardCodeBlock -Comment：说明是独立字段，不许拼进 command（B-31 / C-08）' {
    $block = New-CardCodeBlock -Command 'ls -l /root' -Comment '看目录'
    if ($block.command -ne 'ls -l /root') { return "命令被改了：'$($block.command)'" }
    if ($block.comment -ne '看目录') { return 'comment 没有写进块' }
    # 不带 -Comment 时字段必须**不存在**（不是空串）：页面靠「字段在不在」判断有没有说明。
    $plain = New-CardCodeBlock -Command 'ls'
    if ($plain.Contains('comment')) { return '没给说明时也写了 comment 字段' }
    $blank = New-CardCodeBlock -Command 'ls' -Comment '   '
    if ($blank.Contains('comment')) { return '空白说明也写成了 comment 字段' }
    $true
}

Check 'ConvertTo-CardBlockList：comment 透传，不丢也不凭空造' {
    $blocks = @(ConvertTo-CardBlockList -Body @(
            @{ kind = 'code'; command = 'df -h'; comment = '看磁盘' }
            @{ kind = 'code'; command = 'ls' }
        ))
    if ($blocks.Count -ne 2) { return "块数 $($blocks.Count)，应为 2" }
    if ($blocks[0].comment -ne '看磁盘') { return 'comment 在转换里丢了' }
    if ($blocks[1].Contains('comment')) { return '没有说明的块被补了 comment 字段' }
    $true
}

Check 'New-CardRow：没有 label 的行被丢掉（按下标回传 checked，少一行就错位）' {
    $rows = @(ConvertTo-CardRowList -Rows @(@{ label = '甲' }, @{ meta = '没有标签' }, @{ label = '乙' }))
    if ($rows.Count -ne 2) { return "留下 $($rows.Count) 行，应为 2" }
    if ($rows[1].label -ne '乙') { return '顺序变了' }
    $true
}

Check '按钮：kind 只归一成 primary/default，且主按钮唯一' {
    $buttons = @(ConvertTo-CardButtonList -Buttons @(
            @{ label = '取消'; action = 'cancel'; kind = 'outline' }
            @{ label = '确定'; action = 'ok'; kind = 'primary' }
        ))
    if ($buttons[0].kind -ne 'default') { return "outline 没归一成 default：$($buttons[0].kind)" }
    if ((@($buttons | Where-Object { $_.kind -eq 'primary' })).Count -ne 1) { return '主按钮不是唯一' }

    $message = ''
    try {
        $null = ConvertTo-CardButtonList -Buttons @(
            @{ label = 'a'; action = 'a'; kind = 'primary' }
            @{ label = 'b'; action = 'b'; kind = 'primary' }
        )
    } catch { $message = $_.Exception.Message }
    if ($message -eq '') { return '两个主按钮没有抛异常' }
    $true
}

Check 'New-CardButton：防误点与计数模板只在给了值时出现（按钮级 armDelayMs 已删，BACKLOG #21）' {
    $plain = New-CardButton -Label '取消' -Action 'cancel'
    if ($plain.Contains('armDelayMs') -or $plain.Contains('labelCount') -or $plain.Contains('requiresChecked')) {
        return '默认按钮带上了可选键'
    }
    $full = New-CardButton -Label '提交' -Action 'submit' -Kind 'primary' `
        -RequiresChecked -LabelCount '提交 {n} 项'
    # 按钮级 armDelayMs 是死字段（App 只读载荷级 armMs），2026-11-01 删除；这里钉住它不回来。
    if ($full.Contains('armDelayMs')) { return '按钮载荷里又出现了 armDelayMs 死字段' }
    if ($full.requiresChecked -ne $true) { return 'requiresChecked 丢了' }
    if ($full.labelCount -ne '提交 {n} 项') { return 'labelCount 丢了' }
    $true
}

Check '标题片段：New-CardTitlePath 转义文本，只产出带 card__title-path 的 span' {
    $fragment = New-CardTitlePath -Text 'C:\a<b>&"c"'
    if (-not $fragment.StartsWith('<span class="card__title-path">')) { return "结构不对：$fragment" }
    if ($fragment.Contains('<b>')) { return '尖括号没转义' }
    if (-not $fragment.Contains('&lt;b&gt;')) { return '转义结果不对' }
    $true
}

# ---- 协议 -----------------------------------------------------------------------

$script:BridgeText = Get-CardShellText 'app\src\bridge.ts'
$script:AppText = Get-CardShellText 'app\src\App.tsx'
$script:WindowText = Get-CardShellText 'webview2.ps1'
$script:EnvText = Get-CardShellText 'environment.ps1'

Check '协议：页面侧的消息类型齐全（ready/resize/decision/cancel/expired/copy/drag + shown）' {
    foreach ($type in @("'ready'", "'resize'", "'decision'", "'cancel'", "'expired'", "'copy'", "'drag'", "'shown'")) {
        if (-not $script:BridgeText.Contains($type)) { return "bridge.ts 缺 $type" }
    }
    # drag 是「按下标题 → 宿主进系统移动循环」那一条（R-15 / D-40）：必须是页面能发的消息，
    # 少了它标题就只能选字、拖不动。
    if ($script:BridgeText -notmatch "\| \{ type: 'drag' \}") { return 'HostMessage 联合类型里没有 { type: ''drag'' }' }
    $true
}

Check '协议：ready 在首次布局后发，且只发一次' {
    if ($script:AppText -notmatch "postToHost\(\{ type: 'ready'") { return 'App.tsx 没发 ready' }
    if ($script:AppText -notmatch 'readySent') { return '没有「只报一次」的标记' }
    $true
}

Check '协议：resize 只在 measure 阶段报' {
    if ($script:AppText -notmatch "phase !== 'measure'") { return 'resize 没有按 phase 收口' }
    if ($script:AppText -notmatch 'ResizeObserver') { return '没有 ResizeObserver' }
    $true
}

Check '协议：终态消息只发一次（useRef 防重入）' {
    if ($script:AppText -notmatch 'decided\.current') { return '没有防重入标记' }
    if ($script:AppText -notmatch 'if \(decided\.current\) return') { return '防重入没有生效' }
    $true
}

Check '协议：ready 高度用 documentElement 量（不受滚动容器影响）' {
    if ($script:BridgeText -notmatch 'getBoundingClientRect') { return '没有量高度' }
    if ($script:BridgeText -notmatch "getElementById\('root'\)") { return '量高度的起点不是 #root' }
    $true
}

Check '协议：宿主发 shown 走 PostWebMessageAsJson，而不是注入脚本' {
    if ($script:WindowText -notmatch 'PostWebMessageAsJson') { return '没有 PostWebMessageAsJson' }
    if ($script:WindowText -notmatch "type = 'shown'") { return '没有发 shown' }
    $true
}

Check '协议：宿主等 ready 有 2 秒超时，超时按 360 高显示' {
    if ($script:WindowText -notmatch '\$readyTimeoutMs = 2000') { return '没有 2 秒的就绪超时' }
    if ($script:WindowText -notmatch '\$fallbackHeight = 360') { return '没有 360 的兜底高度' }
    $true
}

# ---- 等 ready 的两个时钟（D-45）--------------------------------------------------
#
# 2026-11-12 17:32 真机弹出一张 680×360 的 SSH 执行确认卡，内容只有 ~290：灰框与按钮之间一条 80px
# 白（截图就是窗口本身，四边都是 1px #faad14 边框）。360 恰好是建窗初值，也就是「页面没在预算内
# 报高度」的兜底值。旧写法从 NavigateToString 起算 2 秒，把这 2 秒同时算给了「WebView2 冷启 +
# 728KB 产物解析执行 + 首渲染」——机器一忙就赌输。下面三条把「什么时候可以认输」钉死。

Check '高度（D-45）：先等 NavigationCompleted，页面加载完才起算「报高度」的窗口' {
    # 页面加载完的信号早就接好了（$script:cardFlags.NavDone），旧代码只是从来不读它。
    if ($script:WindowText -notmatch 'NavigationCompleted') { return '没订阅 NavigationCompleted' }
    if ($script:WindowText -notmatch '\$navSeen = \$false') { return '没有「导航是否已收口」的状态' }
    if ($script:WindowText -notmatch '(?m)if \(-not \$navSeen -and \$script:cardFlags\.NavDone\)') {
        return '等待循环没把 NavDone 当起算点（又回到「只赌一个常数」）'
    }
    # 报高度的窗口在 NavDone 之前必须「永不超时」：初值 MaxValue，NavDone 到了才换成 now+2000。
    if ($script:WindowText -notmatch '\$readyDeadline = \[DateTime\]::MaxValue') {
        return '报高度的窗口在页面加载前就开始计时了'
    }
    if ($script:WindowText -notmatch '\$readyDeadline = \[DateTime\]::Now\.AddMilliseconds\(\$readyTimeoutMs\)') {
        return 'NavDone 之后没有重设报高度的窗口'
    }
    # 次序：NavigateToString → 循环里读 NavDone → 判定。起算点跑到导航之前就等于旧写法。
    # 找「循环里那处」而不是全局第一处：第一处是导航事件处理器里的 `NavDone = $true`，本来就在前面。
    $navAt = $script:WindowText.IndexOf('NavigateToString($Html)', [System.StringComparison]::Ordinal)
    if ($navAt -lt 0) { return '找不到 NavigateToString' }
    $gateAt = $script:WindowText.IndexOf('if (-not $navSeen', [System.StringComparison]::Ordinal)
    $verdictAt = $script:WindowText.IndexOf('$wait = Test-CardHeightWait', [System.StringComparison]::Ordinal)
    if ($gateAt -lt 0 -or $verdictAt -lt 0) { return '找不到起算点或判定点' }
    if ($gateAt -lt $navAt) { return '起算点跑到了 NavigateToString 之前' }
    if ($verdictAt -lt $gateAt) { return '判定在起算之前' }
    $true
}

Check '高度（D-45）：页面慢只让卡片晚出来，不许把高度赌成 360' {
    # 直接驱动判定函数（不建窗、不需要 WebView2）：把「何时加载完 / 何时报高度」铺成时刻，
    # 每 10ms 走一步，取第一个定案的时刻。这是这张卡的时序契约本身，不是对源码的字符串匹配。
    #   NavAt    = NavigationCompleted 的时刻（秒），99 = 一直没加载完
    #   ReportAt = 页面报高度的时刻（秒），与期望的定案时刻一一对应
    $cases = @(
        @{ Name = '机器空闲：0.4s 加载完、0.5s 报高度'; NavAt = 0.4; ReportAt = 0.5; Expect = 'ready'; ExpectAt = 500 },
        @{ Name = '加载慢但报得快：3.2s 加载完、3.3s 报高度'; NavAt = 3.2; ReportAt = 3.3; Expect = 'ready'; ExpectAt = 3300 },
        @{ Name = '加载很慢：12s 加载完、12.1s 报高度'; NavAt = 12.0; ReportAt = 12.1; Expect = 'ready'; ExpectAt = 12100 },
        @{ Name = '高度先到：0.5s 报高度、3.2s 才收到 NavDone'; NavAt = 3.2; ReportAt = 0.5; Expect = 'ready'; ExpectAt = 500 },
        @{ Name = '加载完 1.9s 报高度：还在宽限内'; NavAt = 0.4; ReportAt = 1.9; Expect = 'ready'; ExpectAt = 1900 },
        @{ Name = '加载完但页面不报高度：0.4s 加载完、2.5s 才报'; NavAt = 0.4; ReportAt = 2.5; Expect = 'timeout'; ExpectAt = 2400 },
        @{ Name = '导航本身没收口：一直没加载完'; NavAt = 99; ReportAt = 99; Expect = 'timeout'; ExpectAt = 20000 }
    )
    $t0 = [datetime]'2026-01-01T00:00:00'
    $bad = @()
    foreach ($case in $cases) {
        $navMs = [int]([double]$case.NavAt * 1000)
        $reportMs = [int]([double]$case.ReportAt * 1000)
        $navSeen = $false
        $readyDeadline = [datetime]::MaxValue
        $navigationDeadline = $t0.AddMilliseconds(20000)
        $verdict = 'timeout'
        $hitAt = -1
        for ($ms = 0; $ms -le 25000; $ms += 10) {
            $now = $t0.AddMilliseconds($ms)
            if (-not $navSeen -and $ms -ge $navMs) {
                $navSeen = $true
                $readyDeadline = $now.AddMilliseconds(2000)
            }
            $height = if ($ms -ge $reportMs) { 290 } else { 0 }
            $verdict = Test-CardHeightWait -Height $height -NavDone $navSeen `
                -NavigationDeadline $navigationDeadline -ReadyDeadline $readyDeadline -Now $now
            if ($verdict -ne 'wait') { $hitAt = $ms; break }
        }
        if ($verdict -ne $case.Expect) {
            $bad += ('{0}：判成 {1}，应为 {2}' -f $case.Name, $verdict, $case.Expect)
            continue
        }
        if ($hitAt -ne $case.ExpectAt) {
            $bad += ('{0}：在 {1}ms 定案，应在 {2}ms' -f $case.Name, $hitAt, $case.ExpectAt)
        }
    }
    if ($bad.Count -gt 0) { return ($bad -join '；') }
    $true
}

Check '高度（D-45）：窗口高度只由页面报的那一个值决定（同一载荷必得同一高度）' {
    # 钳高是纯函数：Min(屏高 62% 与 760, Max(160, 页面报的高度))——不取整、不按 DPI 再乘、
    # 不平均、不「长高不缩」。同一份载荷在同一台机器上因此只有一个答案。
    if ($script:WindowText -notmatch '(?m)\[Math\]::Min\(\$MaxHeight, \[Math\]::Max\(160, \[int\]\$cardState\.Height\)\)') {
        return '钳高不再是「页面报的高度夹到 [160, MaxHeight]」，高度可能又掺了别的量'
    }
    $assign = [regex]::Matches($script:WindowText, '(?m)^\s*\$logicalHeight\s*=').Count
    if ($assign -ne 1) { return "`$logicalHeight 有 $assign 处赋值（应恰好 1 处，多于 1 处就可能一条路量、一条路猜）" }
    # 写死的高度只允许出现在「判定为 timeout」那条路上。
    if ($script:WindowText -notmatch '(?m)\$logicalHeight = if \(\$readyTimedOut\) \{') {
        return '兜底不只看 $readyTimedOut（有别的地方也会写死高度）'
    }
    if ($script:WindowText -match '\$cardState\.Height\s*[-+*/]=') { return '高度被累加/平均过' }
    $true
}

Check '高度（D-45）：落到 360 时留一条埋点（真机上才分得清卡在导航还是卡在量高）' {
    if ($script:WindowText -notmatch "kind\s*=\s*'height-fallback'") { return '落兜底时没有埋点' }
    if ($script:WindowText -notmatch 'segment\s*=') { return '埋点没记是导航段还是报高度段' }
    $true
}

Check '高度（D-46）：钳到上限必须留一条 height-clamp 埋点（页面报多少 / 上限多少 / 用了多少）' {
    # 「页面报 291、窗口 271」只有两种可能：页面报小了，或这里被上限钳了。没有这条埋点，
    # 两种情形在真机上长得一模一样（只能靠事后反推屏区），2026-11-12 就是这么绕了半天的（D-46）。
    if ($script:WindowText -notmatch "kind\s*=\s*'height-clamp'") { return '钳高时没有埋点' }
    foreach ($field in @('pageHeight', 'maxHeight', 'adoptedHeight', 'area', 'scale')) {
        if ($script:WindowText -notmatch ('(?m)^\s*' + $field + '\s*=')) { return "埋点缺字段 $field" }
    }
    # 只在真的钳了才写：正常卡片不许刷日志。
    if ($script:WindowText -notmatch '\$logicalHeight\s*-lt\s*\[Math\]::Max\(160, \[int\]\$cardState\.Height\)') {
        return '埋点不是「只在被钳时」写（少了 $logicalHeight -lt 页面报高的判断）'
    }
    $true
}

Check '高度（D-46）：Show-CardWindow 接受调用方给的屏区，且解析不出来就报错（不猜）' {
    if ($script:WindowText -notmatch '\[object\]\$Area\s*=\s*\$null') { return 'Show-CardWindow 没有 -Area 参数' }
    if ($script:WindowText -notmatch 'if \(\$null -ne \$Area\) \{ \$screenArea = \$Area \}') {
        return '-Area 没有覆盖自己解析出来的 $screenArea（限高与落位又可能各用一块屏）'
    }
    if ($script:WindowText -notmatch '解析不出屏幕可用区') { return '屏区为空时没有报错（会拿全零矩形建窗）' }
    $true
}

Check '高度（D-46）：上限只能来自 Get-CardMaxHeight（别处不许再写死一个高度上限）' {
    $assign = [regex]::Matches($script:WindowText, '(?m)^\s*\$MaxHeight\s*=\s*Get-CardMaxHeight').Count
    if ($assign -ne 1) { return "`$MaxHeight 由 Get-CardMaxHeight 赋值 $assign 处（应恰好 1 处）" }
    if ($script:WindowText -match '(?m)^\s*\$MaxHeight\s*=\s*\d+') { return '$MaxHeight 被写死成常数了' }
    $true
}

Check '量高取证（D-46）：探针逐层记 scrollHeight/clientHeight，脚本把「被裁」判成失败' {
    # 「窗口盖不住内容」是用户看到的样子（附注条只剩上半截）。判据必须量在每一层盒子上，
    # 而不是只看卡片总高——总高一样矮也是一种错，只是错得很稳定。
    $probe = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'debug\probe.js') -Encoding utf8
    if ($probe -notmatch 'clipped:\s*element\.scrollHeight - element\.clientHeight') {
        return 'probe.js 没有记逐层的 clipped（scrollHeight − clientHeight）'
    }
    if ($probe -notmatch "layout\.fill = samples\('fill'\)") { return 'probe.js 没有量 fill 态的每层盒子' }
    if ($probe -notmatch "layout\.natural = samples\('measure'\)") { return 'probe.js 没有把 phase 切回 measure 量自然高度' }
    $stability = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'debug\height-stability.ps1') -Encoding utf8
    if ($stability -notmatch 'scrollHeight > clientHeight') { return 'height-stability.ps1 没有「内容被裁即失败」的判据注释/判定' }
    if ($stability -notmatch '\$cut -gt 1') { return 'height-stability.ps1 没有按层收集被裁像素' }
    if ($stability -notmatch '钳高只许按 62% 上限来') { return 'height-stability.ps1 没有「窗口 = Min(上限, 页面报高)」这条判据' }
    $true
}

Check '量高取证（D-46）：时间线的包装装在文档开始处（不然 ready 一条都记不到）' {
    $tracePath = Join-Path $script:CardDir 'debug\trace.js'
    if (-not (Test-Path -LiteralPath $tracePath)) { return 'debug\trace.js 不存在' }
    $trace = Get-Content -Raw -LiteralPath $tracePath -Encoding utf8
    # 第一版把包装放在 rAF 里：ready 比第一帧还早，结果每条记录都是 resize、ready 恒为 0。
    if ($trace -notmatch 'queueMicrotask') { return '包装没有在文档开始处的微任务里重试（会漏掉 ready）' }
    if ($trace -match 'requestAnimationFrame\(\(\) => \{\s*wrap') { return '包装又放回 rAF 里了（ready 会漏）' }
    $render = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'debug\render.ps1') -Encoding utf8
    if (-not $render.Contains("'trace.js'")) { return 'render.ps1 没有注入 trace.js' }
    if ($render -notmatch 'placement\s*=\s*\$state\.Placement') { return 'measure.json 没有记 placement（屏区/缩放/上限）' }
    $true
}

Check '报高（D-46）：字体到位 + 连续两次采样一致才报，而且只报一条' {
    # 宿主只认第一条高度（D-45），那一条就必须是最终值。页面原来在首个被动 effect 里直接量高，
    # 布局还没稳定就已经报出去了（2026-11-12 的偶发 271：第一条比最终矮 20px，20–40ms 后才 291）。
    if ($script:AppText -notmatch 'createMeasureState\(') { return 'App.tsx 没用 settle 的状态机' }
    if ($script:AppText -notmatch 'nextMeasureDecision\(') { return 'App.tsx 没用 settle 的判定' }
    if ($script:AppText -notmatch 'document\.fonts\.ready') { return '报高前没等 document.fonts.ready' }
    if ($script:AppText -notmatch 'setTimeout\(step, MEASURE_SAMPLE_INTERVAL_MS\)') { return '没有「按采样间隔不停地量」的循环' }
    # 判据本身必须在产品代码里，不许在这里另写一套。
    $settle = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'app\src\settle.ts') -Encoding utf8
    if ($settle -notmatch 'sameSample\(previous, sample\)') { return 'settle.ts 没比较前后两次采样的样本' }
    if ($settle -notmatch 'fontsReady && stable') { return 'settle.ts 没把「字体就绪」与「两次一致」一起当条件' }
    if ($settle -match 'setTimeout\(|setInterval\(|Start-Sleep') { return 'settle.ts 里排了定时器或固定等待（判据必须是纯函数）' }
    # 只发一条：ready 的 post 恰好一处（补第二条 = 两次改窗口）。
    $posts = [regex]::Matches($script:AppText, "type: 'ready'").Count
    if ($posts -ne 1) { return "App.tsx 里有 $posts 处 ready 消息（应恰好 1 处）" }
    $true
}

Check '报高（D-46）：采样时钟是定时器，不是 requestAnimationFrame（不可见窗口会把 rAF 饿死）' {
    # 2026-11-15 真机 30/30 全落到兜底 360：宿主「拿到 ready 才 ShowWindow」，在那之前窗口不可见、
    # WebView2 基本不产帧，rAF 回调饿死（trace 首帧 t≈2327ms，而宿主 ready 预算只有 2000ms）。
    # 把判据挂在 rAF 上＝把「等布局稳定」绑成「等窗口可见」＝锁死。判据没问题，时钟错了。
    $rafLines = @($script:AppText -split "`n" | Where-Object { $_ -match 'requestAnimationFrame\s*\(' })
    if ($rafLines.Count -ne 1) { return "App.tsx 里有 $($rafLines.Count) 处 requestAnimationFrame（只许剩 resize 取证那 1 处）" }
    if ($rafLines[0] -notmatch "'resize'") { return 'requestAnimationFrame 又回到报高路径上了（不可见窗口里它不触发）' }
    if ($script:AppText -notmatch 'MEASURE_SAMPLE_INTERVAL_MS') { return '采样间隔不是来自 settle.ts 的常量' }
    $settle = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'app\src\settle.ts') -Encoding utf8
    if ($settle -notmatch 'MEASURE_SAMPLE_INTERVAL_MS = 16') { return '采样间隔不是 16ms 的常量' }
    # 判定与时钟无关：纯函数里不取时间、不碰帧（换成任何 tick 源结论都一样）。
    if ($settle -match 'requestAnimationFrame\(|setInterval\(|Date\.now\(|performance\.now\(') {
        return 'settle.ts 自己取时间/碰帧了（判定必须只吃调用方传来的样本与时间戳）'
    }
    $true
}

Check '报高（D-46）：预算到点按最后一次报，并把两次高度带回去（不许无限等）' {
    $settle = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'app\src\settle.ts') -Encoding utf8
    foreach ($key in @('first:', 'last:', "reason: 'budget'", 'fontsReady', 'frames')) {
        if ($settle -notmatch [regex]::Escape($key)) { return "预算到点的取证缺 $key" }
    }
    if ($settle -notmatch 'MEASURE_SETTLE_BUDGET_MS = 500') { return '预算不是 500ms 的常量（改常数就是在赌时间）' }
    if ($settle -notmatch 'now - state\.startedAt >= budgetMs') { return '预算没按「从起算点过了多久」判' }
    # 稳定判定排在预算之前：同一帧既稳定又超预算时按「稳定」报，不留没意义的埋点。
    $stableAt = $settle.IndexOf('fontsReady && stable')
    $budgetAt = $settle.IndexOf('now - state.startedAt >= budgetMs')
    if ($stableAt -lt 0 -or $budgetAt -lt 0 -or $stableAt -gt $budgetAt) { return '「稳定」判定没有排在预算之前' }
    $true
}

Check '宿主（D-46）：measure-unstable 埋点字段齐，且埋点不改接管流程' {
    if ($script:WindowText -notmatch "kind\s*=\s*'measure-unstable'") { return '没有 measure-unstable 埋点' }
    foreach ($field in @('firstHeight', 'lastHeight', 'reason', 'frames', 'fontsReady')) {
        if ($script:WindowText -notmatch ('(?m)^\s*' + $field + '\s*=')) { return "埋点缺字段 $field" }
    }
    # 埋点只是取证：ready 仍然只做「记下高度」这一件事，不许顺手改窗口、也不许回消息。
    if ($script:WindowText -notmatch '\$cardState\.Height = \$message\.Height') { return 'ready 不再只是记高度' }
    $true
}

Check '报高（D-46）：稳定判据有桩测试，且测的是产品里那份实现' {
    $testPath = Join-Path $script:RepoRoot 'tests\settle.mjs'
    if (-not (Test-Path -LiteralPath $testPath)) { return 'tests\settle.mjs 不存在（判据没有桩测试）' }
    $test = Get-Content -Raw -LiteralPath $testPath -Encoding utf8
    if ($test -notmatch 'app/src/settle\.ts') { return '桩测试没 import 产品那份 settle.ts（另抄一份就等于没测）' }
    foreach ($case in @('首帧不报', '两帧一致就报', 'fonts.ready 没到', '预算到点')) {
        if ($test -notmatch [regex]::Escape($case)) { return "桩测试缺用例：$case" }
    }
    $true
}

Check '协议：宿主不再用 CDP / ExecuteScriptAsync 量 DOM' {
    if ($script:WindowText -match 'ExecuteScriptAsync') { return 'webview2.ps1 还在执行脚本量高' }
    if ($script:WindowText -match 'CallDevToolsProtocolMethod') { return 'webview2.ps1 还在用 CDP' }
    if ($script:WindowText -match 'Measure-CardContent') { return '还有 Measure-CardContent' }
    $true
}

Check '协议：OnRendered 在 shown 之后调用（不再自己等布局）' {
    $shownAt = $script:WindowText.IndexOf("type = 'shown'", [System.StringComparison]::Ordinal)
    $renderedAt = $script:WindowText.IndexOf('& $OnRendered', [System.StringComparison]::Ordinal)
    if ($shownAt -lt 0 -or $renderedAt -lt 0) { return '找不到 shown / OnRendered' }
    if ($renderedAt -lt $shownAt) { return 'OnRendered 在 shown 之前调用' }
    $true
}

Check '协议：Show-CardWindow 的返回字段恒定（7 个，StrictMode 下读不抛）' {
    foreach ($field in @('Action', 'Message', 'ContentWidth', 'ContentHeight', 'WindowBounds', 'ShowInfo', 'Error')) {
        if ($script:WindowText -notmatch ('(?m)^\s*' + $field + '\s+=')) { return "返回对象缺 $field" }
    }
    # 单字段输入区的两个回传字段已随 R-12 删除：返回对象里不许再把它们加回来（含 `$result.X = …`）。
    if ($script:WindowText -match '\bInput(Length)?\s*=') { return '返回对象还留着 Input / InputLength' }
    $true
}

Check '协议：ConvertFrom-CardMessage 认五种消息（含 drag），坏消息不抛' {
    $ready = ConvertFrom-CardMessage -Json '{"type":"ready","height":512}'
    if ($ready.Type -ne 'ready' -or $ready.Height -ne 512) { return "ready 解析不对：$($ready.Type)/$($ready.Height)" }

    $decision = ConvertFrom-CardMessage -Json '{"type":"decision","value":"submit","checked":[true,false]}'
    if ($decision.Value -ne 'submit') { return 'value 丢了' }
    if (-not $decision.Checked[0] -or $decision.Checked[1]) { return 'checked 解析不对' }
    # 单字段输入区已随 R-12 删除：消息对象里不该再有那两个字段（连读都不该读得到）。
    if ($decision.PSObject.Properties['Input'] -or $decision.PSObject.Properties['InputLength']) {
        return '消息对象里还有 Input / InputLength（单字段输入区已随 R-12 删除）'
    }

    foreach ($type in @('cancel', 'expired')) {
        $message = ConvertFrom-CardMessage -Json ('{"type":"' + $type + '"}')
        if ($message.Type -ne $type) { return "$type 没解析出来" }
    }

    # drag 没有载荷字段：它靠的是「未知 type 原样带出」，这里同时守住那条通道
    # （消息泵按 Type 分支，Type 一旦丢成空串，标题就拖不动了）。
    $drag = ConvertFrom-CardMessage -Json '{"type":"drag"}'
    if ($drag.Type -ne 'drag') { return "drag 没解析出来：Type=$($drag.Type)" }

    $bad = ConvertFrom-CardMessage -Json 'not json'
    if ($bad.Type -ne '' -or $bad.PSObject.Properties['Fields']) { return '坏消息没有返回空结果' }
    $empty = ConvertFrom-CardMessage -Json ''
    if ($empty.Type -ne '') { return '空消息没有返回空结果' }
    $true
}

# ---- 标题拖动（R-15：只做拖动，不改大小） ------------------------------------------
#
# 用户 2026-11-10：「只做拖动」「拖动区在标题」，跟着真机原话：「我发现怎么是 工作路径那一行能拖动。。。」
# 「我要的是 标题拖动」。他说的「标题」是卡上的抬头 `pwsh · 提权审批` / `SSH · 执行确认`（载荷字段
# eyebrow），不是首行那个路径 `C:\…`（载荷字段 titleHtml）——**字段名与用户的叫法是错位的**。
# 上一版照着「拖动区在标题」把拖动挂在了 titleHtml 上，于是他按住拖的是工作目录那一行。
# 链路只有三跳：
#   页面：抬头 eyebrow 的 pointerdown → preventDefault（不许变成选字）→ postToHost({type:'drag'})
#   宿主：ReleaseCapture() + SendMessage(WM_NCLBUTTONDOWN=0xA1, HTCAPTION=2) → 系统移动循环
# 不做的事：不改窗口过程、不做 hit-test、不做改大小；也不许顺手动层级/焦点（Invoke-CardForceShow 一字节不动）。

Check '拖动（R-15）：拖动区是抬头 eyebrow（用户口中的「标题」），按下即发 drag 且不变成选字' {
    $eyebrow = [regex]::Match($script:AppText, '(?s)<Text\s+data-part="eyebrow".*?</Text>').Value
    if ($eyebrow -eq '') { return '找不到 data-part="eyebrow" 的抬头节点（屏上「pwsh · 提权审批」那一行），拖动区无处可挂' }
    if ($eyebrow -notmatch 'onPointerDown') { return '抬头 eyebrow 没有 onPointerDown：按住「pwsh · 提权审批」那一行窗口不动' }
    if ($eyebrow -notmatch 'event\.preventDefault\(\)') { return '抬头按下没有 preventDefault：一按就选中「pwsh · 提权审批」的文字' }
    if ($eyebrow -notmatch "postToHost\(\{ type: 'drag' \}\)") { return '抬头按下没有发 drag 消息：按住抬头窗口不动（页面不发，宿主收不到）' }
    if ($eyebrow -notmatch "cursor: 'grab'") { return '抬头没有 cursor: grab：光标移到「pwsh · 提权审批」还是箭头，看不出这行能拖' }
    if ($eyebrow -notmatch "userSelect: 'none'") { return '抬头没有 userSelect: none：拖的时候会把「pwsh · 提权审批」选中' }
    # 没有抬头就没有拖动区：这条分支必须仍以 eyebrow 为条件（不许偷偷退回路径行——用户明确不要）。
    if ($script:AppText -notmatch '\{payload\.eyebrow \? \(') { return '抬头渲染不再以 eyebrow 为条件：空抬头也会渲染出一块能拖的区域' }
    $true
}

Check '拖动（R-15）回归：工作目录那一行（data-part="title"）纯展示，按住路径拖不动窗口' {
    $title = [regex]::Match($script:AppText, '(?s)<span\s+data-part="title".*?/>').Value
    if ($title -eq '') { return '找不到 data-part="title" 的 span（首行工作目录 `C:\…`）；它改名了也要跟着改这条反向检查' }
    if ($title -match 'onPointerDown') {
        return '窗口截图式失败：鼠标按住首行 `C:\…`（工作目录）窗口跟着走了——data-part="title" 上又挂了 onPointerDown，正是 2026-11-10 真机撞到的那个 bug'
    }
    if ($title -match "cursor: 'grab'") {
        return '窗口截图式失败：光标移到首行 `C:\…`（工作目录）变成抓手，明示「这行能拖」——data-part="title" 上又有 cursor: grab'
    }
    # 标题行本身仍是纯展示：没有 titleHtml 就不出这一行（这条是既有检查，随目标元素一起搬到这里）。
    if ($script:AppText -notmatch '\{payload\.titleHtml \? \(') { return '标题渲染不再以 titleHtml 为条件（工作目录行会凭空出现）' }
    $true
}

Check '拖动（R-15）：宿主 ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION，不改窗口过程、不做改大小' {
    if ($script:EnvText -notmatch 'public static extern bool ReleaseCapture\(\)') { return 'environment.ps1 没有 ReleaseCapture 声明' }
    if ($script:EnvText -notmatch 'public static extern System\.IntPtr SendMessage\(System\.IntPtr hWnd, int msg, System\.IntPtr wParam, System\.IntPtr lParam\)') {
        return 'environment.ps1 没有 SendMessage 声明'
    }
    $pump = [regex]::Match($script:WindowText, '(?s)\$pump = \{.*?\n    \}').Value
    if ($pump -eq '') { return '找不到消息泵 $pump' }
    $branch = [regex]::Match($pump, "(?s)elseif \(\`$message\.Type -eq 'drag'\) \{.*?\}").Value
    if ($branch -eq '') { return "消息泵没有 drag 分支" }
    if ($branch -notmatch '\[DshUiCard\.Native\]::ReleaseCapture\(\)') { return 'drag 分支没有 ReleaseCapture' }
    if ($branch -notmatch 'SendMessage\(\$form\.Handle, 0xA1, \[System\.IntPtr\]::new\(2\), \[System\.IntPtr\]::Zero\)') {
        return 'drag 分支没有发 WM_NCLBUTTONDOWN(0xA1) + HTCAPTION(2)'
    }
    # 只做拖动：不许子类化窗口过程、不许自己做 hit-test、不许出现改大小的入口。
    if ($pump -match 'SetWindowLong|WndProc|WM_NCHITTEST|HTBOTTOMRIGHT|HTBORDER') { return '拖动掺进了窗口过程/hit-test/改大小' }
    # 拖动**不新增**任何层级/焦点操作。让位（D-43）有意加了**一处**降层调用，所以这里从「恰好 1 处」
    # 改成「恰好 2 处」：多出第三处就是没登记的层级操作（两处的语义由「置顶」「让位」两条各自钉住）。
    # 注意这条只能守住「没有新增层级/焦点 API 调用」——NC 按下本身会由系统做一次 mouse-activate
    # （WM_NCLBUTTONDOWN 的正常行为），焦点到底动没动**待真机确认**。
    if (([regex]::Matches($script:EnvText, '::SetWindowPos\(')).Count -ne 2) {
        return 'environment.ps1 的 SetWindowPos 调用点变了：只允许「显示兜底（HWND_TOPMOST）」与「让位降层（HWND_NOTOPMOST）」两处（拖动不该动层级）'
    }
    $true
}

# ---- 防回退 ---------------------------------------------------------------------

Check '防回退：旧模板 / 旧样式文件已经删除' {
    foreach ($name in @('card.html', 'dsh-card.css', 'dsh-tokens.css')) {
        if (Test-Path -LiteralPath (Join-Path $script:CardDir $name)) { return "还有 $name" }
    }
    $true
}

Check '防回退：外壳源码里没有 .qc- 类名' {
    $files = @(Get-ChildItem -LiteralPath $script:CardDir -Recurse -File -Force | Where-Object {
            $_.Extension -in @('.ps1', '.ts', '.tsx', '.css', '.html', '.json') -and
            $_.FullName -notmatch '\\node_modules\\|\\dist\\'
        })
    $hits = @()
    foreach ($file in $files) {
        $match = Select-String -LiteralPath $file.FullName -Pattern 'qc-' -SimpleMatch -ErrorAction SilentlyContinue
        if ($null -ne $match) { $hits += $file.Name }
    }
    if ($hits.Count -eq 0) { $true } else { '命中 ' + ($hits -join ', ') }
}

Check '防回退：旧的拼 HTML 函数已经不存在' {
    foreach ($name in @('New-CardShell', 'New-CardOption', 'New-CardNote')) {
        if ($null -ne (Get-Command $name -ErrorAction SilentlyContinue)) { return "还有 $name" }
    }
    $true
}

Check '防回退：宿主不再认识 card.html / dsh-card.css' {
    foreach ($name in @('card.html', 'dsh-card.css')) {
        if ($script:WindowText.Contains($name)) { return "webview2.ps1 还提到 $name" }
        if ((Get-CardShellText 'card-html.ps1').Contains($name)) { return "card-html.ps1 还提到 $name" }
    }
    $true
}

Check '防回退：按钮的 type 只有 primary/default，App 显式渲染 type' {
    if ($script:AppText -notmatch 'type="primary"') { return '主按钮没有显式 type' }
    if ($script:AppText -notmatch 'type="default"') { return '普通按钮没有显式 type' }
    if ($script:AppText -match 'type="outline"') { return '还有 outline 按钮' }
    $true
}

Check '防回退：卡片只有内部滚动（fill 阶段 body 滚动、页脚钉住）' {
    $css = Get-CardShellText 'app\src\styles.css'
    if ($css -match 'max-height:\s*62vh') { return 'styles.css 还有 max-height:62vh（与量高打架）' }
    if ($css -notmatch "data-phase='fill'") { return "styles.css 没有 fill 阶段的高度契约" }
    if ($script:AppText -notmatch "overflowY: phase === 'fill' \? 'auto'") { return 'App 没有在 fill 阶段让主体区滚动' }
    if ($script:AppText -notmatch 'minHeight: 0') { return '滚动容器没写 minHeight:0，flex 子项撑不出滚动' }
    if ($css -notmatch '::-webkit-scrollbar') { return '没有细滚动条样式' }
    $true
}

Check '防回退：没有新的 npm 依赖（只允许 antd/react/vite/shiki）' {
    # shiki 是用户定的代码高亮库（PREFERENCES B-10 / K-012，DECISIONS D-29），
    # 是这一轮**有意**新增的依赖；其余仍然只允许构建与组件库那几样。
    $package = Get-CardShellText 'app\package.json' | ConvertFrom-Json
    $allowed = @('antd', 'react', 'react-dom', 'shiki', '@types/react', '@types/react-dom', '@vitejs/plugin-react', 'typescript', 'vite', 'vite-plugin-singlefile')
    $names = @()
    foreach ($group in @('dependencies', 'devDependencies')) {
        $names += @($package.$group.PSObject.Properties.Name)
    }
    $extra = @($names | Where-Object { $allowed -notcontains $_ })
    if ($extra.Count -eq 0) { $true } else { '多出依赖：' + ($extra -join ', ') }
}

# ---- 代码高亮（K-012 / DECISIONS D-29）------------------------------------------
#
# 七条断言只钉「结构上不会翻车」的四件事：单文件约束（JS 正则引擎、不引根入口）、
# 高度定格（同步 API，measure 之前就完成）、失败退化（纯文本、不改原文）、
# 样式来源（css-variables → antd token，只改颜色不改字重）。
# 颜色好不好看、真机有没有跳高，由协调会话构建后出图与真机验收，断言不替代那一步。

$script:HighlightText = Get-CardShellText 'app\src\highlight.ts'
$script:CodeTextSource = Get-CardShellText 'app\src\CodeText.tsx'

Check '高亮（K-012）：Shiki + 只装 shellscript / powershell 两种语法' {
    if ($script:HighlightText -notmatch "from 'shiki/core'") { return '没有从 shiki/core 引 highlighter' }
    if ($script:HighlightText -notmatch 'shiki/langs/shellscript\.mjs') { return '没有引入 shellscript 语法' }
    if ($script:HighlightText -notmatch 'shiki/langs/powershell\.mjs') { return '没有引入 powershell 语法' }
    if ($script:HighlightText -notmatch "'shellscript'") { return '没有把 shellscript 当目标语言' }
    if ($script:HighlightText -notmatch "'powershell'") { return '没有把 powershell 当目标语言' }
    # 根入口会把全部语法/主题的懒加载表一起带进单文件产物；只允许按子路径引。
    if ($script:HighlightText -match "from 'shiki'") { return '引了 shiki 根入口（会把全部语法与主题带进产物）' }
    if ($script:AppText -notmatch '<CodeText') { return 'App.tsx 没有走高亮组件' }
    $true
}

Check '高亮：显式用 JS 正则引擎，源码里没有 oniguruma / wasm 外链' {
    # 只扫代码：注释里写清「不用 oniguruma，因为单文件产物装不下 wasm」是结论，不是用法（同 D-28 的口径）。
    $codeOnly = [regex]::Replace($script:HighlightText, '(?s)/\*.*?\*/', '')
    $codeOnly = (@($codeOnly -split "`r?`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n")
    if ($script:HighlightText -notmatch 'createJavaScriptRegexEngine') { return '没有显式使用 JS 正则引擎' }
    if ($codeOnly -match '(?i)oniguruma') { return '代码里还在用 oniguruma 引擎' }
    if ($codeOnly -match '(?i)wasm') { return '代码里还有 wasm 引用（单文件产物装不下）' }
    $true
}

Check '高亮：任何失败都退回纯文本（try/catch，不抛、不改原文）' {
    if ($script:HighlightText -notmatch 'catch') { return 'highlight.ts 没有 try/catch' }
    if ($script:HighlightText -notmatch 'return null') { return '没有「退回纯文本」的返回值' }
    if ($script:CodeTextSource -notmatch 'return <>\{code\}</>') { return 'CodeText 没有原样输出纯文本' }
    if ($script:CodeTextSource -notmatch 'highlight\(') { return 'CodeText 没有调 highlight()' }
    # 拼不回原文就退纯文本：命令原文不许被高亮改写（C-08）。
    if ($script:HighlightText -notmatch 'rebuilt === source') { return '没有「拼回原文」的校验' }
    # 兜底分支也不许把说明弄丢，`#` 也不许丢（D-42）：认不出语言时它就是纯文本的「`# 说明` + 换行 + 命令」。
    if ($script:CodeTextSource -notmatch "if \(head === ''\) return <>\{code\}</>") {
        return 'CodeText 的兜底分支没有「没有说明就原样输出」的短路'
    }
    if ($script:CodeTextSource -notmatch 'const head = commentSource\(comment\)') {
        return 'CodeText 的兜底分支没有用 commentSource 补 `#`（纯文本回退会少一个 #、或者说明整个丢了）'
    }
    if ($script:CodeTextSource -match 'COMMENT_COLOR') {
        return 'CodeText 又在自己给说明上色：`#` 与注释色都该由 highlight.ts 生成（D-42）'
    }
    $true
}

Check '高亮：DOM 契约不变（<pre data-part="code">、pre-wrap、超长折行）' {
    if ($script:AppText -notmatch 'data-part="code"') { return '没有 data-part="code"' }
    if ($script:AppText -notmatch "whiteSpace: 'pre-wrap'") { return 'pre-wrap 丢了（长命令不折行）' }
    if ($script:AppText -notmatch "overflowWrap: 'anywhere'") { return 'overflowWrap 丢了（长串不折行）' }
    if ($script:AppText -notmatch '<CodeText code=\{block\.command\} lang=\{codeLang\(block\.lang\)\}') { return '代码块没有按载荷 lang 归一化后高亮' }
    if ($script:AppText -notmatch '<CodeText code=\{row\.text\} lang=\{codeLang\(row\.lang\)\}') { return '行内命令没有按载荷 lang 归一化后高亮' }
    $true
}

Check '高亮：主题走 css-variables，色值取自 IDEA Light 调色板常量（highlight.ts 里不写裸色值）' {
    if ($script:HighlightText -notmatch 'createCssVariablesTheme') { return '没有用 css-variables 主题' }
    if ($script:HighlightText -notmatch '--shiki-') { return '没有 --shiki- 变量前缀' }
    foreach ($name in @('--shiki-foreground', '--shiki-token-comment', '--shiki-token-string', '--shiki-token-keyword', '--shiki-token-function', '--shiki-token-constant')) {
        if ($script:AppText -notmatch [regex]::Escape($name)) { return "App.tsx 没有映射 $name" }
    }
    # 变量值必须来自 token（B-20）：高亮两个文件里不许出现裸色值。
    if ($script:HighlightText -match '#[0-9a-fA-F]{3,8}\b') { return 'highlight.ts 里出现裸色值' }
    if ($script:CodeTextSource -match '#[0-9a-fA-F]{3,8}\b') { return 'CodeText.tsx 里出现裸色值' }
    $true
}

Check '高亮：只改颜色 + 关键词加粗，不改字体/字号（字重会改折行与量高）' {
    # 用户 2026-10-30 明确要求「关键词：加粗 #0033B3」（B-41），所以 keyword 这条是**唯一**允许
    # 改字重的地方；其余 token 一律继承正文，字体与字号不许动（动了折行位置与量高都会变）。
    if ($script:HighlightText -notmatch 'fontStyle: false') { return '基础主题没有关掉斜体/加粗' }
    if ($script:HighlightText -notmatch 'BOLD_KEYWORD_SCOPES') { return '关键词加粗规则丢了（B-41）' }
    if ($script:HighlightText -notmatch "fontStyle: 'bold'") { return '关键词没有加粗（B-41）' }
    foreach ($bad in @('fontFamily', 'fontSize')) {
        if ($script:CodeTextSource -match $bad) { return "CodeText 动了 $bad" }
    }
    if ($script:CodeTextSource -notmatch 'FONT_STYLE_BOLD') { return '没有按 token 的 Bold 位决定是否加粗' }
    if ($script:CodeTextSource -notmatch 'color: token\.color') { return 'span 没有只设颜色' }
    $true
}

Check '高亮：同步完成（measure 之前就已定格），highlighter 只建一次' {
    if ($script:HighlightText -notmatch 'createHighlighterCoreSync') { return '没有用同步 highlighter' }
    if ($script:HighlightText -match 'createHighlighterCore\(') { return '还在用异步 createHighlighterCore' }
    if ($script:HighlightText -match '(?m)^\s*await\b') { return 'highlight.ts 里有 await（高亮会晚于 ready 完成）' }
    if (([regex]::Matches($script:HighlightText, 'createHighlighterCoreSync\(')).Count -ne 1) { return 'highlighter 不是只建一次' }
    if ($script:HighlightText -notmatch 'if \(highlighter !== null \|\| broken\) return highlighter') { return '没有模块级缓存与失败记忆' }
    if ($script:CodeTextSource -notmatch 'useMemo') { return 'CodeText 没有在 render 期算好高亮' }
    $true
}

# ---- 代码框：折叠 / 展开 / 复制（B-28 / B-29 / B-30 / B-31 / B-32，DECISIONS D-31）------
#
# 这一组钉的是「结构上不会退回旧观感」：
#   - 折叠只用「限高」裁，**不许**出现 line-clamp / text-overflow 那类会画省略号的截断；
#   - 展开换的是框内排版（不折行 + 双向滚动），卡片高度仍是 measure 定下的那个值；
#   - 按钮绝对定位、默认透明、藏着时点不到（不占布局、不改高度）；
#   - 复制拿的是命令本体（纯函数真的跑一遍），注释与说明不进剪贴板。
# 高度到底变不变、hover 显不显，离屏与真机由协调会话验收，断言不替代那一步。

$script:CodeToolsSource = Get-CardShellText 'app\src\CodeTools.tsx'
$script:CommandTextSource = Get-CardShellText 'app\src\commandText.ts'
$script:StylesSource = Get-CardShellText 'app\src\styles.css'
$script:TypesSource = Get-CardShellText 'app\src\types.ts'

# 只扫代码、不扫注释：注释里写「不是 line-clamp」是结论，不许当成用法（同 D-28/D-29 的口径）。
function Get-CodeOnly {
    param([string]$Text)
    $stripped = [regex]::Replace($Text, '(?s)/\*.*?\*/', '')
    $stripped = (@($stripped -split "`r?`n" | Where-Object { $_ -notmatch '^\s*//' }) -join "`n")
    $stripped -replace '(?m)\s//\s.*$', ''
}

Check '折叠（B-28/B-38）：默认折行、按 6 行 + 露出 10px 限高、能上下滚' {
    # 用户 2026-10-30：「折叠无法上下滚动，超出可用范围时一般是 下一行稍微露出一点 能看出来还有」
    # → 折叠态 = 6 行 + 10px 露出（让人看出还有），并且**能滚**（不是 overflow:hidden）。
    if ($script:AppText -notmatch 'const FOLD_LINES = 6') { return '没有把折叠行数钉成 6' }
    if ($script:AppText -notmatch "whiteSpace: 'pre-wrap'") { return '折叠态不是 pre-wrap（默认折行没了）' }
    if ($script:AppText -notmatch 'overflowWrap: ''anywhere''') { return 'overflowWrap: anywhere 丢了' }
    if ($script:AppText -notmatch 'const FOLD_PEEK_Y = 10') { return '没有露出下一行的 10px（B-38）' }
    if ($script:AppText -notmatch 'FOLD_LINES \* CODE_LINE_HEIGHT \+ FOLD_PEEK_Y') { return '折叠高度不是「行数 × 行高 + 露出高度」' }
    $folded = [regex]::Match($script:AppText, '(?s)const foldedBox = \(max: number\).*?\}\)').Value
    if ($folded -eq '') { return '找不到 foldedBox' }
    if ($folded -notmatch "overflowY: 'auto'") { return '折叠态不能上下滚（B-38）' }
    if ($folded -match "overflow: 'hidden'") { return '折叠态又退回 overflow: hidden（滚不动）' }
    $true
}

Check '折叠（B-28）：源码里没有 line-clamp / text-overflow / ellipsis 这类截断显示' {
    foreach ($name in @('App.tsx', 'CodeTools.tsx', 'styles.css', 'commandText.ts', 'CodeText.tsx')) {
        $text = Get-CardShellText (Join-Path 'app\src' $name)
        $code = Get-CodeOnly $text
        if ($code -match '(?i)line-?clamp|text-overflow|textOverflow|ellipsis') {
            return "$name 里出现了截断显示（line-clamp / text-overflow / ellipsis）"
        }
    }
    $true
}

Check '展开（B-28/T-09）：不折行 + 双向滚动，框高与折叠态相同' {
    # 用户 2026-10-30 真机：「展开成一行后高度变矮…卡片高度不变 代码框变矮 导致内容空了」，
    # 并定了做法：**不改卡片高度**（点了位置会跳），改成**代码框保持原高度**。
    # 所以：溢出过的框，折叠与展开都是定高（正文 130 / 行内 130），展开只改排版不改高度；
    # 没溢出过的短框仍按内容自适应（不能把每条短命令都撑成 146 的空框）。
    if ($script:AppText -notmatch "whiteSpace: 'pre'") { return '展开态不是 whiteSpace: pre（还在折行）' }
    if ($script:AppText -notmatch "overflow: 'auto'") { return '展开态不是 overflow: auto（不能双向滚）' }
    if ($script:AppText -match 'expandedCap') { return '还留着 expandedCap（展开会按可视区变高）' }
    if ($script:AppText -notmatch 'expandedBox\(FOLD_BODY_MAX\)') { return '正文块展开态没用固定高度 FOLD_BODY_MAX' }
    if ($script:AppText -notmatch 'expandedBox\(FOLD_ROW_MAX\)') { return '行内块展开态没用固定高度 FOLD_ROW_MAX' }
    if ($script:AppText -notmatch 'fixedBox\(FOLD_BODY_MAX\)') { return '溢出过的正文块折叠态没有定高（会随内容变矮）' }
    if ($script:AppText -notmatch 'fixedBox\(FOLD_ROW_MAX\)') { return '溢出过的行内块折叠态没有定高' }
    if ($script:AppText -notmatch 'foldedBox\(FOLD_BODY_MAX\)') { return '短框不再按内容自适应（maxHeight 丢了）' }
    # 定高只能写 height，写成 maxHeight 就会在展开态缩回去。
    if ($script:AppText -notmatch '(?s)const fixedBox = \(max: number\).{0,120}?height: max') { return 'fixedBox 不是 height 定高' }

    # A1（2026-10-30 判据）：按钮恒显之后，「展开」不能单独决定定高——否则 1–3 行的短命令点一下
    # 就变成一个 130px 的空框，正文容器还被顶出滚动条。所以展开分支必须**先看溢出**：
    # 溢出过 → expandedBox（定高，与折叠态同高）；没溢出 → expandedShortBox（按内容自适应，只关折行）。
    if ($script:AppText -notmatch '(?s)expanded\s*\?\s*overflows\s*\?\s*expandedBox\(FOLD_BODY_MAX\)') {
        return '正文块的展开态没先看溢出（短框会被拉成固定 130 的空框）'
    }
    if ($script:AppText -notmatch '(?s)rowExpanded\s*\?\s*rowOverflows\s*\?\s*expandedBox\(FOLD_ROW_MAX\)') {
        return '行内块的展开态没先看溢出（短命令会被拉成固定高的空框）'
    }
    # 反向：expandedBox 不许直接挂在 `expanded ?` 的真分支上（那正是本 bug 的形状）。
    if ($script:AppText -match '(?s)expanded\s*\?\s*expandedBox\(') {
        return 'expanded ? 的真分支直接用了 expandedBox（短框会被撑成空框）'
    }
    if ($script:AppText -notmatch 'expandedShortBox\(FOLD_BODY_MAX\)') { return '正文短框没有单独的展开态（expandedShortBox）' }
    if ($script:AppText -notmatch 'expandedShortBox\(FOLD_ROW_MAX\)') { return '行内短框没有单独的展开态（expandedShortBox）' }
    # 短框展开态必须「不定高、只关折行」：写死 height 就退回空框；不关折行就不叫展开。
    $shortBox = [regex]::Match($script:AppText, '(?s)const expandedShortBox = \(max: number\).*?\}\)').Value
    if ($shortBox -eq '') { return '找不到 expandedShortBox' }
    if ($shortBox -match '(?m)^\s*height:') { return 'expandedShortBox 定了高（短框展开会多一块空框）' }
    if ($shortBox -notmatch "whiteSpace: 'pre'") { return 'expandedShortBox 没关掉折行（展开应不折行）' }
    if ($shortBox -notmatch 'foldedBox\(max\)') { return 'expandedShortBox 没沿用 foldedBox 的限高/滚动（maxHeight 丢了）' }
    $true
}

Check '展开（D-44）：短框展开后灰框不许变矮——折叠态的高度记下来当 minHeight' {
    # 用户 2026-11-10 真机：「展开后怎么代码框（灰色的）下面有了空白（白色的）」「导致 代码框（灰色的）
    # 与 按钮 中间有空白（白色的）」「既然你给了默认高度（灰色的），那就不要收起来」。
    # 根因：没溢出过的短框展开只关折行 → 行数变少 → 灰框自然高度变小；而卡片窗口高度不会跟着缩
    #（宿主只在需要时量高），于是灰框底边与按钮之间露出一块白。做法：折叠时量高，展开态用 minHeight 兜住。
    if ($script:AppText -notmatch 'useLayoutEffect') { return '短命令点展开后，灰框底边和按钮之间又空出一条白（折叠高度没量）' }
    if ($script:AppText -notmatch 'offsetHeight|clientHeight') { return '短命令点展开后，灰框底边和按钮之间又空出一条白（没读实测高度）' }
    if ($script:AppText -notmatch 'foldedHeights = useRef<Record<string, number>>') {
        return '短命令点展开后，灰框底边和按钮之间又空出一条白（没有「每个框各记一份」的高度表）'
    }
    if ($script:AppText -notmatch 'foldedHeights\.current\[key\] = height') {
        return '短命令点展开后，灰框底边和按钮之间又空出一条白（折叠态的高度没写进表里）'
    }
    # 只记折叠态：展开态量到的是被兜过的高度，回写会让折叠态也变高。
    if ($script:AppText -notmatch 'expandedKeys\[key\] === true\) continue') {
        return '展开态的高度被回写了（折叠态会跟着变高）'
    }
    $shortBox = [regex]::Match($script:AppText, '(?s)const expandedShortBox = \(max: number\).*?\}\)').Value
    if ($shortBox -eq '') { return '找不到 expandedShortBox' }
    if ($shortBox -notmatch 'minHeight: folded') {
        return '短命令点展开后，灰框底边和按钮之间又空出一条白（展开态没有 minHeight 兜底）'
    }
    if ($shortBox -notmatch 'foldedHeights\.current\[boxKey\]') {
        return '展开态没按框取折叠高度（共用一个值会把短框撑成别人的高度）'
    }
    # 正文块与行内框各自把自己的键交给展开态，键与溢出判定同一套（body- / row-）。
    if ($script:AppText -notmatch 'layoutKey = key') { return '正文块没把自己的键交给展开态（正文短命令展开还是变矮）' }
    if ($script:AppText -notmatch 'layoutKey = rowKey') { return '行内框没把自己的键交给展开态（行内短命令展开还是变矮）' }
    $true
}

Check '展开（D-44）反向：minHeight 不等于定高，短框仍按内容自适应（不退回空框）' {
    $shortBox = [regex]::Match($script:AppText, '(?s)const expandedShortBox = \(max: number\).*?\}\)').Value
    if ($shortBox -eq '') { return '找不到 expandedShortBox' }
    if ($shortBox -match '(?m)^\s*height:') {
        return '短命令点展开后，灰框底边和按钮之间又空出一条白（短框被写成了定高，会多出一块空框）'
    }
    if ($shortBox -match 'height:\s*FOLD_(BODY|ROW)_MAX') {
        return 'expandedShortBox 把折叠高度当定高用了（定高属于溢出路径的 expandedBox）'
    }
    if ($shortBox -notmatch 'foldedBox\(max\)') { return '短框丢了 maxHeight 限高（以后变长会撑破卡片）' }
    $true
}

Check '展开（B-28）：切换只改框内排版，不上报 resize、不改卡片高度' {
    # 卡片根节点的高度契约没变：fill 阶段仍是 100%，由窗口决定，内容变化不会把它顶大。
    if ($script:AppText -notmatch "height: phase === 'fill' \? '100%' : undefined") { return '卡片根节点的高度契约被改了' }
    # toggle 里不许掺进两次量高：那就等于回到「量完再跳」。
    $toggle = [regex]::Match($script:AppText, '(?s)const toggleCode = useCallback\(.*?\}, \[\]\)').Value
    if ($toggle -eq '') { return '找不到 toggleCode' }
    if ($toggle -match 'postToHost|resize|contentHeight') { return 'toggleCode 在改窗口尺寸/重新量高' }
    $true
}

Check '按钮（B-29）：正文代码框与行内命令框各自一套' {
    $count = ([regex]::Matches($script:AppText, '<CodeTools')).Count
    if ($count -ne 2) { return "CodeTools 挂了 $count 处，应为 2 处（正文块 + 行内命令块各一套）" }
    if ($script:AppText -notmatch 'text=\{commandOnly\(block\.command\)\}') { return '正文块的复制文本没走 commandOnly' }
    if ($script:AppText -notmatch 'text=\{commandOnly\(row\.text\)\}') { return '行内命令的复制文本没走 commandOnly' }
    $true
}

Check '按钮（B-29）：绝对定位 + 默认透明 + 悬停才显，且藏着时点不到' {
    if ($script:StylesSource -notmatch '\.card-code-tools\s*\{[^}]*position:\s*absolute') { return '工具条不是绝对定位（会占布局）' }
    if ($script:StylesSource -notmatch '\.card-code-tools\s*\{[^}]*opacity:\s*0') { return '工具条默认不是透明的' }
    if ($script:StylesSource -notmatch '\.card-code-tools\s*\{[^}]*pointer-events:\s*none') { return '藏起来的按钮还能点到（会吃掉一次点击）' }
    if ($script:StylesSource -notmatch '\.card-code:hover\s+\.card-code-tools') { return '没有「鼠标进到代码框才显示」的规则' }
    if ($script:StylesSource -notmatch '\.card-code:hover\s+\.card-code-tools\s*\{[^}]*opacity:\s*1') { return '悬停时没有显形' }
    # 淡入淡出 120ms（T-05⑥）：没有过渡就会「啪」地出现/消失；显形后必须把 pointer-events 还回去，
    # 否则看得见却点不到。
    if ($script:StylesSource -notmatch '\.card-code-tools\s*\{[^}]*transition:\s*opacity\s+120ms') { return '按钮没有 120ms 淡入淡出过渡' }
    if ($script:StylesSource -notmatch '\.card-code:hover\s+\.card-code-tools\s*\{[^}]*pointer-events:\s*auto') { return '悬停显形后按钮仍点不到（pointer-events 没恢复）' }
    # 两套框（正文块 / 行内命令块）必须共用同一层定位父级：用户 2026-10-30 真机看到
    # 「下面的选项 复制按钮在代码行而不是最上面」「鼠标放注释行没显示复制按钮」——
    # 根因就是行内框的 .card-code 只包住命令那一行，注释行在外面（T-10）。
    $shells = ([regex]::Matches($script:AppText, 'className="card-code"')).Count
    if ($shells -ne 2) { return "className=""card-code"" 有 $shells 处，应为 2 处（正文框 + 行内框各一个灰底整框）" }
    $relatives = ([regex]::Matches($script:AppText, "position:\s*'relative'")).Count
    if ($relatives -lt 2) { return "定位父级只有 $relatives 处，两个灰底框都要 position:relative" }
    # 工具条必须挂在整框里（在 .card-code 内部），不能退回命令行那一层。
    if ($script:AppText -match '<div className="card-code"[^>]*>\s*<CodeTools') { return '工具条被挂成了 .card-code 的第一个子节点（应整框最后一个）' }
    $true
}

Check '主题（B-30）：IDEA Light 固定色（注释灰、字符串绿），不再全部指向 token' {
    if ($script:AppText -notmatch "'#8C8C8C'") { return '注释没有钉成 IDEA Light 的灰（#8C8C8C）' }
    if ($script:AppText -notmatch "'#067D17'") { return '字符串没有钉成 IDEA Light 的绿（#067D17）' }
    if ($script:AppText -notmatch "'#0033B3'") { return '关键字没有钉成 IDEA Light 的蓝（#0033B3）' }
    if ($script:AppText -notmatch 'IDEA_LIGHT\.comment') { return '注释色没有集中在 IDEA_LIGHT 里' }
    # 注释与字符串两项必须是固定色，不许再回到「跟随界面色」。
    if ($script:AppText -match "'--shiki-token-comment':\s*token\.") { return '注释色还指着 antd token（等于没有主题）' }
    if ($script:AppText -match "'--shiki-token-string':\s*token\.") { return '字符串色还指着 antd token' }
    $true
}

Check '主题（B-30）：IDEA Light 调色板逐色对值，变量再逐个指向它' {
    # 色值都是用户在 IDEA 里**实测取值**（2026-10-30，B-41），禁止从截图取色：
    # 普通文本 #080808、注释 #8C8C8C、字符串 #067D17、关键词 #0033B3（加粗）、
    # 命令与数字同色 #1750EB（「数字算命令」）；B 版另加变量/类型/操作符三色。
    $palette = @(
        @('comment', '#8C8C8C'),
        @('string', '#067D17'),
        @('keyword', '#0033B3'),
        @('constant', '#1750EB'),
        @('function', '#1750EB'),
        @('foreground', '#080808'),
        @('variable', '#248F8F'),
        @('type', '#7A7A43'),
        @('operator', '#871094')
    )
    foreach ($pair in $palette) {
        $needle = $pair[0] + ": '" + $pair[1] + "'"
        if ($script:AppText -notmatch [regex]::Escape($needle)) {
            return ("IDEA_LIGHT." + $pair[0] + " 不是 " + $pair[1])
        }
    }
    # 变量必须指向调色板常量，而不是随手写个 token 或另一处色值——「映射错位」正是这么来的。
    foreach ($pair in @(
            @('--shiki-token-comment', 'comment'),
            @('--shiki-token-string', 'string'),
            @('--shiki-token-string-expression', 'string'),
            @('--shiki-token-keyword', 'keyword'),
            @('--shiki-token-constant', 'constant'),
            @('--shiki-token-function', 'function'),
            @('--shiki-token-variable', 'variable'),
            @('--shiki-token-type', 'type'),
            @('--shiki-token-operator', 'operator'),
            @('--shiki-foreground', 'foreground'))) {
        $needle = "'" + $pair[0] + "': IDEA_LIGHT." + $pair[1]
        if ($script:AppText -notmatch [regex]::Escape($needle)) {
            return ($pair[0] + ' 没有指向 IDEA_LIGHT.' + $pair[1])
        }
    }
    $true
}

Check '主题（B-30）：裸参数不是字符串——string.unquoted / option 拉回正文色' {
    # shell 语法把裸参数标成 string.unquoted.*，css-variables 主题的 `string` 规则会把它涂成
    # 字符串色（整行发绿）。这里钉住那条覆盖规则的存在与目标色（行为断言见 tests/card-tokens.ps1）。
    if ($script:HighlightText -notmatch "'string\.unquoted'") { return '没有覆盖 string.unquoted（裸参数会发绿）' }
    if ($script:HighlightText -notmatch "'constant\.other\.option'") { return '没有覆盖 constant.other.option（-h / -c 会发绿）' }
    if ($script:HighlightText -notmatch "foreground: 'var\(--shiki-foreground\)'") {
        return '覆盖规则没有把颜色拉回 --shiki-foreground'
    }
    $true
}

Check '说明并入高亮流（B-31/R-17/D-42）：`#` 拼进 source 交 shiki，不手造注释 token' {
    if ($script:TypesSource -notmatch 'comment\?: string') { return 'types.ts 的 CodeBlock 没有 comment 字段' }
    # 用户 2026-11-10：「肯定要#号啊， 再说没有#你怎么让shiki渲染为注释的啊？你还有特殊处理？
    # 我不是说了他就作为标准内容放进去shiki自己会处理吗？你还特殊处理了？」
    # 所以 App.tsx 里既不许再来一行手写的 `# 说明`，也不许自己调注释色画它——拼前缀与上色都是 highlight() 的事。
    if ($script:AppText -match '# \$\{') { return 'App.tsx 还在给说明拼 `#` 前缀（R-17）' }
    # 模板字符串之外，`'# '` / `"# "` 这种**字面量**拼法同样是「自己拼注释前缀」（`{'# '}`、`'# ' + …`）：
    # 说明行必须由 highlight.ts 拼进 shiki 的 source，App.tsx 里出现前缀就说明又分叉成两条渲染路径。
    if ($script:AppText -match "'# '") { return 'App.tsx 里出现 ''# '' 字面量（`#` 只许由 highlight.ts 生成）' }
    if ($script:AppText -match '"# "') { return 'App.tsx 里出现 "# " 字面量（`#` 只许由 highlight.ts 生成）' }
    # 说明必须作为 comment 传进代码框里的 CodeText（正文块在 <pre data-part="code"> 内部）。
    $pre = [regex]::Match($script:AppText, '(?s)<pre\s+data-part="code".*?</pre>').Value
    if ($pre -eq '') { return '找不到 <pre data-part="code"> 块' }
    if ($pre -notmatch 'comment=\{block\.comment\}') { return '正文代码框没有把 comment 交给 CodeText（说明会丢）' }
    # 行内命令同理：`why` 交给 CodeText，不再单独渲染成一行。
    if ($script:AppText -notmatch 'comment=\{row\.why\}') { return '行内命令没有把 why 交给 CodeText（说明会丢）' }
    # 只剩说明、没有命令的行（why 有、text 没有）：保留纯文本兜底，`#` 仍从 commentSource 取。
    if ($script:AppText -notmatch '(?s)只剩说明.{0,1200}?commentSource\(row\.why\)') {
        return '只剩说明的行没有兜底渲染（这种行没有代码框，说明会丢 / 少一个 #）'
    }
    # `#` 只允许一处生成：highlight.ts 的 COMMENT_PREFIX（每行拼一次，多行说明每行都有）。
    if ($script:HighlightText -notmatch "'# '") { return 'highlight.ts 里没有拼 `# ` 前缀的代码（说明又变成没有 # 的灰字）' }
    if ($script:HighlightText -notmatch 'COMMENT_PREFIX \+ line') {
        return 'highlight.ts 的说明不是逐行拼前缀（多行说明会少 #）'
    }
    # 说明必须**整段**进分词：不再有「手造注释 token 拼在分词结果前面」这条捷径。
    # 只扫代码不扫注释（同 D-28 / D-29 的口径：注释里写「上一版用的是什么」是结论，不是用法）。
    $highlightCode = Get-CodeOnly $script:HighlightText
    if ($highlightCode -match 'textToken|commentLines') {
        return 'highlight.ts 又有手造注释 token（textToken / commentLines）：说明绕开了 shiki，`#` 也会丢'
    }
    if ($highlightCode -match '\[\.\.\.head') {
        return 'highlight.ts 还在把说明 token 拼在分词结果前面（说明没进 shiki 的输入）'
    }
    if ($script:HighlightText -notmatch 'codeToTokens\(source') { return '说明没有和命令一起交给 codeToTokens（不是标准代码内容）' }
    if ($script:HighlightText -notmatch 'lines = tokens') { return '分词结果不是整段直接用（说明与命令必须是同一次分词）' }
    # 缓存键要带上说明：同一段命令配不同说明是不同的行流。
    if (-not $script:HighlightText.Contains("comment ?? ''")) { return '高亮缓存键没有带上 comment（会串内容）' }
    if ($script:AppText -notmatch 'data-part="note"') { return 'note 块的渲染被删了（别处还在用）' }
    $true
}

Check '折叠按钮（R-17）：canFold 恒为 true，不再由溢出判定决定' {
    # 用户 2026-11-10：「溢出判定会变，那就默认都显示，简单处理 又不影响功能」。
    if ($script:AppText -match 'canFold=\{') { return 'canFold 又按条件算了（应恒为 true）' }
    if ($script:AppText -match 'canFold=\{expanded \|\|') { return 'canFold 还挂在展开/溢出条件上' }
    $count = ([regex]::Matches($script:AppText, '(?m)^\s*canFold\s*$')).Count
    if ($count -ne 2) { return "canFold 恒为 true 的写法有 $count 处，应为 2 处（正文块 + 行内块）" }
    # 溢出判定本身不许顺手删掉：它仍决定折叠/展开是否定高（T-09）。
    if ($script:AppText -notmatch 'overflowingKeys') { return '溢出判定被删了（T-09 的定高还靠它）' }
    if ($script:AppText -notmatch 'element\.scrollHeight - element\.clientHeight > 1') { return '真实溢出量测量被删了' }
    $true
}

Check '复制（B-32）：取文本是独立纯函数，整行注释与首尾空行都去掉' {
    if ($script:CommandTextSource -notmatch 'export function commandOnly') { return '没有独立的 commandOnly 纯函数' }
    if ($script:CommandTextSource -notmatch '/\^\\s\*#/') { return '没有按「行首 #」识别注释行' }
    if ($script:CommandTextSource -match 'navigator|document|window') { return 'commandOnly 不是纯函数（碰了浏览器 API）' }
    # 行为（「# 原因 + 命令」→ 只剩命令）由 tests/command-only.ps1 真跑一遍。
    # 不写在这份脚本里：它要起 node，而这份脚本一旦被管道/捕获运行，PowerShell 就起不了原生程序
    # （StandardOutputEncoding / 受限沙箱下的「拒绝访问」），会让门禁莫名其妙失败。
    $true
}

Check '复制（B-29/B-40）：走宿主 Set-Clipboard 回执，成功对勾、失败可见' {
    # 卡片是 NavigateToString 出来的，origin 是 about:blank，**不是 secure context**：
    # navigator.clipboard 恒为 undefined，旧实现 `if (!clipboard) return` 就是
    # 「点了没反应、也确实没复制」的根因（D-34）。现在只有一条路：发 copy 给宿主。
    if ($script:CodeToolsSource -match 'navigator\.clipboard') { return '又用回了 navigator.clipboard（该环境恒为 undefined）' }
    if ($script:CodeToolsSource -notmatch "type: 'copy'") { return '没有把命令本体发给宿主（copy 消息）' }
    if ($script:WindowText -notmatch 'Set-Clipboard') { return '宿主没有写剪贴板' }
    if ($script:WindowText -notmatch "'copy'") { return '宿主没有识别 copy 消息' }
    if ($script:CodeToolsSource -notmatch 'CheckOutlined') { return '复制成功没有即时反馈（对勾）' }
    if ($script:CodeToolsSource -notmatch 'CloseOutlined') { return '复制失败没有可见反馈（B-40：失败不许静默）' }
    foreach ($bad in @('notification', 'Modal', 'Alert', 'toast')) {
        if ($script:CodeToolsSource -match $bad) { return "复制反馈加了新 UI：$bad" }
    }
    $true
}

# ---- 窗口外观（图标 / 闪烁 / 置顶 / 描边） -----------------------------------------
#
# 任务栏与 alt-tab 里「认得出、不漏看」靠三件互不替代的事（PREFERENCES B-25 / B-26；D-39 取代 D-27）：
#   - 窗口图标：透明底 + 橙色线条的 card.ico（卡片内部视觉不动）；
#   - 显示之后闪任务栏（不激活、不抢焦点；置顶负责「在最上面」，闪烁负责「把视线叫过来」）；
#   - 描边橙色系：灰色的边界在多窗口里不容易辨认。

Check '窗口图标：$form.Icon 从 assets/card.ico 加载；缺文件只写一次 stderr、不拦弹窗' {
    if ($script:WindowText -notmatch '\$form\.Icon\s*=\s*\$icon') { return '没有给 $form.Icon 赋值' }
    if ($script:WindowText -notmatch 'Get-CardWindowIcon') { return '没有读图标的辅助函数' }
    if ($script:WindowText -notmatch 'assets\\card\.ico') { return '没有指向 assets\card.ico' }

    $icon = Get-CardWindowIcon
    if ($null -eq $icon) { return '默认路径下的图标读不出来' }
    try {
        if ($icon.Width -ne $icon.Height -or $icon.Width -lt 16) { return "图标尺寸不对：$($icon.Width)x$($icon.Height)" }
    } finally {
        $icon.Dispose()
    }

    # 文件缺失：返回 $null（窗口继续用默认图标），并在 stderr 说明一次。
    $missing = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-no-icon-' + [guid]::NewGuid().ToString('N') + '.ico')
    $captured = [System.IO.StringWriter]::new()
    $original = [Console]::Error
    try {
        [Console]::SetError($captured)
        $broken = Get-CardWindowIcon -Path $missing
    } finally {
        [Console]::SetError($original)
    }
    $stderrText = $captured.ToString()
    $captured.Dispose()
    if ($null -ne $broken) { return '缺文件时没有退回默认图标' }
    if (-not $stderrText.Contains('默认图标')) { return '缺文件时 stderr 没有说明' }
    $true
}

Check '闪烁：ShowWindow 之后调用一次任务栏闪烁，用的是窗口句柄' {
    $showAt = $script:WindowText.IndexOf('Invoke-CardForceShow', [System.StringComparison]::Ordinal)
    $flashAt = $script:WindowText.IndexOf('Invoke-TaskbarFlash', [System.StringComparison]::Ordinal)
    if ($showAt -lt 0) { return '找不到 Invoke-CardForceShow' }
    if ($flashAt -lt 0) { return 'webview2.ps1 没有调用 Invoke-TaskbarFlash' }
    if ($flashAt -lt $showAt) { return '闪烁发生在显示之前' }
    if ($script:WindowText -notmatch 'Invoke-TaskbarFlash -Handle \$form\.Handle') { return '闪烁没有用窗口句柄' }
    if ($script:EnvText -notmatch 'FlashWindowEx') { return 'environment.ps1 没有 FlashWindowEx' }
    # P/Invoke 只允许一个类型：新的原生调用要加进 DshUiCard.Native，不许再开第二个 Add-Type。
    if (([regex]::Matches($script:EnvText, 'Add-Type -Namespace DshUiCard')).Count -ne 1) { return 'Native 类型不止一个 Add-Type' }
    $true
}

Check '闪烁：节奏有限（FLASHW_ALL、5 × 500ms = 2.5 秒），不再用 FLASHW_TIMERNOFG' {
    # 只扫代码：注释（含 <# #> 段落）里写清「为什么不用 TIMERNOFG」是结论，不是用法（D-28）。
    $code = [regex]::Replace($script:EnvText, '(?s)<#.*?#>', '')
    $code = (@($code -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
    if ($code -match 'TIMERNOFG') { return '又用回 FLASHW_TIMERNOFG（会一直闪到窗口到前台为止）' }
    if ($code -match '\$info\.dwFlags\s*=\s*14\b') { return 'dwFlags 还是 14（FLASHW_TRAY | FLASHW_TIMERNOFG）' }
    if ($code -notmatch '\$info\.dwFlags\s*=\s*3\b') { return 'dwFlags 不是 FLASHW_ALL(3)' }
    if ($code -notmatch '\$info\.uCount\s*=\s*[1-9]\d*\b') { return 'uCount 不是有限正整数' }
    if ($code -notmatch '\$info\.dwTimeout\s*=\s*[1-9]\d*\b') { return 'dwTimeout 不是有限正整数（0 = 跟系统光标闪烁节奏走）' }
    # 总时长按源码里的两个值算，必须落在 2–3 秒：闪几秒就停，既不等用户点、也不无限循环。
    $count = [int][regex]::Match($code, '\$info\.uCount\s*=\s*(\d+)').Groups[1].Value
    $timeout = [int][regex]::Match($code, '\$info\.dwTimeout\s*=\s*(\d+)').Groups[1].Value
    $totalMs = $count * $timeout
    if ($totalMs -lt 2000 -or $totalMs -gt 3000) { return "总时长 $totalMs ms 不在 2–3 秒（uCount $count × dwTimeout $timeout）" }
    $true
}

Check '闪烁：约 2.5 秒时显式 FLASHW_STOP 停（非前台窗口不会自己停）' {
    # 真机结论：窗口不在前台时，任务栏的「请求注意」会一直闪到该窗口被激活，uCount / dwTimeout
    # 压不住它（D-28：「一直闪不停，直到卡片关掉」）。所以必须有第二条显式停止路径。
    $code = [regex]::Replace($script:EnvText, '(?s)<#.*?#>', '')
    $code = (@($code -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
    if ($script:EnvText -notmatch 'FLASHW_STOP') { return 'environment.ps1 里没有 FLASHW_STOP 的显式停止路径' }
    if ($code -notmatch 'function Stop-TaskbarFlash') { return '没有 Stop-TaskbarFlash' }
    if ($code -notmatch '\$info\.dwFlags\s*=\s*0\b') { return '停止时没有把 dwFlags 置 0（FLASHW_STOP）' }
    if ($code -notmatch '\$info\.uCount\s*=\s*0\b') { return '停止时没有把 uCount 归零' }
    if ($code -notmatch '\$info\.dwTimeout\s*=\s*0\b') { return '停止时没有把 dwTimeout 归零' }
    if ($code -notmatch '::IsWindow\(\$Handle\)') { return '停止前没有 IsWindow 判活（卡片可能已经关掉）' }
    # 窗口层：必须用 WinForms Timer 到点停。Start-Sleep 会卡住宿主线程，另起进程则会闪到关窗为止。
    if ($script:WindowText -notmatch 'System\.Windows\.Forms\.Timer') { return 'webview2.ps1 没有用 WinForms Timer 定时停止' }
    if ($script:WindowText -notmatch '\$flashTimer\.Interval\s*=') { return 'Timer 没有设 Interval' }
    if ($script:WindowText -notmatch '\$flashTimer\.add_Tick') { return 'Timer 没有挂 Tick' }
    if ($script:WindowText -notmatch 'Stop-TaskbarFlash -Handle') { return 'webview2.ps1 没有调用 Stop-TaskbarFlash' }
    if ($script:WindowText -match '(?m)Start-Sleep\s+-Milliseconds\s+2500') { return '用 Start-Sleep 等 2.5 秒（会卡住宿主线程）' }
    $true
}

Check '置顶（D-41，取代 D-39）：WS_EX_TOPMOST 在建窗时交给 CreateWindowEx，不是事后 SetWindowPos' {
    # 用户 2026-11-10：「很多软件都有 显示出新的窗口但不打断输入的 窗口。这应该不是技术限制吧？」
    # 上一版按 D-39 在显示之后 SetWindowPos(HWND_TOPMOST)：调用返回 True，exstyle 却仍是 0x50000，
    # 卡片照旧被最大化浏览器盖住。本机 12 组对照只有一条成立——建窗时给 CreateParams 补
    # WS_EX_TOPMOST(0x8)：exstyle 0x50008、IsWindowVisible=True、前台没被抢（D-41）。
    if ($script:WindowText -match '(?m)\[switch\]\$TopMost') { return 'webview2.ps1 又有 -TopMost 开关了（层级只能来自建窗时的 WS_EX_TOPMOST）' }
    if ($script:WindowText -match '\$form\.TopMost\s*=') { return '又去设 WinForms 的 $form.TopMost（窗口一被激活就会把窗口重新插回 topmost，第二条层级来源）' }

    # 建窗那一步三件缺一不可：派生 Form、覆盖 CreateParams、把 WS_EX_TOPMOST 交出去。
    if ($script:EnvText -notmatch 'function New-CardForm') { return 'environment.ps1 没有 New-CardForm（建窗时补 WS_EX_TOPMOST 的地方）' }
    if ($script:EnvText -notmatch ': System\.Windows\.Forms\.Form') {
        return 'TopMostForm 不是 System.Windows.Forms.Form 的派生类：CreateParams 无从覆盖，置顶位带不进去'
    }
    if ($script:EnvText -notmatch 'override System\.Windows\.Forms\.CreateParams CreateParams') {
        return '没有覆盖 CreateParams：WS_EX_TOPMOST 交不进 CreateWindowEx'
    }
    if ($script:EnvText -notmatch 'ExStyle\s*\|=\s*0x00000008') {
        return '卡片弹出来还在浏览器后面——置顶又退回了事后 SetWindowPos：CreateParams 里没有 WS_EX_TOPMOST(0x00000008)'
    }
    # Add-Type 必须幂等（environment.ps1 被多个入口 dot-source）：类型存在就不再编译。
    if ($script:EnvText -notmatch "if \(-not \('DshUiCard\.Card\.TopMostForm' -as \[type\]\)\)") {
        return 'New-CardForm 的 Add-Type 不是幂等的（第二次 dot-source 会重复编译/报错）'
    }
    if ($script:WindowText -notmatch '\$form = New-CardForm') {
        return 'webview2.ps1 没有用 New-CardForm 建窗：WS_EX_TOPMOST 根本不会带上，卡片仍在浏览器后面'
    }
    if ($script:WindowText -match 'New-Object System\.Windows\.Forms\.Form') {
        return 'webview2.ps1 还在 New-Object System.Windows.Forms.Form（裸 Form 没有 WS_EX_TOPMOST）'
    }

    # 显示那一步留作「显示兜底」：STARTUPINFO 的 SW_HIDE 会吞掉第一次 ShowWindow，0x0053 里的
    # SWP_SHOWWINDOW 负责显出来、SWP_NOACTIVATE 负责不抢焦点。它的 Z 序部分无效，别再当置顶来源。
    $line = @($script:EnvText -split "`r?`n" | Where-Object { $_ -match '::SetWindowPos\(\$Handle' }) -join "`n"
    if ($line -eq '') { return 'environment.ps1 里找不到对窗口句柄的 SetWindowPos（SW_HIDE 的显示兜底没了）' }
    if ($line -notmatch '\[System\.IntPtr\]::new\(-1\)') { return 'SetWindowPos 的插入位置不是 HWND_TOPMOST(-1)' }
    $flagsMatch = [regex]::Match($line, '0x([0-9A-Fa-f]+)\)')
    if (-not $flagsMatch.Success) { return 'SetWindowPos 没有可读的 flags' }
    $flags = [Convert]::ToInt32($flagsMatch.Groups[1].Value, 16)
    if (($flags -band 0x0010) -eq 0) { return 'flags 里没有 SWP_NOACTIVATE(0x0010)——显示兜底会抢焦点，这轮的前提不成立' }
    if (($flags -band 0x0040) -eq 0) { return 'flags 里没有 SWP_SHOWWINDOW(0x0040)——SW_HIDE 之后窗口显不出来' }
    if ($flags -ne 0x0053) { return ("flags=0x{0:X4}，应为 0x0053（NOSIZE|NOMOVE|NOACTIVATE|SHOWWINDOW）" -f $flags) }

    # -Activate 这个开关本身保留（tools/preview-card.ps1 还在用，它不属于产品路径）。
    if ($script:WindowText -notmatch '\[switch\]\$Activate') { return '-Activate 开关被删了（tools/preview-card.ps1 还在用）' }
    if ($script:WindowText -notmatch 'Invoke-CardForceShow -Handle \$form\.Handle -Activate') { return 'Invoke-CardForceShow 的 -Activate 分支被删了' }
    $true
}

Check '置顶回归（D-41）：事后抬层 / 抢前台的老路一条都不许回来' {
    # 这次 bug 的回归防线：非前台进程事后改 Z 序无效（实测 exstyle 只到 0x50000），唯一成立的是
    # 建窗时 CreateParams 的 WS_EX_TOPMOST（0x50008）。所以「再抬一次」「抢前台凑数」都必须绝迹——
    # 它们要么无效（问题没修），要么把用户正在打的字打断（C-01）。
    # `SetForegroundWindow` 不在这里重复扫：下面「不抢焦点（C-01）」那条已经按产品脚本全量扫过。
    $suspects = [ordered]@{
        '.Activate('      = '调 Activate() 抢激活（D-27 当年被用户否掉的就是这个）'
        '.Show()'         = '调 Form.Show() 抢前台（显示只能走 Invoke-CardForceShow）'
        'TopMost = $true' = '设 WinForms 的 TopMost 属性（第二条层级来源）'
    }
    foreach ($pair in @(@('environment.ps1', $script:EnvText), @('webview2.ps1', $script:WindowText))) {
        foreach ($key in $suspects.Keys) {
            if ($pair[1].Contains($key)) {
                return ("窗口截图上卡片要么还在浏览器后面、要么把输入打断了：$($pair[0]) 里出现 $key（$($suspects[$key])）")
            }
        }
    }
    $true
}

# ---- 让位（D-43）：弹出即置顶，点卡片外面一下就让位 --------------------------------
#
# 用户原话：「又回到之前的问题了： 置顶了窗口 我其他程序即使激活 卡片还是在上面 影响使用」，
# 紧接着对着 demo 说「这种是可以的」。demo 的机制就三件：建窗置顶（D-41）+ WH_MOUSE_LL 钩子 +
# 第一次「按在卡片之外」时自己 SetWindowPos(HWND_NOTOPMOST) 并卸钩。
#
# 为什么只能这么修：`WS_EX_TOPMOST` 不会自动衰减；非前台进程替**别人的**窗口降层无效
# （实测 exstyle 停在 0x50000）；「前台窗口变化」当不了触发（卡片从不获得前台，浏览器始终在前台，
# 事件永远不触发）。所以下面钉的是「钩子装得上、只对卡片外面的按下降层、降层用 -2 + 0x0013、
# 用完就卸」，而不是「看着像让位」。真机在 WebView2 窗体里是否照 demo 一样工作只能人点（D-43 未验清单）。
#
# 不抢焦点那三条（SetForegroundWindow / .Activate( / .Show() / TopMost = $true）**不在这里重复扫**：
# 上面「置顶回归（D-41）」与「不抢焦点（C-01）」已经按文件与产品脚本全量扫过。

$script:YieldBody = [regex]::Match($script:EnvText, '(?s)function Start-CardTopMostYield \{.*?\r?\n\}').Value

Check '让位（D-43）：低层鼠标钩子的原生声明齐全（WH_MOUSE_LL=14、CallNextHookEx、WindowFromPoint、GetAncestor）' {
    if ($script:YieldBody -eq '') { return '找不到 Start-CardTopMostYield：让位机制根本不存在，卡片会一直压着别的程序' }
    if ($script:EnvText -notmatch 'SetWindowsHookEx\(14,') { return '没有 SetWindowsHookEx(14 = WH_MOUSE_LL)：钩子装不成，点了外面卡片也不会让位' }
    if ($script:EnvText -notmatch 'UnhookWindowsHookEx\(') { return '没有 UnhookWindowsHookEx：钩子只能留到进程结束，卡片关掉后还在被回调' }
    if ($script:EnvText -notmatch 'CallNextHookEx\(') { return '没有 CallNextHookEx：卡片之外的鼠标事件在回调里断掉（鼠标会卡顿/丢事件）' }
    if ($script:EnvText -notmatch 'WindowFromPoint\(') { return '没有 WindowFromPoint：判不出「这次按在哪」' }
    if ($script:EnvText -notmatch 'GetAncestor\(') { return '没有 GetAncestor：点在 WebView2 子窗口上会被误判成「点在外面」' }
    if ($script:EnvText -notmatch 'public struct MSLLHOOKSTRUCT') { return '没有 MSLLHOOKSTRUCT 结构体：拿不到按下时的坐标' }
    if ($script:EnvText -notmatch 'public struct POINT') { return '没有 POINT 结构体：WindowFromPoint 没有入参类型' }
    if ($script:EnvText -notmatch "'yield-armed'") { return '没有 yield-armed 埋点：真机上分不清「钩子没装」和「装了但没触发」' }
    if ($script:EnvText -notmatch "'yield'") { return '没有 yield 埋点：让位到底发生没有只能靠感觉' }
    $true
}

Check '让位（D-43）：只有「按在卡片之外」才降层——根窗口比对，点在卡片上不动' {
    if ($script:YieldBody -notmatch 'WindowFromPoint\(\$info\.pt\)') { return '让位没有按鼠标坐标取窗口（拿不到「按在哪」）' }
    if ($script:YieldBody -notmatch 'GetAncestor\(\$under, 2\)') { return '没有用 GA_ROOT(2) 归到根窗口：点卡片自己的内容会被当成「点在外面」' }
    if ($script:YieldBody -notmatch '\$root -ne \$script:YieldHandle') {
        return '没有「根窗口 != 卡片句柄」这条判据：窗口截图上会是「点卡片里面卡片也让位了」'
    }
    $guardAt = $script:YieldBody.IndexOf('$root -ne $script:YieldHandle')
    $demoteAt = $script:YieldBody.IndexOf('::SetWindowPos(')
    if ($demoteAt -lt $guardAt) { return '降层跑在「点在哪」的比对之前：点卡片里面也会降层' }
    foreach ($msg in @('0x0201', '0x0204', '0x0207')) {
        if ($script:YieldBody -notmatch [regex]::Escape($msg)) { return "没有识别按下消息 $msg（只认左/右/中键按下）" }
    }
    $true
}

Check '让位（D-43）：降层是 HWND_NOTOPMOST(-2) + 0x0013（只动层级，不改尺寸/位置、不抢焦点）' {
    if ($script:YieldBody -notmatch '\[System\.IntPtr\]::new\(-2\)') { return '降层没把插入位置指向 HWND_NOTOPMOST(-2)：卡片还会压在浏览器上面' }
    $call = [regex]::Match($script:YieldBody, '(?s)::SetWindowPos\(.*?0x([0-9A-Fa-f]+)\)').Value
    if ($call -eq '') { return '找不到降层那一次 SetWindowPos（或它的 flags 不可读）' }
    $flags = [Convert]::ToInt32([regex]::Match($call, '0x([0-9A-Fa-f]+)\)').Groups[1].Value, 16)
    if ($flags -ne 0x0013) { return ("降层的 flags=0x{0:X4}，应为 0x0013（NOSIZE|NOMOVE|NOACTIVATE）" -f $flags) }
    if (($flags -band 0x0040) -ne 0) { return '降层的 flags 里带了 SWP_SHOWWINDOW：让位会顺手把窗口再显一次' }
    $true
}

Check '让位（D-43）：回调委托的强引用留在 $script:（被 GC 回收后钩子会静默失效）' {
    if ($script:EnvText -notmatch '\$script:YieldProc = \[DshUiCard\.Native\+CardHookProc\]\{') {
        return '回调委托没有建成 CardHookProc 并放到 $script:YieldProc'
    }
    if ($script:YieldBody -notmatch 'SetWindowsHookEx\(14, \$script:YieldProc,') {
        return 'SetWindowsHookEx 拿的不是 $script:YieldProc：委托被回收后钩子静默失效（点了外面毫无反应）'
    }
    # 反向：委托**只能**在 $script: 上建一次；建进局部变量（哪怕同时另外还放了一份到 $script:）也不行，
    # 那种写法在 demo 里真踩过——回调被 GC 回收后钩子静默失效，「点外面毫无反应」。
    if (([regex]::Matches($script:EnvText, '= \[DshUiCard\.Native\+CardHookProc\]\{')).Count -ne 1) {
        return 'CardHookProc 委托不止建了一处：委托必须只在 $script:YieldProc 上建一次（别的引用被回收后钩子会失效）'
    }
    $true
}

Check '让位（D-43）：webview2.ps1 显示之后装钩、收尾 finally 卸钩（各一处，顺序对）' {
    $showAt = $script:WindowText.IndexOf('Invoke-CardForceShow -Handle $form.Handle')
    $armAt = $script:WindowText.IndexOf('Start-CardTopMostYield -Handle $form.Handle')
    if ($armAt -lt 0) { return 'webview2.ps1 没有 Start-CardTopMostYield -Handle $form.Handle：卡片只会置顶、不会让位' }
    if ($showAt -lt 0) { return '找不到 Invoke-CardForceShow（显示那一步没了）' }
    if ($armAt -lt $showAt) { return '钩子装在窗口显示之前，应放 Invoke-CardForceShow 之后、进消息泵之前' }
    if (([regex]::Matches($script:WindowText, 'Start-CardTopMostYield')).Count -ne 1) { return 'Start-CardTopMostYield 不止一处调用（一张卡只该一个钩子）' }
    $stopCount = ([regex]::Matches($script:WindowText, 'Stop-CardTopMostYield')).Count
    if ($stopCount -ne 1) { return "Stop-CardTopMostYield 出现 $stopCount 处，应为 1 处（收尾只卸一次）" }
    $finallyAt = $script:WindowText.IndexOf('} finally {')
    if ($finallyAt -lt 0) { return '找不到 Show-CardWindow 的 finally（收尾没了）' }
    if ($script:WindowText.IndexOf('Stop-CardTopMostYield') -lt $finallyAt) {
        return '卸钩不在收尾 finally 里：超时/异常那条路会把钩子留到进程结束'
    }
    $true
}

Check '让位（D-43）：事件驱动——Start-CardTopMostYield 里没有 Start-Sleep / Timer / while / for' {
    # 定时降层会让用户还没看完就被盖住；轮询则是空转（D-43 被否方案 ①②）。
    # 只扫代码不扫注释（注释里写「不做轮询」是结论，不是用法，同 D-28/D-29 的口径）。
    $code = (@($script:YieldBody -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
    foreach ($bad in @('Start-Sleep', 'System.Windows.Forms.Timer', 'while (', 'for (')) {
        if ($code.Contains($bad)) {
            return "让位用上了轮询/定时（$bad）：用户可能还没看完卡片就被盖住，或者 CPU 白烧"
        }
    }
    if ($code -notmatch 'SetWindowsHookEx\(') { return '让位里没有装钩子（那就只剩轮询这条路了）' }
    $true
}

# -Activate 的扫描只认一种写法：`-Activate:$Activate.IsPresent`（webview2.ps1 把调用方的开关
# 原样透传给 Invoke-CardForceShow，这是产品路径上唯一的出现处）。
# 旧的 `-Activate(?=[\s`]|$)` 有洞：`-Activate:$true`、`-Activate;` 都匹配不上，把产品里的透传
# 换成 `-Activate:$true` 照样全绿、卡片却永久抢前台（review 实测 match=False）。这里改成
# 「扫出每一处 `-Activate`，逐处核对它后面是不是那串唯一允许的实参」。
# 抽成函数是为了让断言先自验扫描器本身（见下面「不抢焦点」那条）。
function Get-CardActivateViolation {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Code)

    $bad = @()
    foreach ($match in [regex]::Matches($Code, '(?<![\w$])-Activate')) {
        $rest = $Code.Substring($match.Index + $match.Length)
        if ([regex]::IsMatch($rest, '^:\$Activate\.IsPresent(?![\w$.:])')) { continue }
        $head = ($rest.Substring(0, [Math]::Min(16, $rest.Length)) -replace '\s+', ' ')
        $bad += ('-Activate' + $head)
    }
    $bad
}

Check '不抢焦点（C-01）：-Activate 扫描器自验（-Activate:$true / -Activate; / -Activate -x 都必须判违规）' {
    # 断言本身也要能被证伪：扫描器要是漏了这三种写法，「把产品代码换成 -Activate:$true」也照样全绿。
    if (@(Get-CardActivateViolation '-Activate:$true').Count -eq 0) { return '-Activate:$true 漏过（会永久抢前台）' }
    if (@(Get-CardActivateViolation '-Activate;').Count -eq 0) { return '-Activate; 漏过' }
    if (@(Get-CardActivateViolation 'Invoke-X -Activate -x').Count -eq 0) { return '-Activate -x 漏过' }
    # 唯一允许的形式必须放过，否则这条会变成「谁都过不了」的假红。
    if (@(Get-CardActivateViolation 'Invoke-CardForceShow -Handle $h -Activate:$Activate.IsPresent').Count -ne 0) {
        return '合法写法 -Activate:$Activate.IsPresent 被误判'
    }
    $true
}

Check '不抢焦点（C-01）：产品代码不调 SetForegroundWindow、不传 -TopMost / -Activate 实参' {
    # 置顶解决「看不见」，但绝不能用抢前台来解决（那是 D-27 当年被用户否掉的东西）。
    $roots = @(
        $script:CardDir,
        (Join-Path $script:RepoRoot 'dsh-ssh-remote\scripts'),
        (Join-Path $script:RepoRoot 'dsh-approval-notifier\scripts')
    )
    $productFiles = @($roots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
            Get-ChildItem -LiteralPath $_ -Recurse -File -Include '*.ps1', '*.psm1' -ErrorAction SilentlyContinue
        } | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' })

    $foreground = @($productFiles | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'SetForegroundWindow' })
    if ($foreground.Count -gt 0) { return '产品代码里出现 SetForegroundWindow：' + (($foreground | ForEach-Object { $_.Name }) -join ', ') }

    # 只扫「代码」：注释里写清「不传 -Activate / 为什么不用 topmost」是结论，不是用法（同上一条的思路）。
    $codeOf = {
        param([string]$path)
        $text = [regex]::Replace((Get-Content -Raw -LiteralPath $path), '(?s)<#.*?#>', '')
        (@($text -split "`r?`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n")
    }

    # 两个插件 + 外壳的产品脚本里都不许再传 -TopMost（测试里的 mock 参数声明不算）。
    $topMost = @($productFiles | Where-Object { (& $codeOf $_.FullName) -match '(?<![\w$])-TopMost\b' })
    if ($topMost.Count -gt 0) { return '还有地方传 -TopMost：' + (($topMost | ForEach-Object { $_.Name }) -join ', ') }

    # -Activate 走 SW_RESTORE，会抢前台：产品脚本里唯一允许的写法是 `-Activate:$Activate.IsPresent`
    # （透传调用方给的开关）；写成别的实参（含 `-Activate:$true`）一律算违规，
    # 只有 tools/preview-card.ps1 不在产品路径上、可以随便传。扫描器自验见上一条。
    $activate = @($productFiles | Where-Object { @(Get-CardActivateViolation (& $codeOf $_.FullName)).Count -gt 0 })
    if ($activate.Count -gt 0) { return '产品脚本还在传 -Activate（SW_RESTORE 会抢前台）：' + (($activate | ForEach-Object { $_.Name }) -join ', ') }
    $true
}

Check '描边：不再用灰色 colorBorderSecondary，改橙色来源（B-26）' {
    if ($script:AppText -match 'colorBorderSecondary') { return 'App.tsx 还在用 colorBorderSecondary' }
    if ($script:AppText -notmatch 'border:\s*`1px solid \$\{token\.colorWarning\}') { return '描边没有用橙色 token' }
    if ($script:AppText -notmatch 'B-26') { return '没注明 B-26 出处' }
    $true
}

# ---- 尺寸 -----------------------------------------------------------------------

Check 'Get-CardMaxHeight：屏高 62%，夹在 160–760' {
    if ((Get-CardMaxHeight -WorkAreaHeight 1000 -Scale 1) -ne 620) { return "1000 屏算出 $(Get-CardMaxHeight -WorkAreaHeight 1000 -Scale 1)" }
    if ((Get-CardMaxHeight -WorkAreaHeight 200 -Scale 1) -ne 160) { return '小屏没有落到 160 下限' }
    if ((Get-CardMaxHeight -WorkAreaHeight 2160 -Scale 1) -ne 760) { return '大屏没有落到 760 上限' }
    if ((Get-CardMaxHeight -WorkAreaHeight 1080 -Scale 2) -ne 334) { return "高 DPI 没有按逻辑像素算：" }
    $true
}

Check 'Get-CardMaxHeight：显式值同样受 160–760 约束' {
    if ((Get-CardMaxHeight -Requested 600) -ne 600) { return '合法值被改' }
    if ((Get-CardMaxHeight -Requested 120) -ne 160) { return '低于下限没抬到 160' }
    if ((Get-CardMaxHeight -Requested 900) -ne 760) { return '高于上限没压到 760' }
    $true
}

# ---- 真实载荷样例 ---------------------------------------------------------------

$script:FixtureOut = @()
Check '开发态：?fixture=approval|select 能离线看两种卡（表单/确认卡已随 B-47 删除）' {
    $payloadSource = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'shared\ui-card\app\src\payload.ts')
    if ($payloadSource -notmatch '\?fixture=approval\|select') { return '开发态提示里没有 ?fixture=approval|select' }
    foreach ($name in @('approval', 'select')) {
        $fixture = Join-Path $script:RepoRoot "shared\ui-card\app\src\fixtures\$name.ts"
        if (-not (Test-Path -LiteralPath $fixture)) { return "缺 $name 的样例文件" }
        if ($payloadSource -notmatch "${name}Fixture") { return "样例表里没有 $name" }
    }
    foreach ($gone in @('confirm', 'form')) {
        $fixture = Join-Path $script:RepoRoot "shared\ui-card\app\src\fixtures\$gone.ts"
        if (Test-Path -LiteralPath $fixture) { return "样例文件 $gone.ts 还在（对应卡片已删除）" }
    }
    $true
}

Check '样例载荷：两个 JSON 都能生成完整文档，且载荷字段没丢' {
    foreach ($name in @('approval', 'select')) {
        $json = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot "tests\fixtures\$name.json")
        $parsed = $json | ConvertFrom-Json
        if ($null -eq $parsed) { return "$name 的 JSON 解析失败" }
        if ($parsed.PSObject.Properties['form']) { return "$name 的载荷里还有 form（表单卡已删除）" }
        if ($parsed.PSObject.Properties['title']) { return "$name 的载荷里还有 title 死字段（B-16）" }
    }
    $true
}

Check '契约（B-47）：外壳不再提供表单卡能力——没有 -FormFields / CardField / Fields 回传' {
    $cardHtml = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'shared\ui-card\card-html.ps1')
    foreach ($name in @('FormFields', 'ConvertTo-CardField', 'CardField')) {
        if ($cardHtml -match [regex]::Escape($name)) { return "card-html.ps1 里还有 $name" }
    }
    $window = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'shared\ui-card\webview2.ps1')
    if ($window -match '(?m)^\s*Fields\s*=') { return 'webview2.ps1 还在返回对象里写 Fields' }
    $types = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'shared\ui-card\app\src\types.ts')
    foreach ($name in @('CardForm', 'CardField')) {
        if ($types -match [regex]::Escape($name)) { return "types.ts 里还有 $name" }
    }
    if ($types -match 'form\?\:') { return 'types.ts 的 CardPayload 还有 form 字段' }
    $true
}

Check '样例载荷：勾选卡每行自带命令与原因（命令不能浮到正文，否则看不出属于哪台机器）' {
    $data = Get-Content -Raw -LiteralPath (Join-Path $script:RepoRoot 'tests\fixtures\select.json') | ConvertFrom-Json
    $payload = New-CardDemoPayload -Data $data
    $bodyProp = $payload.PSObject.Properties['body']
    if ($null -ne $bodyProp -and @($bodyProp.Value | Where-Object { $_.kind -eq 'code' }).Count -ne 0) {
        return '正文里还有代码块，命令被拆出去了'
    }
    foreach ($row in $payload.rows) {
        if ([string]::IsNullOrWhiteSpace([string]$row.text)) { return "行 $($row.label) 没有命令" }
        if ([string]::IsNullOrWhiteSpace([string]$row.why)) { return "行 $($row.label) 没有原因" }
    }
    $true
}

# ---- 探针与自测入口（T-07 / B-42）------------------------------------------------
#
# 行几何（可见几行 / 总行数 / 露多少）只有**一份实现**了：`app/src/measure.ts` 已随「删行数计数」
# 整份删除，剩下的就是 `debug/probe.js`。它曾经同时错三处——getClientRects 是文档序没排序、
# 用 padding box 裁却按 content box 判、半行被当成整行——所以这三条判据要逐条钉住，
# 少一条就会退回「探针说 11 行、实际 9 行」那类假数字。

Check '探针（T-07）：行几何三个判据一个都不许少' {
    $probeText = Get-CardShellText 'debug\probe.js'
    if ($probeText -notmatch [regex]::Escape('.sort((a, b) => a.top - b.top)')) {
        return 'probe.js 没有按 top 排序（getClientRects 返回文档序，不排序行数会算错）'
    }
    if ($probeText -notmatch 'scrollHeight - clientHeight > 1') {
        return 'probe.js 没有「真的被裁了」的判据（scrollHeight - clientHeight > 1）'
    }
    if ($probeText -notmatch 'line\.bottom <= contentBottom \+ 0\.5') {
        return 'probe.js 没有「整行落在内容盒内」的容差判据（半行会被算成整行）'
    }
    $true
}

Check '自测入口（B-42）：tools/preview-card.ps1 起真窗口、不截图、关窗后核对剪贴板' {
    # CardDir = <repo>\shared\ui-card，所以仓库根要往上两级再拼 tools\。
    $repoRoot = Split-Path -Parent (Split-Path -Parent $script:CardDir)
    $entry = Join-Path $repoRoot 'tools\preview-card.ps1'
    if (-not (Test-Path -LiteralPath $entry)) { return "缺 $entry" }
    $text = Get-Content -Raw -LiteralPath $entry -Encoding utf8
    # 不许截图 / 不许注入探针：验收靠人点，截图看不出交互（B-42 的出处就是用户这句话）。
    # 只禁「真会产图或真会注入」的东西；注释里提到 render.ps1 当范例不算。
    foreach ($bad in @('CopyFromScreen', 'BitBlt', '-OutFile', '.png', '-Probe')) {
        if ($text -match [regex]::Escape($bad)) { return "自测入口里有截图/探针注入的痕迹：$bad" }
    }
    if ($text -notmatch 'Show-CardWindow') { return '没用正式外壳起窗（Show-CardWindow）' }
    if ($text -notmatch 'Get-Clipboard') { return '关窗后没有核对剪贴板（复制到底成没成就没法判）' }
    $true
}

# ---- 表单卡：载荷 / 渲染 / 提交 / 协议（DECISIONS D-36；单字段输入区已随 R-12 删除）----
""
if ($script:FixtureOut.Count -gt 0) {
    '样例文档（供提权出图）：'
    foreach ($item in $script:FixtureOut) {
        '  {0}  {1} bytes' -f $item.Name, $item.Bytes
    }
    ''
}
if ($script:Failures -gt 0) {
    "通过 $($script:Total - $script:Failures) / 失败 $($script:Failures)（共 $($script:Total) 项）"
    exit 1
}
"通过 $($script:Total) / 失败 0（共 $($script:Total) 项）"
exit 0
