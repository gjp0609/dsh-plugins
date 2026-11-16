#Requires -Version 7
# 审批流水报告：给「维护会话」用的只读统计工具（tools/approvals-report.ps1）
#
# 谁用：另开一个维护会话，读白名单插件 dsh-approval-allow 的审批流水，看「最近哪些命令老是要问、
# 名单还没覆盖」，据此提出 allow / deny 规则。读 <dataDir>\approvals.jsonl（默认
# %USERPROFILE%\.dsh\plugin-data\approval-allow\，设了 DSH_HOME 就在其下，与插件同源）；
# 一行一条 JSON：ts / tool / command / outcome / rule / reason。输出一份 Markdown 报告。
#
# 边界（重要）：**只读**——不写 allow.json、不改任何配置、不碰数据目录里别的文件。改名单必须由
# 人和会话自己决定（B-43：决定放行的配置只能在根工作区外，脚本更不能替人放行）。只统计 pwsh /
# bash 的审批流水，fs 写文件与 ssh_run 的审批不在这里。流水里是命令原文、可能带 token，别外传。
#
# 跑法：
#   pwsh -NoProfile -File tools\approvals-report.ps1
#   pwsh -NoProfile -File tools\approvals-report.ps1 -IncludeDeny -Top 30
#   pwsh -NoProfile -File tools\approvals-report.ps1 -Since (Get-Date).AddDays(-7) -OutFile .tmp\report.md

[CmdletBinding()]
param(
    [string]$Path = '',                          # 流水文件；不给就用 dataDir 默认路径
    [ValidateRange(1, 1000)][int]$Top = 20,      # 每个分节最多列几组
    [Nullable[datetime]]$Since = $null,          # 只算这之后的行（按绝对时刻比，流水 ts 是 UTC）
    [string]$OutFile = '',                       # 写了就落文件，stdout 只留一句「写到哪」
    [switch]$IncludeDeny,                        # deny 段命中（reason = deny-rule）也统计，单独一节
    [switch]$All                                 # 全部行（含 auto-allowed 与其它审批原因）
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 「像路径/file」的 token 只由这些字符组成；泛化成哪个字符类见 DECISIONS D-11
$script:PathChars = '._/\:-'

# 危险模式：命中就往风险列写中文标记（数组顺序即输出顺序）
$script:DangerRules = @(
    @{ Label = 'rm -rf / rm -r（递归删除）'; Pattern = '(?i)\brm\s+[^|;&\r\n]*(?:-[a-z]*(?:rf|fr)[a-z]*|--recursive)' }
    @{ Label = 'Remove-Item -Recurse（递归删除）'; Pattern = '(?i)\bRemove-Item\b[^|;&\r\n]*-Recurse' }
    @{ Label = 'sudo（提权执行）'; Pattern = '(?i)(?:^|[\s|;&(])sudo\b' }
    @{ Label = '--force / push -f（强推）'; Pattern = '(?i)(?:--force\b|\bgit\s+push\b[^|;&\r\n]*\s-[a-zA-Z]*f\b)' }
    @{ Label = 'git reset --hard（丢工作区改动）'; Pattern = '(?i)\bgit\s+reset\b[^|;&\r\n]*--hard' }
    @{ Label = 'curl ... | sh（拉下来直接执行）'; Pattern = '(?i)\b(?:curl|wget|Invoke-WebRequest|iwr|irm)\b[^|;&\r\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b' }
    @{ Label = '> /dev/sd（直接写块设备）'; Pattern = '>\s*/dev/sd[a-z]' }
    @{ Label = 'rmdir /s（递归删目录）'; Pattern = '(?i)\b(?:rmdir|rd)\s+/s\b' }
    @{ Label = 'format（格式化盘）'; Pattern = '(?i)\bformat\s+[a-z]:' }
    @{ Label = 'DROP TABLE / drop database（删表删库）'; Pattern = '(?i)\bdrop\s+(?:table|database)\b' }
    @{ Label = 'truncate（清空表/文件）'; Pattern = '(?i)\btruncate\b' }
    @{ Label = 'shutdown（关机/重启）'; Pattern = '(?i)\b(?:shutdown|Stop-Computer)\b' }
)

# 行内代码，表格单元也用它：竖线转义（代码段里的竖线照样拆单元格）、去掉换行、反引号自动加长围栏
function Format-MdCode {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Text)
    $one = ($Text -replace '[\r\n]+', ' ').Trim().Replace('|', '\|')
    $fence = '`'
    while ($one.Contains($fence)) { $fence += '`' }
    $pad = if ($fence.Length -gt 1 -or $one.StartsWith('`')) { ' ' } else { '' }
    return $fence + $pad + $one + $pad + $fence
}

