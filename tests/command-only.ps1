# 复制（B-32）的行为断言：commandOnly 只留命令本体。
#
# 为什么单独一份脚本：这条断言要真的把 TS 纯函数跑一遍，而 card-shell.ps1 是纯 PowerShell、
# 读不懂 TS，只能借 node（Node ≥ 22.18 能直接 import .ts，不用编译）。一旦掺进 card-shell.ps1，
# 那份脚本被管道或捕获运行时就会起不了原生程序（PowerShell 报
# 「StandardOutputEncoding is only supported when standard output is redirected」，受限沙箱下报
# 「拒绝访问」），门禁会莫名失败。所以行为断言放这里，卡外壳那份只做源码断言。
#
# 用法：直接跑，不要接管道（`& .\tests\command-only.ps1`；`| Tee-Object` 之类会起不了 node）。
#
# 判定：六个用例全过为 PASS。命令行里带行内注释（`echo hi # 备注`）是 shell 语法的一部分，
# 必须原样保留——只有「行首 #」才算说明行。

$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:ModulePath = (Join-Path $script:RepoRoot 'shared\ui-card\app\src\commandText.ts').Replace('\', '/')

if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'shared\ui-card\app\src\commandText.ts'))) {
    Write-Output 'FAIL  复制（B-32）：找不到 app/src/commandText.ts'
    exit 1
}

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-commandonly-' + [guid]::NewGuid().ToString('n'))
$probeFile = "$base.mjs"
$resultFile = "$base.txt"
$logFile = "$base.log"

$probe = @'
import { commandOnly } from 'file:///__MODULE__'
import { writeFileSync } from 'node:fs'
const cases = [
  ['# 原因\ncmd --flag', 'cmd --flag'],
  ['# 原因\n# 第二行说明\nls -l /tmp', 'ls -l /tmp'],
  ['  # 缩进的注释\nGet-ChildItem', 'Get-ChildItem'],
  ['echo hi # 行内注释', 'echo hi # 行内注释'],
  ['\n\n# 说明\ndf -h\n\n', 'df -h'],
  ['', ''],
]
const bad = []
for (const [input, want] of cases) {
  const got = commandOnly(input)
  if (got !== want) bad.push(JSON.stringify(input) + ' -> ' + JSON.stringify(got))
}
writeFileSync('__RESULT__', bad.length === 0 ? 'OK' : bad.join(' | '), 'utf8')
'@.Replace('__MODULE__', $script:ModulePath).Replace('__RESULT__', $resultFile.Replace('\', '/'))

Set-Content -LiteralPath $probeFile -Value $probe -Encoding utf8
# 用 cmd 的 > 落文件（AGENTS.md 指定的写法）：PS 直接捕获原生输出在受限沙箱下必然失败。
cmd /c "node `"$probeFile`" > `"$logFile`" 2> `"$logFile.err`""

$verdict = ''
if (Test-Path -LiteralPath $resultFile) {
    $verdict = (Get-Content -Raw -LiteralPath $resultFile -Encoding utf8).Trim()
} else {
    $why = @()
    foreach ($path in @($logFile, "$logFile.err")) {
        if (Test-Path -LiteralPath $path) {
            $text = (Get-Content -Raw -LiteralPath $path).Trim()
            if ($text -ne '') { $why += $text }
        }
    }
    $hint = '（需要 node ≥ 22.18 才能直接 import .ts；另外本脚本必须直接运行，不能接管道）'
    $verdict = 'node 没写出结果' + $hint + ' ' + ($why -join ' ')
}

foreach ($path in @($probeFile, $resultFile, $logFile, "$logFile.err")) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

if ($verdict -eq 'OK') {
    Write-Output 'PASS  复制（B-32）：commandOnly 只留命令本体（六个用例全过）'
    exit 0
}

Write-Output "FAIL  复制（B-32）：$verdict"
exit 1
