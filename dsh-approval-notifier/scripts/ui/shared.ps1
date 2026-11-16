# 业务适配层：审批载荷 ↔ 共享卡片外壳（scripts\ui\shared.ps1）
#
# 外壳只有一份，在仓库根 shared/ui-card：JSON 载荷的结构、页面渲染、窗口、消息协议都在那边。
# 这里只留两件事：
#   - New-ApprovalCardPayload    审批载荷 → 页面认识的载荷（New-CardPayload / New-CardCodeBlock / …）
#   - ConvertTo-ApprovalDecision 页面消息 → 业务结果（allowed-once / rejected / closed / expired）
# 不做：拼 HTML（那是 React 产物）、起窗口（shared/ui-card/webview2.ps1）、
# 读写 payload/结果文件（prompt.ps1）。
#
# 不再自包含：把 dsh-approval-notifier/ 单独拷出去会找不到外壳（于是卡片起不来、退出码 1，
# 宿主退回浏览器审批，不崩）。发布成独立包时需要把仓库根的 shared/ 与 vendor/ 一起打包。

Set-StrictMode -Version Latest

# $PSScriptRoot 的坑：函数被调用时它可能已经是调用方的目录，所以在文件执行时就算好。
$script:ApprovalUiDir = $PSScriptRoot

# 卡片宽度（CSS 逻辑像素）：窗口宽度只有一个来源（这里）。
$script:ApprovalCardWidth = 680

# 方形（0）且只有一个来源：Show-CardWindow 的 -CornerRadius。
$script:ApprovalCardCornerRadius = 0

function Get-ApprovalCardShellDir {
    <#
    .SYNOPSIS
        找仓库根的 shared/ui-card（从起始目录逐级上溯，最多 6 层）；找不到返回空串。
    .DESCRIPTION
        不用 junction、不用复制：相对路径在 worktree 里天然正确，「只有一份」是物理事实。
        不抛异常（调用方要能据此写一条明确日志、按「没做决定」收尾，而不是启动就炸）。
    #>
    [CmdletBinding()]
    param([string]$StartDir = '')

    $dir = if ([string]::IsNullOrWhiteSpace($StartDir)) { $script:ApprovalUiDir } else { $StartDir }
    for ($i = 0; $i -lt 6 -and -not [string]::IsNullOrWhiteSpace($dir); $i++) {
        $candidate = Join-Path $dir 'shared\ui-card'
        if ((Test-Path -LiteralPath (Join-Path $candidate 'card-html.ps1')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'webview2.ps1'))) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    ''
}

# 外壳的拼装层与窗口层一起 dot-source：前者是纯函数（能单测），后者要提权才真弹窗，
# dot-source 本身不建窗口。找不到就什么都不加载，两个业务函数各自抛明确错误。
$script:ApprovalCardShellDir = Get-ApprovalCardShellDir
if ($script:ApprovalCardShellDir -ne '') {
    . (Join-Path $script:ApprovalCardShellDir 'card-html.ps1')
    . (Join-Path $script:ApprovalCardShellDir 'webview2.ps1')
}

function Assert-ApprovalCardShell {
    <#
    .SYNOPSIS
        外壳没找到时给一条能直接照着修的错误（不要静默生成「一张空卡」）。
    #>
    [CmdletBinding()]
    param()

    if ($script:ApprovalCardShellDir -ne '') { return }
    throw ('找不到共享卡片外壳 shared/ui-card（插件不再自带副本）。' +
        '请确认 dsh-approval-notifier 位于仓库内且 shared/ui-card 存在；' +
        '发布成独立包时需要把 shared/ 与 vendor/ 一起打包。')
}

function Get-ApprovalToolName {
    <#
    .SYNOPSIS
        从窗口标题里取工具名（宿主拼的是「DSH 审批请求 · Write」这种）。
    #>
    [CmdletBinding()]
    param([AllowNull()][string]$WindowTitle)

    if ([string]::IsNullOrWhiteSpace($WindowTitle)) { return '' }
    if ($WindowTitle -match '·') { return ([string]$WindowTitle -split '·')[-1].Trim() }
    return ''
}

