# `tools/deploy.ps1` 的行为断言（部署脚本自己的门禁）。
#
# 跑法：直接跑，不要接管道（`& .\tests\deploy.ps1`）。受限沙箱下 PowerShell 捕获原生输出会失败
# （StandardOutputEncoding is only supported when standard output is redirected），所以：
#   * 每次调用都是用 cmd 把输出重定向到文件，再读文件 —— 而且 cmd 必须在**脚本作用域**发，
#     包进函数会被 PowerShell 接进管道，原生程序当场起不来（实测）。
#   * 本脚本因此比普通测试长：每个场景都是「算命令串 → 脚本作用域发 cmd → 读结果」三行。
#
# 测试不碰正式环境：`-Root` 一律指到工作区内的临时目录（仓库 `.gitignore` 里的 `/.agents/` 下属目录，
# 不计入工作树的 `git status`）；tag 也只打在临时源树的仓库里，跑完整个删掉。
#
# `-Source` 也不是工作树，而是工作树在 `.agents\deploy-tests\<时间戳>\src` 的一份副本，副本自带一个
# 新建的 git 仓库。原因：生产树只带打包产物 `dsh-ssh-remote/index.bundle.js`，真实产物要 `npm run build`
# 才有，测试不真打包；而往工作树里丢一个未跟踪的假产物会让工作树的 `git status` 变脏，部署的干净校验
# 会先把它挡下来，测不到想测的分支。副本里造假的产物、自己提交，工作树一个字节都不动。
#
# 前置：工作区必须干净（脚本自己有干净校验，副本也才等于 HEAD）。没提交就先提交再跑。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:DeployPath = Join-Path $script:RepoRoot 'tools\deploy.ps1'
$script:PwshExe = Join-Path $PSHOME 'pwsh.exe'
$script:Pass = 0
$script:Fail = 0

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:Scratch = Join-Path $script:RepoRoot ".agents\deploy-tests\$stamp-$([guid]::NewGuid().ToString('n').Substring(0, 6))"
$script:Root = Join-Path $script:Scratch 'production'
$script:DryRoot = Join-Path $script:Scratch 'dryrun\production'
# 测试源树：工作树的副本 + 自建 git 仓库（见文件头）。部署的 -Source 指到这里。
$script:Source = Join-Path $script:Scratch 'src'
$script:BundleFileName = 'index.bundle.js'
# 拷副本时跳过的目录段：版本库、DSH 工作树（含本临时目录）、会话状态与本地产物。
$script:SourceCopyExcludes = @('.git', '.agents', '.session-files', 'out', 'node_modules', '.dev')
# 假产物就几个字节——测试要的是「部署怎么搬、怎么改写 package.json」，不验证打包内容。
$script:FakeBundleText = '/* deploy-test bundle */'
New-Item -ItemType Directory -Path $script:Scratch -Force | Out-Null

$script:TagNoBundle = "deploy-selftest-nobundle-$stamp"
$script:TagA = "deploy-selftest-a-$stamp"
$script:TagB = "deploy-selftest-b-$stamp"
$script:TagC = "deploy-selftest-c-$stamp"
$script:TagAncestor = "deploy-selftest-old-$stamp"
$script:TagMissing = "deploy-selftest-missing-$stamp"
$script:CreatedTags = [System.Collections.Generic.List[string]]::new()
$script:DirtyProbe = Join-Path $script:Source '.deploy-dirty-probe.txt'
$script:LockPath = Join-Path $script:Source 'dsh-ssh-remote\lib\pool.mjs'
$script:LockHandle = $null

function Write-Assert {
    <#
    .SYNOPSIS
        记一条断言；失败也不中断（要一次看到所有问题），最后按失败数给退出码。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][bool]$Ok, [string]$Detail = '')

    if ($Ok) {
        $script:Pass++
        Write-Host "PASS  $Name"
        return
    }
    $script:Fail++
    if ($Detail -ne '') { Write-Host "FAIL  $Name`n      $Detail" } else { Write-Host "FAIL  $Name" }
}

function New-CommandPlan {
    <#
    .SYNOPSIS
        只算「命令行 + 输出文件」，不执行（执行必须在脚本作用域，见文件头）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CommandLine)

    $id = [guid]::NewGuid().ToString('n')
    [pscustomobject]@{
        OutFile     = Join-Path $script:Scratch "run-$id.out"
        ErrFile     = Join-Path $script:Scratch "run-$id.err"
        CommandLine = $CommandLine + ' > "' + (Join-Path $script:Scratch "run-$id.out") + '" 2> "' + (Join-Path $script:Scratch "run-$id.err") + '"'
        ExitCode    = -1
    }
}

