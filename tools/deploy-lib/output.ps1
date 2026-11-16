# tools/deploy.ps1 的输出层（D-35）：DryRun 计划、依赖形态说明、收尾的「重启才生效」。
# 由 tools/deploy.ps1 用 dot-source 载入，不单独执行；只写 Host，不碰文件。

function Write-NextStep {
    <#
    .SYNOPSIS
        最后一步永远是重启宿主：脚本只换了磁盘上的文件，正在跑的 DSH 还拿着旧的模块。
    #>
    [CmdletBinding()]
    param()

    Write-Host ''
    Write-Host '==================================================' -ForegroundColor Yellow
    Write-Host '  下一步：重启 DSH 才生效' -ForegroundColor Yellow
    Write-Host '==================================================' -ForegroundColor Yellow
}

function Show-DryRunPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Items,
        [Parameter(Mandatory)][string]$RootPath,
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][string]$Commit
    )

    Write-Host 'DryRun：不写任何文件。'
    Write-Host "  tag    ：$TagName"
    Write-Host "  commit ：$Commit"
    Write-Host "  source ：$SourceDir"
    Write-Host "  目标   ：$RootPath"
    Write-Host "  清单   ：$($Items.Count) 个文件"
    foreach ($item in $Items) {
        Write-Host ("  {0}  ->  {1}" -f $item.Relative, (Join-Path $RootPath $item.Relative))
    }
    foreach ($bundle in @($Items | Where-Object { $_.Relative -like ('*\' + $script:BundleFileName) })) {
        Write-Host ("  产物   ：{0}（{1} 字节，单文件无依赖，生产树不需要 node_modules）" -f $bundle.Relative, $bundle.Bytes)
    }
    if (Test-Path -LiteralPath $RootPath -PathType Container) {
        Write-Host "  备份   ：将把现有 $RootPath 改名为 $(Get-BackupName -RootPath $RootPath -Stamp (Get-Date))"
    } else {
        Write-Host '  备份   ：没有现有正式树，首次部署不产生备份'
    }
    Write-Host 'DryRun 结束：未创建任何文件。'
}

function Write-DependencyNotes {
    <#
    .SYNOPSIS
        说清生产树的依赖形态：打包插件走单文件产物，依赖已经内联，不需要 node_modules。
    .DESCRIPTION
        以前这里提醒"没有 node_modules，首次部署后去装一次"——那正是 asn1 找不到的根源。
        现在生产树零依赖：打包插件只认 index.bundle.js，装依赖既不需要也不该发生。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath)

    foreach ($plugin in $script:BundledPluginNames) {
        $bundle = Join-Path $RootPath (Join-Path $plugin $script:BundleFileName)
        if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { continue }
        Write-Host ("依赖：{0} 走 {1}（单文件，无 node_modules）" -f $plugin, $script:BundleFileName)
    }
}
