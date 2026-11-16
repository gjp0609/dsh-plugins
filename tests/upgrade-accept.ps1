# 升级验收：插件在当前这版 dsh 上还能不能用。
#
# 跑法：
#   pwsh -NoProfile -File tests\upgrade-accept.ps1 -Phase Pre
#   pwsh -NoProfile -File tests\upgrade-accept.ps1 -Phase Post -ExpectedVersion 0.2.2-rc.3
#
# Pre（升级前，随时可跑，必须全绿）：
#   1. 四个插件的 package.json 都有 engines.dsh（0.2.2 起插件管理器按它判兼容）；
#   2. 四个插件的 node 测试全绿（接口被删、行为变了，这里先红）；
#   3. 仓库根 *.test.mjs 全绿（目前 0 个，留着给以后）；
#   4. tests\shared-ui-guard.ps1 绿（卡片外壳只有一份）。
#
# Post（收到「dsh -V 已经变了」的信号之后再跑）：
#   5. dsh -V：给了 -ExpectedVersion 就断言相等，没给就只打印；
#   6. 同 2、3、4（主干：测试红了就是插件在新版上坏了）；
#   7. 构建产物不旧（直接跑 tests\plugin-bundle.ps1，口径就是它的口径）；
#   8. 打印 4 条人工项（机器判不了，得人点一遍）。
#
# 为什么测试是主干：我们依赖的全是运行时接口——事件名、服务名、exec 上的字段、槽名、DOM 类名。
# 这类东西被删/改名不会报「找不到函数」，只会让某条行为静默失效；能抓住它的只有覆盖它的测试。
# 依赖面清单见 docs\plugin-dsh-contract.md。
#
# 退出码：0 全过；1 有 FAIL。
# Post 且 -ExpectedVersion 没到 → 宿主侧项目全部 SKIP、退出 0（信号未到，不算失败）。
#
# 实现注意：所有 native 调用都写在脚本顶层，不在函数/脚本块里跑。本机受限沙箱下，
# 函数或脚本块内重定向 native 输出会报
# 「StandardOutputEncoding is only supported when standard output is redirected」，
# 所以这里分两段：先顶层采集结果，再用纯 PowerShell 的 Check 断言并打印。

param(
    [ValidateSet('Pre', 'Post')]
    [string]$Phase = 'Pre',
    [string]$ExpectedVersion = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Plugins = @('dsh-approval-allow', 'dsh-approval-notifier', 'dsh-rail-pins', 'dsh-ssh-remote')
$script:Failures = 0
$script:Total = 0
$script:Skipped = 0
$script:WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-upgrade-accept'

New-Item -ItemType Directory -Force -Path $script:WorkDir | Out-Null

# ---------------------------------------------------------------------------
# 断言工具（纯 PowerShell：不调 native，不重定向）
# ---------------------------------------------------------------------------

function Ok {
    param([string]$Evidence = '')
    return @{ Pass = $true; Evidence = $Evidence }
}

function Bad {
    param([string]$Reason)
    return @{ Pass = $false; Evidence = $Reason }
}

function Short {
    param([string]$Text, [int]$Max = 180)
    $one = ($Text -replace '\s+', ' ').Trim()
    if ($one.Length -le $Max) { return $one }
    return $one.Substring(0, $Max) + '…'
}

function Read-Text {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '' }
    $text = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    if ($null -eq $text) { return '' }
    return $text
}

function Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )

    $script:Total++
    try {
        $result = & $Body
        if ($result.Pass -eq $true) {
            if ([string]::IsNullOrWhiteSpace($result.Evidence)) { "PASS  $Name" }
            else { "PASS  $Name  （$($result.Evidence)）" }
            return
        }
        "FAIL  $Name  ->  $($result.Evidence)"
        $script:Failures++
    } catch {
        "FAIL  $Name  ->  抛异常：$($_.Exception.Message)"
        $script:Failures++
    }
}

function Skip {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Why
    )

    "SKIP  $Name  ->  $Why"
    $script:Skipped++
}

function Get-TestVerdict {
    <#
    .SYNOPSIS
        把一次 node --test 的结果换成 PASS/FAIL 与一句证据。
    .DESCRIPTION
        跑法与仓库既有的一致：node --test --test-isolation=none "<插件>/tests/*.test.mjs"。
    #>
    param(
        [Parameter(Mandatory = $true)][hashtable]$Run
    )

    $pass = 0
    $fail = 0
    foreach ($m in [regex]::Matches($Run.Output, '(?m)^.{0,3}pass\s+(\d+)\s*$')) { $pass = [int]$m.Groups[1].Value }
    foreach ($m in [regex]::Matches($Run.Output, '(?m)^.{0,3}fail\s+(\d+)\s*$')) { $fail = [int]$m.Groups[1].Value }

    if ($Run.ExitCode -ne 0) {
        $hits = @($Run.Output -split "`r?`n" | Where-Object { $_ -match '✖|not ok|Error' } | Select-Object -First 2)
        $why = Short ($hits -join ' / ')
        if ($Run.Output -match 'ERR_MODULE_NOT_FOUND|Cannot find package') {
            $why = '缺依赖（先在该插件目录 pnpm install）；' + $why
        }
        return (Bad ("退出码 $($Run.ExitCode)；" + $why))
    }
    if ($pass -gt 0 -or $fail -gt 0) { return (Ok "通过 $pass / 失败 $fail") }
    return (Ok '退出码 0')
}

