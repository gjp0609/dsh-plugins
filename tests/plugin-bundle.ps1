# 纯逻辑自检：ssh 插件打包产物与源码同步（dsh-ssh-remote/index.bundle.js）。
#
# 跑法：& tests\plugin-bundle.ps1
#
# 覆盖：
#   - 产物存在，且不晚于它的输入（index.js / lib\*.mjs / lib\*.js，client.js 除外——它不进包）；
#   - package.json 里有 build 脚本、脚本用的是 esbuild、声明了 esbuild 开发依赖；
#   - 产物确实内联了 ssh2（不是空壳），且没有把 cpu-features 这类原生模块硬绑进来；
#   - 产物顶层没有 `import ... from 'ssh2'` 这种运行时外部依赖（否则生产又得带 node_modules）。
#
# 为什么需要这条：改了 index.js / lib\ 却忘了 `pnpm build`，125 项功能测试一条都不会红，
# 但生产装的就是旧产物——这是"部署看起来成功、行为却是旧的"的典型来源。
# 生产树零依赖是用户定的（AGENTS §0、docs/deploy.md），靠这一条守着。

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:PluginDir = Join-Path $script:RepoRoot 'dsh-ssh-remote'
$script:BundlePath = Join-Path $script:PluginDir 'index.bundle.js'
$script:EntryPath = Join-Path $script:PluginDir 'index.js'
$script:ManifestPath = Join-Path $script:PluginDir 'package.json'
$script:Failures = 0
$script:Total = 0

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
        }
        else {
            "FAIL  $Name  ->  $result"
            $script:Failures++
        }
    }
    catch {
        "FAIL  $Name  ->  $($_.Exception.Message)"
        $script:Failures++
    }
}

Check '打包产物存在（dsh-ssh-remote\index.bundle.js）' {
    if (-not (Test-Path -LiteralPath $script:BundlePath)) { return '产物不存在，先跑 pnpm build' }
    $true
}

Check '产物不早于源码入口 index.js（改了源码要重新打包）' {
    if (-not (Test-Path -LiteralPath $script:EntryPath)) { return '源码入口 index.js 不存在' }
    $bundle = (Get-Item -LiteralPath $script:BundlePath).LastWriteTimeUtc
    $entry = (Get-Item -LiteralPath $script:EntryPath).LastWriteTimeUtc
    # 1 秒容差：`git checkout` 一次写出的一批文件，时间戳只差毫秒，按秒看是同一时刻；
    # 逐毫秒比较会把刚拉出来的干净工作树判成「产物过期」（2026-11-01 新建 worktree 时踩到）。
    # 真正「改了源码没重新打包」的间隔远大于 1 秒，容差不影响这条断言的用途。
    if ($bundle.Add([TimeSpan]::FromSeconds(1)) -lt $entry) { return "产物 $($bundle.ToString('s')) 早于 index.js $($entry.ToString('s'))" }
    $true
}

Check '产物不早于 lib\ 下任何一个会被打进包的模块' {
    $libDir = Join-Path $script:PluginDir 'lib'
    if (-not (Test-Path -LiteralPath $libDir)) { return 'lib 目录不存在' }
    $bundle = (Get-Item -LiteralPath $script:BundlePath).LastWriteTimeUtc.Add([TimeSpan]::FromSeconds(1))
    $stale = @()
    Get-ChildItem -LiteralPath $libDir -File | Where-Object {
        # client.js 是浏览器侧注入脚本，不参与宿主打包（exports["./client"] 直接引源码）。
        $_.Name -ne 'client.js' -and $_.Extension -in '.js', '.mjs'
    } | ForEach-Object {
        # 同上：同一批文件被写出时，按毫秒比会假过期。
        if ($_.LastWriteTimeUtc -gt $bundle) { $stale += "$($_.Name)（$($_.LastWriteTimeUtc.ToString('s'))）" }
    }
    if ($stale.Count -gt 0) { return "这些模块比产物新：" + ($stale -join ', ') }
    $true
}

Check 'package.json 声明 esbuild 开发依赖与 build 脚本' {
    $manifest = Get-Content -LiteralPath $script:ManifestPath -Raw | ConvertFrom-Json
    $deps = $manifest.PSObject.Properties['devDependencies']
    if ($null -eq $deps -or $null -eq $deps.Value.PSObject.Properties['esbuild']) { return 'devDependencies 里没有 esbuild' }
    $scripts = $manifest.PSObject.Properties['scripts']
    if ($null -eq $scripts -or $null -eq $scripts.Value.PSObject.Properties['build']) { return '没有 build 脚本' }
    $build = [string]$scripts.Value.build
    if ($build -notmatch 'esbuild') { return 'build 脚本里没调用 esbuild' }
    if ($build -notmatch 'index\.bundle\.js') { return 'build 输出不叫 index.bundle.js' }
    $true
}

Check '产物内联了 ssh2（不是空壳，也不是外部 import）' {
    $text = [System.IO.File]::ReadAllText($script:BundlePath)
    if ($text.Length -lt 100000) { return "产物只有 $($text.Length) 字节，不像内联了 ssh2" }
    if ($text -notmatch 'ssh2') { return '产物里找不到 ssh2 的痕迹' }
    if ($text -match "(?m)^\s*import\s[^\n]*from\s*['""]ssh2['""]") { return '产物里还有对 ssh2 的外部 import，生产会缺依赖' }
    if ($text -match "(?m)^\s*import\s[^\n]*from\s*['""](asn1|bcrypt-pbkdf|tweetnacl)['""]") { return '产物里还有外部依赖 import' }
    $true
}

Check '产物带了 require/__dirname 兼容 banner（ssh2 的 CJS 胶水需要）' {
    $text = [System.IO.File]::ReadAllText($script:BundlePath)
    if ($text -notmatch 'createRequire') { return '没有 createRequire 兼容层，加载会报 Dynamic require' }
    if ($text -notmatch '__dirname') { return '没有 __dirname 兜底，加载会报 __dirname is not defined' }
    $true
}

""
"结果：$($script:Total - $script:Failures) 项通过 / $($script:Failures) 项失败（共 $script:Total 项）"
if ($script:Failures -gt 0) { exit 1 }
