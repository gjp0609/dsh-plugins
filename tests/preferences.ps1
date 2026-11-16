# 断言 PREFERENCES.md 里那些「机器能查」的偏好在代码里还成立。
#   为什么需要它：偏好只写在文档里，会在某次重构里被悄悄推翻（P-01 就这么丢过一次）。
#   这里不重复偏好本身，只做「载体还在不在」的检查；真正的行为断言在各自的测试里。
#
# 跑法：& <repo>\tests\preferences.ps1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
    $mark = if ($Ok) { 'ok  ' } else { 'FAIL' }
    Write-Host ("{0} {1}{2}" -f $mark, $Name, $(if ($Detail) { "  → $Detail" } else { '' }))
}

function Get-Text {
    param([string]$RelativePath)
    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path)) { throw "缺文件：$RelativePath" }
    Get-Content -Raw -LiteralPath $path
}

function Test-FileHas {
    param([string]$RelativePath, [string]$Pattern, [string]$What)
    $path = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $path)) { Add-Check $What $false "缺文件 $RelativePath"; return }
    $text = Get-Content -Raw -LiteralPath $path
    Add-Check $What ($text -match $Pattern) $RelativePath
}

# B-02 字体：两个 token + body 栈都以中文族名开头，且字体断言还在。
Test-FileHas 'shared/ui-card/app/src/main.tsx' 'fontFamily:.*等距更纱黑体 SC' 'B-02 main.tsx 的 fontFamily 用等距更纱黑体 SC'
Test-FileHas 'shared/ui-card/app/src/main.tsx' 'fontFamilyCode:.*等距更纱黑体 SC' 'B-02 main.tsx 的 fontFamilyCode 也用同一款'
Test-FileHas 'shared/ui-card/app/src/styles.css' "font-family:\s*'等距更纱黑体 SC'" 'B-02 body 字体栈第一位是中文族名'
$fontTest = Join-Path $repoRoot 'dsh-approval-notifier\tests\card-font.ps1'
if (-not (Test-Path -LiteralPath $fontTest)) {
    Add-Check 'B-02 字体断言文件还在' $false 'card-font.ps1 被删了'
} else {
    $ft = Get-Content -Raw -LiteralPath $fontTest
    Add-Check 'B-02 字体断言文件还在' $true
    Add-Check 'B-02 断言用的是渲染引擎（不是只看 CSS）' ($ft -match 'CSS\.getPlatformFontsForNode')
    Add-Check 'B-02 断言要求落笔字体是 Sarasa' ($ft -match '等距更纱黑体|Sarasa Mono')
}

# C-01 不做自动鼠标操作：只扫**产品代码**（插件脚本、外壳宿主），不扫测试与历史原型。
#   历史原型在 .session-files/ 里（AntdUI 时代的探索脚本），那不是线上代码；
#   测试里出现这些名字往往是断言文本。
$productRoots = @(
    (Join-Path $repoRoot 'dsh-approval-notifier\scripts'),
    (Join-Path $repoRoot 'dsh-ssh-remote\scripts'),
    (Join-Path $repoRoot 'shared\ui-card')
)
$offenders = @($productRoots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Recurse -File -Include '*.ps1', '*.psm1' -ErrorAction SilentlyContinue
    } | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' } |
    Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'SetCursorPos|SendInput|mouse_event|SendKeys' })
Add-Check 'C-01 产品代码里没有自动鼠标/键盘注入' ($offenders.Count -eq 0) (($offenders | ForEach-Object { $_.FullName }) -join ', ')

# P-03 方形边：外壳的圆角默认值必须是 0。
Test-FileHas 'shared/ui-card/webview2.ps1' '\$CornerRadius\s*=\s*0' 'B-05 圆角默认值为 0'

# B-07 是用户的「高度合适 + 三段式」；具体数值是实现选择（DECISIONS D-10），
#   这里只守「实现别漂走」，不把这些数字当成用户偏好。
Test-FileHas 'shared/ui-card/webview2.ps1' 'Max\(160,' 'D-10 实现选择：高度下限 160'
Test-FileHas 'shared/ui-card/webview2.ps1' '760' 'D-10 实现选择：高度上限 760'
Test-FileHas 'shared/ui-card/webview2.ps1' '0\.62' 'D-10 实现选择：屏高 62%'

# P-05/P-06/P-07：载荷里的默认值。
Test-FileHas 'dsh-approval-notifier/scripts/ui/shared.ps1' 'keyboard' 'C-03 审批卡声明 keyboard'
Test-FileHas 'dsh-approval-notifier/scripts/ui/shared.ps1' "'none'" 'C-03 审批卡 keyboard=none'
Test-FileHas 'shared/ui-card/app/src/App.tsx' "type: 'cancel'" 'C-04 关闭按钮只发 cancel'

