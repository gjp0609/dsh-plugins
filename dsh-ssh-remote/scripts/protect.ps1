# 用 Windows DPAPI（CurrentUser）加密 stdin 里的 UTF-8 文本，写到 -Path。
# 明文只走 stdin，不落在命令行参数里。
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

$entropy = [Text.Encoding]::UTF8.GetBytes('dsh-ssh-remote/v1')
$json = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($json)) {
    throw 'protect: stdin 为空'
}

$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$cipher = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $entropy,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)

$dir = [IO.Path]::GetDirectoryName($Path)
if ($dir -and -not [IO.Directory]::Exists($dir)) {
    [void][IO.Directory]::CreateDirectory($dir)
}

# 先写临时文件再替换，避免写一半留下坏 vault。
# 临时名必须带随机后缀：固定 "$Path.tmp" 时，两次并发写会互相覆盖/抢 Move，
# 结果是内存与磁盘不一致，甚至丢一条密码。
$tmp = "$Path.tmp-$([IO.Path]::GetRandomFileName())"
[IO.File]::WriteAllBytes($tmp, $cipher)
[IO.File]::Move($tmp, $Path, $true)
