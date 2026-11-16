# 用 Windows DPAPI（CurrentUser）解密 -Path，把明文 UTF-8 写到 stdout。
# 只写 stdout，不写文件、不写日志。
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

$entropy = [Text.Encoding]::UTF8.GetBytes('dsh-ssh-remote/v1')
$cipher = [IO.File]::ReadAllBytes($Path)
$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $cipher,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)

[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
