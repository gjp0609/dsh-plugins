# 断言 dsh-approval-allow（R-07 / T-11）的关键不变量还成立。
#   为什么需要它：这个插件**替人点「允许」**，写错一条匹配规则就等于自动同意一次提权。
#   所以这里钉的不是「功能有没有」，而是「有没有偷偷放开」：只两个通道、只按锚定正则、
#   deny 永远先判、任何不确定都交回下游（fail-closed）。
#   行为断言用真实模块跑（compileDocument + decide），不靠读源码猜。
#
# 跑法：& <repo>\tests\approval-allow.ps1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginRel = 'dsh-approval-allow'
$pluginDir = Join-Path $repoRoot $pluginRel
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
    $mark = if ($Ok) { 'ok  ' } else { 'FAIL' }
    Write-Host ("{0} {1}{2}" -f $mark, $Name, $(if ($Detail) { "  → $Detail" } else { '' }))
}

function Get-PluginText {
    param([string]$RelativePath)
    $path = Join-Path $pluginDir $RelativePath
    if (-not (Test-Path -LiteralPath $path)) { throw "缺文件：$pluginRel/$RelativePath" }
    Get-Content -Raw -LiteralPath $path
}

function Add-TextCheck {
    param([string]$RelativePath, [string]$Pattern, [string]$Name, [string]$Miss)
    try { $text = Get-PluginText $RelativePath } catch { Add-Check $Name $false $_.Exception.Message; return }
    $ok = $text -match $Pattern
    Add-Check $Name $ok $(if ($ok) { $RelativePath } else { $Miss })
}

# ---- 骨架 ---------------------------------------------------------------------

$required = @(
    'index.js', 'package.json', 'cordis.patch.yml', 'README.md', 'DECISIONS.md',
    'lib/config.mjs', 'lib/match.mjs', 'lib/audit.mjs', 'tests/allow.test.mjs'
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $pluginDir $_)) })
Add-Check '插件：骨架文件齐全' ($missing.Count -eq 0) $(if ($missing.Count -eq 0) { $pluginRel } else { "缺 $($missing -join ', ')" })

Add-TextCheck 'cordis.patch.yml' 'id:\s*approval-allow' '插件：patch 里登记 id=approval-allow' 'patch 里没有 approval-allow 这一行'
Add-TextCheck 'cordis.patch.yml' 'name:\s*dsh-approval-allow' '插件：patch 的 name 指向本包' 'name 不是 dsh-approval-allow'

# 插件目录不得有外壳副本（卡片的渲染源只有 shared/ui-card 一份）。
$shellCopies = @(Get-ChildItem -LiteralPath $pluginDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('index.html', 'webview2.ps1') })
Add-Check '插件：目录里没有外壳副本' ($shellCopies.Count -eq 0) $(if ($shellCopies.Count -eq 0) { '无 index.html / webview2.ps1' } else { ($shellCopies.Name -join ', ') })

# 只用 Node 内置模块：import 了 @deepseek-ai/* 就等于和宿主版本绑死。
$sources = @(Get-ChildItem -LiteralPath $pluginDir -Recurse -File -Include *.js, *.mjs -ErrorAction SilentlyContinue)
$vendorImports = @($sources | Select-String -Pattern "from\s+'@deepseek-ai/" -ErrorAction SilentlyContinue)
Add-Check '插件：只 import node 内置模块' ($vendorImports.Count -eq 0) $(if ($vendorImports.Count -eq 0) { "$($sources.Count) 个源文件" } else { "$($vendorImports.Count) 处 @deepseek-ai 导入" })

# ---- 挂载点：只碰 pwsh/bash，只挂两个瀑布 -------------------------------------