function ConvertTo-ApprovalCommentText {
    <#
    .SYNOPSIS
        模型给的理由 → 能放进代码框第一行注释的单行文本。
    .DESCRIPTION
        注释只有**一行**（外壳渲染成 `# {comment}`），所以内部换行折成一个空格：
        框里除这一行以外全是命令，多出来的、没有 `#` 前缀的行会被读成「还要执行的命令」，
        在审批卡上属于会误导判断的显示错误。措辞一个字不改、也不截断（长度不受限）。
        不加 `# ` 前缀：前缀由外壳加（这里再加就会渲染成 `# # …`）。
    #>
    [CmdletBinding()]
    param([AllowNull()][string]$Reason)

    if ([string]::IsNullOrWhiteSpace($Reason)) { return '' }
    $text = $Reason.Replace("`r`n", "`n").Replace("`r", "`n")
    $lines = @($text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    ($lines -join ' ')
}

function New-ApprovalCardPayload {
    <#
    .SYNOPSIS
        审批载荷 → 共享外壳的载荷（不建窗口、不拼 HTML）。
    .DESCRIPTION
        审批的形状落在载荷字段上：
          - eyebrow：「工具名 · 提权审批」（工具名从窗口标题里取，宿主拼在「·」后面）；
          - titleHtml：给了工作目录就把它显示在标题行（判断「这条命令在哪儿跑」的唯一依据）；
          - body：只有命令原文代码块（没有 caption，B-14 不写「判断以此为准」这种模板句）；
            模型给的理由进这块的 `comment`，渲染成框内第一行 `# …`，框外不再重复一块正文（B-33）；
          - buttons：拒绝 = rejected、允许一次 = allowed-once（主按钮），都等 armMs；
          - keyboard none：审批卡只认鼠标。
        没有固定句标题（B-16）：抬头已经说清「谁 · 做什么」。
    .PARAMETER Data
        有序字典：windowTitle / meta / reason / command / armDelayMs / closeAfterMs。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Data,
        [int]$Width = 0
    )

    Assert-ApprovalCardShell

    if ($Width -le 0) { $Width = $script:ApprovalCardWidth }

    $windowTitle = [string](Get-CardItemValue $Data 'windowTitle' '')
    $meta = [string](Get-CardItemValue $Data 'meta' '')
    $reason = [string](Get-CardItemValue $Data 'reason' '')
    $command = [string](Get-CardItemValue $Data 'command' '（未取到参数）')
    $armDelayMs = [int](Get-CardItemValue $Data 'armDelayMs' 1000)
    $closeAfterMs = [int](Get-CardItemValue $Data 'closeAfterMs' 600000)

    $tool = Get-ApprovalToolName -WindowTitle $windowTitle
    $eyebrow = if ($tool -eq '') { '提权审批' } else { $tool + ' · 提权审批' }

    # 标题行放工作目录（判断「这条命令在哪儿跑」的主要依据）；没有路径就不出这一行。
    $titleHtml = New-CardTitlePath -Text $meta

    # 说明句进命令框（B-33）：模型给的理由就是「这条命令为什么跑」，和设备 ssh 卡同一个形态——
    # 框内第一行 `# 原因`，框外不再单独摆一块正文（同一句说明只许出现一处）。
    # 外壳的 New-CardCodeBlock 认 -Comment（写进块的 comment 字段），这里直接传，载荷不再二次加工。
    $comment = ConvertTo-ApprovalCommentText -Reason $reason
    if ([string]::IsNullOrWhiteSpace($command)) {
        # 没有命令就没有框可挂注释：说明退回正文块，别让它凭空消失（也不硬塞 comment）。
        $body = @(New-CardNoteBlock -Text $comment)
    } else {
        # 说明为空就不传 -Comment：块里不该出现 comment 键（空字符串会被渲染成一行空的 `#`）。
        $codeBlockArgs = @{ Command = $command; Lang = 'sh' }
        if (-not [string]::IsNullOrWhiteSpace($comment)) { $codeBlockArgs.Comment = $comment }
        $body = @(New-CardCodeBlock @codeBlockArgs)
    }

    # 两个按钮的先后与网页端一致：拒绝在左、允许在右；都不给 armDelayMs，统一用全局 armMs。
    $buttons = @(
        New-CardButton -Label '拒绝' -Action 'rejected' -Kind 'default'
        New-CardButton -Label '允许一次' -Action 'allowed-once' -Kind 'primary'
    )

    # keyboard none：审批卡只认鼠标。回车误批一次提权，比少一个快捷键严重得多。
    New-CardPayload -Eyebrow $eyebrow -TitleHtml $titleHtml -Body $body `
        -Buttons $buttons -ArmMs $armDelayMs -CloseMs $closeAfterMs -Keyboard 'none'
}

function ConvertTo-ApprovalDecision {
    <#
    .SYNOPSIS
        页面回传的消息 → 宿主认识的结果类型。纯函数，方便单测。
    .DESCRIPTION
        对外契约保持不变（prompt.ps1 按它写结果文件 / 定退出码）：
          message + decision(allowed-once|rejected) → 同名结果
          message + cancel / 关窗 / 任何认不出来的消息 → closed（= 不做决定）
          timeout / message + expired            → expired（到点，也不做决定）
        认不出来的一律按「没决定」处理——宁可不执行，也绝不因为解析不出来就放行。
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$Action = 'closed',
        [AllowNull()][string]$Message = ''
    )

    if ($Action -eq 'shot') { return 'shot' }
    if ($Action -eq 'timeout') { return 'expired' }
    if ($Action -ne 'message') { return 'closed' }
    if ([string]::IsNullOrWhiteSpace($Message)) { return 'closed' }

    $parsed = $null
    try { $parsed = $Message | ConvertFrom-Json } catch { return 'closed' }
    if ($null -eq $parsed) { return 'closed' }

    $type = [string](Get-CardItemValue $parsed 'type' '')
    switch ($type) {
        'decision' {
            $value = [string](Get-CardItemValue $parsed 'value' '')
            if ($value -eq 'allowed-once') { return 'allowed-once' }
            if ($value -eq 'rejected') { return 'rejected' }
            return 'closed'
        }
        'cancel' { return 'closed' }
        'expired' { return 'expired' }
        default { return 'closed' }
    }
}
