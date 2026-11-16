# tools/deploy.ps1 的动作层（D-35）：部署（备份 → 拷贝 → 落清单，失败即回滚）与回滚。
# 由 tools/deploy.ps1 用 dot-source 载入，不单独执行；这里没有 git 调用——
# 入口把 SourceDir / Commit / Items 算好后作为参数传进来。

function Invoke-Deploy {
    <#
    .SYNOPSIS
        备份 → 拷贝 → 落清单；拷贝中途失败就把半成品删掉、把备份换回原名。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SourceDir,
        [Parameter(Mandatory)][string]$RootPath,
        [Parameter(Mandatory)][string]$TagName,
        [Parameter(Mandatory)][string]$Commit,
        [Parameter(Mandatory)]$Items
    )

    $backupPath = Backup-Production -RootPath $RootPath
    try {
        if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
            New-Item -ItemType Directory -Path $RootPath -Force | Out-Null
        }
        Invoke-CopyDeployItems -Items $Items -RootPath $RootPath
        # 打包插件的 package.json 在正式树这边改写：main / exports["."] 指到产物、删 dependencies。
        foreach ($plugin in $script:BundledPluginNames) {
            Update-BundledPackageJson -RootPath $RootPath -PluginName $plugin | Out-Null
        }
        Write-DeployManifest -RootPath $RootPath -TagName $TagName -Commit $Commit -SourceDir $SourceDir -Items $Items | Out-Null
    } catch {
        $reason = $_.Exception.Message
        Write-Host "拷贝失败，开始回滚：$reason" -ForegroundColor Red
        if (Test-Path -LiteralPath $RootPath) {
            Remove-Item -LiteralPath $RootPath -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($backupPath -and (Test-Path -LiteralPath $backupPath -PathType Container)) {
            Move-Item -LiteralPath $backupPath -Destination $RootPath
            Write-Host "已把备份换回：$RootPath" -ForegroundColor Yellow
        }
        throw "部署失败（已回滚，正式树保持部署前的状态）：$reason"
    }

    Remove-OldBackups -RootPath $RootPath
    Write-Host ("已部署 {0}（{1}），文件 {2} 个 → {3}" -f $TagName, $Commit.Substring(0, 8), $Items.Count, $RootPath)
    Write-DependencyNotes -RootPath $RootPath
    Write-NextStep
}

function Invoke-RollbackDeploy {
    <#
    .SYNOPSIS
        把最近一份备份换回正式树，并把当前正式树改名留档（回滚本身也可再回滚）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath, [switch]$Plan)

    $backups = @(Get-BackupDirs -RootPath $RootPath)
    if ($backups.Count -eq 0) {
        throw "回滚失败：找不到备份（在 $(Split-Path -Parent $RootPath) 下没有 $(Split-Path -Leaf $RootPath).bak.<时间戳>）。"
    }
    $latest = $backups[0]
    $hasProduction = Test-Path -LiteralPath $RootPath -PathType Container
    $archiveName = Get-BackupName -RootPath $RootPath -Stamp (Get-Date)

    if ($Plan) {
        Write-Host 'DryRun（回滚）：不写任何文件。'
        Write-Host "  最近备份：$($latest.Name)"
        if ($hasProduction) { Write-Host "  当前正式树将留档为：$archiveName" }
        Write-Host "  然后把 $($latest.Name) 换回 $RootPath"
        Write-Host 'DryRun 结束：未改动任何目录。'
        return
    }

    if ($hasProduction) {
        Move-Item -LiteralPath $RootPath -Destination (Join-Path (Split-Path -Parent $RootPath) $archiveName)
        Write-Host "当前正式树已留档：$archiveName"
    }
    Move-Item -LiteralPath $latest.FullName -Destination $RootPath
    Remove-OldBackups -RootPath $RootPath
    Write-Host "已回滚：$($latest.Name) → $RootPath"
    Write-NextStep
}
