# sshctl.ps1 的交互层（D-34）：读密码与读确认。
# 由 sshctl.ps1 用 dot-source 载入，不单独执行。

# 交互输入密码；SSHCTL_PASSWORD 仅供自动化测试，设置后跳过 Read-Host。
function Read-HostPassword {
    param([Parameter(Mandatory = $true)][string]$HostId)

    $fromEnv = [Environment]::GetEnvironmentVariable('SSHCTL_PASSWORD')
    if ($null -ne $fromEnv) {
        $plain = $fromEnv
    } else {
        if ([Console]::IsInputRedirected) {
            throw '当前没有可交互的终端，无法读取密码（自动化测试可设置 SSHCTL_PASSWORD）。'
        }
        [Console]::Error.WriteLine("请输入主机「$HostId」的密码（输入不回显）：")
        $secure = Read-Host -AsSecureString
        $bstr = [IntPtr]::Zero
        try {
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            if ($bstr -ne [IntPtr]::Zero) {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
    }

    if ([string]::IsNullOrEmpty($plain)) {
        throw '密码不能为空。'
    }
    return $plain
}

# 读确认输入；SSHCTL_CONFIRM 仅供自动化测试。非交互且没设环境变量时视为取消。
function Read-HostConfirmation {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$EnvironmentName
    )

    $fromEnv = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if ($null -ne $fromEnv) {
        return $fromEnv.Trim()
    }

    if ([Console]::IsInputRedirected) {
        return ''
    }

    [Console]::Error.WriteLine($Prompt)
    $answer = Read-Host
    if ($null -eq $answer) {
        return ''
    }
    return $answer.Trim()
}
