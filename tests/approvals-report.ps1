# 断言「白名单维护会话」用的统计工具（T-12 / tools\approvals-report.ps1）没走偏。
#   为什么需要它：这个脚本的输出去向是**人改 allow.json 的依据**。它自己写错不致命，
#   但它要是偷偷改 allow.json、或把建议正则在 Markdown 里写坏（粘贴回配置就成了另一个意思），
#   后果就是「名单被放宽了而人不知道」。所以这里钉三件事：
#     ① 只读（绝不写 allow.json，-OutFile 只写它自己指定的文件）；
#     ② 报表里的建议正则必须能原样粘回 JS（`^…$` 全锚定、竖线写成 \x7C）；
#     ③ 实际行为对（坏行、多行、无命令、deny 单独一节、多种写法提示）。
#
# 跑法：& <repo>\tests\approvals-report.ps1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$toolRel = 'tools\approvals-report.ps1'
$toolPath = Join-Path $repoRoot $toolRel
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
    $mark = if ($Ok) { 'ok  ' } else { 'FAIL' }
    Write-Host ("{0} {1}{2}" -f $mark, $Name, $(if ($Detail) { "  → $Detail" } else { '' }))
}

function Get-ToolText {
    if (-not (Test-Path -LiteralPath $toolPath)) { throw "缺文件：$toolRel" }
    Get-Content -Raw -LiteralPath $toolPath
}

function Add-TextCheck {
    param([string]$Pattern, [string]$Name, [string]$Miss)
    try { $text = Get-ToolText } catch { Add-Check $Name $false $_.Exception.Message; return }
    $ok = $text -match $Pattern
    Add-Check $Name $ok $(if ($ok) { $toolRel } else { $Miss })
}

