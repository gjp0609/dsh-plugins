# tools/deploy.ps1 的校验层（D-35）：部署前的六道断言，任何一条不满足就 throw，一个字节都不写。
# 由 tools/deploy.ps1 用 dot-source 载入，不单独执行；这里没有任何 git 调用——
# 入口把 git 的结果（tag 是否存在、commit、porcelain 文本）作为参数传进来。

function Assert-SourceRoot {
    <#
    .SYNOPSIS
        -Source 必须是仓库/工作树的根（传插件子目录或随便一个目录都要拒绝）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TopLevel,
        [Parameter(Mandatory)][string]$Requested
    )

    if (Test-PathEqual $TopLevel $Requested) { return }
    throw "拒绝部署：-Source $Requested 不是仓库/工作树的根（git rev-parse --show-toplevel 是 $TopLevel）。"
}

function Assert-DeployTagState {
    <#
    .SYNOPSIS
        tag 必须存在，而且必须就钉在当前 HEAD 上（祖先不算——那是旧提交，不能拿来上线）。
    .PARAMETER Relation
        head = tag 与 HEAD 是同一个提交；ancestor = tag 在 HEAD 的祖先上；other = 无关。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][bool]$RefExists,
        [string]$TagCommit = '',
        [string]$Head = '',
        [ValidateSet('head', 'ancestor', 'other', 'unknown')][string]$Relation = 'unknown'
    )

    if (-not $RefExists) {
        throw "拒绝部署：tag '$TagName' 不存在（git rev-parse --verify refs/tags/$TagName 失败）。先打 tag 再部署。"
    }
    if ($Relation -eq 'head') { return }

    $tagShort = if ($TagCommit.Length -ge 8) { $TagCommit.Substring(0, 8) } else { $TagCommit }
    $headShort = if ($Head.Length -ge 8) { $Head.Substring(0, 8) } else { $Head }
    if ($Relation -eq 'ancestor') {
        throw "拒绝部署：tag '$TagName' 指向 $tagShort，它在 HEAD 的祖先上（HEAD 是 $headShort）。" +
            '上线必须给当前 HEAD 本身打 tag，不能拿旧提交的 tag 上线。'
    }
    throw "拒绝部署：tag '$TagName' 指向 $tagShort，HEAD 是 $headShort，两者不是同一个提交。" +
        '上线必须给当前 HEAD 本身打 tag。'
}

function Assert-CleanWorktree {
    <#
    .SYNOPSIS
        有未提交改动就拒绝：生产里跑的东西必须能在 git 里找回来。
    #>
    [CmdletBinding()]
    param([string]$PorcelainText = '')

    if ($PorcelainText -eq '') { return }
    $lines = @($PorcelainText -split "`r?`n" | Where-Object { $_ -ne '' })
    $shown = ($lines | Select-Object -First 8) -join "`n"
    throw "拒绝部署：工作区有未提交改动，先提交或还原再部署。`n$shown"
}

function Assert-CardArtifact {
    <#
    .SYNOPSIS
        dist/index.html 必须存在且是单文件产物：任何 <script src> / <link href> 都意味着运行时还要外部文件，
        生产树里没有那些文件，卡片会白屏。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourceDir)

    $artifact = Join-Path $SourceDir 'shared\ui-card\dist\index.html'
    if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
        throw '拒绝部署：找不到构建产物 shared\ui-card\dist\index.html（先构建并提交产物）。'
    }

    $html = [string](Get-Content -Raw -LiteralPath $artifact -Encoding utf8)
    $scriptSrc = [regex]::Matches($html, '<script\b[^>]*\bsrc\s*=', 'IgnoreCase').Count
    $linkHref = [regex]::Matches($html, '<link\b[^>]*\bhref\s*=', 'IgnoreCase').Count
    if ($scriptSrc -eq 0 -and $linkHref -eq 0) { return }

    throw "拒绝部署：dist\index.html 不是单文件产物（发现 $scriptSrc 处 <script src>、$linkHref 处 <link href>）。" +
        '生产树只带这一份 HTML，外部引用会让卡片白屏；先修构建再部署。'
}

