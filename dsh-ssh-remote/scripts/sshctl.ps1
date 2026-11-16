#Requires -Version 7.0
<#
.SYNOPSIS
    dsh-ssh-remote 的独立命令行管理工具。

.DESCRIPTION
    直接读写插件数据目录（默认 %USERPROFILE%\.dsh\plugin-data\ssh-remote）：

      hosts.json   主机元数据（明文，可手改）
      vault.dat    密码（DPAPI 密文，明文绝不落盘）

    加解密复用同目录的 protect.ps1 / unprotect.ps1：明文只走 stdin / stdout。
    本脚本不会写任何明文临时文件，也不记录日志。

.PARAMETER Command
    子命令：status | list | add | set | remove | export | import。

.PARAMETER Rest
    子命令的其余参数。

.PARAMETER DataDir
    数据目录，默认 %USERPROFILE%\.dsh\plugin-data\ssh-remote。

.EXAMPLE
    sshctl.ps1 status
    sshctl.ps1 list
    sshctl.ps1 add web1 192.168.1.11 22 deploy 主机E
    sshctl.ps1 set web1
    sshctl.ps1 remove web1
    sshctl.ps1 export
    sshctl.ps1 import .\vault-plain.json

.NOTES
    退出码：0 成功；1 出错；2 用户取消。

    自动化测试旁路（仅供自动化测试，正常使用不要设置）：
      SSHCTL_PASSWORD   设置后跳过密码交互，直接使用该值（不会回显、不会写盘）
      SSHCTL_CONFIRM    设置后跳过确认输入：export 需为 EXPORT，remove 需为 yes
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Command,

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest,

    [string]$DataDir
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 常量与路径
# ---------------------------------------------------------------------------

$script:HostIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
$script:DefaultPort = 22
$script:ExitCode = 0

if ([string]::IsNullOrWhiteSpace($DataDir)) {
    $userProfile = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
        $userProfile = [Environment]::GetFolderPath('UserProfile')
    }
    if ([string]::IsNullOrWhiteSpace($userProfile)) {
        [Console]::Error.WriteLine('错误：无法确定用户目录，请用 -DataDir 指定数据目录。')
        exit 1
    }
    $DataDir = Join-Path (Join-Path (Join-Path $userProfile '.dsh') 'plugin-data') 'ssh-remote'
}
$DataDir = [IO.Path]::GetFullPath($DataDir)

$script:HostsPath = Join-Path $DataDir 'hosts.json'
$script:VaultPath = Join-Path $DataDir 'vault.dat'
$script:VaultBackupPath = Join-Path $DataDir 'vault.dat.bak'
$script:ProtectScript = Join-Path $PSScriptRoot 'protect.ps1'
$script:UnprotectScript = Join-Path $PSScriptRoot 'unprotect.ps1'

# ---------------------------------------------------------------------------
# 载入库文件
# ---------------------------------------------------------------------------

# 三个库都 dot-source 进本脚本作用域：$script: 仍指本文件，所以
# $script:ExitCode / $script:HostsPath 的读写语义与拆分前一致（D-34）。
. (Join-Path $PSScriptRoot 'lib\hosts-store.ps1')
. (Join-Path $PSScriptRoot 'lib\prompts.ps1')
. (Join-Path $PSScriptRoot 'lib\commands.ps1')

# ---------------------------------------------------------------------------
# 分发
# ---------------------------------------------------------------------------

try {
    if ([string]::IsNullOrWhiteSpace($Command)) {
        Show-Usage
        [Console]::Error.WriteLine('错误：请指定子命令。')
        exit 1
    }

    $arguments = @()
    if ($null -ne $Rest) {
        $arguments = @($Rest)
    }

    switch ($Command.Trim().ToLowerInvariant()) {
        'status' { Invoke-Status }
        'list' { Invoke-List }
        'add' { Invoke-Add -Arguments $arguments }
        'set' { Invoke-Set -Arguments $arguments }
        'remove' { Invoke-Remove -Arguments $arguments }
        'export' { Invoke-Export }
        'import' { Invoke-Import -Arguments $arguments }
        'help' { Show-Usage }
        '--help' { Show-Usage }
        '-h' { Show-Usage }
        default {
            Show-Usage
            throw "未知子命令「$Command」。"
        }
    }
} catch {
    $message = $_.Exception.Message
    $ErrorActionPreference = 'Continue'
    Write-Error "错误：$message"
    exit 1
}

exit $script:ExitCode
