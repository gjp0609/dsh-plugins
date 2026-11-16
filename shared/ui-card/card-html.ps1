# 布局层：把「这次要给人看什么」变成载荷与文档（shared/ui-card/card-html.ps1）
#   - New-CardPayload / New-Card*Block：业务数据 → 页面认识的 JSON 载荷（字段见 app/src/types.ts）；
#   - New-CardDocument：读构建产物 dist/index.html，只换 <script id="dsh-payload"> 的内容。
# 不拼 HTML 结构（DOM/样式/行为全在 React 产物里），不创建窗口（那是 webview2.ps1 的事）。

Set-StrictMode -Version Latest
# $PSScriptRoot 在函数被调用时可能已经是调用方的目录（dot-source 之后不可靠），
# 所以外壳目录在这里就算好，函数里只用这个常量。
$script:CardShellDir = $PSScriptRoot

function Get-SharedCardDir {
    <#
    .SYNOPSIS
        从某个起点向上找仓库根的 shared/ui-card，返回绝对路径；找不到返回空串。
    .DESCRIPTION
        插件在自己的 $PSScriptRoot 上调用它（最多上溯 6 层）定位共享外壳：不用 junction
        （worktree 里会指回主 checkout），也不复制（两份必然漂移）。调用方仍要检查产物是否已构建。
    #>
    [CmdletBinding()]
    param(
        [string]$StartDir = '',
        [int]$MaxDepth = 6
    )

    $dir = if ([string]::IsNullOrWhiteSpace($StartDir)) { $script:CardShellDir } else { $StartDir }
    if (-not (Test-Path -LiteralPath $dir)) { return '' }
    $dir = [System.IO.Path]::GetFullPath($dir)

    for ($i = 0; $i -le $MaxDepth; $i++) {
        # 外壳签名：拼装层 + 窗口层一起在，才说明这里是 shared/ui-card。
        foreach ($candidate in @($dir, (Join-Path $dir 'shared\ui-card'))) {
            if ((Test-Path -LiteralPath (Join-Path $candidate 'card-html.ps1')) -and
                (Test-Path -LiteralPath (Join-Path $candidate 'webview2.ps1'))) {
                return $candidate
            }
        }

        $parent = Split-Path -Parent $dir
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $dir) { break }
        $dir = $parent
    }
    ''
}

function ConvertTo-CardHtmlText {
    <#
    .SYNOPSIS
        转义成可以安全放进 HTML 文本节点的字符串（只给 titleHtml 用，其余字段由 React 转义）。
    #>
    [CmdletBinding()]
    param([AllowNull()][string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $Text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&#39;')
}

function New-CardTitlePath {
    <#
    .SYNOPSIS
        标题第二行的那段路径/主机标签（唯一允许带 HTML 的载荷字段）。
    #>
    [CmdletBinding()]
    param([AllowNull()][string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    '<span class="card__title-path">' + (ConvertTo-CardHtmlText $Text) + '</span>'
}

function Get-CardItemValue {
    <#
    .SYNOPSIS
        从「字段表」里安全取一个值（哈希表、有序字典、PSCustomObject 都认）。
    .DESCRIPTION
        调用方可能传 @{...}、[ordered]@{...} 或 ConvertFrom-Json 出来的对象；缺字段拿默认值，读不到不抛。
    #>
    [CmdletBinding()]
    param(
        [AllowNull()]$Item,
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()]$Default = ''
    )

    if ($null -eq $Item) { return $Default }
    $value = $null
    if ($Item -is [System.Collections.IDictionary]) {
        if ($Item.Contains($Name)) { $value = $Item[$Name] }
    } else {
        $property = $Item.PSObject.Properties[$Name]
        if ($null -ne $property) { $value = $property.Value }
    }
    if ($null -eq $value) { return $Default }
    $value
}

function New-CardNoteBlock {
    <#
    .SYNOPSIS
        一段正文（理由、说明）：保留换行、超长折行；没内容时给一句占位而不是留白。
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][string]$Text,
        [switch]$Muted
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return [ordered]@{ kind = 'note'; text = '（尚未提供正文）'; muted = $true }
    }
    $block = [ordered]@{ kind = 'note'; text = ([string]$Text).Replace("`r`n", "`n").Replace("`r", "`n") }
    if ($Muted) { $block.muted = $true }
    $block
}

function New-CardCodeBlock {
    <#
    .SYNOPSIS
        一个只读代码块：等宽原文 + 可选的一行说明。lang 只留给高亮（见 app/src/highlight.ts）。
    .DESCRIPTION
        没有说明句：B-14 不要「我肯定知道」的模板文案（「命令原文 · 判断以此为准」已删）。
    .PARAMETER Comment
        这条命令的说明：外壳把它渲染成**框内第一行** `# 说明`（B-31），复制时排除（B-32）。
        所以它必须是独立字段，不许拼进 -Command——拼进去就等于改了命令原文（C-08）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Command,
        [string]$Lang = 'sh',
        [AllowNull()][string]$Comment = ''
    )

    $block = [ordered]@{ kind = 'code'; command = $Command }
    if (-not [string]::IsNullOrWhiteSpace($Lang)) { $block.lang = $Lang }
    if (-not [string]::IsNullOrWhiteSpace($Comment)) { $block.comment = $Comment }
    $block
}