function Get-ScriptVerdict {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Run,
        [Parameter(Mandatory = $true)][string]$SummaryPattern
    )

    if ($Run.ExitCode -ne 0) {
        $tail = Short (@($Run.Output -split "`r?`n" | Select-Object -Last 1) -join ' / ')
        return (Bad ("退出码 $($Run.ExitCode)；" + $tail))
    }
    $summary = [regex]::Match($Run.Output, $SummaryPattern).Value
    if ($summary -eq '') { return (Ok '退出码 0') }
    return (Ok $summary)
}

# ---------------------------------------------------------------------------
# 采集（native 调用只在这里；都在脚本顶层）
# ---------------------------------------------------------------------------

Push-Location $script:RepoRoot

# engines.dsh（纯文件读取）
$enginesData = [ordered]@{}
foreach ($plugin in $script:Plugins) {
    $path = Join-Path (Join-Path $script:RepoRoot $plugin) 'package.json'
    if (-not (Test-Path -LiteralPath $path)) { $enginesData[$plugin] = $null; continue }
    $manifest = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $engines = $manifest.PSObject.Properties['engines']
    if ($null -eq $engines -or $null -eq $engines.Value) { $enginesData[$plugin] = $false; continue }
    $dsh = $engines.Value.PSObject.Properties['dsh']
    $enginesData[$plugin] = if ($null -eq $dsh) { $false } else { [string]$dsh.Value }
}

