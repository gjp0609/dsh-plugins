# 业务适配层：SSH 载荷 ↔ 共享卡片外壳（scripts\ui\shared.ps1）
#
# 外壳只有一份，在仓库根 shared/ui-card：JSON 载荷的结构、页面渲染、窗口、消息协议都在那边。
# 这里只留两件事：
#   - New-Ssh*Payload        业务载荷 → 页面认识的载荷（New-CardPayload / New-CardRow / …）
#   - ConvertTo-SshDecision  页面消息 → 业务结果（勾了哪几行）
# 不做：拼 HTML（那是 React 产物）、起窗口（shared/ui-card/webview2.ps1）、读写临时文件（dialog.ps1）。
#
# 不再自包含：把 dsh-ssh-remote/ 单独拷出去会找不到外壳（弹窗写 stderr 并非零退出，不静默成功）。

Set-StrictMode -Version Latest

# $PSScriptRoot 的坑：函数被调用时它可能已经是调用方的目录，所以在文件执行时就算好。
$script:SshUiDir = $PSScriptRoot

# 方形（0）且只有一个来源：Show-CardWindow 的 -CornerRadius。
$script:SshCardCornerRadius = 0

# 卡片消息里代表「提交」的那个值（外壳只负责回传，语义在这里）。
$script:SshSubmitAction = 'submit'
$script:SshSkipAction = 'skip'

