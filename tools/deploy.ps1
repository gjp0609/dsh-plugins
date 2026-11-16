#Requires -Version 7.0
<#
.SYNOPSIS
    唯一的上线通道：把测试树里验证过的运行时文件拷进正式树，并留一份可回滚的备份。

.DESCRIPTION
    正式环境是 %LOCALAPPDATA%\dsh-plugins\production\（真实拷贝，不是 junction），测试环境是仓库根与
    .agents\worktrees\*。以前 profile 的 link: 直接指向仓库根，改一行就是上线；现在上线只走这一个脚本，
    而且要带一个指向当前 HEAD 的 tag。

    脚本做的事，按顺序（任何一步不满足就拒绝，一个字节都不写）：
      1. 解析 Source（默认本仓库的 git 顶层目录）；
      2. tag 校验：refs/tags/<tag> 必须存在，且 <tag>^{commit} 必须就是 HEAD；
      3. 干净校验：git status --porcelain 必须为空；
      4. 产物校验：shared/ui-card/dist/index.html 必须存在，且是单文件产物（无外链 script/link）；
      5. 打包校验：dsh-ssh-remote/index.bundle.js 必须存在（生产树只带单文件产物，依赖已内联），
         而且修改时间不早于 index.js（产物比源码旧 = 改了源码没重新打包）；
      6. 备份：production → production.bak.<yyyyMMdd-HHmmss>，只留最近 3 份；
      7. 拷贝：白名单搬运（打包插件只搬产物与运行时目录，其它插件搬运行时文件；外加卡片外壳与 DLL）；
      8. package.json 改写：只改正式树那一份——main / exports["."] 指到产物、删 dependencies；
      9. 清单：production\deploy.json（tag / commit / deployedAt / files / bundles / bundleSize / source）；
     10. 拷贝失败：删掉半成品，把备份换回原名，非零退出。

    生产树零依赖：dsh-ssh-remote 的 ssh2 打进了 index.bundle.js，部署不再需要 node_modules，
    也不接受"先装依赖再说"的兜底路径。

    两个写法上的硬约束（不要"顺手改成更自然的写法"）：
      * 原生程序（git）只能在**脚本作用域**直接调用，并把输出交给 cmd 重定向到临时文件再读。
        受限沙箱下 PowerShell 自己捕获原生输出会失败（StandardOutputEncoding is only supported when
        standard output is redirected），而**包进函数**会让 PowerShell 把它的 stdout 接进管道，
        于是必然踩到这条——所以 git 调用集中写在入口那段，纯逻辑才做成函数。
      * 运行时不要接管道（`.\deploy.ps1 -Tag x | Tee-Object` 之类），也不要在函数里再包一层调用。

.PARAMETER Tag
    必填（-Rollback 之外）。必须是一个已存在、且指向当前 HEAD 的 tag。

.PARAMETER Root
    正式树根。默认 $env:LOCALAPPDATA\dsh-plugins\production；测试把它指到临时目录。

.PARAMETER Source
    测试树根。默认由脚本自己 git rev-parse --show-toplevel 得出（不硬编码盘符）。

.PARAMETER DryRun
    只打印将要拷贝的清单与目标路径，不写任何文件（-Rollback 时打印回滚计划）。

.PARAMETER Rollback
    把最近一份 production.bak.<时间戳> 换回 production，并把当前 production 改名留档。

.EXAMPLE
    pwsh -File tools\deploy.ps1 -Tag v1

.EXAMPLE
    pwsh -File tools\deploy.ps1 -Tag v1 -DryRun

.EXAMPLE
    pwsh -File tools\deploy.ps1 -Rollback
