# 守卫：共享外壳只有一份，插件里不许留副本、外壳里不许长业务概念、也不许混进调试代码。
#
# 跑法：pwsh -NoProfile -File tests\shared-ui-guard.ps1
#
# 五条断言（任一失败即视为分叉，退出码 1）：
#   1. 插件目录下不存在外壳文件副本（card-html / webview2 / environment / dist 产物）；
#   2. 插件目录下不存在 app / dist / node_modules 这一类「构建期目录」的副本；
#   3. shared/ui-card/ 里不出现插件专有词（ssh、审批、勾选、插件名）；
#   4. dot-source 外壳能产出缺省载荷的完整文档（不建窗、不需要提权）；
#   5. shared/ui-card/ 的正式路径文件里不出现调试专用符号（截图 / 出图 / 字体枚举 / 点击注入）。
#
# 两个插件都已接入共享外壳，所以这里没有「遗留副本豁免」：副本必须是零。
# 第 3、5 条跳过 app/node_modules 与 dist：前者是第三方依赖，后者是打包产物（含 antd 压缩代码），
# 扫它们只会得到假阳性。外壳自己的源码（.ps1 / .ts / .tsx / .css / .html / .json）才是断言对象；
# 文档（.md）不扫——讲清决策必须点名插件，那是结论不是耦合。

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:CardDir = Join-Path $script:RepoRoot 'shared\ui-card'
$script:Failures = 0
$script:Total = 0

# 外壳只允许有一份的文件（插件里出现任何一个同名文件都是副本）。
$script:ShellFiles = @('card-html.ps1', 'webview2.ps1', 'webview2-runtime.ps1')

# 构建期目录名：插件里出现就是「把 app 或产物拷进去了」。
$script:BuildDirs = @('app', 'dist')

# 插件专有词：外壳里出现任何一个都说明把业务塞进了通用层。
$script:BannedWords = @('ssh', '审批', 'allow-once', '勾选', 'dsh-ssh-remote', 'dsh-approval-notifier')

# 调试专用符号：只许出现在 shared/ui-card/debug/ 与 tests/ 里。
$script:DebugSymbols = @('shot', 'RenderTo', 'ScreenCapture', 'Get-InstalledFamil', 'card-click', 'CapturePreview', 'Bitmap')

$script:Plugins = @('dsh-approval-notifier', 'dsh-ssh-remote')

function Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )

    $script:Total++
    try {
        $result = & $Body
        if ($result -eq $true) {
            "PASS  $Name"
            return
        }
        "FAIL  $Name -> $result"
        $script:Failures++
    } catch {
        "FAIL  $Name -> 抛异常：$($_.Exception.Message)"
        $script:Failures++
    }
}

function Get-ShellSourceFiles {
    <#
    .SYNOPSIS
        外壳的「人写的源码」：跳过第三方依赖、打包产物、验收脚本与开发态样例。
    .DESCRIPTION
        - app/node_modules 与 dist 是别人的压缩代码，扫了只会假阳性；
        - debug 是验收脚本，本来就该有截图/出图符号；
        - app/src/fixtures 是「像真卡」的假数据，带业务词正是它的用途。
    #>
    $files = @(Get-ChildItem -LiteralPath $script:CardDir -Recurse -File -Force -ErrorAction SilentlyContinue)
    @($files | Where-Object {
            # 文档不算代码：DECISIONS.md 必须点名插件才能讲清「为什么」，把它纳入业务词扫描只会逼出含糊的写法。
            $_.Extension -in @('.ps1', '.ts', '.tsx', '.css', '.html', '.json') -and
            $_.FullName -notmatch '\\node_modules\\' -and
            $_.FullName -notmatch '\\dist\\' -and
            $_.FullName -notmatch '\\debug\\' -and
            $_.FullName -notmatch '\\fixtures\\'
        })
}

function Get-BannedPattern {
    <#
    .SYNOPSIS
        专有词的匹配式：纯 ASCII 词按词边界（避免 sshHeight 之类误判），中文直接匹配。
    #>
    param([Parameter(Mandatory = $true)][string]$Word)

    if ($Word -match '^[A-Za-z0-9._-]+$') { return ('(?<![A-Za-z0-9_])' + [regex]::Escape($Word) + '(?![A-Za-z0-9_])') }
    return [regex]::Escape($Word)
}

# ---- 1. 插件里没有外壳副本 -------------------------------------------------------