function Assert-BundleArtifacts {
    <#
    .SYNOPSIS
        打包插件的产物必须是新的：index.bundle.js 要在，而且不能比 index.js 旧。
    .DESCRIPTION
        生产树只带单文件产物（ssh2 内联进 index.bundle.js），所以产物不在就没得部署；
        产物比入口源码旧说明改了 index.js 却没重新打包，上线的是旧逻辑。两者都硬失败。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourceDir)

    foreach ($plugin in $script:BundledPluginNames) {
        $pluginDir = Join-Path $SourceDir $plugin
        $relative = Join-Path $plugin $script:BundleFileName
        $bundle = Join-Path $pluginDir $script:BundleFileName

        if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) {
            throw "拒绝部署：找不到 $relative。生产树只带打包产物（单文件、依赖已内联）；" +
                '先在插件目录跑 `npm run build`，把产物提交后再部署。'
        }

        # index.js 是打包入口（它本身不上生产）。它不存在时没有对照物，跳过这条一致性校验。
        $entry = Join-Path $pluginDir 'index.js'
        if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { continue }

        $bundleTime = (Get-Item -LiteralPath $bundle).LastWriteTimeUtc
        $entryTime = (Get-Item -LiteralPath $entry).LastWriteTimeUtc
        if ($bundleTime -ge $entryTime) { continue }

        $format = 'yyyy-MM-dd HH:mm:ss'
        throw "拒绝部署：$relative 比 index.js 旧（产物 $($bundleTime.ToLocalTime().ToString($format))" +
            "，源码 $($entryTime.ToLocalTime().ToString($format))），说明改了源码没重新打包。" +
            '先在插件目录跑 `npm run build`，把产物提交后再部署。'
    }
}

function Assert-DeployItemsComplete {
    <#
    .SYNOPSIS
        清单必须真的含运行时入口；漏掉时在写盘之前就报错，而不是等卡片白屏才发现。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Items)

    $present = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $Items) { [void]$present.Add($item.Relative) }

    $required = @(
        'shared\ui-card\card-html.ps1',
        'shared\ui-card\webview2.ps1',
        'shared\ui-card\webview2-runtime.ps1',
        'shared\ui-card\dist\index.html',
        'vendor\webview2\Microsoft.Web.WebView2.Core.dll',
        'vendor\webview2\Microsoft.Web.WebView2.WinForms.dll',
        'vendor\webview2\WebView2Loader.dll'
    )
    foreach ($plugin in $script:PluginNames) {
        $required += (Join-Path $plugin 'package.json')
    }

    $missing = @(foreach ($path in $required) { if (-not $present.Contains($path)) { $path } })
    if ($missing.Count -gt 0) {
        throw "拒绝部署：清单里缺少运行时必需的文件：`n" + (($missing | ForEach-Object { "  $_" }) -join "`n")
    }

    foreach ($plugin in $script:PluginNames) {
        if ($script:BundledPluginNames -contains $plugin) {
            if (-not $present.Contains((Join-Path $plugin $script:BundleFileName))) {
                throw "拒绝部署：打包插件 $plugin 的产物 $($script:BundleFileName) 不在清单里。"
            }
            continue
        }
        $hasEntry = $present.Contains((Join-Path $plugin 'index.js')) -or
            $present.Contains((Join-Path $plugin 'index.mjs'))
        if (-not $hasEntry) {
            throw "拒绝部署：插件 $plugin 的入口 index.js / index.mjs 不在清单里。"
        }
        if ($script:PluginRequiredFiles.ContainsKey($plugin)) {
            foreach ($relative in $script:PluginRequiredFiles[$plugin]) {
                if (-not $present.Contains((Join-Path $plugin $relative))) {
                    throw "拒绝部署：插件 $plugin 缺少运行时文件 $relative（不在清单里）。"
                }
            }
        }
    }
}
