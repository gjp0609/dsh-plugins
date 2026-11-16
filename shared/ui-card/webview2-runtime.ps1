# 运行环境层：WebView2 的 DLL 探测与初始化（shared/ui-card/webview2-runtime.ps1）
#
# 从 webview2.ps1 拆出来，只为单文件不过长。这里只有三件事：
#   - 找仓库根 vendor\webview2 下三个 DLL；
#   - 查这台机器现在能不能弹卡（不建窗口）；
#   - 载入程序集并准备环境（环境对象进程内复用，省掉每次几百毫秒的初始化）。
# 窗口、协议、消息泵都在 webview2.ps1 里。

Set-StrictMode -Version Latest

$script:CardShellDir = $PSScriptRoot

$script:WebView2AssembliesLoaded = $false
$script:WebView2Environment = $null
$script:WebView2EnvironmentKey = ''

function Get-CardVendorDir {
    <#
    .SYNOPSIS
        找 WebView2 那几个 DLL 所在目录：从本文件所在目录逐级上溯，命中第一个
        含 Core + Loader 的 vendor\webview2（最多 6 层）。
    #>
    [CmdletBinding()]
    param([string]$StartDir = '')

    $dir = if ([string]::IsNullOrWhiteSpace($StartDir)) { $script:CardShellDir } else { $StartDir }
    for ($i = 0; $i -lt 6 -and -not [string]::IsNullOrWhiteSpace($dir); $i++) {
        $candidate = Join-Path $dir 'vendor\webview2'
        if ((Test-Path -LiteralPath (Join-Path $candidate 'Microsoft.Web.WebView2.Core.dll')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'WebView2Loader.dll'))) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
        $parent = Split-Path -Parent $dir
        if ($parent -eq $dir) { break }
        $dir = $parent
    }
    Join-Path $script:CardShellDir 'vendor\webview2'
}

function Test-CardWebView2 {
    <#
    .SYNOPSIS
        这台机器现在能不能用 WebView2 弹卡。不创建窗口，只查文件与运行时。
    .OUTPUTS
        [pscustomobject] Available / Reason / Core / WinForms / Loader
    #>
    [CmdletBinding()]
    param()

    $dir = Get-CardVendorDir
    $core = Join-Path $dir 'Microsoft.Web.WebView2.Core.dll'
    $winforms = Join-Path $dir 'Microsoft.Web.WebView2.WinForms.dll'
    $loader = Join-Path $dir 'WebView2Loader.dll'

    foreach ($path in @($core, $winforms, $loader)) {
        if (-not (Test-Path -LiteralPath $path)) {
            return [pscustomobject]@{ Available = $false; Reason = "缺少 $path"; Core = $core; WinForms = $winforms; Loader = $loader }
        }
    }

    # 运行时：注册表里 WebView2 的 pv 值（Edge WebView2 Runtime 与 Edge 稳定版都写）。
    $runtime = ''
    try {
        $keys = @(
            'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
            'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
            'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
        )
        foreach ($key in $keys) {
            $item = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            $pv = $null
            if ($null -ne $item) {
                $property = $item.PSObject.Properties['pv']
                if ($null -ne $property) { $pv = [string]$property.Value }
            }
            if (-not [string]::IsNullOrEmpty($pv)) { $runtime = $pv; break }
        }
    } catch {
        $runtime = ''
    }

    [pscustomobject]@{
        Available = $true
        Reason    = if ($runtime -eq '') { '未检测到 WebView2 运行时版本号（可能仍可用，创建时会再判断）' } else { "运行时 $runtime" }
        Core      = $core
        WinForms  = $winforms
        Loader    = $loader
    }
}

function Initialize-CardWebView2 {
    <#
    .SYNOPSIS
        载入托管程序集并准备环境（环境对象进程内复用，省掉每次几百毫秒的初始化）。
    .PARAMETER DataDir
        WebView2 的用户数据目录。空 = %LOCALAPPDATA%\dsh-ui-card\webview2。
    #>
    [CmdletBinding()]
    param([string]$DataDir)

    $probe = Test-CardWebView2
    if (-not $probe.Available) { throw $probe.Reason }

    if (-not $script:WebView2AssembliesLoaded) {
        $loaderDir = Split-Path -Parent $probe.Loader
        if (-not ($env:PATH -split ';' | Where-Object { $_ -eq $loaderDir })) {
            $env:PATH = $loaderDir + ';' + $env:PATH
        }
        [void][System.Reflection.Assembly]::LoadFrom($probe.Core)
        [void][System.Reflection.Assembly]::LoadFrom($probe.WinForms)
        $script:WebView2AssembliesLoaded = $true
    }

    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        $root = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $env:TEMP } else { $env:LOCALAPPDATA }
        $DataDir = Join-Path $root 'dsh-ui-card\webview2'
    }
    try {
        New-Item -ItemType Directory -Path $DataDir -Force -ErrorAction Stop | Out-Null
    } catch {
        # 一条明确的错，而不是让 CreateAsync 拿一个不可写目录去报 E_UNEXPECTED。
        throw "WebView2 数据目录不可用（$DataDir）：$($_.Exception.Message)"
    }

    if ($null -eq $script:WebView2Environment -or $script:WebView2EnvironmentKey -ne $DataDir) {
        $task = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $DataDir)
        $deadline = [DateTime]::Now.AddSeconds(20)
        while (-not $task.IsCompleted -and [DateTime]::Now -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 5
        }
        # 没有超时收口就等于「永远弹不出来」：必须自己中断，让调用方拿到 failed 而不是卡死。
        if (-not $task.IsCompleted) { throw 'WebView2 环境初始化超时（20s）' }
        if ($task.IsFaulted) { throw $task.Exception.GetBaseException().Message }
        $script:WebView2Environment = $task.Result
        $script:WebView2EnvironmentKey = $DataDir
    }
    $script:WebView2Environment
}
