# sshctl.ps1 的命令层（D-34）：每个子命令一个 Invoke-*，加排序与用法。
# 由 sshctl.ps1 用 dot-source 载入，不单独执行；退出码写 $script:ExitCode
# （dot-source 后 $script: 仍指主脚本，见 D-34）。

# 列出主机 id（大小写敏感去重后按字典序），用于 status。
function Get-SortedHostIds {
    param([Parameter(Mandatory = $true)]$Hosts)
    return @($Hosts.Keys | ForEach-Object { [string]$_ } | Sort-Object)
}

# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------

function Invoke-Status {
    Write-Output "数据目录：$DataDir"

    $document = Read-HostsDocument
    $hosts = $document['hosts']
    $ids = Get-SortedHostIds -Hosts $hosts
    if ([IO.File]::Exists($script:HostsPath)) {
        $hostsState = '存在'
    } else {
        $hostsState = '不存在'
    }
    Write-Output "hosts.json：$hostsState，主机 $($ids.Count) 台"
    if ($ids.Count -eq 0) {
        Write-Output '  主机 id：（无）'
    } else {
        Write-Output "  主机 id：$($ids -join '、')"
    }

    $wsl = $document['wsl']
    $distros = @()
    if ($null -ne $wsl -and $wsl -is [System.Collections.IDictionary]) {
        $distros = @($wsl.Keys | ForEach-Object { [string]$_ } | Sort-Object)
    }
    if ($distros.Count -eq 0) {
        Write-Output 'WSL 发行版：（无）'
    } else {
        Write-Output "WSL 发行版：$($distros -join '、')"
    }

    if (-not [IO.File]::Exists($script:VaultPath)) {
        Write-Output 'vault.dat：不存在（还没有保存任何密码）'
    } else {
        $cipherBytes = (Get-Item -LiteralPath $script:VaultPath).Length
        try {
            $entries = Read-VaultEntries
            Write-Output "vault.dat：存在，条目 $($entries.Count) 个，密文 $cipherBytes 字节"
        } catch {
            Write-Output "vault.dat：存在，密文 $cipherBytes 字节，但读取失败：$($_.Exception.Message)"
        }
    }

    $script:ExitCode = 0
}