# P-08 命令原文不加 $ 前缀。
Test-FileHas 'tests/fixtures/approval.json' '"command":\s*"(?!\$ )' 'C-08 样例命令没有 $ 前缀'
Test-FileHas 'dsh-approval-notifier/scripts/ui/shared.ps1' '\$command = \[string\]' 'C-08 业务层原样取命令'

# P-09 产物单文件、无外链。
$dist = Join-Path $repoRoot 'shared/ui-card/dist/index.html'
if (-not (Test-Path -LiteralPath $dist)) {
    Add-Check 'D-06 构建产物存在' $false 'dist/index.html 不在（改 UI 后要跑构建并提交）'
} else {
    $html = Get-Content -Raw -LiteralPath $dist
    Add-Check 'D-06 构建产物存在' $true
    Add-Check 'D-06 产物里没有外链样式/脚本' (($html -notmatch 'src="/') -and ($html -notmatch '<link rel="stylesheet"'))
    Add-Check 'D-06 产物里有 payload 占位' ($html -match 'id="dsh-payload"')
}

# B-09 出图要能指定底色，否则白底会掩盖多余渲染。
Test-FileHas 'shared/ui-card/debug/render.ps1' 'Backdrop' 'B-09 render.ps1 支持 -Backdrop'

# ---- 跨插件部分（这些偏好管的是「所有插件、所有改动」，不只卡片）----------------

# B-01 不要自绘：产品代码里不该再有 AntdUI / WinForms 控件（测试里的断言文本不算）。
$uiRoots = @(
    (Join-Path $repoRoot 'dsh-approval-notifier'),
    (Join-Path $repoRoot 'dsh-ssh-remote'),
    (Join-Path $repoRoot 'shared')
)
$uiOffenders = @($uiRoots | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
        Get-ChildItem -LiteralPath $_ -Recurse -File -Include '*.ps1', '*.psm1', '*.js', '*.mjs' -ErrorAction SilentlyContinue
    } | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\tests\\' } |
    Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'AntdUI' })
Add-Check 'B-01 产品代码里没有 AntdUI 引用（自绘已退役）' ($uiOffenders.Count -eq 0) (($uiOffenders | ForEach-Object { $_.FullName }) -join ', ')

# E-02 正式与测试分离、部署看时机：AGENTS §1 必须有这两条，不能只剩一句「要重启」。
Test-FileHas 'AGENTS.md' '只接受' 'E-02 AGENTS 写明正式环境只接受部署'
Test-FileHas 'AGENTS.md' '回滚点' 'E-02 AGENTS 要求部署前留回滚点'
Test-FileHas 'AGENTS.md' '正在用' 'E-02 AGENTS 要求部署前确认没人在用'

# D-02 单文件超过上限就记下来（技术债清单的来源，不算失败，避免把已有债务变成红灯）。
$long = @(Get-ChildItem -LiteralPath $repoRoot -Recurse -File -Include '*.ps1', '*.mjs' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\\.agents\\' } |
    Where-Object { (Get-Content -LiteralPath $_.FullName).Count -gt 450 })
Add-Check 'D-02 超长文件清单（>450 行，技术债）' $true (($long | ForEach-Object { "$($_.Name)=$((Get-Content -LiteralPath $_.FullName).Count)" }) -join ', ')

# E-04 偏好清单是**项目文档**，放在项目根（不在某个 worktree 里）；从工作树往上找。
#   工作树的 .git 是 gitfile，文件本身不随分支走，所以只能逐级向上定位。
$projectRoot = $null
$probe = $repoRoot
for ($i = 0; $i -lt 6 -and $probe; $i++) {
    # PREFERENCES.md 随分支入库，工作树里也有一份；落在 .agents\worktrees\ 的那层不是项目根，
    # 跳过它继续往上找，否则在 worktree 里跑守卫会假失败。
    if ($probe -notmatch '\\\.agents\\worktrees\\' -and
        (Test-Path -LiteralPath (Join-Path $probe 'PREFERENCES.md'))) { $projectRoot = $probe; break }
    $parent = Split-Path -Parent $probe
    if ($parent -eq $probe) { break }
    $probe = $parent
}
if (-not $projectRoot) { $projectRoot = $repoRoot }
$pref = Join-Path $projectRoot 'PREFERENCES.md'

$copies = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\\.agents\\|\\\.session-files\\' } |
    Where-Object { $_.Name -match 'PREFERENCE|STYLE' -and $_.FullName -ne $pref })
