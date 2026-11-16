# tools/deploy.ps1 的清单层（D-35）：白名单搬运清单与打包插件的 package.json 改写。
# 由 tools/deploy.ps1 用 dot-source 载入，不单独执行；插件名、排除表、必搬文件等常量留在入口。

function Get-PluginDeployItems {
    <#
    .SYNOPSIS
        一个插件要搬的文件清单（相对路径以正式树根为基准）。
    .DESCRIPTION
        两种形态：
          * 打包插件：只搬 index.bundle.js + cordis.patch.yml + package.json 与 scripts\、lib\ 两个
            运行时子目录；index.js、pnpm-lock.yaml、tests\、node_modules 一律不上生产。
          * 其它插件：整目录按排除表过滤（源码目录、依赖、测试、文档都不进生产）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourceDir, [Parameter(Mandatory)][string]$PluginName)

    $pluginDir = Join-Path $SourceDir $PluginName
    if (-not (Test-Path -LiteralPath $pluginDir -PathType Container)) {
        throw "拒绝部署：找不到插件目录 $PluginName（在 $SourceDir 下）。"
    }

    $items = [System.Collections.Generic.List[object]]::new()

    if ($script:BundledPluginNames -contains $PluginName) {
        foreach ($fileName in $script:BundledPluginFiles) {
            $filePath = Join-Path $pluginDir $fileName
            if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                throw "拒绝部署：打包插件 $PluginName 里缺少 $fileName（生产树只带打包产物）。"
            }
            $items.Add((New-DeployItem -FullPath $filePath -RelativePath (Join-Path $PluginName $fileName)))
        }
        foreach ($dirName in $script:BundledPluginDirs) {
            $dirPath = Join-Path $pluginDir $dirName
            if (-not (Test-Path -LiteralPath $dirPath -PathType Container)) {
                throw "拒绝部署：打包插件 $PluginName 里缺少 $dirName\（运行时脚本在这个目录里）。"
            }
            foreach ($file in Get-ChildItem -LiteralPath $dirPath -Recurse -File -Force) {
                $relative = [System.IO.Path]::GetRelativePath($pluginDir, $file.FullName)
                $items.Add((New-DeployItem -FullPath $file.FullName -RelativePath (Join-Path $PluginName $relative)))
            }
        }
        return $items
    }

    foreach ($file in Get-ChildItem -LiteralPath $pluginDir -Recurse -File -Force) {
        $relative = [System.IO.Path]::GetRelativePath($pluginDir, $file.FullName)
        if (Test-ExcludedRelativePath -RelativePath $relative) { continue }
        $items.Add((New-DeployItem -FullPath $file.FullName -RelativePath (Join-Path $PluginName $relative)))
    }
    $items
}