Add-TextCheck 'index.js' "SHELL_TOOLS\s*=\s*Object\.freeze\(\['pwsh',\s*'bash'\]\)" '通道：只登记 pwsh 与 bash' 'SHELL_TOOLS 不是恰好 [pwsh, bash]'
Add-TextCheck 'index.js' "'tools/pre-execute'" '挂载：监听 tools/pre-execute 记命令原文' '没有挂 tools/pre-execute'
Add-TextCheck 'index.js' "'approval/request'" '挂载：监听 approval/request 认领审批' '没有挂 approval/request'
$prependCount = ([regex]::Matches((Get-PluginText 'index.js'), '\{\s*prepend:\s*true\s*\}')).Count
Add-Check '挂载：两个瀑布都 prepend' ($prependCount -eq 2) "prepend 出现 $prependCount 次（应为 2）"
Add-TextCheck 'index.js' "return 'allowed-once'" '放行：命中规则返回 allowed-once（弹窗不出现）' '没有返回 allowed-once'

foreach ($forbidden in @(
        @{ Pattern = "return 'rejected'"; Why = '插件不该替人拒绝' },
        @{ Pattern = "return 'cancelled'"; Why = '插件不该替人取消' }
    )) {
    $hit = (Get-PluginText 'index.js') -match $forbidden.Pattern
    Add-Check "边界：index.js 不含 $($forbidden.Pattern)" (-not $hit) $(if ($hit) { $forbidden.Why } else { '未出现' })
}

# ssh_run 只许出现在注释里（说明「不管它」），不许出现在代码里。
$sshCodeLines = @((Get-PluginText 'index.js') -split "`r?`n" | Where-Object {
        $_.Trim() -match 'ssh_run' -and $_.Trim() -notmatch '^(\*|//|/\*)'
    })
Add-Check '边界：index.js 代码里不碰 ssh_run' ($sshCodeLines.Count -eq 0) $(if ($sshCodeLines.Count -eq 0) { '仅在注释里出现' } else { "命中 $($sshCodeLines.Count) 行代码" })

# ---- 匹配引擎文本证据 ---------------------------------------------------------

Add-TextCheck 'lib/match.mjs' "startsWith\('\^'\)" '匹配：规则必须以 ^ 开头（否则作废）' 'match.mjs 没有校验 ^ 前缀'
Add-TextCheck 'lib/match.mjs' "endsWith\('\$'\)" '匹配：规则必须以 $ 结尾（否则作废）' 'match.mjs 没有校验 $ 后缀'
Add-TextCheck 'lib/match.mjs' 'raw\.version !== 1' '配置：version 不是 1 就整份作废' 'match.mjs 没有校验 version===1'
Add-TextCheck 'lib/config.mjs' 'mtime' '热更：用 mtime 判断文件变没变' 'config.mjs 没有 mtime'
Add-TextCheck 'lib/audit.mjs' 'approvals\.jsonl' '审计：决策流水写 approvals.jsonl' 'audit.mjs 没有 approvals.jsonl'

# B-43（用户 2026-11-02）：放行规则只能来自工作区外。配置路径必须由 dataDir 拼出来；
# 代码里不许出现「按项目根拼配置」的写法——那正是被否掉的方案：模型能写的文件＝模型能给自己放行。
Add-TextCheck 'lib/config.mjs' "join\(dataDir, CONFIG_FILE_NAME\)" 'B-43：配置路径由 dataDir 拼出（工作区外）' '配置路径不是从 dataDir 拼的'
$workspaceReads = @((Get-PluginText 'lib/config.mjs') -split "`r?`n" | Where-Object {
        $_.Trim() -notmatch '^(\*|//)' -and $_ -match "projectRoot.*(\.dsh|allow\.json)|join\(projectRoot"
    })
Add-Check 'B-43：不按项目根拼配置路径（工作区文件不读）' ($workspaceReads.Count -eq 0) $(if ($workspaceReads.Count -eq 0) { '没有 join(projectRoot, …)' } else { "命中 $($workspaceReads.Count) 行" })
Add-TextCheck 'lib/match.mjs' "'projects'" '布局：项目名单是同一文件里的 projects 段' 'match.mjs 没有 projects 段'
Add-TextCheck 'lib/config.mjs' 'CONFIG_FILE_NAME\s*=\s*.allow\.json.' '布局：唯一配置入口叫 allow.json' 'CONFIG_FILE_NAME 不是 allow.json'
$subDirs = @((Get-PluginText 'lib/config.mjs') -split "`r?`n" | Where-Object {
        $_.Trim() -notmatch '^(\*|//)' -and $_ -match "join\(dataDir, '(projects|rules|configs)'\)"
    })
