# 高亮配色的行为断言：裸参数必须是正文色，只有带引号的字符串才是字符串色。
#
# 为什么单独一份：它要把 app/src/highlight.ts 真跑一遍（借 node 直接 import .ts），
# 掺进 card-shell.ps1 会让那份脚本在被管道/捕获运行时起不了原生程序（PowerShell 报
# 「StandardOutputEncoding is only supported when standard output is redirected」，受限沙箱下
# 报「拒绝访问」）。所以行为放这里，card-shell.ps1 只做源码断言。
#
# 用法：直接跑，不要接管道（`& .\tests\card-tokens.ps1`）。
#
# 钉住的事（DECISIONS D-31 附录 B 的回归）：
#   1. `echo xxxxx…` 的裸参数、`for i in 1 2 3` 的字面量、`wc -c` 的 `-c` **不许**是字符串色；
#   2. `'%s\n'` / `"step $i"` / `'s/a/b/g'` **必须**还是字符串色；
#   3. 通项：任何被涂成字符串色的 token，内容必须以引号（或反引号）开头——不闭合的字符串
#      会把后面整段吞成绿色，这条能直接逮住；
#   4. 命令 / 关键字 / 注释仍然各归各位。
#   5. 语言标记归一化（D-38）：空 / 全空白 / undefined → `sh`；`text` 不被吞、两端空白被去掉。
#   6. 说明作为**标准代码内容**交给 shiki（R-17 / D-42）：`comment` 非空时 `source = '# 说明\n' + 命令`，
#      说明行**必须带 `# ` 前缀**、整行是**一条**注释色 token、`content` 等于 `'# ' + 原文`；
#      多行说明每行一个 `# `；整段（含 `#` 行）拼回来逐字等于 source；认不出语言时 highlight 返回 null，
#      纯文本回退的 `#` 由 `commentSource` 补；缓存键带上说明（同一段命令配不同说明不串内容）；
#      空内容 + 有说明仍有输出。这一条真跑 highlight.ts，不是拿正则看源码。