# 跑工具并抓输出。**写法是被沙箱逼出来的**：受限沙箱下 PowerShell 一旦「消费 native 程序的输出」
# （赋值、管道、2>&1 到变量）就会 `StandardOutputEncoding is only supported when standard output is
# redirected` 而失败，所以这里 ① 输出在 cmd 内部就重定向到文件；② 退出码由 cmd 自己 `echo EXIT:!errorlevel!`
# 追加进同一个文件；③ 函数**不返回**抓取结果，只写脚本域变量，调用点也不做赋值（一赋值就等于消费输出）。
$script:toolText = ''
function Invoke-Tool {
    param([string[]]$Arguments)
    $stdout = Join-Path $fixtureDir ('out-{0}.txt' -f ([guid]::NewGuid().ToString('N')))
    $quoted = ($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
    $cmd = 'cmd /v:on /c "cd /d ""{0}"" && pwsh -NoProfile -File ""{1}"" {2} > ""{3}"" 2>&1 & echo EXIT:!errorlevel! >> ""{3}"""' -f $repoRoot, $toolPath, $quoted, $stdout
    cmd /c $cmd
    $script:toolText = if (Test-Path -LiteralPath $stdout) { Get-Content -Raw -LiteralPath $stdout } else { '' }
}

function Get-LastToolResult {
    $m = [regex]::Match($script:toolText, 'EXIT:(\d+)')
    [pscustomobject]@{
        ExitCode = if ($m.Success) { [int]$m.Groups[1].Value } else { -1 }
        Text     = ($script:toolText -replace 'EXIT:\d+\s*$', '')
    }
}

# ---- 骨架与只读边界 -------------------------------------------------------------

Add-Check '工具存在' (Test-Path -LiteralPath $toolPath) $toolRel
Add-TextCheck '#Requires -Version 7' '声明 PowerShell 7' '没有 #Requires -Version 7'
Add-TextCheck '\[CmdletBinding\(\)\]' '声明 CmdletBinding' '没有 [CmdletBinding()]'

# 只读：允许 -OutFile 那一处 Set-Content，但不许任何写操作碰到 allow.json。
$writesAllow = @((Get-ToolText) -split "`r?`n" | Where-Object {
        $_ -match 'allow\.json' -and $_ -match '(Set|Add)-Content|Out-File|ConvertTo-Json.*allow\.json'
    })
Add-Check '只读：没有任何写 allow.json 的语句' ($writesAllow.Count -eq 0) $(if ($writesAllow.Count -eq 0) { '没有写操作指向 allow.json' } else { "命中 $($writesAllow.Count) 行" })

$allowRefs = @((Get-ToolText) -split "`r?`n" | Where-Object { $_ -match 'allow\.json' -and $_.Trim() -notmatch '^(#|\*|>|\$out\.Add)' })
Add-Check 'allow.json 只出现在注释/提示里，或只被读路径拼过一次' ($allowRefs.Count -le 1) "非注释引用 $($allowRefs.Count) 处"

Add-TextCheck 'plugin-data' '默认路径落在 plugin-data（B-43：工作区外）' '没有 plugin-data'
Add-TextCheck 'approvals\.jsonl' '默认读 approvals.jsonl' '没有 approvals.jsonl'

$paramNames = @('Path', 'Top', 'Since', 'OutFile', 'IncludeDeny', 'All')
$missingParams = @($paramNames | Where-Object { (Get-ToolText) -notmatch ('\$' + $_) })
Add-Check '六个参数都在（-Path -Top -Since -OutFile -IncludeDeny -All）' ($missingParams.Count -eq 0) $(if ($missingParams.Count -eq 0) { '齐全' } else { '缺：' + ($missingParams -join ', ') })

# 竖线写成 \x7C：Markdown 表格里 `\|` 的反斜杠会被吃掉，粘回配置就成了「或」。
Add-TextCheck '\\x7C' '建议正则里竖线写成 \x7C（避免 Markdown 吃掉反斜杠）' '没有 \x7C 处理'

# ---- 行为断言：造一份假流水 ------------------------------------------------------

$fixtureDir = Join-Path $repoRoot '.session-files'
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
$fixture = Join-Path $fixtureDir ('approvals-fixture-{0}.jsonl' -f ([guid]::NewGuid().ToString('N')))
$lines = @(
    '{"ts":"2026-11-02T02:00:00.000Z","tool":"pwsh","command":"git fetch --all","outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:01:00.000Z","tool":"pwsh","command":"git fetch --all","outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:02:00.000Z","tool":"pwsh","command":"git fetch --all","outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:03:00.000Z","tool":"bash","command":"git fetch origin","outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:04:00.000Z","tool":"pwsh","command":"git push --force","outcome":"asked","rule":"no-force-push","reason":"deny-rule"}'
    '{"ts":"2026-11-02T02:05:00.000Z","tool":"pwsh","command":null,"outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:06:00.000Z","tool":"pwsh","command":"git status\nrm -rf /tmp/x","outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:07:00.000Z","tool":"pwsh","command":"New-Item -ItemType Directory -Path \"C:\\tmp\\a b\" -Force | Out-Null","outcome":"asked","rule":null,"reason":"no-rule"}'
    '{"ts":"2026-11-02T02:08:00.000Z","tool":"pwsh","command":"git fetch --all","outcome":"auto-allowed","rule":"git-fetch","reason":null}'
    '{ this is not json'
)
try {
    Set-Content -LiteralPath $fixture -Value $lines -Encoding utf8NoBOM

    Invoke-Tool @('-Path', $fixture)
    $default = Get-LastToolResult
    Add-Check '默认跑得通（退出码 0）' ($default.ExitCode -eq 0) "退出码 $($default.ExitCode)"
    Add-Check '坏行被跳过并计数' ($default.Text -match '跳过坏行\s*1|坏行 1') '没报坏行计数'
    Add-Check '口径内只算 asked·no-rule（auto-allowed 不进表）' ($default.Text -notmatch 'git-fetch') 'auto-allowed 混进了报告'
    Add-Check 'deny 命中默认不进主表' ($default.Text -notmatch 'push --force') 'deny-rule 出现在默认报告里'
    Add-Check '无命令归 (无命令) 组' ($default.Text -match '\(无命令\)') '没有 (无命令) 组'
    Add-Check '多行命令标出来' ($default.Text -match '多行') '没有「多行」提示'
    Add-Check '同一命令族多种写法有提示' ($default.Text -match '另有') '没有「另有 N 种写法」提示'
    Add-Check '建议正则全锚定（^ 开头）' ($default.Text -match '\^git fetch') '没有 ^git fetch 形式的建议'
    Add-Check '建议正则全锚定（$ 结尾）' ($default.Text -match '(\\\$|`\$|\$`|\$$)') '建议正则没有 $ 结尾'
    Add-Check '报告说清只读边界' ($default.Text -match '只读') '报告没写只读'

    # 建议正则必须能被 JS 原样编译，且至少命中一条「本份流水的命令首行」——粘回配置才真的可用。
    $regexes = @([regex]::Matches($default.Text, '`(\^[^`]*\$)`') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
    Add-Check '报告里至少给出 2 条建议正则' ($regexes.Count -ge 2) "拿到 $($regexes.Count) 条"
    if ($regexes.Count -ge 2) {
        # 样例取自流水本身（多行只取首行），不另抄一份，避免测试与夹具漂移。
        $firstLines = @(foreach ($line in $lines) {
                try { $obj = $line | ConvertFrom-Json } catch { continue }
                if ($obj.command) { (($obj.command -split "`n")[0]) }
            })
        $probe = Join-Path $fixtureDir ('regex-probe-{0}.mjs' -f ([guid]::NewGuid().ToString('N')))
        $payload = @($regexes | ForEach-Object { $_.Replace('`', '') })
        $body = @"
const pats = $($payload | ConvertTo-Json -Compress);
const samples = $($firstLines | ConvertTo-Json -Compress);
let ok = 0, bad = [];
for (const p of pats) {
  let re; try { re = new RegExp(p); } catch (e) { bad.push(['compile', p, String(e)]); continue; }
  const hit = samples.some((s) => re.test(s));
  if (hit) { ok += 1; } else { bad.push(['nomatch', p]); }
}
console.log(JSON.stringify({ ok, bad, total: pats.length }));
"@
        Set-Content -LiteralPath $probe -Value $body -Encoding utf8NoBOM
        $probeOut = Join-Path $fixtureDir ('regex-probe-out-{0}.txt' -f ([guid]::NewGuid().ToString('N')))
        cmd /c ('node "{0}" > "{1}" 2>&1' -f $probe, $probeOut)
        $probeJson = Get-Content -Raw -LiteralPath $probeOut | ConvertFrom-Json
        Add-Check '每条建议正则都能被 JS 编译且命中流水里的命令首行' ($probeJson.bad.Count -eq 0) ("ok=$($probeJson.ok)/$($probeJson.total) bad=$($probeJson.bad.Count)")
        Remove-Item -LiteralPath $probe, $probeOut -Force -ErrorAction SilentlyContinue
    }

    Invoke-Tool @('-Path', $fixture, '-IncludeDeny')
    $withDeny = Get-LastToolResult
    Add-Check '-IncludeDeny 时 deny 命中单独出现' ($withDeny.Text -match 'push --force') '-IncludeDeny 没把 deny 带出来'

    Invoke-Tool @('-Path', $fixture, '-Top', '1')
    $top1 = Get-LastToolResult
    Add-Check '-Top 生效并说明截断' ($top1.Text -match '只列前' -or $top1.Text -match '共 \d+ 组') '-Top 没生效或没说明'

    Invoke-Tool @('-Path', (Join-Path $fixtureDir 'no-such-file.jsonl'))
    $missing = Get-LastToolResult
    Add-Check '流水不存在时明确说「还没有流水」' ($missing.Text -match '还没有流水') '没有明确提示'
    Add-Check '流水不存在时退出码 0（不是错误）' ($missing.ExitCode -eq 0) "退出码 $($missing.ExitCode)"

    # 只读验证：真实数据目录里的 allow.json 不该被这次运行碰过。
    $dataDir = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'plugin-data\approval-allow'
    $allowFile = Join-Path $dataDir 'allow.json'
    if (Test-Path -LiteralPath $allowFile) {
        $before = (Get-Item -LiteralPath $allowFile).LastWriteTimeUtc
        Invoke-Tool @('-Path', $fixture, '-IncludeDeny', '-All')
        $after = (Get-Item -LiteralPath $allowFile).LastWriteTimeUtc
        Add-Check '跑完不改真实 allow.json（mtime 不变）' ($before -eq $after) "before=$before after=$after"
    } else {
        Add-Check '跑完不改真实 allow.json（mtime 不变）' $true '（本机没装插件，跳过实测）'
    }
}
finally {
    Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue
    Get-ChildItem -LiteralPath $fixtureDir -Filter 'out-*.txt' -File -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

$failed = @($checks | Where-Object { -not $_.Ok }).Count
Write-Host ''
Write-Host ('通过 {0} / 失败 {1}（共 {2} 项）' -f ($checks.Count - $failed), $failed, $checks.Count)
if ($failed -gt 0) {
    Write-Host '失败说明统计工具的「只读」或「建议正则可粘贴」这两条不变量被破坏了。'
}
exit $(if ($failed -eq 0) { 0 } else { 1 })