Add-Check '布局：数据目录下不建二级分类目录' ($subDirs.Count -eq 0) $(if ($subDirs.Count -eq 0) { '只有 allow.json 一层' } else { "命中 $($subDirs.Count) 行" })
$nextCalls = ([regex]::Matches((Get-PluginText 'index.js'), 'return next\(\)')).Count
Add-Check '兜底：不确定时一律 next()（至少 6 处）' ($nextCalls -ge 6) "return next() 出现 $nextCalls 次"

# ---- 行为探针：喂真实模块 -----------------------------------------------------
#
# 探针文件放在仓库根（相对 import 才解析得到），跑完即删。
$probePath = Join-Path $repoRoot ('.approval-allow-probe-{0}.mjs' -f ([guid]::NewGuid().ToString('N')))
$probeRel = Split-Path -Leaf $probePath
$pluginRelPosix = $pluginRel
$probeSource = @"
import { compileDocument, decide } from './$pluginRelPosix/lib/match.mjs'

const fail = (message) => { console.error('FAIL ' + message); process.exit(1) }
const doc = (deny, allow) => compileDocument({ version: 1, deny, allow })
const rule = (id, tool, match) => ({ id, tool, match })

// ① deny 优先：同一命令同时命中 allow 与 deny → 照常问
{
  const compiled = doc([rule('d', 'pwsh', '^git pull origin main$')], [rule('a', 'pwsh', '^git pull origin main$')])
  if (compiled.errors.length !== 0) fail('deny 用例规则没编译通过：' + JSON.stringify(compiled.errors))
  const decision = decide(compiled.rules, { tool: 'pwsh', command: 'git pull origin main' })
  if (decision.kind !== 'deny') fail('deny 没有优先：' + JSON.stringify(decision))
}

// ② 命中 allow → allow（用户要的 git commit -m 任意消息）
{
  const compiled = doc([], [rule('c', ['pwsh', 'bash'], '^git commit -m .+\$')])
  const decision = decide(compiled.rules, { tool: 'pwsh', command: "git commit -m 'x'" })
  if (decision.kind !== 'allow') fail('commit 没被放行：' + JSON.stringify(decision))
}

// ③ 不锚定的规则必须作废（不能静默生效）
{
  const compiled = doc([], [rule('a', 'pwsh', '^git pull')])
  if (compiled.rules.length !== 0) fail('不锚定的规则竟然留下了')
  if (compiled.errors.length === 0) fail('不锚定的规则没有产生诊断')
  const decision = decide(compiled.rules, { tool: 'pwsh', command: 'git pull origin main' })
  if (decision.kind !== 'none') fail('作废后仍然放行了')
}

// ④ 锚定的意义：复合命令不能被前缀规则放过
{
  const compiled = doc([], [rule('a', 'pwsh', '^git pull origin main\$')])
  const decision = decide(compiled.rules, { tool: 'pwsh', command: 'git pull origin main; rm -rf ~' })
  if (decision.kind !== 'none') fail('复合命令被放过了：' + JSON.stringify(decision))
}

// ⑤ 末尾换行口子：JS 的 \$ 能匹配 "…\n" 之前，必须靠长度校验堵死
{
  const compiled = doc([], [rule('a', 'pwsh', '^git status\$')])
  const decision = decide(compiled.rules, { tool: 'pwsh', command: 'git status' + String.fromCharCode(10) })
  if (decision.kind !== 'none') fail('末尾换行被放过了')
}

// ⑥ 工具过滤：规则只对 bash，pwsh 不该放行
{
  const compiled = doc([], [rule('a', 'bash', '^git pull origin main\$')])
  const decision = decide(compiled.rules, { tool: 'pwsh', command: 'git pull origin main' })
  if (decision.kind !== 'none') fail('工具名不匹配却放行了')
}