# Post：先取版本号——没到就不跑后面的（那时测试红是「新旧混跑」，不是插件坏了）
$versionRun = $null
$actualVersion = ''
if ($Phase -eq 'Post') {
    $outFile = Join-Path $script:WorkDir 'dsh-version.txt'
    cmd /c "dsh -V > `"$outFile`" 2>&1"
    $versionRun = @{ ExitCode = $LASTEXITCODE; Output = (Read-Text $outFile) }
    $first = @($versionRun.Output -split "`r?`n" | Where-Object { $_.Trim() -ne '' }) | Select-Object -First 1
    if ($null -ne $first) { $actualVersion = $first.Trim() }
}

$hostReady = $true
if ($Phase -eq 'Post' -and $ExpectedVersion -ne '' -and $actualVersion -ne $ExpectedVersion) { $hostReady = $false }

# 单测 / 根级测试 / 外壳守卫 / 构建产物
$testRuns = [ordered]@{}
$rootTestPatterns = @()
$rootTestRun = $null
$guardRun = $null
$bundleRun = $null

if ($hostReady) {
    foreach ($plugin in $script:Plugins) {
        $dir = Join-Path (Join-Path $script:RepoRoot $plugin) 'tests'
        $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.test.mjs' -File -ErrorAction SilentlyContinue)
        if ($files.Count -eq 0) { $testRuns[$plugin] = @{ Found = $false }; continue }
        $outFile = Join-Path $script:WorkDir ("tests-{0}.txt" -f $plugin)
        cmd /c "node --test --test-isolation=none `"$plugin/tests/*.test.mjs`" > `"$outFile`" 2>&1"
        $testRuns[$plugin] = @{ Found = $true; ExitCode = $LASTEXITCODE; Output = (Read-Text $outFile) }
    }

    if (@(Get-ChildItem -LiteralPath $script:RepoRoot -Filter '*.test.mjs' -File -ErrorAction SilentlyContinue).Count -gt 0) { $rootTestPatterns += '*.test.mjs' }
    if (@(Get-ChildItem -LiteralPath (Join-Path $script:RepoRoot 'tests') -Filter '*.test.mjs' -File -ErrorAction SilentlyContinue).Count -gt 0) { $rootTestPatterns += 'tests/*.test.mjs' }
    if ($rootTestPatterns.Count -gt 0) {
        $outFile = Join-Path $script:WorkDir 'tests-root.txt'
        $patterns = ($rootTestPatterns | ForEach-Object { '"{0}"' -f $_ }) -join ' '
        cmd /c "node --test --test-isolation=none $patterns > `"$outFile`" 2>&1"
        $rootTestRun = @{ ExitCode = $LASTEXITCODE; Output = (Read-Text $outFile) }
    }

    $outFile = Join-Path $script:WorkDir 'shared-ui-guard.txt'
    cmd /c "pwsh -NoProfile -File tests\shared-ui-guard.ps1 > `"$outFile`" 2>&1"
    $guardRun = @{ ExitCode = $LASTEXITCODE; Output = (Read-Text $outFile) }

    if ($Phase -eq 'Post') {
        $outFile = Join-Path $script:WorkDir 'plugin-bundle.txt'
        cmd /c "pwsh -NoProfile -File tests\plugin-bundle.ps1 > `"$outFile`" 2>&1"
        $bundleRun = @{ ExitCode = $LASTEXITCODE; Output = (Read-Text $outFile) }
    }
}

Pop-Location

# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------

"阶段：$Phase（仓库：$script:RepoRoot）"
""

foreach ($plugin in $script:Plugins) {
    Check "engines.dsh：$plugin" {
        $value = $enginesData[$plugin]
        if ($null -eq $value) { return (Bad "缺 $plugin\package.json") }
        if ($value -is [bool]) { return (Bad 'package.json 里没有 engines.dsh') }
        if ([string]::IsNullOrWhiteSpace([string]$value)) { return (Bad 'engines.dsh 是空的') }
        return (Ok "engines.dsh = $value")
    }
}

if ($Phase -eq 'Post') {
    if ($versionRun.ExitCode -ne 0) {
        Check '版本：dsh -V' { Bad "dsh -V 退出码 $($versionRun.ExitCode)；$(Short $versionRun.Output)" }
    }
    elseif ([string]::IsNullOrWhiteSpace($actualVersion)) {
        Check '版本：dsh -V' { Bad 'dsh -V 没有输出' }
    }
    elseif (-not $hostReady) {
        Skip '版本：dsh -V' "实际 $actualVersion，期望 $ExpectedVersion（信号未到）"
    }
    else {
        $evidence = if ($ExpectedVersion -eq '') { "dsh -V = $actualVersion（没给 -ExpectedVersion，只记录不断言）" } else { "dsh -V = $actualVersion" }
        Check '版本：dsh -V' { Ok $evidence }
    }
}

$skipWhy = "版本没到（dsh -V = $actualVersion，期望 $ExpectedVersion）"

if ($hostReady) {
    foreach ($plugin in $script:Plugins) {
        Check "单测：$plugin" {
            $run = $testRuns[$plugin]
            if ($run.ContainsKey('Found') -and $run.Found -eq $false) { return (Bad "找不到 $plugin\tests\*.test.mjs") }
            return (Get-TestVerdict -Run $run)
        }
    }

    Check '单测：仓库根 *.test.mjs' {
        if ($null -eq $rootTestRun) { return (Ok '根上没有根级 *.test.mjs（0 个；四个插件的已在上面跑过）') }
        return (Get-TestVerdict -Run $rootTestRun)
    }

    Check '守卫：tests\shared-ui-guard.ps1' {
        return (Get-ScriptVerdict -Run $guardRun -SummaryPattern '(?m)^通过\s.*$')
    }

    if ($Phase -eq 'Post') {
        Check '构建：tests\plugin-bundle.ps1' {
            return (Get-ScriptVerdict -Run $bundleRun -SummaryPattern '(?m)^结果：.*$')
        }
    }
}
else {
    foreach ($plugin in $script:Plugins) { Skip "单测：$plugin" $skipWhy }
    Skip '单测：仓库根 *.test.mjs' $skipWhy
    Skip '守卫：tests\shared-ui-guard.ps1' $skipWhy
    Skip '构建：tests\plugin-bundle.ps1' $skipWhy
}

if ($Phase -eq 'Post' -and $hostReady) {
    ""
    "需人工确认（4 项，机器判不了，跑完自己打勾）："
    "  [ ] ssh_status 能列主机            —— 会话里调 ssh_status，输出里有配置过的主机"
    "  [ ] ssh_run 弹卡并执行一条只读命令  —— ssh_run 一条 uname -a：卡片出现、勾选、命令跑通"
    "  [ ] 审批卡（提权）能弹能批          —— 触发一次提权：浏览器卡片出现，批准/拒绝生效"
    "  [ ] 侧栏 pin 还在                  —— 折叠侧栏，已 pin 的会话方块仍在、点得进去"
    ""
    "两段结果（脚本输出 + 上面 4 个勾）一起贴进 RESULT.md 的「插件」段。"
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

""
if ($script:Failures -gt 0) {
    "通过 $($script:Total - $script:Failures) / 失败 $($script:Failures)（共 $($script:Total) 项）"
    if ($script:Skipped -gt 0) { "另有 $($script:Skipped) 项 SKIP" }
    exit 1
}
"通过 $($script:Total) / 失败 0（共 $($script:Total) 项）"
if ($script:Skipped -gt 0) { "另有 $($script:Skipped) 项 SKIP（版本没到，宿主侧验收不做）" }
exit 0