function New-CardRow {
    <#
    .SYNOPSIS
        一行可选行（checkbox）：标签 + 可选说明 / 等宽原文 / 元信息 / 警告。
    .DESCRIPTION
        外壳会把 why 排成代码框第一行注释、text 排成主体、meta 排成框底一条；
        warn（「覆盖」这类）单独渲染在主机那一行右侧，不混进 cwd/超时。
        lang 只决定 text 的高亮：缺省（不写这个键）按 `sh` 高亮，因为行的主体通常是命令；
        搬运卡那类「说明文字」给 `text`，表示不渲染高亮、逐字纯文本。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Label,
        [AllowNull()][string]$Why = '',
        [AllowNull()][string]$Text = '',
        [AllowNull()][string]$Meta = '',
        [AllowNull()][string]$Warn = '',
        [AllowNull()][string]$Lang = ''
    )

    $row = [ordered]@{ label = $Label }
    if (-not [string]::IsNullOrWhiteSpace($Why)) { $row.why = $Why }
    if (-not [string]::IsNullOrWhiteSpace($Text)) { $row.text = $Text }
    if (-not [string]::IsNullOrWhiteSpace($Meta)) { $row.meta = $Meta }
    if (-not [string]::IsNullOrWhiteSpace($Warn)) { $row.warn = $Warn }
    # 空值不写键：页面靠「键在不在」决定按 sh 高亮（缺省）还是不渲染高亮（lang 有值）。
    if (-not [string]::IsNullOrWhiteSpace($Lang)) { $row.lang = $Lang }
    $row
}

function New-CardButton {
    <#
    .SYNOPSIS
        一个页脚按钮。Kind 只有 primary / default；其余取值一律按 default 处理。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$Action,
        [ValidateSet('primary', 'default', 'none', 'outline')][string]$Kind = 'default',
        [switch]$RequiresChecked,
        [AllowEmptyString()][string]$LabelCount = ''
    )

    $button = [ordered]@{
        label  = $Label
        action = $Action
        kind   = $(if ($Kind -eq 'primary') { 'primary' } else { 'default' })
    }
    if ($RequiresChecked) { $button.requiresChecked = $true }
    if (-not [string]::IsNullOrWhiteSpace($LabelCount)) { $button.labelCount = $LabelCount }
    $button
}