Add-Check 'E-04 偏好只有 PREFERENCES.md 一份' ($copies.Count -eq 0) (($copies | ForEach-Object { $_.FullName }) -join ', ')

# 偏好文档本身必须在项目根，且不能膨胀到没人愿意读（超过 140 行就该分节或删旧条目）。
if (-not (Test-Path -LiteralPath $pref)) {
    Add-Check 'PREFERENCES.md 在项目根' $false "找不到（从 $repoRoot 向上找了 6 级）"
} else {
    Add-Check 'PREFERENCES.md 在项目根（不跟着分支跑）' ($projectRoot -notmatch '\\\.agents\\worktrees\\') $pref
    $lines = (Get-Content -LiteralPath $pref).Count
    Add-Check 'PREFERENCES.md 不过长' ($lines -lt 140) "$lines 行"
}

# E-06 待办清单在项目根，且是「可勾选」的活清单（不是一段散文）。
#
# 计数口径（2026-11-01 修）：清单的主结构是**表格**（编号 + 判定方式 + 状态），勾选框只用在「七、清理」。
# 原来只数 `- [ ]`，一旦清理项勾完就会误报「没有未完成条目」——那说明的是清单还在，不是活干完了。
# 现在：表格行（T- / R- / 纯数字编号）与未勾选勾选框**都算未完成条目**。
$backlog = Join-Path $projectRoot 'BACKLOG.md'
if (-not (Test-Path -LiteralPath $backlog)) {
    Add-Check 'E-06 BACKLOG.md 在项目根' $false "找不到 $backlog"
} else {
    $bl = Get-Content -Raw -LiteralPath $backlog
    $openBoxes = ([regex]::Matches($bl, '(?m)^\s*- \[ \]')).Count
    # 只数「数据行」：表头（编号）与分隔行（:---）不算。
    $tableRows = ([regex]::Matches($bl, '(?m)^\|\s*(T-\d+|R-\d+|\d+)\s*\|')).Count
    $open = $openBoxes + $tableRows
    Add-Check 'E-06 BACKLOG.md 在项目根' $true $backlog
    Add-Check 'E-06 BACKLOG.md 有未完成条目' ($open -gt 0) "未完成 $open 条（表格 $tableRows + 勾选框 $openBoxes）"
}

# B-24 卡片落位跟「当前活动窗口所在的那块屏」走：屏幕只解析一处，落位不再硬编码主屏。
Test-FileHas 'shared/ui-card/environment.ps1' 'function Get-CardScreenArea' 'B-24 屏幕解析函数还在'
Test-FileHas 'shared/ui-card/environment.ps1' 'GetForegroundWindow' 'B-24 按前台窗口取屏'
Add-Check 'B-24 落位断言还在' (Test-Path -LiteralPath (Join-Path $repoRoot 'tests\card-placement.ps1')) 'tests/card-placement.ps1'
Add-Check 'B-24 落位不硬编码主屏' ((Get-Text 'shared/ui-card/webview2.ps1') -notmatch 'PrimaryScreen') 'webview2.ps1'


# B-45 结构化内容逐行给：需求卡模板与状态块都得是「每字段一行」，挤成一段就退回老毛病。
$agentsText = Get-Text 'AGENTS.md'
Add-Check 'B-45 需求卡模板是逐行字段（- 原话 / 我理解的 / …）' `
    ($agentsText -match '(?s)- 原话：.*- 我理解的：.*- 规格：') 'AGENTS.md §7.1'
Add-Check 'B-45 状态块是四行（在做 / 卡住 / 下一步 / 等你）' `
    ($agentsText -match '(?s)在做：.*卡住：.*下一步：.*等你：') 'AGENTS.md §5'
Add-Check 'B-45 偏好行在位' ((Get-Text 'PREFERENCES.md') -match '\| B-45 \|') 'PREFERENCES.md'

# B-46 前端布局只用现代布局方式（grid/flex）：列宽一次定死，不再用 table + th:nth-child 百分比 + 单元格 padding。
#   载体：dsh-ssh-remote 设置页的两张列表；一旦有人写回 table 布局这条就红。
$sshClient = Get-Text 'dsh-ssh-remote/lib/client.js'
Add-Check 'B-46 列表布局用 grid-template-columns' ($sshClient -match 'grid-template-columns') 'client.js'
Add-Check 'B-46 不再用 table-layout' (-not ($sshClient -match 'table-layout')) 'client.js'
Add-Check 'B-46 不再有 th:nth-child 列宽' (-not ($sshClient -match 'th:nth-child')) 'client.js'
Add-Check 'B-46 单元格可压缩（minmax(0, 1fr)）' ($sshClient -match 'minmax\(0, 1fr\)') 'client.js'
Add-Check 'B-46 偏好行在位' ((Get-Text 'PREFERENCES.md') -match '\| B-46 \|') 'PREFERENCES.md'

