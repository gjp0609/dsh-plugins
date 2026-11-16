# tools/deploy.ps1 的写盘层（D-35）：备份留档与清理、按清单逐文件拷贝、deploy.json 清单。
# 由 tools/deploy.ps1 用 dot-source 载入，不单独执行。

function Remove-OldBackups {
    <#
    .SYNOPSIS
        只留最近 3 份备份，更老的删掉（留着占盘，且回滚只会用最近的那份）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath)

    $backups = @(Get-BackupDirs -RootPath $RootPath)
    if ($backups.Count -le $script:KeepBackups) { return }
    foreach ($old in $backups[$script:KeepBackups..($backups.Count - 1)]) {
        Write-Host "删除更老的备份：$($old.Name)"
        Remove-Item -LiteralPath $old.FullName -Recurse -Force
    }
}

function Backup-Production {
    <#
    .SYNOPSIS
        把现有正式树改名留档，返回备份路径；没有正式树时返回 $null。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath)

    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) { return $null }

    $backupName = Get-BackupName -RootPath $RootPath -Stamp (Get-Date)
    $backupPath = Join-Path (Split-Path -Parent $RootPath) $backupName
    Move-Item -LiteralPath $RootPath -Destination $backupPath
    Write-Host "已留档：$backupName"
    # 老备份等这次部署成功之后再删（Invoke-Deploy 最后调 Remove-OldBackups）：
    # 万一清理失败，正式树已经拷好了，不会停在「只有备份、没有正式树」这一步。
    $backupPath
}

function Invoke-CopyDeployItems {
    <#
    .SYNOPSIS
        按清单逐个文件拷贝（不整树复制，目标目录不存在就建）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Items, [Parameter(Mandatory)][string]$RootPath)

    foreach ($item in $Items) {
        $destination = Join-Path $RootPath $item.Relative
        $destinationDir = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $destinationDir -PathType Container)) {
            New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $item.Full -Destination $destination -Force
    }
}

function Write-DeployManifest {
    <#
    .SYNOPSIS
        落 production\deploy.json：这次上线是哪个 tag、哪个提交、什么时候、搬了哪些文件。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RootPath,
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][string]$Commit,
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)]$Items
    )

    $bundleItems = @($Items | Where-Object { $_.Relative -like ('*\' + $script:BundleFileName) })
    $manifest = [ordered]@{
        tag        = $TagName
        commit     = $Commit
        deployedAt = (Get-Date).ToString('o')
        files      = @($Items | ForEach-Object { $_.Relative })
        # 单文件产物单独列一份（正斜杠，跨平台眼熟）：生产树里从此没有任何 node_modules。
        bundles    = @($bundleItems | ForEach-Object { $_.Relative.Replace('\', '/') })
        bundleSize = [long](($bundleItems | Measure-Object -Property Bytes -Sum).Sum)
        source     = $SourceDir
    }
    $path = Join-Path $RootPath 'deploy.json'
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
    $path
}