foreach ($plugin in $script:Plugins) {
    $pluginRoot = Join-Path $script:RepoRoot $plugin

    Check "副本：$plugin 里没有外壳文件" {
        if (-not (Test-Path -LiteralPath $pluginRoot)) { return "找不到插件目录 $pluginRoot" }
        $files = @(Get-ChildItem -LiteralPath $pluginRoot -Recurse -File -Force -ErrorAction SilentlyContinue)
        $hits = @()
        foreach ($file in $files) {
            if ($script:ShellFiles -contains $file.Name) { $hits += $file.FullName.Replace($pluginRoot + '\', '') }
        }
        if ($hits.Count -eq 0) { $true } else { '副本：' + ($hits -join '; ') }
    }

    Check "副本：$plugin 里没有 dist/index.html 或 app/ 目录" {
        $hits = @()
        $dirs = @(Get-ChildItem -LiteralPath $pluginRoot -Recurse -Directory -Force -ErrorAction SilentlyContinue)
        foreach ($dir in $dirs) {
            # node_modules 是构建期第三方依赖，里面本来就有几十个 dist\（eslint、acorn、ajv…）。
            # 扫它只会得到假阳性，而这条断言要防的是「把外壳的 app/ 或 dist/ 拷进插件」。
            if ($dir.FullName -match '\\node_modules\\') { continue }
            $relative = $dir.FullName.Replace($pluginRoot + '\', '')
            # 插件根上的 node_modules 合法（打 bundle 要安装依赖）；scripts\ 下出现就是拷贝了外壳的代码目录。
            if ($dir.Name -eq 'node_modules' -and $dir.FullName -match '\\scripts\\') { $hits += $relative; continue }
            if ($dir.Name -in $script:BuildDirs) { $hits += $relative }
        }
        if ($hits.Count -eq 0) { $true } else { '构建期目录副本：' + ($hits -join '; ') }
    }
}

# ---- 2. 外壳只有一份，且结构完整 -------------------------------------------------

Check '外壳：共享目录结构完整（拼装层 / 窗口层 / 运行环境层 / 产物）' {
    foreach ($name in @('card-html.ps1', 'webview2.ps1', 'webview2-runtime.ps1', 'environment.ps1', 'dist\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:CardDir $name))) { return "缺 $name" }
    }
    $true
}

Check '外壳：两个插件都 dot-source 的是同一份 shared/ui-card（没有本地路径兜底）' {
    foreach ($plugin in $script:Plugins) {
        $shared = Join-Path $script:RepoRoot $plugin 'scripts\ui\shared.ps1'
        if (-not (Test-Path -LiteralPath $shared)) { return "缺 $plugin 的 shared.ps1" }
        $text = Get-Content -Raw -LiteralPath $shared -Encoding utf8
        if ($text -notmatch 'Join-Path \$script:\w+CardShellDir .card-html\.ps1.') { return "$plugin 没有 dot-source 外壳拼装层" }
        if ($text -notmatch 'Join-Path \$script:\w+CardShellDir .webview2\.ps1.') { return "$plugin 没有 dot-source 外壳窗口层" }
    }
    $true
}

# ---- 3. 外壳里没有业务概念 -------------------------------------------------------

Check '外壳：正式路径的源码里没有插件专有词' {
    $files = @(Get-ShellSourceFiles)
    if ($files.Count -eq 0) { return '没找到外壳源码' }
    $hits = @()
    foreach ($file in $files) {
        foreach ($word in $script:BannedWords) {
            $lineHits = @(Select-String -LiteralPath $file.FullName -Pattern (Get-BannedPattern $word) -ErrorAction SilentlyContinue)
            foreach ($match in $lineHits) {
                $hits += ('{0}:{1} [{2}]' -f $file.Name, $match.LineNumber, $word)
            }
        }
    }
    if ($hits.Count -eq 0) { $true } else { '命中 ' + ($hits -join '; ') }
}

Check '外壳：载荷键名与 app/src/types.ts 对得上（不出现 powershell 风格的键名）' {
    $types = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'app\src\types.ts') -Encoding utf8
    $builder = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'card-html.ps1') -Encoding utf8
    foreach ($key in @('eyebrow', 'titleHtml', 'status', 'body', 'rows', 'buttons', 'armMs', 'closeMs', 'keyboard')) {
        if ($types -notmatch ('\b' + $key + '\??:')) { return "types.ts 缺字段 $key" }
        if ($builder -notmatch ('\b' + $key + '\b')) { return "card-html.ps1 不认识字段 $key" }
    }
    $true
}

# ---- 4. dot-source 外壳能生成文档 ------------------------------------------------

Check '外壳：dot-source 之后能产出带缺省载荷的完整文档' {
    . (Join-Path $script:CardDir 'card-html.ps1')
    . (Join-Path $script:CardDir 'webview2.ps1')
    $payload = New-CardPayload -Eyebrow '守卫自检' -Body @(New-CardCodeBlock -Command 'echo hi')
    $document = New-CardDocument -Payload $payload
    if ([string]::IsNullOrWhiteSpace($document)) { return '文档是空的' }
    if ($document.Length -lt 100000) { return "文档只有 $($document.Length) 字节，产物没内联？" }
    $inner = [regex]::Match($document, '(?s)<script id="dsh-payload"[^>]*>(.*?)</script>').Groups[1].Value
    if (-not $inner.Contains('守卫自检')) { return '载荷没进文档' }
    $true
}

# ---- 5. 正式路径里没有调试代码 ---------------------------------------------------

Check '外壳：正式路径的文件里没有调试专用符号' {
    $files = @(Get-ShellSourceFiles)
    $hits = @()
    foreach ($file in $files) {
        # assets\make-icon.ps1 是**生成图标资产的构建期脚本**（System.Drawing.Bitmap 是画布），
        # 不是运行路径上的截图/出图代码；图标产物本身是 card.ico / card-256.png。见 DECISIONS D-27。
        if ($file.FullName -match '\\assets\\') { continue }
        foreach ($symbol in $script:DebugSymbols) {
            $lineHits = @(Select-String -LiteralPath $file.FullName -Pattern $symbol -SimpleMatch -ErrorAction SilentlyContinue)
            foreach ($match in $lineHits) {
                $hits += ('{0}:{1} [{2}]' -f $file.Name, $match.LineNumber, $symbol)
            }
        }
    }
    if ($hits.Count -eq 0) { $true } else { '命中 ' + ($hits -join '; ') }
}

# ---------------------------------------------------------------------------
""
if ($script:Failures -gt 0) {
    "通过 $($script:Total - $script:Failures) / 失败 $($script:Failures)（共 $($script:Total) 项）"
    exit 1
}
"通过 $($script:Total) / 失败 0（共 $($script:Total) 项）"
exit 0