#>
[CmdletBinding()]
param(
    [string]$Tag = '',
    [string]$Root = (Join-Path $env:LOCALAPPDATA 'dsh-plugins\production'),
    [string]$Source = '',
    [switch]$DryRun,
    [switch]$Rollback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 生产树里搬什么：四个插件（各自按形态过滤）、卡片外壳（白名单）与 WebView2 的 DLL。
$script:PluginNames = @('dsh-approval-notifier', 'dsh-approval-allow', 'dsh-ssh-remote', 'dsh-rail-pins')
# 打包成单文件的插件：生产树只放 index.bundle.js（ssh2 内联），源码 index.js 与 pnpm-lock.yaml 都不上生产。
$script:BundledPluginNames = @('dsh-ssh-remote')
$script:BundleFileName = 'index.bundle.js'
# 打包插件在插件根只搬这几样，外加下面两个运行时子目录（scripts\ 是 PowerShell 侧入口、lib\ 是模块）。
$script:BundledPluginFiles = @('index.bundle.js', 'cordis.patch.yml', 'package.json')
$script:BundledPluginDirs = @('scripts', 'lib')
# 排除的目录段（源码、依赖、测试、版本库、本地状态都不进生产）。
$script:ExcludedDirNames = @('node_modules', '.git', 'app', 'tests', '.session-files')
# 排除的文件（文档不进生产）。
$script:ExcludedFileNames = @('*.md')
# 非打包插件的额外必需文件（按插件名）：只给需要显式守运行时文件的插件加，不改其他插件的行为。
$script:PluginRequiredFiles = @{
    'dsh-approval-allow' = @('cordis.patch.yml', 'lib\audit.mjs', 'lib\config.mjs', 'lib\match.mjs')
}
# 卡片外壳只搬这三样：根上的 *.ps1、dist\（构建产物）、assets\（图标）。
$script:UiCardSubDirs = @('dist', 'assets')
# 备份只留最近几份。
$script:KeepBackups = 3
$script:BackupStampFormat = 'yyyyMMdd-HHmmss'

# ---------------------------------------------------------------------------
# 载入库文件
# ---------------------------------------------------------------------------

# 六个库都 dot-source 进本脚本作用域（不新建 scope）：$script: 仍指本文件，所以库函数读到的
# $script:PluginNames / $script:BundledPluginNames / $script:ExcludedDirNames 等与拆分前一致（D-35）。
# 常量必须先于 dot-source，入口调用必须在它之后；顺序按「路径 → 断言 → 清单 → 备份 → 输出 → 动作」，
# 运行期靠同一个作用域解析函数名（库之间没有 import，也不是依赖顺序）。
# git 调用全部留在下面的入口段：六个库里没有一个原生命令（受限沙箱下在函数里发 native 会踩管道）。
. (Join-Path $PSScriptRoot 'deploy-lib\paths.ps1')
. (Join-Path $PSScriptRoot 'deploy-lib\assert.ps1')
. (Join-Path $PSScriptRoot 'deploy-lib\items.ps1')
. (Join-Path $PSScriptRoot 'deploy-lib\backup.ps1')
. (Join-Path $PSScriptRoot 'deploy-lib\output.ps1')
. (Join-Path $PSScriptRoot 'deploy-lib\actions.ps1')

# ---------------------------------------------------------------- 入口
# 原生命令只在这里发（脚本作用域）：包进函数会让 PowerShell 把 git 的 stdout 接进管道，
# 受限沙箱下那条路径必然失败。读文件、拼命令串仍然交给函数。

$rootPath = Resolve-FullPath $Root

if ($Rollback) {
    try {
        Invoke-RollbackDeploy -RootPath $rootPath -Plan:$DryRun
        exit 0
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        exit 1
    }
}

if ([string]::IsNullOrWhiteSpace($Tag)) {
    Write-Host '拒绝部署：缺少 -Tag。上线必须显式给一个指向当前 HEAD 的 tag（tools\deploy.ps1 -Tag <tag>）。' -ForegroundColor Red
    exit 1
}

try {
    # -Source 缺省时用本脚本所在仓库；显式给了就先用它去问 git（后面再核对它确实是顶层目录）。
    $repoDir = if ([string]::IsNullOrWhiteSpace($Source)) {
        Split-Path -Parent $PSScriptRoot
    } else {
        Resolve-FullPath $Source
    }

    $gitCalls = @(
        @{ Key = 'top'; Args = @('rev-parse', '--show-toplevel') },
        @{ Key = 'head'; Args = @('rev-parse', 'HEAD') },
        @{ Key = 'tagRef'; Args = @('rev-parse', '--verify', "refs/tags/$Tag") },
        @{ Key = 'tagCommit'; Args = @('rev-parse', "$Tag^{commit}") },
        @{ Key = 'status'; Args = @('status', '--porcelain') }
    )
    $git = @{}
    foreach ($call in $gitCalls) {
        $base = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-deploy-git-' + [guid]::NewGuid().ToString('n'))
        $quoted = foreach ($arg in $call.Args) { '"' + $arg + '"' }
        $line = 'git -C "' + $repoDir + '" ' + ($quoted -join ' ') + ' > "' + "$base.out" + '" 2> "' + "$base.err" + '"'
        cmd /c $line
        $exitCode = $LASTEXITCODE
        $text = ''
        $errorText = ''
        if (Test-Path -LiteralPath "$base.out") { $text = [string](Get-Content -Raw -LiteralPath "$base.out" -Encoding utf8) }
        if (Test-Path -LiteralPath "$base.err") { $errorText = [string](Get-Content -Raw -LiteralPath "$base.err" -Encoding utf8) }
        foreach ($tempFile in @("$base.out", "$base.err")) {
            if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue }
        }
        $git[$call.Key] = [pscustomobject]@{
            ExitCode  = $exitCode
            Text      = ("$text").Trim()
            ErrorText = ("$errorText").Trim()
        }
    }

    if ($git.top.ExitCode -ne 0) {
        throw "拒绝部署：$repoDir 不是 Git 仓库（git rev-parse --show-toplevel 失败：$($git.top.ErrorText)）。"
    }
    $sourcePath = Resolve-FullPath $git.top.Text
    if (-not [string]::IsNullOrWhiteSpace($Source)) {
        Assert-SourceRoot -TopLevel $sourcePath -Requested $repoDir
    }

    # tag 与 HEAD 的关系：同一个提交 / 在祖先上 / 无关（后两种都要说清差在哪）。
    $tagExists = $git.tagRef.ExitCode -eq 0
    $relation = 'unknown'
    if ($tagExists) {
        if ($git.tagCommit.ExitCode -eq 0 -and $git.tagCommit.Text -eq $git.head.Text) {
            $relation = 'head'
        } else {
            cmd /c "git -C `"$sourcePath`" merge-base --is-ancestor `"$($git.tagCommit.Text)`" `"$($git.head.Text)`" > NUL 2> NUL"
            $relation = if ($LASTEXITCODE -eq 0) { 'ancestor' } else { 'other' }
        }
    }
    Assert-DeployTagState -TagName $Tag -RefExists $tagExists -TagCommit $git.tagCommit.Text `
        -Head $git.head.Text -Relation $relation

    if ($git.status.ExitCode -ne 0) { throw "拒绝部署：读不到工作区状态（$($git.status.ErrorText)）。" }
    Assert-CleanWorktree -PorcelainText $git.status.Text

    Assert-CardArtifact -SourceDir $sourcePath
    Assert-BundleArtifacts -SourceDir $sourcePath

    # 正式树不能落在要拷的目录里（否则拷进去的东西下一轮又成了源）。放在源码树的其他位置只用来跑测试。
    foreach ($copiedDirName in @($script:PluginNames + @('shared', 'vendor'))) {
        $copiedDir = Join-Path $sourcePath $copiedDirName
        if (Test-PathUnder -Child $rootPath -Parent $copiedDir) {
            throw "拒绝部署：-Root $rootPath 落在待拷目录 $copiedDir 里面，会自己拷自己。"
        }
    }

    $items = @(Get-DeployItems -SourceDir $sourcePath)

    if ($DryRun) {
        Show-DryRunPlan -Items $items -RootPath $rootPath -SourceDir $sourcePath -TagName $Tag -Commit $git.head.Text
        exit 0
    }

    Invoke-Deploy -SourceDir $sourcePath -RootPath $rootPath -TagName $Tag -Commit $git.head.Text -Items $items
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