function Get-SshCardShellDir {
    <#
    .SYNOPSIS
        找仓库根的 shared/ui-card（从起始目录逐级上溯，最多 6 层）；找不到返回空串。
    .DESCRIPTION
        不用 junction、不用复制：相对路径在 worktree 里天然正确，「只有一份」是物理事实。
        不抛异常（调用方要能据此写一条明确错误并非零退出，而不是启动就炸）。
    #>
    [CmdletBinding()]
    param([string]$StartDir = '')

    $dir = if ([string]::IsNullOrWhiteSpace($StartDir)) { $script:SshUiDir } else { $StartDir }
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
$script:SshCardShellDir = Get-SshCardShellDir
if ($script:SshCardShellDir -ne '') {
    . (Join-Path $script:SshCardShellDir 'card-html.ps1')
    . (Join-Path $script:SshCardShellDir 'webview2.ps1')
}

function Assert-SshCardShell {
    <#
    .SYNOPSIS
        外壳没找到时给一条能直接照着修的错误（不要静默生成一张空卡）。
    #>
    [CmdletBinding()]
    param()

    if ($script:SshCardShellDir -ne '') { return }
    throw ('找不到共享卡片外壳 shared/ui-card（插件不再自带副本）。' +
        '请确认 dsh-ssh-remote 位于仓库内且 shared/ui-card 存在；发布成独立包时需要把 shared/ 与 vendor/ 一起打包。')
}

function Get-SshRowLabels {
    <#
    .SYNOPSIS
        每行显示什么标签：给了 Options 就用它，否则用行自己的 label。
    .DESCRIPTION
        顺序必须与 Rows 一一对应——回传的 checked 是布尔数组，下标就是这里的下标。
    #>
    [CmdletBinding()]
    param(
        [object[]]$Rows = @(),
        [string[]]$Options = @()
    )

    $labels = @()
    foreach ($option in $Options) {
        if (-not [string]::IsNullOrWhiteSpace($option)) { $labels += $option }
    }
    if ($labels.Count -eq 0) {
        foreach ($row in $Rows) { $labels += [string](Get-CardItemValue $row 'label' '') }
    }
    $labels
}

function Split-SshRowMeta {
    <#
    .SYNOPSIS
        行的附加信息拆成「代码框底部的 cwd/超时」与「主机那一行的警告」（B-15）。
    .DESCRIPTION
        上游把附加信息用 ` · ` 连成一条（例如 `目录 5 项 · ⚠ 覆盖`）。警告跟 cwd/超时不是一回事：
        警告留在主机那一行，框底只放每次执行都要核对的东西。这里只认「覆盖」，其余原样留在 meta。
        载荷里的 warn 只放词本身（「覆盖」），⚠ 由外壳统一画，不在两层各画一次。
    #>
    [CmdletBinding()]
    param([AllowNull()][string]$Meta = '')

    $metaParts = @()
    $warn = ''
    foreach ($part in ([string]$Meta -split '·')) {
        $item = $part.Trim()
        if ($item -eq '') { continue }
        if ($item.Contains('覆盖')) {
            $warn = $item.Replace('⚠', '').Trim()
            continue
        }
        $metaParts += $item
    }
    [pscustomobject]@{ Meta = ($metaParts -join ' · '); Warn = $warn }
}

function New-SshCardPayload {
    <#
    .SYNOPSIS
        SSH 业务载荷 → 共享外壳的载荷（不建窗口、不拼 HTML）。
    .DESCRIPTION
        ssh 的形状落在载荷字段上：
          - eyebrow：固定「SSH · 执行确认」（外壳不认识 SSH，这句是业务给的）；
          - titleHtml：给了 ProjectDir 就显示工作目录（命令是从哪个项目发起的）；
          - rows：每行一个勾选行（label = 目标主机，why = 原因，text = 命令原文，
            meta = cwd/超时，warn = 覆盖这类警告）；
          - buttons：跳过 = skip，提交 = submit（带计数模板、必须至少勾一行）。
        没有固定句标题（B-16）：抬头已经用「域 · 动作」说清，字段直接不出。
    .PARAMETER Rows
        `@{ label; why; text; meta; warn; lang }` 数组，顺序即展示顺序。
        `lang` 只决定 `text` 的高亮：搬运卡的行是说明文字（`text` = 不高亮），
        `ssh_run` 的行是真命令（不给 lang 键 = 按 `sh` 高亮）。
    .PARAMETER Options
        可选的显示标签；缺省用 `Rows[i].label`。
    .PARAMETER Detail
        Rows 为空时的兜底正文（整段文本按一个代码块展示）。
    .PARAMETER CloseMs
        页面倒计时到点自己关（0 = 不自动关）。**当前无人传**：SSH 的勾选卡一律永不自动关闭。
        保留它是通用能力在适配层的入口（D-39），不是死参数——审批卡走 `scripts/ui/card.ps1`
        自己的 `-CloseMs`（10 分钟无人处理自动关），与这里无关，别当没人用就删掉。
    #>
    [CmdletBinding()]
    param(
        [object[]]$Rows = @(),
        [string[]]$Options = @(),
        [AllowEmptyString()][string]$Detail = '',
        [string]$Eyebrow = 'SSH · 执行确认',
        [string]$ProjectDir = '',
        [string]$CancelLabel = '跳过',
        [string]$ConfirmLabel = '提交',
        [string]$ConfirmCountLabel = '提交 {n} 项',
        [int]$ArmMs = 1000,
        [int]$CloseMs = 0
    )

    Assert-SshCardShell

    $rows = @($Rows)
    $labels = @(Get-SshRowLabels -Rows $rows -Options $Options)

    $body = @()
    $cardRows = @()
    for ($index = 0; $index -lt $rows.Count; $index++) {
        $row = $rows[$index]
        $label = if ($index -lt $labels.Count) { [string]$labels[$index] } else { '' }
        $why = [string](Get-CardItemValue $row 'why' '')
        $meta = [string](Get-CardItemValue $row 'meta' '')
        $warn = [string](Get-CardItemValue $row 'warn' '')
        $text = [string](Get-CardItemValue $row 'text' '')
        # 高亮语言照抄上游：不给就是空串，New-CardRow 不写这个键（页面按 `sh` 处理）。
        $lang = [string](Get-CardItemValue $row 'lang' '')
        # 行没有命令时给个占位而不是空行（否则那一行只剩标签和勾选框，看不出会执行什么）。
        if ([string]::IsNullOrWhiteSpace($text)) { $text = '(' + $label + ')' }

        # 原因、命令、元信息都留在**同一行**里：它们是一个整体，拆到正文会被读成
        # 「三条命令 + 三个勾选框」，看不出哪条命令属于哪台机器。
        # 警告从 meta 里拆出来单独给外壳：它渲染在主机那一行，而不是框底。
        $split = Split-SshRowMeta -Meta $meta
        if (-not [string]::IsNullOrWhiteSpace($warn)) { $split.Warn = $warn }
        $cardRows += New-CardRow -Label $label -Why $why -Text $text -Meta $split.Meta -Warn $split.Warn -Lang $lang
    }
    if ($rows.Count -eq 0 -and -not [string]::IsNullOrWhiteSpace($Detail)) {
        $body += New-CardCodeBlock -Command $Detail -Lang 'sh'
    }

    # 防误点只在载荷级给一次（armMs）：按钮级 armDelayMs 已删（BACKLOG #21，从未生效）。
    $buttons = @(
        New-CardButton -Label $CancelLabel -Action $script:SshSkipAction -Kind 'default'
        New-CardButton -Label $ConfirmLabel -Action $script:SshSubmitAction -Kind 'primary' `
            -RequiresChecked -LabelCount $ConfirmCountLabel
    )

    New-CardPayload -Eyebrow $Eyebrow -TitleHtml (New-CardTitlePath -Text $ProjectDir) `
        -Body $body -Rows $cardRows -Buttons $buttons -ArmMs $ArmMs -CloseMs $CloseMs
}

function Test-SshCardField {
    <#
    .SYNOPSIS
        对象里到底有没有这个字段（哈希表 / 有序字典 / ConvertFrom-Json 出来的对象都认）。
    .DESCRIPTION
        协议里 `checked` 只在有勾选行时出现。读不到和「读到空数组」是两件事，
        所以不能用带默认值的取值函数——那会把「没有这个键」猜成「一行都没勾」。
    #>
    [CmdletBinding()]
    param(
        [AllowNull()]$Item,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Item) { return $false }
    if ($Item -is [System.Collections.IDictionary]) { return $Item.Contains($Name) }
    return ($null -ne $Item.PSObject.Properties[$Name])
}

function ConvertTo-SshDecision {
    <#
    .SYNOPSIS
        窗口结果 → 调用方要的答案（纯函数，方便单测；不碰窗口）。
    .DESCRIPTION
        协议（外壳定的，业务只解释）：
          { type:'decision', value:'submit'|'skip', checked:[bool…] }
          { type:'cancel' } / { type:'expired' } / 关窗 / 到点
        规则与旧卡一致：只有 submit 且至少勾了一行才算「答了」；其余一律按一行都不选。
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$Action = '',
        [AllowNull()][string]$Message = '',
        [string[]]$Labels = @()
    )

    $outcome = [pscustomobject]@{
        answered = $false
        selected = @()
        action   = $Action
    }

    # 没有消息（关窗 / 到点 / 起不来）：一行都不选。
    if ($Action -ne 'message' -or [string]::IsNullOrWhiteSpace($Message)) {
        if ($Action -eq 'timeout') { $outcome.action = 'expired' }
        return $outcome
    }

    $parsed = $null
    try { $parsed = $Message | ConvertFrom-Json } catch { return $outcome }
    if ($null -eq $parsed) { return $outcome }

    $type = [string](Get-CardItemValue $parsed 'type' '')
    switch ($type) {
        'decision' {
            $value = [string](Get-CardItemValue $parsed 'value' '')
            $outcome.action = $value
            if ($value -ne $script:SshSubmitAction) { return $outcome }
            # 没有勾选行时协议不给 checked：别猜，按没勾处理。
            if (-not (Test-SshCardField -Item $parsed -Name 'checked')) { return $outcome }

            $checked = @(Get-CardItemValue $parsed 'checked' @())
            $selected = @()
            for ($index = 0; $index -lt $checked.Count -and $index -lt $Labels.Count; $index++) {
                if ($checked[$index] -eq $true) { $selected += [string]$Labels[$index] }
            }
            $outcome.selected = $selected
            $outcome.answered = ($selected.Count -gt 0)
        }
        'cancel' { $outcome.action = 'cancel' }
        'expired' { $outcome.action = 'expired' }
        default { $outcome.action = 'unknown' }
    }
    $outcome
}