# 字面文本转正则写法。竖线写 \x7C：Markdown 表格里 \| 的反斜杠会被吃掉，粘出去就成了「或」；
# \x7C 在 .NET 与 JS 正则里都是同一个字面竖线，也省掉表格转义
function Format-RegexLiteral {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Text)
    $meta = '\^$.*+?()[]{}'
    $sb = [System.Text.StringBuilder]::new()
    foreach ($ch in $Text.ToCharArray()) {
        if ($ch -eq '|') { [void]$sb.Append('\x7C'); continue }
        if ($meta.IndexOf($ch) -ge 0) { [void]$sb.Append('\') }
        [void]$sb.Append($ch)
    }
    return $sb.ToString()
}

# 从一行命令生成全锚定正则 ^…$：'…'/"…" → '[^']*' / "[^"]*"，独立数字 → [0-9]+，
# 含 / 或 \ 的 token → [A-Za-z0-9._\\/:-]+，其余原样转义（只泛化形状，不猜语义）
function Format-AnchorRegex {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Line)
    if ([string]::IsNullOrEmpty($Line)) { return '' }
    $sb = [System.Text.StringBuilder]::new('^')
    $n = $Line.Length
    $i = 0
    while ($i -lt $n) {
        $ch = $Line[$i]
        $close = if ($ch -eq '"' -or $ch -eq "'") { $Line.IndexOf($ch, $i + 1) } else { -1 }
        if ($close -gt $i) {
            $inner = if ($ch -eq "'") { "[^']*" } else { '[^"]*' }
            [void]$sb.Append($ch).Append($inner).Append($ch)
            $i = $close + 1
            continue
        }
        if ([char]::IsAsciiDigit($ch)) {
            $start = $i
            while ($i -lt $n -and [char]::IsAsciiDigit($Line[$i])) { $i++ }
            $bare = (($start -eq 0) -or (-not [char]::IsLetterOrDigit($Line[$start - 1]))) -and
                    (($i -ge $n) -or (-not [char]::IsLetterOrDigit($Line[$i])))
            [void]$sb.Append($(if ($bare) { '[0-9]+' } else { $Line.Substring($start, $i - $start) }))
            continue
        }
        if ([char]::IsLetterOrDigit($ch) -or $script:PathChars.IndexOf($ch) -ge 0) {
            $start = $i
            while ($i -lt $n -and ([char]::IsLetterOrDigit($Line[$i]) -or $script:PathChars.IndexOf($Line[$i]) -ge 0)) { $i++ }
            $token = $Line.Substring($start, $i - $start)
            $isPath = ($token.IndexOf('/') -ge 0) -or ($token.IndexOf('\') -ge 0)
            [void]$sb.Append($(if ($isPath) { '[A-Za-z0-9._\\/:-]+' } else { Format-RegexLiteral $token }))
            continue
        }
        [void]$sb.Append((Format-RegexLiteral ([string]$ch)))
        $i++
    }
    [void]$sb.Append('$')
    return $sb.ToString()
}

# 自检：生成的正则必须整条盖住它自己的样例（插件不只看 ^/$，还要求 index = 0 且长度相等）
function Test-AnchorRegexMatch {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Pattern, [AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrEmpty($Pattern)) { return $false }
    try {
        $match = [regex]::new($Pattern).Match($Text)
        return ($match.Success -and $match.Index -eq 0 -and $match.Value.Length -eq $Text.Length)
    }
    catch { return $false }
}

# 一条命令的风险标记（中文）；没有风险返回空
function Get-RiskTags {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Command)
    $tags = [System.Collections.Generic.List[string]]::new()
    if ($Command -match '[\r\n]') { $tags.Add('多行，不能单条锚定') }
    foreach ($rule in $script:DangerRules) {
        if ([regex]::IsMatch($Command, $rule.Pattern)) { $tags.Add($rule.Label) }
    }
    return $tags
}

# 读流水并按口径过滤。坏行 = 坏 JSON / 顶层不是对象 / ts 解析不出，跳过计数不中断；空行不算坏行。
function Get-ApprovalAudit {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path, [Nullable[datetime]]$Since = $null, [switch]$IncludeDeny, [switch]$All)
    $audit = [pscustomobject]@{
        Path = $Path; Total = 0; BadJson = 0; BadTs = 0
        Rows = [System.Collections.Generic.List[object]]::new()
    }
    # 注意：Nullable[datetime] 绑定时会退化成 datetime，判空只看 $null，别碰 .HasValue
    $sinceDto = if ($null -eq $Since) { $null } else { [datetimeoffset]$Since }
    foreach ($rawLine in @(Get-Content -LiteralPath $Path -Encoding utf8)) {
        $text = $rawLine.Trim()
        if ($text -eq '') { continue }
        $audit.Total++

        try { $obj = $text | ConvertFrom-Json -AsHashtable -ErrorAction Stop } catch { $audit.BadJson++; continue }
        if ($obj -isnot [System.Collections.IDictionary]) { $audit.BadJson++; continue }
        $stamp = [datetimeoffset]::MinValue
        $okTs = [datetimeoffset]::TryParse([string]$obj['ts'], [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$stamp)
        if (-not $okTs) { $audit.BadTs++; continue }
        if ($null -ne $sinceDto -and $stamp -lt $sinceDto) { continue }

        $outcome = [string]$obj['outcome']
        $reason = [string]$obj['reason']
        $isNoRule = ($outcome -eq 'asked' -and $reason -eq 'no-rule')
        $isDeny = ($reason -eq 'deny-rule')
        if (-not ($All -or $isNoRule -or ($IncludeDeny -and $isDeny))) { continue }

        $command = if ($null -eq $obj['command']) { '' } else { [string]$obj['command'] }
        $firstLine = if ($command -match '[\r\n]') { ($command -split "\r?\n")[0] } else { $command }
        $tokens = @(($firstLine.Trim() -split '\s+') | Where-Object { $_ -ne '' } | Select-Object -First 2)
        $family = if ($tokens.Count -ge 2) { "$($tokens[0]) $($tokens[1])" } elseif ($tokens.Count -eq 1) { $tokens[0] } else { '' }
        if ([string]::IsNullOrWhiteSpace($command)) { $family = '(无命令)' }
        elseif ($family -eq '') { $family = '(空首行)' }

        $audit.Rows.Add([pscustomobject]@{
                Time = $stamp; Command = $command; FirstLine = $firstLine; Family = $family
                Tool = if ([string]::IsNullOrWhiteSpace([string]$obj['tool'])) { '(未知)' } else { [string]$obj['tool'] }
                FirstToken = if ($tokens.Count -ge 1) { $tokens[0] } else { $family }
                Bucket = if ($isNoRule) { 'primary' } elseif ($isDeny) { 'deny' } else { 'other' }
            })
    }
    return $audit
}

# 按「前两个 token」归组成表（如 git fetch）：样例取组内最多的写法，正则从完整第一行生成
function Format-GroupTable {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Rows, [Parameter(Mandatory)][int]$Top)
    $lines = [System.Collections.Generic.List[string]]::new()
    $groups = @(
        $Rows | Group-Object -Property Family | ForEach-Object {
            $variants = @($_.Group | Group-Object -Property FirstLine |
                    Sort-Object -Property @{ Expression = 'Count'; Descending = $true }, @{ Expression = 'Name' })
            [pscustomobject]@{
                Count = $_.Count; VariantCount = $variants.Count
                SampleLine = $variants[0].Name; Members = @($_.Group)
            }
        } | Sort-Object -Property @{ Expression = 'Count'; Descending = $true }, @{ Expression = 'SampleLine' }
    )
    $lines.Add('| 出现次数 | 命令样例 | 建议锚定正则 | 风险 |')
    $lines.Add('| ---: | :--- | :--- | :--- |')
    foreach ($group in @($groups | Select-Object -First $Top)) {
        $sample = $group.SampleLine
        if ($sample.Length -gt 60) { $sample = $sample.Substring(0, $(if ([char]::IsHighSurrogate($sample[59])) { 59 } else { 60 })) + '…' }
        if ($sample -eq '') { $sample = '(无命令)' }
        $pattern = Format-AnchorRegex -Line $group.SampleLine
        $ok = ($pattern -ne '') -and (Test-AnchorRegexMatch -Pattern $pattern -Text $group.SampleLine)

        $risks = [System.Collections.Generic.List[string]]::new()
        if (-not $ok -and $group.SampleLine -ne '') { $risks.Add('生成失败，人工写') }
        foreach ($member in $group.Members) {
            foreach ($tag in @(Get-RiskTags -Command $member.Command)) {
                if (-not $risks.Contains($tag)) { $risks.Add($tag) }
            }
        }
        if ($group.VariantCount -gt 1) { $risks.Add("另有 $($group.VariantCount - 1) 种写法（此正则只覆盖样例）") }

        $riskCell = if ($risks.Count -eq 0) { '-' } else { (@($risks | ForEach-Object { Format-MdCode $_ }) -join '；') }
        $patternCell = if ($pattern -eq '') { '-' } else { Format-MdCode $pattern }
        $lines.Add("| $($group.Count) | $(Format-MdCode $sample) | $patternCell | $riskCell |")
    }
    if (@($groups).Count -gt $Top) { $lines.Add("`n（只列前 $Top 组，共 $(@($groups).Count) 组；用 -Top 调整）") }
    return $lines
}