function ConvertTo-CardBlockList {
    <#
    .SYNOPSIS
        任意来源的正文块 → 页面认识的两种块（note / code），认不出来的直接丢掉。
    #>
    [CmdletBinding()]
    param([AllowNull()][object[]]$Body = @())

    $blocks = @()
    foreach ($item in @($Body)) {
        if ($null -eq $item) { continue }
        $kind = [string](Get-CardItemValue $item 'kind' '')
        switch ($kind) {
            'note' {
                $block = New-CardNoteBlock -Text ([string](Get-CardItemValue $item 'text' '')) `
                    -Muted:([bool](Get-CardItemValue $item 'muted' $false))
                # 显式给了空文本时也保留占位（与直接调 New-CardNoteBlock 一致）。
                $blocks += $block
            }
            'code' {
                $blocks += New-CardCodeBlock -Command ([string](Get-CardItemValue $item 'command' '')) `
                    -Lang ([string](Get-CardItemValue $item 'lang' 'sh')) `
                    -Comment ([string](Get-CardItemValue $item 'comment' ''))
            }
            default { }
        }
    }
    $blocks
}

function ConvertTo-CardRowList {
    <#
    .SYNOPSIS
        任意来源的可选行 → 页面认识的 rows（必须有 label，其余可选）。
    #>
    [CmdletBinding()]
    param([AllowNull()][object[]]$Rows = @())

    $out = @()
    foreach ($row in @($Rows)) {
        if ($null -eq $row) { continue }
        $label = [string](Get-CardItemValue $row 'label' '')
        if ([string]::IsNullOrWhiteSpace($label)) { continue }
        $out += New-CardRow -Label $label `
            -Why ([string](Get-CardItemValue $row 'why' '')) `
            -Text ([string](Get-CardItemValue $row 'text' '')) `
            -Warn ([string](Get-CardItemValue $row 'warn' '')) `
            -Meta ([string](Get-CardItemValue $row 'meta' '')) `
            -Lang ([string](Get-CardItemValue $row 'lang' ''))
    }
    $out
}

function ConvertTo-CardButtonList {
    <#
    .SYNOPSIS
        任意来源的按钮 → 页面认识的 buttons；保证「主按钮唯一」。
    #>
    [CmdletBinding()]
    param([AllowNull()][object[]]$Buttons = @())

    $out = @()
    $index = 0
    foreach ($button in @($Buttons)) {
        if ($null -eq $button) { continue }
        $action = [string](Get-CardItemValue $button 'action' '')
        if ([string]::IsNullOrWhiteSpace($action)) { $action = 'action-' + ($index + 1) }
        $kind = [string](Get-CardItemValue $button 'kind' 'default')
        if ($kind -notin @('primary', 'default')) { $kind = 'default' }
        $out += New-CardButton -Label ([string](Get-CardItemValue $button 'label' '')) -Action $action `
            -Kind $kind `
            -RequiresChecked:([bool](Get-CardItemValue $button 'requiresChecked' $false)) `
            -LabelCount ([string](Get-CardItemValue $button 'labelCount' ''))
        $index++
    }

    $primaries = @($out | Where-Object { $_.kind -eq 'primary' })
    if ($primaries.Count -gt 1) { throw "一张卡只能有一个主按钮，实际 $($primaries.Count) 个" }
    $out
}

function New-CardPayload {
    <#
    .SYNOPSIS
        把一张卡的输入整理成页面认识的标准载荷（有序字典，键名与 app/src/types.ts 一致）。
    .DESCRIPTION
        空字符串与空数组不写进载荷：页面靠「字段在不在」区分「没有这个区域」和「区域是空的」，
        例如没有可选行时协议里就不该出现 checked。
    .PARAMETER Body
        正文块数组（New-CardNoteBlock / New-CardCodeBlock 的产物）。
    .PARAMETER Rows
        可选行数组（New-CardRow 的产物）。
    .PARAMETER Buttons
        页脚按钮数组（New-CardButton 的产物）。
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$Eyebrow = '',
        [AllowEmptyString()][string]$TitleHtml = '',
        [AllowEmptyString()][string]$Status = '',
        [AllowNull()][object[]]$Body = @(),
        [AllowNull()][object[]]$Rows = @(),
        [AllowNull()][object[]]$Buttons = @(),
        [int]$ArmMs = 0,
        [int]$CloseMs = 0,
        [ValidateSet('default', 'none')][string]$Keyboard = 'default'
    )

    $payload = [ordered]@{}
    if (-not [string]::IsNullOrWhiteSpace($Eyebrow)) { $payload.eyebrow = $Eyebrow }
    if (-not [string]::IsNullOrWhiteSpace($TitleHtml)) { $payload.titleHtml = $TitleHtml }
    if (-not [string]::IsNullOrWhiteSpace($Status)) { $payload.status = $Status }

    $blocks = @(ConvertTo-CardBlockList -Body $Body)
    if ($blocks.Count -gt 0) { $payload.body = $blocks }

    $rowList = @(ConvertTo-CardRowList -Rows $Rows)
    if ($rowList.Count -gt 0) { $payload.rows = $rowList }

    $buttonList = @(ConvertTo-CardButtonList -Buttons $Buttons)
    if ($buttonList.Count -gt 0) { $payload.buttons = $buttonList }

    if ($ArmMs -gt 0) { $payload.armMs = $ArmMs }
    if ($CloseMs -gt 0) { $payload.closeMs = $CloseMs }
    if ($Keyboard -eq 'none') { $payload.keyboard = 'none' }
    $payload
}

function ConvertTo-CardPayloadJson {
    <#
    .SYNOPSIS
        载荷 → 可以安全放进 <script> 标签里的一行 JSON。
    .DESCRIPTION
        `<`/`>`/`&` 转成 JSON 的 \u 转义：命令原文里的 `</script>` 不会提前闭合标签，
        JSON 本身仍然合法（JSON.parse 得到同样的字符串）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Payload)

    $json = $Payload | ConvertTo-Json -Depth 8 -Compress
    if ([string]::IsNullOrEmpty($json)) { $json = '{}' }
    $json = $json.Replace('&', '\u0026').Replace('<', '\u003c').Replace('>', '\u003e')
    # U+2028 / U+2029 在 JS 里是换行符，JSON 里必须转义。
    $json = $json.Replace([string][char]0x2028, '\u2028').Replace([string][char]0x2029, '\u2029')
    $json
}

function Get-CardDocumentPath {
    <#
    .SYNOPSIS
        构建产物 dist/index.html 的路径；不存在就抛一条能照着做的错。
    #>
    [CmdletBinding()]
    param([string]$CardDir = '')

    if ([string]::IsNullOrWhiteSpace($CardDir)) { $CardDir = $script:CardShellDir }
    $path = Join-Path $CardDir 'dist\index.html'
    if (-not (Test-Path -LiteralPath $path)) {
        throw ("卡片产物缺失：$path（在 shared/ui-card/app 里执行 npm run build；产物要入库）")
    }
    (Resolve-Path -LiteralPath $path).Path
}

function New-CardDocument {
    <#
    .SYNOPSIS
        载荷 → 一张可直接交给 WebView2 的完整 HTML（React 产物 + 本次载荷）。
    .DESCRIPTION
        只做一处替换：`<script id="dsh-payload">` 标签**内部**。标签外的内容一个字节都不动
        ——占位符字符串在打包后的 JS 里也可能出现，整串 Replace 会连 JS 一起改坏，
        所以这里按标签定位，并要求恰好命中一个。
    .PARAMETER SourcePath
        产物路径；缺省用 dist/index.html。测试可传一份构造出来的假产物。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Payload,
        [string]$SourcePath = ''
    )

    if ([string]::IsNullOrWhiteSpace($SourcePath)) { $SourcePath = Get-CardDocumentPath }
    if (-not (Test-Path -LiteralPath $SourcePath)) { throw "卡片产物不存在：$SourcePath" }

    $html = Get-Content -Raw -LiteralPath $SourcePath -Encoding utf8
    if ([string]::IsNullOrWhiteSpace($html)) { throw "卡片产物是空文件：$SourcePath" }

    $json = ConvertTo-CardPayloadJson -Payload $Payload
    $pattern = '(?s)(<script id="dsh-payload"[^>]*>).*?(</script>)'
    $found = [regex]::Matches($html, $pattern)
    if ($found.Count -ne 1) {
        throw "卡片产物里的 payload 标签应恰好 1 个，实际 $($found.Count) 个：$SourcePath"
    }

    # MatchEvaluator：替换进去的 JSON 不会被再次扫描，也不会被当成 $1/$2 展开。
    [regex]::Replace($html, $pattern, {
            param($match)
            $match.Groups[1].Value + $json + $match.Groups[2].Value
        })
}