function Invoke-List {
    $document = Read-HostsDocument
    $hosts = $document['hosts']

    if ($hosts.Count -eq 0) {
        [Console]::Error.WriteLine('（hosts.json 里还没有主机）')
        $script:ExitCode = 0
        return
    }

    foreach ($key in (Get-SortedHostIds -Hosts $hosts)) {
        $entry = $hosts[$key]
        if ($null -eq $entry -or $entry -isnot [System.Collections.IDictionary]) {
            [Console]::Error.WriteLine("警告：主机「$key」的配置不是对象，已跳过。")
            continue
        }
        $address = $entry['address']
        $user = $entry['user']
        if ($address -isnot [string] -or $address.Trim() -eq '' -or $user -isnot [string] -or $user.Trim() -eq '') {
            [Console]::Error.WriteLine("警告：主机「$key」缺 address 或 user，已跳过。")
            continue
        }
        $port = $script:DefaultPort
        if ($null -ne (Get-ExactKey -Dictionary $entry -Key 'port')) {
            $parsed = 0
            if (-not [int]::TryParse([string]$entry['port'], [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
                [Console]::Error.WriteLine("警告：主机「$key」的端口「$($entry['port'])」不合法，已跳过。")
                continue
            }
            $port = $parsed
        }
        $label = $entry['label']
        if ($label -isnot [string] -or $label.Trim() -eq '') {
            $label = $key
        }
        Write-Output ('{0}  {1}:{2}  {3}  {4}' -f $key, $address.Trim(), $port, $user.Trim(), $label.Trim())
    }

    $script:ExitCode = 0
}

function Invoke-Add {
    param([string[]]$Arguments)

    if ($Arguments.Count -lt 2) {
        throw '用法：sshctl.ps1 add <id> <address> [<port>] <user> [<label>]'
    }

    $id = $Arguments[0].Trim()
    $address = $Arguments[1].Trim()

    if ($id -cnotmatch $script:HostIdPattern) {
        throw "主机 id「$id」不合法（必须以字母数字开头，只允许 A-Z a-z 0-9 . _ -，最长 64 个字符）。"
    }
    if ($address -eq '') {
        throw 'address 不能为空。'
    }

    $tail = @()
    if ($Arguments.Count -gt 2) {
        $tail = @($Arguments[2..($Arguments.Count - 1)])
    }

    $port = $script:DefaultPort
    $user = $null
    $label = $null

    if ($tail.Count -ge 1 -and $tail[0] -match '^\d+$') {
        # 形如 add <id> <address> <port> <user> [<label>]
        $parsedPort = 0
        if (-not [int]::TryParse($tail[0], [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
            throw "端口「$($tail[0])」不合法（应为 1-65535 的整数）。"
        }
        $port = $parsedPort
        if ($tail.Count -ge 2) { $user = $tail[1] }
        if ($tail.Count -ge 3) { $label = $tail[2] }
        if ($tail.Count -gt 3) {
            throw '参数过多。用法：sshctl.ps1 add <id> <address> [<port>] <user> [<label>]'
        }
    } else {
        # 形如 add <id> <address> <user> [<label>]（端口省略）
        if ($tail.Count -ge 1) { $user = $tail[0] }
        if ($tail.Count -ge 2) { $label = $tail[1] }
        if ($tail.Count -gt 2) {
            throw '参数过多。用法：sshctl.ps1 add <id> <address> [<port>] <user> [<label>]'
        }
    }

    if ([string]::IsNullOrWhiteSpace($user)) {
        throw '缺少用户名。用法：sshctl.ps1 add <id> <address> [<port>] <user> [<label>]'
    }
    $user = $user.Trim()
    if ($null -ne $label) { $label = $label.Trim() }

    $document = Read-HostsDocument
    $hosts = $document['hosts']

    if ($null -ne (Get-ExactKey -Dictionary $hosts -Key $id)) {
        throw "主机「$id」已存在，未做任何修改。"
    }

    $entry = [ordered]@{
        address = $address
        port    = $port
        user    = $user
    }
    if (-not [string]::IsNullOrEmpty($label)) {
        $entry['label'] = $label
    }

    $hosts[$id] = $entry
    Save-HostsDocument -Document $document

    Write-Output "已添加主机「$id」：$address`:$port，用户 $user。"
    $script:ExitCode = 0
}

function Invoke-Set {
    param([string[]]$Arguments)

    if ($Arguments.Count -ne 1) {
        throw '用法：sshctl.ps1 set <id>'
    }
    $id = $Arguments[0].Trim()

    $document = Read-HostsDocument
    $hosts = $document['hosts']
    $spec = Get-RemoteHostSpec -Hosts $hosts -HostId $id

    $password = Read-HostPassword -HostId $id

    $entries = Read-VaultEntries
    $entries[$spec.key] = [ordered]@{
        password = $password
        addrHash = Get-AddrHash -Address $spec.address -Port $spec.port -User $spec.user
    }
    Save-VaultEntries -Entries $entries

    Write-Output "已更新主机「$id」的密码（vault 共 $($entries.Count) 个条目）。"
    $script:ExitCode = 0
}

function Invoke-Remove {
    param([string[]]$Arguments)

    if ($Arguments.Count -ne 1) {
        throw '用法：sshctl.ps1 remove <id>'
    }
    $id = $Arguments[0].Trim()

    $confirmation = Read-HostConfirmation -Prompt "将删除主机「$id」的 hosts.json 条目和已保存的密码。输入 yes 确认：" -EnvironmentName 'SSHCTL_CONFIRM'
    if ($confirmation -ne 'yes') {
        [Console]::Error.WriteLine('已取消（未输入 yes）。')
        $script:ExitCode = 2
        return
    }

    $document = Read-HostsDocument
    $hosts = $document['hosts']
    $hostsKey = Get-ExactKey -Dictionary $hosts -Key $id

    $entries = Read-VaultEntries
    $vaultKey = Get-ExactKey -Dictionary $entries -Key $id

    if ($null -eq $hostsKey -and $null -eq $vaultKey) {
        throw "主机「$id」不存在（hosts.json 与 vault 里都没有）。"
    }

    $removedHosts = $false
    $removedVault = $false

    if ($null -ne $hostsKey) {
        $hosts.Remove($hostsKey)
        Save-HostsDocument -Document $document
        $removedHosts = $true
    }
    if ($null -ne $vaultKey) {
        $entries.Remove($vaultKey)
        Save-VaultEntries -Entries $entries
        $removedVault = $true
    }

    $hostsText = if ($removedHosts) { '已删除' } else { '本来就没有' }
    $vaultText = if ($removedVault) { '已删除' } else { '本来就没有' }
    Write-Output "已处理主机「$id」：hosts.json $hostsText，vault $vaultText。"
    $script:ExitCode = 0
}

function Invoke-Export {
    $confirmation = Read-HostConfirmation -Prompt '警告：这会以明文输出所有密码！确认请输入 EXPORT：' -EnvironmentName 'SSHCTL_CONFIRM'
    if ($confirmation -cne 'EXPORT') {
        [Console]::Error.WriteLine('已取消（未原样输入 EXPORT）。')
        $script:ExitCode = 2
        return
    }

    if (-not [IO.File]::Exists($script:VaultPath)) {
        throw 'vault.dat 不存在，没有可导出的密码。'
    }

    $plain = Invoke-UnprotectText -Path $script:VaultPath
    try {
        $null = ConvertFrom-Json -InputObject $plain -AsHashtable
    } catch {
        throw "vault 解密后不是合法 JSON，已拒绝输出：$($_.Exception.Message)"
    }

    # stdout 只放明文 JSON；提示与警告都走 stderr。
    [Console]::Out.Write($plain)
    if (-not $plain.EndsWith("`n")) {
        [Console]::Out.Write("`n")
    }
    $script:ExitCode = 0
}

function Invoke-Import {
    param([string[]]$Arguments)

    if ($Arguments.Count -ne 1) {
        throw '用法：sshctl.ps1 import <明文json文件>'
    }
    $importPath = $Arguments[0]
    if (-not [IO.File]::Exists($importPath)) {
        throw "找不到导入文件：$importPath"
    }

    $text = [IO.File]::ReadAllText($importPath, [Text.Encoding]::UTF8)
    try {
        $document = ConvertFrom-Json -InputObject $text -AsHashtable
    } catch {
        throw "导入文件不是合法 JSON：$($_.Exception.Message)"
    }
    if ($null -eq $document -or $document -isnot [System.Collections.IDictionary]) {
        throw '导入文件的顶层必须是 JSON 对象。'
    }

    $version = $document['version']
    if (-not (Test-VaultVersionOne -Version $version)) {
        throw "导入文件的 version「$version」不认识（当前只支持数字 1）。"
    }

    $rawEntries = $document['entries']
    if ($null -eq $rawEntries -or $rawEntries -isnot [System.Collections.IDictionary]) {
        throw '导入文件的 entries 必须是 JSON 对象。'
    }

    $imported = New-OrderedMap
    foreach ($key in @($rawEntries.Keys)) {
        $entry = $rawEntries[$key]
        if ($null -eq $entry -or $entry -isnot [System.Collections.IDictionary]) {
            throw "导入文件的条目「$key」不是对象。"
        }
        $password = $entry['password']
        $addrHash = $entry['addrHash']
        if ($password -isnot [string] -or $password -eq '') {
            throw "导入文件的条目「$key」缺 password。"
        }
        if ($addrHash -isnot [string] -or $addrHash -eq '') {
            throw "导入文件的条目「$key」缺 addrHash。"
        }
        $imported[[string]$key] = [ordered]@{
            password = $password
            addrHash = $addrHash
        }
    }

    $entries = Read-VaultEntries
    foreach ($key in @($imported.Keys)) {
        $entries[[string]$key] = $imported[$key]
    }
    Save-VaultEntries -Entries $entries

    Write-Output "已导入 $($imported.Count) 条，vault 现有 $($entries.Count) 条。"
    $script:ExitCode = 0
}

function Show-Usage {
    Write-Output @'
用法：sshctl.ps1 <子命令> [参数] [-DataDir <目录>]

  status                                     查看数据目录、主机、WSL 与 vault 状态
  list                                       列出主机（id 地址:端口 用户 标签）
  add <id> <address> [<port>] <user> [<label>]  添加主机（端口省略时默认 22）
  set <id>                                   交互输入密码并写入 vault
  remove <id>                                删除主机及其密码（需输入 yes）
  export                                     导出 vault 明文 JSON（需输入 EXPORT）
  import <明文json文件>                       合并导入 vault 明文 JSON

退出码：0 成功；1 出错；2 用户取消。
'@
}