# 组装整份 Markdown 报告：顶部统计 → 分节表（主表 = 名单没覆盖）→ 下一步 → 坏行数
function Format-ApprovalReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Audit, [Parameter(Mandatory)][int]$Top,
        [switch]$IncludeDeny, [switch]$All, [Nullable[datetime]]$Since = $null
    )
    $rows = @($Audit.Rows); $bad = $Audit.BadJson + $Audit.BadTs
    $scope = if ($All) { '全部行（含 auto-allowed 与其它审批原因）' }
    elseif ($IncludeDeny) { '`asked`：`no-rule` + `deny-rule`（主表只放 no-rule）' }
    else { '`asked` 且 `reason = no-rule`（弹了卡、名单没覆盖）' }
    if ($null -ne $Since) { $scope += "；只算 $(([datetimeoffset]$Since).UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss'))Z 之后" }

    $out = [System.Collections.Generic.List[string]]::new()
    $out.Add('# 审批流水报告'); $out.Add('')
    $out.Add('> 维护会话用的只读报告：脚本不写 `allow.json`、不改任何配置；改名单由人和会话决定。'); $out.Add('')
    $out.Add("- 数据源：$(Format-MdCode $Audit.Path)")
    $out.Add("- 统计口径：$scope")
    $out.Add("- 总行数：$($Audit.Total)（跳过坏行 $bad：JSON 解析失败 $($Audit.BadJson)，ts 无法解析 $($Audit.BadTs)）")
    $out.Add("- 口径内行数：$($rows.Count)")
    if ($rows.Count -gt 0) {
        $times = @($rows | ForEach-Object { $_.Time } | Sort-Object)
        $range = "$($times[0].UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss')) → $($times[-1].UtcDateTime.ToString('yyyy-MM-dd HH:mm:ss'))"
        $out.Add("- 时间范围（UTC）：$range")
        $out.Add("- 按工具：pwsh $(@($rows | Where-Object { $_.Tool -eq 'pwsh' }).Count)，bash $(@($rows | Where-Object { $_.Tool -eq 'bash' }).Count)")
        $families = @($rows | Group-Object -Property FirstToken | Sort-Object Count -Descending | Select-Object -First 8)
        $out.Add("- 命令族（首 token，前 8）：$((@($families | ForEach-Object { "$(Format-MdCode $_.Name) $($_.Count)" })) -join '、')")
    }
    $out.Add('')

    $sections = @(
        @{ Title = '名单没覆盖（asked · no-rule）'; Rows = @($rows | Where-Object { $_.Bucket -eq 'primary' }) }
        @{ Title = 'deny 段命中（reason = deny-rule）'; Rows = @($rows | Where-Object { $_.Bucket -eq 'deny' }) }
        @{ Title = '其它（-All：自动放行 / 其它原因）'; Rows = @($rows | Where-Object { $_.Bucket -eq 'other' }) }
    )
    if (@($sections | Where-Object { $_.Rows.Count -gt 0 }).Count -eq 0) { $out.Add('（这个口径下没有可统计的行）'); $out.Add('') }
    foreach ($section in $sections) {
        if ($section.Rows.Count -eq 0) { continue }
        $groupCount = @($section.Rows | Group-Object -Property Family).Count
        $out.Add("## $($section.Title) · $($section.Rows.Count) 行 / $groupCount 组"); $out.Add('')
        foreach ($line in (Format-GroupTable -Rows $section.Rows -Top $Top)) { $out.Add($line) }
        $out.Add('')
        $out.Add('> 样例取命令第一行、显示截断到 60 字符；正则从**完整第一行**生成，`\x7C` 就是字面的 `|`。'); $out.Add('')
    }

    $allowPath = Join-Path (Split-Path -Parent $Audit.Path) 'allow.json'
    $out.Add('## 下一步'); $out.Add('')
    $out.Add("1. 挑出要自动放行的组，把「建议锚定正则」整条抄进 $(Format-MdCode $allowPath) 的 ``allow`` 段：")
    $out.Add('   `id` 自己起一个，`tool` 写 `"pwsh"` 或 `["pwsh","bash"]`，`match` 直接粘正则正文（不带 `/…/`）。')
    $out.Add('2. 风险列有标记的（递归删除、强推、`curl | sh` 一类）写进 `deny` 段，或干脆不放行；deny 优先于 allow。')
    $out.Add('3. 存盘即生效，不用重启 DSH；改完看一眼同目录 `config-errors.log`，确认没有规则被作废。')
    $out.Add('4. 本脚本只读流水：`allow.json` 由人和会话自己改（写宽了等于把审批关掉）。')
    $out.Add(''); $out.Add('---'); $out.Add('')
    $out.Add("跳过坏行 $bad 行")
    return ($out -join "`n")
}

# ---- 入口 ----

$dataRoot = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $env:USERPROFILE '.dsh' } else { $env:DSH_HOME }
$auditPath = if ([string]::IsNullOrWhiteSpace($Path)) { Join-Path $dataRoot 'plugin-data\approval-allow\approvals.jsonl' } else { $Path }
if (-not (Test-Path -LiteralPath $auditPath -PathType Leaf)) { Write-Output "还没有流水：$auditPath"; exit 0 }

$audit = Get-ApprovalAudit -Path $auditPath -Since $Since -IncludeDeny:$IncludeDeny -All:$All
$report = Format-ApprovalReport -Audit $audit -Top $Top -IncludeDeny:$IncludeDeny -All:$All -Since $Since
if ([string]::IsNullOrWhiteSpace($OutFile)) { Write-Output $report; exit 0 }

$fullOut = if ([System.IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path (Get-Location).Path $OutFile }
$outDir = Split-Path -Parent $fullOut
if (-not [string]::IsNullOrWhiteSpace($outDir) -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
Set-Content -LiteralPath $fullOut -Value $report -Encoding utf8NoBOM
Write-Output "报告已写到 $fullOut（跳过坏行 $($audit.BadJson + $audit.BadTs) 行）"
exit 0