// ⑦ 通配工具 "*" 与数组都认
{
  const star = doc([], [rule('a', '*', '^git fetch\$')])
  if (decide(star.rules, { tool: 'bash', command: 'git fetch' }).kind !== 'allow') fail('"*" 没生效')
  const list = doc([], [rule('a', ['pwsh', 'bash'], '^git fetch\$')])
  if (decide(list.rules, { tool: 'bash', command: 'git fetch' }).kind !== 'allow') fail('数组工具没生效')
}

console.log('probe-ok')
"@
Set-Content -LiteralPath $probePath -Value $probeSource -Encoding utf8
try {
    # 受限沙箱里 `& node ... 2>&1` 会报 StandardOutputEncoding 错误，必须走 cmd 重定向到文件再读。
    $probeLog = Join-Path ([System.IO.Path]::GetTempPath()) ("approval-allow-probe-{0}.log" -f ([guid]::NewGuid().ToString('N')))
    cmd /c "cd /d `"$repoRoot`" && node `"$probePath`" > `"$probeLog`" 2>&1"
    $code = $LASTEXITCODE
    $out = if (Test-Path -LiteralPath $probeLog) { Get-Content -Raw -LiteralPath $probeLog } else { '' }
    Remove-Item -LiteralPath $probeLog -Force -ErrorAction SilentlyContinue
    $ok = ($code -eq 0) -and ([string]$out -match 'probe-ok')
    Add-Check '匹配：deny 优先 / 锚定作废 / 复合与换行不放过 / 工具过滤' $ok $(if ($ok) { '7 组行为探针通过' } else { "exit $code :: $([string]$out)".Trim() })
} catch {
    Add-Check '匹配：行为探针' $false $_.Exception.Message
} finally {
    Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
}

# ---- 文档：边界要写明 ---------------------------------------------------------

Add-TextCheck 'README.md' 'ssh_run' '文档：写明不管 ssh_run' 'README 没提 ssh_run 的边界'
Add-TextCheck 'README.md' '锚定' '文档：写明规则必须锚定' 'README 没写锚定要求'
Add-TextCheck 'DECISIONS.md' '锚定' '决策：记录了为什么强制锚定' 'DECISIONS 没写锚定'

# ---- 跑插件自带的行为测试 -----------------------------------------------------

$testPath = Join-Path $pluginDir 'tests\allow.test.mjs'
if (Test-Path -LiteralPath $testPath) {
    $logPath = Join-Path ([System.IO.Path]::GetTempPath()) ("approval-allow-test-{0}.log" -f ([guid]::NewGuid().ToString('N')))
    cmd /c "cd /d `"$repoRoot`" && node `"$testPath`" > `"$logPath`" 2>&1"
    $code = $LASTEXITCODE
    $log = if (Test-Path -LiteralPath $logPath) { Get-Content -Raw -LiteralPath $logPath } else { '' }
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
    $tail = ($log -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    $okCount = ([regex]::Matches($log, '(?m)^ok\s')).Count
    Add-Check '插件自带行为测试全过' (($code -eq 0) -and ($log -match '全部通过')) $(if ($code -eq 0) { "$tail（$okCount 条）" } else { "exit $code :: $tail" })
    Add-Check '插件自带行为测试覆盖 ≥20 条' ($okCount -ge 20) "$okCount 条"
} else {
    Add-Check '插件自带行为测试全过' $false "缺 $pluginRel/tests/allow.test.mjs"
}

# ---- 汇总 ---------------------------------------------------------------------

$failed = @($checks | Where-Object { -not $_.Ok }).Count
''
if ($failed -gt 0) {
    "通过 $($checks.Count - $failed) / 失败 $failed（共 $($checks.Count) 项）"
    exit 1
}
"通过 $($checks.Count) / 失败 0（共 $($checks.Count) 项）"
exit 0