# E-07 问部署/重启必须先说清「对当前正在运行的会话有没有影响」——载体是 AGENTS.md §7.1 的那段措辞。
Add-Check 'E-07 AGENTS.md 要求部署前说明会话影响' `
    ($agentsText -match '问部署/重启必须先说清「对当前正在运行的会话有没有影响」') 'AGENTS.md §7.1'
Add-Check 'E-07 偏好行在位' ((Get-Text 'PREFERENCES.md') -match '\| E-07 \|') 'PREFERENCES.md'

# B-43 决定「放行什么」的配置不许放在模型可写的地方（工作区内）；只能在工作区外的数据目录。
# 载体：approval-allow 的配置路径由 dataDir 拼、且代码里没有按项目根拼配置的写法。
$allowConfigPath = Join-Path $repoRoot 'dsh-approval-allow\lib\config.mjs'
if (Test-Path -LiteralPath $allowConfigPath) {
    $allowConfig = Get-Content -Raw -LiteralPath $allowConfigPath
    Add-Check 'B-43 白名单配置文件只在 dataDir（工作区外）' ($allowConfig -match "join\(dataDir, CONFIG_FILE_NAME\)") 'config.mjs'
    $rootJoined = @($allowConfig -split "`r?`n" | Where-Object {
            $_.Trim() -notmatch '^(\*|//)' -and $_ -match "projectRoot.*(\.dsh|allow\.json)|join\(projectRoot"
        })
    Add-Check 'B-43 不读工作区里的同名配置' ($rootJoined.Count -eq 0) $(if ($rootJoined.Count -eq 0) { '没有按项目根拼路径' } else { "命中 $($rootJoined.Count) 行" })
    Add-Check 'B-43 唯一的插件数据目录是 plugin-data' ($allowConfig -match "'plugin-data'") 'resolveDataDir 用 <DSH_HOME>/plugin-data/<插件>'
} else {
    Add-Check 'B-43 白名单配置文件只在 dataDir（工作区外）' $false '缺 dsh-approval-allow/lib/config.mjs'
}

# B-47 SSH 插件的弹窗只剩「执行/复制」的勾选卡（＝审批）；主机维护只在设置页。
# 载体：ssh 插件不再注册 ssh_jms 工具、ssh_admin 只剩只读 list、dialog 只剩 select 模式。
$sshIndexPath = Join-Path $repoRoot 'dsh-ssh-remote\index.js'
$sshAdminPath = Join-Path $repoRoot 'dsh-ssh-remote\lib\admin.mjs'
$sshDialogPath = Join-Path $repoRoot 'dsh-ssh-remote\scripts\dialog.ps1'
if ((Test-Path -LiteralPath $sshIndexPath) -and (Test-Path -LiteralPath $sshAdminPath) -and (Test-Path -LiteralPath $sshDialogPath)) {
    $sshIndex = Get-Content -Raw -LiteralPath $sshIndexPath
    $sshAdmin = Get-Content -Raw -LiteralPath $sshAdminPath
    $sshDialog = Get-Content -Raw -LiteralPath $sshDialogPath
    Add-Check 'B-47 不再注册 ssh_jms 工具' (-not ($sshIndex -match 'createJmsTool|ssh_jms')) 'index.js 里没有批量接入工具'
    Add-Check 'B-47 会话侧只读：没有 add_host / set_label / remove_host' (
        -not ($sshAdmin -match "'add_host'|'set_label'|'remove_host'")) 'admin.mjs 只剩只读 list'
    Add-Check 'B-47 dialog 只剩 select 模式' (
        ($sshDialog -match "ValidateSet\('select'\)") -and -not ($sshDialog -match "'confirm'|'form'")) 'dialog.ps1'
    Add-Check 'B-47 偏好行在位' ((Get-Text 'PREFERENCES.md') -match '\| B-47 \|') 'PREFERENCES.md'
} else {
    Add-Check 'B-47 SSH 插件文件在位' $false '缺 index.js / lib/admin.mjs / scripts/dialog.ps1'
}

$failed = @($checks | Where-Object { -not $_.Ok }).Count
Write-Host ''
Write-Host ('通过 {0} / 失败 {1}（共 {2} 项）' -f ($checks.Count - $failed), $failed, $checks.Count)
if ($failed -gt 0) {
    Write-Host '失败项说明某条用户偏好失去了载体——要么恢复实现/断言，要么先问用户能不能改。'
}
exit $(if ($failed -eq 0) { 0 } else { 1 })