function New-DeployPlan {
    <#
    .SYNOPSIS
        拼一次 deploy.ps1 的调用（参数逐个加引号，路径里有空格也不怕）。
    #>
    [CmdletBinding()]
    param([string[]]$DeployArgs = @())

    $argumentText = ''
    foreach ($arg in $DeployArgs) { $argumentText += ' "' + $arg + '"' }
    $commandLine = '"' + $script:PwshExe + '" -NoProfile -NonInteractive -File "' + $script:DeployPath + '"' + $argumentText
    New-CommandPlan -CommandLine $commandLine
}

function New-GitPlan {
    <#
    .SYNOPSIS
        拼一次 git 调用（同样只是为了拿到可读输出，执行留在脚本作用域）。
    .DESCRIPTION
        默认打在测试源树的仓库上；要读工作树本身时显式传 -RepoRoot $script:RepoRoot。
    #>
    [CmdletBinding()]
    param([string[]]$GitArgs = @(), [string]$RepoRoot = '')

    $repo = if ($RepoRoot -eq '') { $script:Source } else { $RepoRoot }
    $quoted = foreach ($arg in $GitArgs) { '"' + $arg + '"' }
    $commandLine = 'git -C "' + $repo + '" ' + ($quoted -join ' ')
    New-CommandPlan -CommandLine $commandLine
}

function Complete-CommandPlan {
    <#
    .SYNOPSIS
        读回一次执行的结果并清理临时输出文件。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan)

    $text = ''
    $errorText = ''
    if (Test-Path -LiteralPath $Plan.OutFile) { $text = [string](Get-Content -Raw -LiteralPath $Plan.OutFile -Encoding utf8) }
    if (Test-Path -LiteralPath $Plan.ErrFile) { $errorText = [string](Get-Content -Raw -LiteralPath $Plan.ErrFile -Encoding utf8) }
    foreach ($path in @($Plan.OutFile, $Plan.ErrFile)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
    [pscustomobject]@{
        ExitCode = $Plan.ExitCode
        Text     = ("$text").Trim()
        ErrorText = ("$errorText").Trim()
        All      = ("$text`n$errorText").Trim()
    }
}

function New-ScenarioPlan {
    <#
    .SYNOPSIS
        拼一次「源树指到测试副本、-Root 指到测试目录」的 deploy 调用。
    #>
    [CmdletBinding()]
    param([string[]]$ExtraArgs = @(), [string]$RootPath = '')

    $root = if ($RootPath -eq '') { $script:Root } else { $RootPath }
    $all = @('-Source', $script:Source, '-Root', $root) + $ExtraArgs
    New-DeployPlan -DeployArgs $all
}

function Get-BackupDirs {
    <#
    .SYNOPSIS
        列出测试目录那一侧的 production.bak.* 备份。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath)

    $parent = Split-Path -Parent $RootPath
    $leaf = Split-Path -Leaf $RootPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return @() }
    $pattern = '^' + [regex]::Escape($leaf) + '\.bak\.\d{8}-\d{6}(-\d+)?$'
    @(Get-ChildItem -LiteralPath $parent -Directory -Force |
        Where-Object { $_.Name -match $pattern } |
        Sort-Object -Property Name -Descending)
}

function Read-Manifest {
    <#
    .SYNOPSIS
        读一份 deploy.json；不存在时返回一个字段为空的占位对象（断言里就不用到处判空）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath)

    $path = Join-Path $RootPath 'deploy.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{ tag = ''; commit = ''; files = @(); bundles = @(); bundleSize = -1; source = ''; deployedAt = '' }
    }
    Get-Content -Raw -LiteralPath $path -Encoding utf8 | ConvertFrom-Json
}

function Read-PackageJson {
    <#
    .SYNOPSIS
        读一份 package.json；不存在时返回空对象。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{} }
    Get-Content -Raw -LiteralPath $Path -Encoding utf8 | ConvertFrom-Json
}

function Get-JsonProperty {
    <#
    .SYNOPSIS
        按名字取 JSON 属性（"dependencies"、"exports" 或 "." 这类名字在 PowerShell 里不能直接点出来）；
        属性不存在时返回 $null，用来断言「这个键没有」。
    #>
    [CmdletBinding()]
    param($Object, [Parameter(Mandatory)][string]$Name)

    if ($null -eq $Object) { return $null }
    $property = @($Object.PSObject.Properties | Where-Object { $_.Name -eq $Name })
    if ($property.Count -eq 0) { return $null }
    $property[0].Value
}