$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:ModuleFile = Join-Path $script:RepoRoot 'shared\ui-card\app\src\highlight.ts'
if (-not (Test-Path -LiteralPath $script:ModuleFile)) {
    Write-Output 'FAIL  高亮（B-30）：找不到 app/src/highlight.ts'
    exit 1
}
$script:ModuleUrl = $script:ModuleFile.Replace('\', '/')
$script:LangModuleFile = Join-Path $script:RepoRoot 'shared\ui-card\app\src\codeLang.ts'
if (-not (Test-Path -LiteralPath $script:LangModuleFile)) {
    Write-Output 'FAIL  高亮（B-30）：找不到 app/src/codeLang.ts'
    exit 1
}
$script:LangModuleUrl = $script:LangModuleFile.Replace('\', '/')

$base = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-tokens-' + [guid]::NewGuid().ToString('n'))
$probeFile = "$base.mjs"
$resultFile = "$base.txt"
$logFile = "$base.log"

$probe = @'
import { commentSource, highlight } from 'file:///__MODULE__'
import { codeLang } from 'file:///__LANGMODULE__'
import { writeFileSync } from 'node:fs'

const FOREGROUND = 'var(--shiki-foreground)'
const STRING = 'var(--shiki-token-string)'
const STRING_EXPR = 'var(--shiki-token-string-expression)'
const XS = 'x'.repeat(700)
const B1 = `for i in 1 2 3 4 5 6 7 8 9 10; do\n  printf '%s\\n' "step $i";\ndone; echo ${XS} | wc -c`

const failures = []

function tokens(code, lang, comment) {
  const lines = highlight(code, lang, comment)
  if (lines === null) return null
  return lines.flatMap((line, index) => line.map((token) => ({ ...token, line: index + 1 })))
}

function expect(label, code, lang, predicate) {
  const list = tokens(code, lang)
  if (list === null) { failures.push(label + '：整段退成了纯文本'); return }
  const problem = predicate(list)
  if (problem) failures.push(label + '：' + problem)
}

function expectLang(label, raw, want) {
  const actual = codeLang(raw)
  if (actual !== want) {
    failures.push(`${label}：codeLang(${JSON.stringify(raw)}) = ${JSON.stringify(actual)}，应为 ${JSON.stringify(want)}`)
  }
}

const byContent = (list, text) => list.find((token) => token.content === text)
const isStringColor = (color) => color === STRING || color === STRING_EXPR

// 1. b1 那条长命令
expect('b1 700 个 x', B1, 'sh', (list) => {
  const long = list.find((token) => token.content === XS)
  if (!long) return '找不到那 700 个 x 的 token'
  if (long.color !== FOREGROUND) return `700 个 x 是 ${long.color}，应为正文色`
  const dash = byContent(list, '-c')
  if (!dash) return '找不到 -c'
  if (dash.color !== FOREGROUND) return `-c 是 ${dash.color}，应为正文色`
  const one = byContent(list, '1')
  if (!one) return '找不到循环里的 1'
  // 用户 2026-10-30：「数字算命令」——数字与命令同色（#1750EB），不再是正文色。
  if (one.color !== 'var(--shiki-token-constant)') return `循环字面量 1 是 ${one.color}，应为数字/命令色`
  const printf = byContent(list, 'printf')
  if (!printf || printf.color !== 'var(--shiki-token-function)') return 'printf 不是命令色'
  const quote = byContent(list, "'%s\\n'")
  if (!quote || !isStringColor(quote.color)) return "'%s\\n' 丢了字符串色"
  // 方案 B 给变量上色后，`"step $i"` 会被语法拆成三段：`"step ` / `$i` / `"`。
  // 前后两段仍是字符串色、中间的 `$i` 是变量色——这不是「字符串掉了色」，按实测分段判，
  // 别再用「整段一个 token」的旧口径（2026-10-30 用户选 B，D-34）。
  const stepOpen = list.find((token) => token.content === '"step ')
  if (!stepOpen || !isStringColor(stepOpen.color)) return '"step $i" 的前半段丢了字符串色'
  const stepClose = list.find((token) => token.content === '"' && isStringColor(token.color))
  if (!stepClose) return '"step $i" 的收尾引号丢了字符串色'
  const innerVar = list.find((token) => token.content === '$i')
  if (!innerVar || innerVar.color !== 'var(--shiki-token-variable)') return '"$i" 不是变量色（B 版应为变量青）'
  const forKeyword = byContent(list, 'for')
  if (!forKeyword || forKeyword.color !== 'var(--shiki-token-keyword)') return 'for 丢了关键字色'
  return null
})

// 2. 回归：printf + 反斜杠转义（上一轮怀疑「单引号没闭合」的地方）
expect('printf 单引号 + 转义', "printf '%s\\n' foo", 'sh', (list) => {
  const quote = byContent(list, "'%s\\n'")
  if (!quote || !isStringColor(quote.color)) return "'%s\\n' 不是字符串色"
  const foo = byContent(list, 'foo')
  if (!foo || foo.color !== FOREGROUND) return 'foo 不是正文色'
  return null
})

// 3. 回归：裸参数与选项
expect('裸参数/选项', 'df -h / && rm -rf /tmp/build', 'sh', (list) => {
  for (const text of ['-h', '/', '/tmp/build']) {
    const token = byContent(list, text)
    if (!token) return `找不到 ${text}`
    if (token.color !== FOREGROUND) return `${text} 是 ${token.color}，应为正文色`
  }
  return null
})

// 4. 回归：注释
expect('注释', '# 看目录\nls -l /root', 'sh', (list) => {
  const comment = list.find((token) => token.content.includes('看目录'))
  if (!comment) return '找不到注释 token'
  if (comment.color !== 'var(--shiki-token-comment)') return '注释不是注释色'
  return null
})

// 5. 通项：字符串色只能给带引号的内容（不闭合的字符串会吞掉后面整段，这条能逮住）
const BATTERY = [
  ['sh', B1],
  ['sh', "sed -i 's/a/b/g' /etc/hosts"],
  ['sh', 'docker ps -a --format "{{.Names}}"'],
  ['sh', 'echo $HOME ${PATH} $(date +%F)'],
  ['sh', "ssh root@192.168.1.11 'ls -l /root'"],
  ['powershell', 'Get-ChildItem -Path C:\\ -Recurse | Select-Object -First 20'],
  ['powershell', 'Copy-Item -LiteralPath C:\\a.txt -Destination D:\\b.txt -Force'],
  ['powershell', '$x = Get-Process | Where-Object { $_.CPU -gt 10 }'],
]
for (const [lang, code] of BATTERY) {
  expect(`字符串色通项（${lang}: ${code.slice(0, 24)}…）`, code, lang, (list) => {
    for (const token of list) {
      if (!isStringColor(token.color)) continue
      if (/^['"`]/.test(token.content.trim())) continue
      return `${JSON.stringify(token.content.slice(0, 24))} 被涂成字符串色但不是引号开头`
    }
    return null
  })
}

// 6. 语言标记归一化（D-38）：空 / 全空白 / undefined 归 sh；text 保留；两端空白去掉
expectLang('空字符串归 sh', '', 'sh')
expectLang('全空白归 sh', '   ', 'sh')
expectLang('undefined 归 sh', undefined, 'sh')
expectLang('text 不被吞', 'text', 'text')
expectLang('去掉两端空白', ' pwsh ', 'pwsh')

// 7. 说明作为标准代码内容交给 shiki（R-17 / D-42）：`# ` 拼进 source，颜色由注释 scope 决定。
const COMMENT = 'var(--shiki-token-comment)'
const linesOf = (code, lang, comment) => {
  const lines = highlight(code, lang, comment)
  if (lines === null) return null
  return lines.map((line) => ({ text: line.map((token) => token.content).join(''), tokens: line }))
}

{
  const lines = linesOf('df -h /', 'sh', '看磁盘占用')
  if (lines === null) {
    failures.push('说明并入行流：整段退成了纯文本（说明会丢）')
  } else {
    if (lines.length !== 2) failures.push(`说明并入行流：应为「1 行说明 + 1 行命令」= 2 行，实际 ${lines.length} 行`)
    const first = lines[0]
    if (first.tokens.length !== 1) failures.push(`说明行应是整行 1 条 token，实际 ${first.tokens.length} 条（说明被拆开了？）`)
    if (first.text !== '# 看磁盘占用') failures.push(`说明行内容是 ${JSON.stringify(first.text)}，应为 '# ' + 原文`)
    if (first.tokens.some((token) => token.color !== COMMENT)) {
      failures.push(`说明行不是整行注释色（有 token 是 ${first.tokens.find((token) => token.color !== COMMENT)?.color}）`)
    }
    if (lines[1].text !== 'df -h /') failures.push(`命令行被改了：${JSON.stringify(lines[1].text)}`)
  }
}

{
  // 多行说明：每行一个 `# `，逐行都是注释色。
  const lines = linesOf('echo hi', 'sh', '第一行说明\n第二行说明')
  if (lines === null) {
    failures.push('多行说明：整段退成了纯文本')
  } else {
    if (lines.length !== 3) failures.push(`多行说明：应为 3 行（2 说明 + 1 命令），实际 ${lines.length} 行`)
    if (lines[0] && lines[0].text !== '# 第一行说明') failures.push(`多行说明第 1 行是 ${JSON.stringify(lines[0].text)}`)
    if (lines[1] && lines[1].text !== '# 第二行说明') failures.push(`多行说明第 2 行是 ${JSON.stringify(lines[1].text)}`)
    for (const at of [0, 1]) {
      if (lines[at] && lines[at].tokens.some((token) => token.color !== COMMENT)) {
        failures.push(`多行说明第 ${at + 1} 行不是整行注释色`)
      }
    }
    if (lines[2] && lines[2].text !== 'echo hi') failures.push(`多行说明后面的命令被改了：${JSON.stringify(lines[2].text)}`)
  }
}

{
  // 拼回校验现在约束**整段**（含 `#` 说明行）：屏幕上每一行都逐字等于交给 shiki 的 source。
  const CODE = 'set -eu\nimport os'
  const lines = linesOf(CODE, 'sh', '脚本开头')
  if (lines === null) {
    failures.push('说明 + 多行命令：整段退成了纯文本')
  } else if (lines.map((line) => line.text).join('\n') !== '# 脚本开头\n' + CODE) {
    failures.push(`说明 + 命令整段与 source 不是逐字相同：${JSON.stringify(lines.map((line) => line.text))}`)
  }
}

{
  // 认不出语言：整段返回 null（交给 CodeText 的纯文本回退），`#` 由 commentSource 补上。
  if (linesOf('echo a\necho b', 'sql', '未知语言也不能丢说明') !== null) {
    failures.push('认不出语言：应当返回 null，交给 CodeText 的纯文本回退（那里才不着色、仍带 #）')
  }
  if (commentSource('未知语言也不能丢说明') !== '# 未知语言也不能丢说明') {
    failures.push(`纯文本回退的说明不是 '# ' + 原文：${JSON.stringify(commentSource('未知语言也不能丢说明'))}`)
  }
  if (commentSource('第一行\n第二行') !== '# 第一行\n# 第二行') {
    failures.push(`纯文本回退的多行说明不是每行一个 #：${JSON.stringify(commentSource('第一行\n第二行'))}`)
  }
  if (commentSource(undefined) !== '') failures.push('没有说明时 commentSource 应是空串')
  if (commentSource('   \n\n') !== '') failures.push('空白说明的 commentSource 应是空串（等于没有说明）')
}

{
  // 缓存键必须带上说明：同一段命令配不同说明不许串内容（先配 A、再配 B、再问一次 A）。
  const a1 = linesOf('echo hi', 'sh', '说明一')
  const b = linesOf('echo hi', 'sh', '说明二')
  const a2 = linesOf('echo hi', 'sh', '说明一')
  const bare = linesOf('echo hi', 'sh')
  if (!a1 || !b || !a2 || !bare) {
    failures.push('缓存：同一段命令换说明后整段退成了纯文本')
  } else {
    if (a1[0].text !== '# 说明一') failures.push(`缓存：第一次的说明行是 ${JSON.stringify(a1[0].text)}`)
    if (b[0].text !== '# 说明二') failures.push(`缓存：换说明后首行还是 ${JSON.stringify(b[0].text)}（缓存串内容了）`)
    if (a2[0].text !== '# 说明一') failures.push(`缓存：缓存命中后说明行变成了 ${JSON.stringify(a2[0].text)}`)
    if (bare[0].text !== 'echo hi') failures.push(`缓存：没有说明时首行不是命令，而是 ${JSON.stringify(bare[0].text)}`)
  }
}

{
  // 空内容 + 有说明：说明照样返回（行里 why 有、text 没有的情况）。
  const only = linesOf('', 'sh', '只有说明')
  if (only === null) {
    failures.push('空内容 + 有说明：说明被丢掉了（不许）')
  } else {
    if (only.length !== 1) failures.push(`空内容 + 有说明：应为 1 行，实际 ${only.length} 行`)
    if (only[0] && only[0].text !== '# 只有说明') failures.push(`空内容 + 有说明：说明内容被改了（${JSON.stringify(only[0].text)}）`)
    if (only[0] && only[0].tokens.some((token) => token.color !== COMMENT)) failures.push('空内容 + 有说明：说明不是注释色')
  }
  if (highlight('', 'sh') !== null) failures.push('空内容 + 没有说明：应返回 null（交给调用方按纯文本渲染）')
  if (linesOf('', 'sql', '只有说明') !== null) failures.push('空内容 + 认不出语言：应返回 null（纯文本回退）')
}

{
  // 空白说明按「没有说明」处理：不许因为多了一行空白就把命令挤下去。
  for (const blank of ['', '   ', '\n\n']) {
    const lines = linesOf('ls', 'sh', blank)
    if (lines === null) {
      failures.push(`空白说明 ${JSON.stringify(blank)}：整段退成了纯文本`)
    } else if (lines.length !== 1) {
      failures.push(`空白说明 ${JSON.stringify(blank)}：被当成 ${lines.length} 行说明（应等于没有说明）`)
    }
  }
}

writeFileSync('__RESULT__', failures.length === 0 ? 'OK' : failures.join('\n'), 'utf8')
'@.Replace('__MODULE__', $script:ModuleUrl).Replace('__LANGMODULE__', $script:LangModuleUrl).Replace('__RESULT__', $resultFile.Replace('\', '/'))

Set-Content -LiteralPath $probeFile -Value $probe -Encoding utf8
cmd /c "node `"$probeFile`" > `"$logFile`" 2> `"$logFile.err`""

$verdict = ''
if (Test-Path -LiteralPath $resultFile) {
    $verdict = (Get-Content -Raw -LiteralPath $resultFile -Encoding utf8).Trim()
} else {
    $why = @()
    foreach ($path in @($logFile, "$logFile.err")) {
        if (Test-Path -LiteralPath $path) {
            $raw = Get-Content -Raw -LiteralPath $path
            $text = if ($null -eq $raw) { '' } else { $raw.Trim() }
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
    Write-Output 'PASS  高亮（B-30/R-17/D-42）：裸参数不绿、引号字符串绿、关键字/注释/命令各归各位、空 lang 归 sh、说明带 # 交给 shiki 且整段逐字可还原'
    exit 0
}

Write-Output "FAIL  高亮（B-30）：$verdict"
exit 1