function Get-DeployItems {
    <#
    .SYNOPSIS
        算出要搬的文件清单（相对路径以正式树根为基准）。
    .DESCRIPTION
        白名单，不是整树复制：插件按各自形态过滤（见 Get-PluginDeployItems），卡片外壳只留
        *.ps1 + dist + assets，vendor 只留 WebView2 的三个 DLL。多搬一个字节都是正式树上的噪声。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$SourceDir)

    $items = [System.Collections.Generic.List[object]]::new()

    foreach ($plugin in $script:PluginNames) {
        foreach ($item in Get-PluginDeployItems -SourceDir $SourceDir -PluginName $plugin) {
            $items.Add($item)
        }
    }

    $uiCardDir = Join-Path $SourceDir 'shared\ui-card'
    if (-not (Test-Path -LiteralPath $uiCardDir -PathType Container)) {
        throw "拒绝部署：找不到卡片外壳 shared\ui-card（在 $SourceDir 下）。"
    }
    foreach ($file in Get-ChildItem -LiteralPath $uiCardDir -File -Force) {
        if ($file.Extension -ne '.ps1') { continue }
        $items.Add((New-DeployItem -FullPath $file.FullName -RelativePath (Join-Path 'shared\ui-card' $file.Name)))
    }
    foreach ($sub in $script:UiCardSubDirs) {
        $subDir = Join-Path $uiCardDir $sub
        if (-not (Test-Path -LiteralPath $subDir -PathType Container)) {
            throw "拒绝部署：卡片外壳缺少 shared\ui-card\$sub（构建产物或图标没入库）。"
        }
        foreach ($file in Get-ChildItem -LiteralPath $subDir -Recurse -File -Force) {
            $relative = [System.IO.Path]::GetRelativePath($uiCardDir, $file.FullName)
            $items.Add((New-DeployItem -FullPath $file.FullName -RelativePath (Join-Path 'shared\ui-card' $relative)))
        }
    }

    # WebView2 的三个 DLL（webview2-runtime.ps1 从卡片目录向上最多找 6 层 vendor\webview2）。
    # 正式树里卡片在 production\shared\ui-card，所以要落在 production\vendor\webview2；少了它们卡片起不来，
    # 审批退回浏览器、ssh 卡直接失败。它们不属于任何一个插件，所以不在插件目录里搬。
    $vendorDir = Join-Path $SourceDir 'vendor\webview2'
    if (-not (Test-Path -LiteralPath $vendorDir -PathType Container)) {
        throw '拒绝部署：找不到 vendor\webview2（WebView2 的三个 DLL 没入库？）。'
    }
    foreach ($file in Get-ChildItem -LiteralPath $vendorDir -File -Force -Filter '*.dll') {
        $items.Add((New-DeployItem -FullPath $file.FullName -RelativePath (Join-Path 'vendor\webview2' $file.Name)))
    }

    Assert-DeployItemsComplete -Items $items
    $items
}

function Get-BundledPackageJson {
    <#
    .SYNOPSIS
        把插件 package.json 改写成生产用的版本：main 与 exports["."] 指到单文件产物，
        files 里的 index.js 换成产物名，并删掉 dependencies（生产不装依赖）。
    .DESCRIPTION
        其它字段（name / type / dsh / scripts …）原样保留，键的顺序也保持原样。返回 JSON 文本，
        由调用方写到正式树那一份；仓库里的 package.json 不动。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Json, [Parameter(Mandatory)][string]$BundleFileName)

    $package = $Json | ConvertFrom-Json
    if ($null -eq $package) { throw '拒绝部署：package.json 解析结果为空。' }

    $entryPoint = './' + $BundleFileName
    $result = [ordered]@{}
    foreach ($property in $package.PSObject.Properties) {
        $name = $property.Name
        if ($name -eq 'dependencies') { continue }
        if ($name -eq 'main') {
            $result['main'] = $entryPoint
            continue
        }
        if ($name -eq 'exports') {
            if ($property.Value -isnot [System.Management.Automation.PSCustomObject]) {
                # exports 写成字符串时只表示根导出，等价于只留 "." 一项。
                $result['exports'] = $entryPoint
                continue
            }
            $exports = [ordered]@{}
            $hasRoot = $false
            foreach ($entry in $property.Value.PSObject.Properties) {
                if ($entry.Name -eq '.') {
                    $exports['.'] = $entryPoint
                    $hasRoot = $true
                } else {
                    $exports[$entry.Name] = $entry.Value
                }
            }
            if (-not $hasRoot) { $exports['.'] = $entryPoint }
            $result['exports'] = $exports
            continue
        }
        if ($name -eq 'files') {
            $result['files'] = @(foreach ($file in @($property.Value)) {
                if ($file -eq 'index.js') { $BundleFileName } else { $file }
            })
            continue
        }
        $result[$name] = $property.Value
    }

    $result | ConvertTo-Json -Depth 10
}

function Update-BundledPackageJson {
    <#
    .SYNOPSIS
        改写正式树里打包插件的 package.json（只改目标端这一份）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath, [Parameter(Mandatory)][string]$PluginName)

    $path = Join-Path $RootPath (Join-Path $PluginName 'package.json')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "拒绝部署：正式树里没有 $PluginName\package.json，没法改写成打包形态。"
    }
    $json = [string](Get-Content -Raw -LiteralPath $path -Encoding utf8)
    $rewritten = Get-BundledPackageJson -Json $json -BundleFileName $script:BundleFileName
    Set-Content -LiteralPath $path -Value $rewritten -Encoding utf8
    $path
}