function Get-TreeNames {
    <#
    .SYNOPSIS
        递归收集一棵目录树里所有文件/目录的名字（用来断言生产树里没有源码、依赖与测试）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath)

    @(Get-ChildItem -LiteralPath $RootPath -Recurse -Force -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name })
}

try {
    # ---------------------------------------------------------------- 前置
    $statusPlan = New-GitPlan -GitArgs @('status', '--porcelain') -RepoRoot $script:RepoRoot
    cmd /c $statusPlan.CommandLine
    $statusPlan.ExitCode = $LASTEXITCODE
    $status = Complete-CommandPlan -Plan $statusPlan
    if ($status.Text -ne '') {
        Write-Host 'FAIL  前置：工作区必须干净（先提交改动再跑本测试）'
        Write-Host $status.Text
        exit 1
    }

    # 测试源树 = 工作树的副本 + 自建仓库（见文件头）。只拷顶层条目，跳过版本库与本地状态。
    New-Item -ItemType Directory -Path $script:Source -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $script:RepoRoot -Force) {
        if ($script:SourceCopyExcludes -contains $entry.Name) { continue }
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $script:Source $entry.Name) -Recurse -Force
    }

    # 第一版提交故意不带产物：用来测「缺 index.bundle.js 就拒绝部署」。
    # 仓库里真有一份产物时也要先删掉，否则副本会带着它，测不出这个分支。
    $bundleSourcePath = Join-Path $script:Source ('dsh-ssh-remote\' + $script:BundleFileName)
    if (Test-Path -LiteralPath $bundleSourcePath) { Remove-Item -LiteralPath $bundleSourcePath -Force }
    $entrySourcePath = Join-Path $script:Source 'dsh-ssh-remote\index.js'
    if (-not (Test-Path -LiteralPath $entrySourcePath -PathType Leaf)) {
        Set-Content -LiteralPath $entrySourcePath -Value '// 打包入口占位（mtime 基线）' -Encoding utf8
    }

    $gitIdentity = @('-c', 'user.name=dsh-deploy-test', '-c', 'user.email=deploy-test@invalid')
    $setupCalls = @(
        @{ Name = 'init'; Args = @('init', '-b', 'deploy-test') },
        @{ Name = 'add1'; Args = @($gitIdentity + @('add', '-A')) },
        @{ Name = 'commit1'; Args = @($gitIdentity + @('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', '源树：还没有打包产物')) },
        @{ Name = 'tagNoBundle'; Args = @('tag', $script:TagNoBundle) }
    )
    $setupResults = @{}
    foreach ($call in $setupCalls) {
        $callPlan = New-GitPlan -GitArgs $call.Args
        cmd /c $callPlan.CommandLine
        $callPlan.ExitCode = $LASTEXITCODE
        $setupResults[$call.Name] = Complete-CommandPlan -Plan $callPlan
    }
    Write-Assert -Name '测试源树：副本仓库初始化并提交成功' `
        -Ok (($setupResults['init'].ExitCode -eq 0) -and ($setupResults['add1'].ExitCode -eq 0) -and
            ($setupResults['commit1'].ExitCode -eq 0) -and ($setupResults['tagNoBundle'].ExitCode -eq 0)) `
        -Detail ("init=$($setupResults['init'].All) add=$($setupResults['add1'].All) " +
            "commit=$($setupResults['commit1'].All) tag=$($setupResults['tagNoBundle'].All)")
    $script:CreatedTags.Add($script:TagNoBundle)

    # ---------------------------------------------------------------- 0. 缺打包产物
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagNoBundle)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Write-Assert -Name '缺 index.bundle.js：拒绝，并提示先跑 npm run build' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match 'index\.bundle\.js' -and
            $result.All -match 'npm run build' -and $result.All -notmatch '未提交') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '缺 index.bundle.js：不写任何文件' -Ok (-not (Test-Path -LiteralPath $script:Root))

    # 造一个假产物（几个字节）再提交：后面的正常部署都拿它当产物，不真打包。
    Set-Content -LiteralPath $bundleSourcePath -Value $script:FakeBundleText -Encoding utf8 -NoNewline
    $bundleSourceFile = Get-Item -LiteralPath $bundleSourcePath
    $bundleSourceFile.LastWriteTimeUtc = [datetime]::UtcNow
    $bundleBytes = $bundleSourceFile.Length

    $setupCalls = @(
        @{ Name = 'add2'; Args = @($gitIdentity + @('add', ('dsh-ssh-remote/' + $script:BundleFileName))) },
        @{ Name = 'commit2'; Args = @($gitIdentity + @('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', '源树：假打包产物')) }
    )
    foreach ($call in $setupCalls) {
        $callPlan = New-GitPlan -GitArgs $call.Args
        cmd /c $callPlan.CommandLine
        $callPlan.ExitCode = $LASTEXITCODE
        $setupResults[$call.Name] = Complete-CommandPlan -Plan $callPlan
    }
    Write-Assert -Name '测试源树：假产物提交成功' `
        -Ok (($setupResults['add2'].ExitCode -eq 0) -and ($setupResults['commit2'].ExitCode -eq 0)) `
        -Detail ("add=$($setupResults['add2'].All) commit=$($setupResults['commit2'].All)")

    # 临时 tag：A / B / C 都在 HEAD 上，old 在 HEAD~1（祖先，也就是没有产物的那一版），missing 不打。
    foreach ($tagName in @($script:TagA, $script:TagB, $script:TagC)) {
        $tagPlan = New-GitPlan -GitArgs @('tag', $tagName)
        cmd /c $tagPlan.CommandLine
        $tagPlan.ExitCode = $LASTEXITCODE
        $script:CreatedTags.Add($tagName)
    }
    $tagPlan = New-GitPlan -GitArgs @('tag', $script:TagAncestor, 'HEAD~1')
    cmd /c $tagPlan.CommandLine
    $tagPlan.ExitCode = $LASTEXITCODE
    $script:CreatedTags.Add($script:TagAncestor)

    $headPlan = New-GitPlan -GitArgs @('rev-parse', 'HEAD')
    cmd /c $headPlan.CommandLine
    $headPlan.ExitCode = $LASTEXITCODE
    $head = Complete-CommandPlan -Plan $headPlan

    # ---------------------------------------------------------------- 1. 不带 -Tag
    $plan = New-ScenarioPlan -ExtraArgs @()
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Write-Assert -Name '不带 -Tag：非零退出，提示里点名 tag' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match 'tag') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '不带 -Tag：一个文件都没写（-Root 未创建）' -Ok (-not (Test-Path -LiteralPath $script:Root))

    # ---------------------------------------------------------------- 2. tag 不存在
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagMissing)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Write-Assert -Name 'tag 不存在：拒绝，并说清哪个 tag 不存在' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match '不存在') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name 'tag 不存在：不写任何文件' -Ok (-not (Test-Path -LiteralPath $script:Root))

    # ---------------------------------------------------------------- 3. tag 在祖先上
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagAncestor)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Write-Assert -Name 'tag 在祖先上（不是 HEAD）：拒绝，并说清差在哪' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match '祖先' -and $result.All -match 'HEAD') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name 'tag 在祖先上：不写任何文件' -Ok (-not (Test-Path -LiteralPath $script:Root))

    # ---------------------------------------------------------------- 4. 工作区脏
    # 临时丢一个未跟踪文件进去（用完删掉）。别用 *.tmp：本机全局 gitignore 里有它，git 根本不看。
    Set-Content -LiteralPath $script:DirtyProbe -Value 'dirty' -Encoding utf8
    $probePlan = New-GitPlan -GitArgs @('status', '--porcelain')
    cmd /c $probePlan.CommandLine
    $probePlan.ExitCode = $LASTEXITCODE
    $probeStatus = Complete-CommandPlan -Plan $probePlan
    Write-Assert -Name '工作区脏：探针文件确实被 git 看见（没被 gitignore 忽略）' `
        -Ok ($probeStatus.Text -match 'deploy-dirty-probe') -Detail "status=$($probeStatus.Text)"
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagA)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Remove-Item -LiteralPath $script:DirtyProbe -Force
    Write-Assert -Name '工作区脏：拒绝部署' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match '未提交') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '工作区脏：不写任何文件' -Ok (-not (Test-Path -LiteralPath $script:Root))

    # ---------------------------------------------------------------- 4b. 产物比源码旧
    # 只动修改时间（内容、git status 都不变）：产物比 index.js 旧 = 改了源码没重新打包。
    $entrySourceFile = Get-Item -LiteralPath $entrySourcePath
    $freshBundleTime = (Get-Item -LiteralPath $bundleSourcePath).LastWriteTime
    Set-ItemProperty -LiteralPath $bundleSourcePath -Name LastWriteTime -Value $entrySourceFile.LastWriteTime.AddHours(-1)
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagA)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Set-ItemProperty -LiteralPath $bundleSourcePath -Name LastWriteTime -Value $freshBundleTime
    Write-Assert -Name '产物比 index.js 旧：拒绝，并说明源码改了没重新打包' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match '旧' -and $result.All -match 'npm run build') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '产物比 index.js 旧：不写任何文件' -Ok (-not (Test-Path -LiteralPath $script:Root))

    # ---------------------------------------------------------------- 5. 正常部署（第一次）
    $sourcePackagePath = Join-Path $script:Source 'dsh-ssh-remote\package.json'
    $sourcePackageBefore = [string](Get-Content -Raw -LiteralPath $sourcePackagePath -Encoding utf8)
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagA)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    $manifest = Read-Manifest -RootPath $script:Root
    Write-Assert -Name '正常部署：退出码 0' -Ok ($result.ExitCode -eq 0) -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '正常部署：打印给人看的收尾行（tag / commit 前 8 位 / 文件数 / 目标）' `
        -Ok ($result.Text -match ('已部署 ' + [regex]::Escape($script:TagA) + '（[0-9a-f]{8}），文件 \d+ 个 → ')) `
        -Detail $result.Text
    Write-Assert -Name '正常部署：醒目提示「下一步：重启 DSH 才生效」' -Ok ($result.Text -match '下一步：重启 DSH 才生效')
    Write-Assert -Name '正常部署：production\deploy.json 存在' -Ok (Test-Path -LiteralPath (Join-Path $script:Root 'deploy.json') -PathType Leaf)
    Write-Assert -Name '正常部署：deploy.json 的 tag 就是传进去的 tag' `
        -Ok ($manifest.tag -eq $script:TagA) `
        -Detail "tag=$($manifest.tag)"
    Write-Assert -Name '正常部署：deploy.json 的 commit 就是 HEAD' `
        -Ok ($manifest.commit -eq $head.Text) `
        -Detail "commit=$($manifest.commit) head=$($head.Text)"
    Write-Assert -Name '正常部署：deploy.json 的 files 非空' `
        -Ok (@($manifest.files).Count -gt 0) `
        -Detail "files=$(@($manifest.files).Count)"
    Write-Assert -Name '正常部署：deploy.json 的 bundles 指向单文件产物' `
        -Ok ((@($manifest.bundles).Count -eq 1) -and (@($manifest.bundles)[0] -eq ('dsh-ssh-remote/' + $script:BundleFileName))) `
        -Detail "bundles=$(@($manifest.bundles) -join ',')"
    Write-Assert -Name '正常部署：deploy.json 的 bundleSize 就是产物的字节数' `
        -Ok ($manifest.bundleSize -eq $bundleBytes) `
        -Detail "bundleSize=$($manifest.bundleSize) 期望=$bundleBytes"
    Write-Assert -Name '正常部署：打印依赖形态（单文件，无 node_modules）' `
        -Ok ($result.Text -match [regex]::Escape('依赖：dsh-ssh-remote 走 index.bundle.js（单文件，无 node_modules）')) `
        -Detail $result.Text
    Write-Assert -Name '正常部署：不再提示「去装依赖」' -Ok ($result.Text -notmatch '装一次依赖|装依赖')
    foreach ($dir in @('dsh-approval-notifier', 'dsh-ssh-remote', 'shared\ui-card')) {
        Write-Assert -Name "正常部署：生产树里有 $dir" `
            -Ok (Test-Path -LiteralPath (Join-Path $script:Root $dir) -PathType Container)
    }
    Write-Assert -Name '正常部署：生产里有 shared\ui-card\dist\index.html' `
        -Ok (Test-Path -LiteralPath (Join-Path $script:Root 'shared\ui-card\dist\index.html') -PathType Leaf)
    Write-Assert -Name '正常部署：生产里有卡片外壳的 *.ps1（能向上找到 shared\ui-card）' `
        -Ok ((Test-Path -LiteralPath (Join-Path $script:Root 'shared\ui-card\card-html.ps1') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $script:Root 'shared\ui-card\webview2.ps1') -PathType Leaf))
    Write-Assert -Name '正常部署：生产里有 WebView2 的 DLL（shared\ui-card 向上第 3 层 vendor\webview2）' `
        -Ok (Test-Path -LiteralPath (Join-Path $script:Root 'vendor\webview2\WebView2Loader.dll') -PathType Leaf)
    Write-Assert -Name '正常部署：生产里有 dsh-ssh-remote\index.bundle.js（单文件产物）' `
        -Ok (Test-Path -LiteralPath (Join-Path $script:Root ('dsh-ssh-remote\' + $script:BundleFileName)) -PathType Leaf)
    Write-Assert -Name '正常部署：生产里没有 dsh-ssh-remote\index.js（源码不上生产）' `
        -Ok (-not (Test-Path -LiteralPath (Join-Path $script:Root 'dsh-ssh-remote\index.js')))
    Write-Assert -Name '正常部署：生产里没有 dsh-ssh-remote\node_modules' `
        -Ok (-not (Test-Path -LiteralPath (Join-Path $script:Root 'dsh-ssh-remote\node_modules')))
    Write-Assert -Name '正常部署：生产里没有 dsh-ssh-remote\pnpm-lock.yaml（锁文件不上生产）' `
        -Ok (-not (Test-Path -LiteralPath (Join-Path $script:Root 'dsh-ssh-remote\pnpm-lock.yaml')))
    Write-Assert -Name '正常部署：生产里有 dsh-ssh-remote 的 scripts\ 与 lib\（运行时目录照搬）' `
        -Ok ((Test-Path -LiteralPath (Join-Path $script:Root 'dsh-ssh-remote\scripts\sshctl.ps1') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $script:Root 'dsh-ssh-remote\lib\pool.mjs') -PathType Leaf))
    Write-Assert -Name '正常部署：dsh-approval-notifier 仍是源码形态（有 index.js、没有产物）' `
        -Ok ((Test-Path -LiteralPath (Join-Path $script:Root 'dsh-approval-notifier\index.js') -PathType Leaf) -and
            (-not (Test-Path -LiteralPath (Join-Path $script:Root ('dsh-approval-notifier\' + $script:BundleFileName)))))

    # 生产 package.json：main / exports["."] 指到产物、删 dependencies，其它字段保留（只改目标端这一份）。
    $prodPackage = Read-PackageJson -Path (Join-Path $script:Root 'dsh-ssh-remote\package.json')
    Write-Assert -Name '正常部署：生产 package.json 的 main 指到产物' `
        -Ok ((Get-JsonProperty -Object $prodPackage -Name 'main') -eq ('./' + $script:BundleFileName)) `
        -Detail "main=$(Get-JsonProperty -Object $prodPackage -Name 'main')"
    Write-Assert -Name '正常部署：生产 package.json 的 exports["."] 指到产物' `
        -Ok ((Get-JsonProperty -Object (Get-JsonProperty -Object $prodPackage -Name 'exports') -Name '.') -eq ('./' + $script:BundleFileName)) `
        -Detail "exports[.]=$(Get-JsonProperty -Object (Get-JsonProperty -Object $prodPackage -Name 'exports') -Name '.')"
    Write-Assert -Name '正常部署：生产 package.json 没有 dependencies 键' `
        -Ok ($null -eq (Get-JsonProperty -Object $prodPackage -Name 'dependencies')) `
        -Detail "dependencies=$(Get-JsonProperty -Object $prodPackage -Name 'dependencies')"
    Write-Assert -Name '正常部署：生产 package.json 的 files 里 index.js 换成了产物名' `
        -Ok ((@((Get-JsonProperty -Object $prodPackage -Name 'files')) -notcontains 'index.js') -and
            (@((Get-JsonProperty -Object $prodPackage -Name 'files')) -contains $script:BundleFileName))
    Write-Assert -Name '正常部署：生产 package.json 保留 name / type / dsh 字段' `
        -Ok (((Get-JsonProperty -Object $prodPackage -Name 'name') -eq 'dsh-ssh-remote') -and
            ((Get-JsonProperty -Object $prodPackage -Name 'type') -eq 'module') -and
            ($null -ne (Get-JsonProperty -Object $prodPackage -Name 'dsh')))
    Write-Assert -Name '正常部署：源树里的 package.json 没被改写（只在目标端改写）' `
        -Ok ([string](Get-Content -Raw -LiteralPath $sourcePackagePath -Encoding utf8) -eq $sourcePackageBefore)
    Write-Assert -Name '正常部署：第一次部署不产生备份' -Ok (@(Get-BackupDirs -RootPath $script:Root).Count -eq 0)

    # ---------------------------------------------------------------- 6. 生产树纯净度
    $names = Get-TreeNames -RootPath $script:Root
    foreach ($forbidden in @('node_modules', '.git', 'app', 'tests')) {
        Write-Assert -Name "生产树里没有 $forbidden" -Ok ($names -notcontains $forbidden)
    }
    Write-Assert -Name '生产树里没有文档（*.md）' -Ok (@($names | Where-Object { $_ -like '*.md' }).Count -eq 0)
    Write-Assert -Name '生产树里没有源码目录 shared\ui-card\app' `
        -Ok (-not (Test-Path -LiteralPath (Join-Path $script:Root 'shared\ui-card\app')))

    # ---------------------------------------------------------------- 7. 连跑两次 → 一份备份
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagB)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    $manifest = Read-Manifest -RootPath $script:Root
    $backups = @(Get-BackupDirs -RootPath $script:Root)
    $backupManifest = if ($backups.Count -gt 0) { Read-Manifest -RootPath $backups[0].FullName } else { [pscustomobject]@{ tag = ""; commit = ""; files = @() } }
    Write-Assert -Name '第二次部署：退出码 0，deploy.json 换成新 tag' `
        -Ok ($result.ExitCode -eq 0 -and $manifest.tag -eq $script:TagB) `
        -Detail "exit=$($result.ExitCode) tag=$($manifest.tag) 输出=$($result.All)"
    Write-Assert -Name '第二次部署：出现一份 production.bak.<时间戳>' `
        -Ok ($backups.Count -eq 1 -and $backups[0].Name -match '^production\.bak\.\d{8}-\d{6}(-\d+)?$') `
        -Detail "备份=$(@($backups | ForEach-Object { $_.Name }) -join ',')"
    Write-Assert -Name '备份里是上一份的内容（tag 是上一次的）' `
        -Ok ($backupManifest.tag -eq $script:TagA) `
        -Detail "备份 tag=$($backupManifest.tag)"

    # ---------------------------------------------------------------- 8. DryRun
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagB, '-DryRun') -RootPath $script:DryRoot
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    Write-Assert -Name 'DryRun：退出码 0，打印清单与目标路径' `
        -Ok ($result.ExitCode -eq 0 -and $result.Text -match 'DryRun' -and $result.Text -match [regex]::Escape($script:DryRoot)) `
        -Detail "exit=$($result.ExitCode) 输出=$($result.Text)"
    Write-Assert -Name 'DryRun：一个文件都没创建（目标目录不存在、也没有备份）' `
        -Ok ((-not (Test-Path -LiteralPath $script:DryRoot)) -and
            (-not (Test-Path -LiteralPath (Split-Path -Parent $script:DryRoot))) -and
            (@(Get-BackupDirs -RootPath $script:DryRoot).Count -eq 0))
    Write-Assert -Name 'DryRun：ssh 的清单里有 index.bundle.js，没有 index.js 与 node_modules' `
        -Ok (($result.Text -match [regex]::Escape('dsh-ssh-remote\' + $script:BundleFileName)) -and
            ($result.Text -notmatch [regex]::Escape('dsh-ssh-remote\index.js')) -and
            ($result.Text -notmatch [regex]::Escape('dsh-ssh-remote\node_modules'))) `
        -Detail $result.Text

    # ---------------------------------------------------------------- 9. 回滚
    $plan = New-ScenarioPlan -ExtraArgs @('-Rollback')
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    $manifest = Read-Manifest -RootPath $script:Root
    $backups = @(Get-BackupDirs -RootPath $script:Root)
    $backupManifest = if ($backups.Count -gt 0) { Read-Manifest -RootPath $backups[0].FullName } else { [pscustomobject]@{ tag = ""; commit = ""; files = @() } }
    Write-Assert -Name '回滚：退出码 0，提示重启' `
        -Ok ($result.ExitCode -eq 0 -and $result.Text -match '已回滚' -and $result.Text -match '下一步：重启 DSH 才生效') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '回滚：内容回到上一份（tag 变回 A）' `
        -Ok ($manifest.tag -eq $script:TagA) `
        -Detail "tag=$($manifest.tag)"
    Write-Assert -Name '回滚：当前那份被留档（备份里是 B）' `
        -Ok ($backups.Count -eq 1 -and $backupManifest.tag -eq $script:TagB) `
        -Detail "备份数=$($backups.Count) 备份tag=$($backupManifest.tag)"

    # ---------------------------------------------------------------- 10. 拷贝失败即回滚
    # 把源里一个文件独占打开：拷贝到它时必然 IOException，用来验证「半成品删掉、备份换回原名」。
    $script:LockHandle = [System.IO.File]::Open($script:LockPath, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    $plan = New-ScenarioPlan -ExtraArgs @('-Tag', $script:TagC)
    cmd /c $plan.CommandLine
    $plan.ExitCode = $LASTEXITCODE
    $result = Complete-CommandPlan -Plan $plan
    $script:LockHandle.Dispose()
    $script:LockHandle = $null
    $manifest = Read-Manifest -RootPath $script:Root
    $backups = @(Get-BackupDirs -RootPath $script:Root)
    $backupManifest = if ($backups.Count -gt 0) { Read-Manifest -RootPath $backups[0].FullName } else { [pscustomobject]@{ tag = ""; commit = ""; files = @() } }
    Write-Assert -Name '拷贝失败：非零退出，并说明已回滚' `
        -Ok ($result.ExitCode -ne 0 -and $result.All -match '部署失败' -and $result.All -match '已回滚') `
        -Detail "exit=$($result.ExitCode) 输出=$($result.All)"
    Write-Assert -Name '拷贝失败：正式树回到失败前的状态（tag 仍是 A）' `
        -Ok ($manifest.tag -eq $script:TagA) `
        -Detail "tag=$($manifest.tag)"
    Write-Assert -Name '拷贝失败：没有留下多余的备份目录' `
        -Ok ($backups.Count -eq 1 -and $backupManifest.tag -eq $script:TagB) `
        -Detail "备份数=$($backups.Count) 备份tag=$($backupManifest.tag)"
    Write-Assert -Name '拷贝失败：没有留下半成品（production 里没有 deploy.json 之外的新 tag）' `
        -Ok ($manifest.tag -ne $script:TagC)

    # ---------------------------------------------------------------- 11. 收尾：测试 tag 已清空
    foreach ($tagName in $script:CreatedTags) { git -C $script:Source tag -d $tagName }
    $script:CreatedTags.Clear()
    $tagPlan = New-GitPlan -GitArgs @('tag', '-l')
    cmd /c $tagPlan.CommandLine
    $tagPlan.ExitCode = $LASTEXITCODE
    $tagList = Complete-CommandPlan -Plan $tagPlan
    $leftover = @($tagList.Text -split "`r?`n" | Where-Object { $_ -match 'deploy-selftest-' })
    Write-Assert -Name '收工：测试源树的 git tag -l 里没有测试 tag' -Ok ($leftover.Count -eq 0) -Detail "残留=$($leftover -join ',')"

    # 全程不该碰工作树的 git 元数据：测试 tag 只存在于临时源树。
    $worktreeTagPlan = New-GitPlan -GitArgs @('tag', '-l') -RepoRoot $script:RepoRoot
    cmd /c $worktreeTagPlan.CommandLine
    $worktreeTagPlan.ExitCode = $LASTEXITCODE
    $worktreeTags = Complete-CommandPlan -Plan $worktreeTagPlan
    $worktreeLeftover = @($worktreeTags.Text -split "`r?`n" | Where-Object { $_ -match 'deploy-selftest-' })
    Write-Assert -Name '收工：工作树里没有测试 tag（测试只在临时源树里打 tag）' `
        -Ok ($worktreeLeftover.Count -eq 0) -Detail "残留=$($worktreeLeftover -join ',')"
} finally {
    if ($null -ne $script:LockHandle) { $script:LockHandle.Dispose() }
    if (Test-Path -LiteralPath $script:Source -PathType Container) {
        foreach ($tagName in $script:CreatedTags) {
            git -C $script:Source tag -d $tagName
        }
    }
    if (Test-Path -LiteralPath $script:DirtyProbe) { Remove-Item -LiteralPath $script:DirtyProbe -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $script:Scratch) { Remove-Item -LiteralPath $script:Scratch -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "结果：$($script:Pass) 项通过 / $($script:Pass + $script:Fail) 项"
if ($script:Fail -gt 0) {
    Write-Host "FAIL  deploy.ps1 的 $($script:Fail) 项断言没通过"
    exit 1
}
Write-Host 'PASS  deploy.ps1 全部断言通过'
exit 0




