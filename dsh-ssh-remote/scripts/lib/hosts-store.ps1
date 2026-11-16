# sshctl.ps1 的存储层（D-34）：hosts.json / vault.dat 的读写、DPAPI 包装、addrHash
# 与主机配置解析。由 sshctl.ps1 用 dot-source 载入，不单独执行；路径来自入口脚本算好的
# $script:HostsPath / $script:VaultPath / $script:ProtectScript / $script:UnprotectScript。

# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------

# 在 IDictionary 里按“大小写敏感”的方式找键，返回磁盘上原来的键名（找不到返回 $null）。
# 不用 ContainsKey：ConvertFrom-Json -AsHashtable 与 [ordered]@{} 的类型不一致，且
# 主机 id 在 JS 侧是大小写敏感的，这里必须一致。
function Get-ExactKey {
    param(
        [Parameter(Mandatory = $true)]$Dictionary,
        [Parameter(Mandatory = $true)][string]$Key
    )
    foreach ($candidate in @($Dictionary.Keys)) {
        if ([string]$candidate -ceq $Key) {
            return [string]$candidate
        }
    }
    return $null
}

# 大小写敏感的“有序字典”。PowerShell 的 [ordered]@{} 大小写不敏感，会把 webx 和 WEBX
# 当成同一个键；主机 id 在 JS 侧是大小写敏感的，所以凡是按 id 存的映射都要用 Ordinal 比较器。
function New-OrderedMap {
    return [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
}

function New-HostsDocument {
    return [ordered]@{
        hosts    = (New-OrderedMap)
        wsl      = (New-OrderedMap)
        defaults = [ordered]@{
            connectTimeoutMs = 15000
            stepTimeoutMs    = 30000
            idleTimeoutMs    = 600000
            maxConnections   = 10
        }
    }
}

# 读 hosts.json。文件不存在 / 内容为空都视为空文档；结构不对则抛错。
function Read-HostsDocument {
    if (-not [IO.File]::Exists($script:HostsPath)) {
        return New-HostsDocument
    }

    $text = [IO.File]::ReadAllText($script:HostsPath, [Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) {
        return New-HostsDocument
    }

    try {
        $document = ConvertFrom-Json -InputObject $text -AsHashtable
    } catch {
        throw "hosts.json 不是合法 JSON：$($_.Exception.Message)"
    }

    if ($null -eq $document -or $document -isnot [System.Collections.IDictionary]) {
        throw 'hosts.json 顶层必须是 JSON 对象。'
    }

    # 补齐缺失的段（不动已有内容，保留用户手写的其它字段）。
    if ($null -eq $document['hosts']) {
        $document['hosts'] = (New-OrderedMap)
    }
    if ($document['hosts'] -isnot [System.Collections.IDictionary]) {
        throw 'hosts.json 的 hosts 段必须是 JSON 对象。'
    }
    if ($null -eq $document['wsl']) {
        $document['wsl'] = (New-OrderedMap)
    }
    if ($null -eq $document['defaults']) {
        $document['defaults'] = [ordered]@{}
    }

    return $document
}

# 原子写 hosts.json：先写同目录临时文件，再 Move-Item -Force 覆盖。
function Save-HostsDocument {
    param([Parameter(Mandatory = $true)]$Document)

    $directory = [IO.Path]::GetDirectoryName($script:HostsPath)
    if (-not [IO.Directory]::Exists($directory)) {
        [void][IO.Directory]::CreateDirectory($directory)
    }

    $json = ConvertTo-Json -InputObject $Document -Depth 32
    $tempPath = Join-Path $directory ('.hosts.json.tmp-' + [guid]::NewGuid().ToString('N'))

    try {
        [IO.File]::WriteAllText($tempPath, $json + "`n", [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempPath -Destination $script:HostsPath -Force
    } catch {
        if ([IO.File]::Exists($tempPath)) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

# 调 protect.ps1：把明文喂给它的 stdin，由它按 DPAPI(CurrentUser) + 固定熵加密。
function Invoke-ProtectText {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    if (-not [IO.File]::Exists($script:ProtectScript)) {
        throw "找不到加密脚本：$($script:ProtectScript)"
    }

    $originalIn = [Console]::In
    try {
        # protect.ps1 从 [Console]::In 读明文；这里在同一进程内换掉输入源，
        # 不产生子进程、不写临时明文文件。
        [Console]::SetIn([IO.StringReader]::new($Text))
        & $script:ProtectScript -Path $Path
    } finally {
        [Console]::SetIn($originalIn)
    }
}

# 调 unprotect.ps1：它把明文写到 [Console]::Out；这里同进程内换一个 StringWriter 接住。
function Invoke-UnprotectText {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not [IO.File]::Exists($script:UnprotectScript)) {
        throw "找不到解密脚本：$($script:UnprotectScript)"
    }

    $originalOut = [Console]::Out
    $writer = [IO.StringWriter]::new()
    try {
        [Console]::SetOut($writer)
        & $script:UnprotectScript -Path $Path
        return $writer.ToString()
    } finally {
        [Console]::SetOut($originalOut)
    }
}

# vault 的 version 必须与 JS 侧一致：JSON 数字 1（字符串 "1" 不算）。
function Test-VaultVersionOne {
    param($Version)
    if ($null -eq $Version) {
        return $false
    }
    if ($Version -is [bool] -or $Version -is [string]) {
        return $false
    }
    try {
        return ([double]$Version -eq 1.0)
    } catch {
        return $false
    }
}

# 读 vault.dat 并解密成 entries（有序字典）。文件不存在视为空仓库。
function Read-VaultEntries {
    if (-not [IO.File]::Exists($script:VaultPath)) {
        return (New-OrderedMap)
    }

    $plain = Invoke-UnprotectText -Path $script:VaultPath
    try {
        $document = ConvertFrom-Json -InputObject $plain -AsHashtable
    } catch {
        throw "vault 解密后不是合法 JSON（文件可能已损坏）：$($_.Exception.Message)"
    }

    if ($null -eq $document -or $document -isnot [System.Collections.IDictionary]) {
        throw 'vault 内容不是 JSON 对象。'
    }

    $version = $document['version']
    if (-not (Test-VaultVersionOne -Version $version)) {
        throw "vault 版本 $version 不认识（当前只支持数字 1）。"
    }

    $rawEntries = $document['entries']
    if ($null -eq $rawEntries -or $rawEntries -isnot [System.Collections.IDictionary]) {
        throw 'vault.entries 不是 JSON 对象。'
    }

    $entries = New-OrderedMap
    foreach ($key in @($rawEntries.Keys)) {
        $entry = $rawEntries[$key]
        if ($null -eq $entry -or $entry -isnot [System.Collections.IDictionary]) {
            throw "vault 条目「$key」不是对象。"
        }
        $password = $entry['password']
        $addrHash = $entry['addrHash']
        if ($password -isnot [string] -or $password -eq '') {
            throw "vault 条目「$key」缺 password。"
        }
        if ($addrHash -isnot [string] -or $addrHash -eq '') {
            throw "vault 条目「$key」缺 addrHash。"
        }
        $entries[[string]$key] = [ordered]@{
            password = $password
            addrHash = $addrHash
        }
    }

    return $entries
}

# 重新加密写回 vault.dat；旧文件先备份成 vault.dat.bak。
function Save-VaultEntries {
    param([Parameter(Mandatory = $true)]$Entries)

    $document = [ordered]@{
        version = 1
        entries = (New-OrderedMap)
    }
    foreach ($key in @($Entries.Keys)) {
        $entry = $Entries[$key]
        $document['entries'][[string]$key] = [ordered]@{
            password = [string]$entry['password']
            addrHash = [string]$entry['addrHash']
        }
    }

    $plain = ConvertTo-Json -InputObject $document -Depth 16 -Compress

    if (-not [IO.Directory]::Exists($DataDir)) {
        [void][IO.Directory]::CreateDirectory($DataDir)
    }
    if ([IO.File]::Exists($script:VaultPath)) {
        Copy-Item -LiteralPath $script:VaultPath -Destination $script:VaultBackupPath -Force
    }

    Invoke-ProtectText -Path $script:VaultPath -Text $plain
}

# addrHash 必须与 JS 侧 lib/hosts.mjs 一致：sha256hex("$address|$port|$user")，小写无连字符。
function Get-AddrHash {
    param(
        [Parameter(Mandatory = $true)][string]$Address,
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][string]$User
    )
    $text = '{0}|{1}|{2}' -f $Address.Trim(), $Port, $User.Trim()
    $bytes = [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))
    return [Convert]::ToHexString($bytes).ToLowerInvariant()
}

# 取一台远程主机的当前配置（用于算 addrHash）；不存在或字段非法时抛错。
function Get-RemoteHostSpec {
    param(
        [Parameter(Mandatory = $true)]$Hosts,
        [Parameter(Mandatory = $true)][string]$HostId
    )

    $key = Get-ExactKey -Dictionary $Hosts -Key $HostId
    if ($null -eq $key) {
        throw "hosts.json 里没有主机「$HostId」，请先用 add 添加。"
    }

    $entry = $Hosts[$key]
    if ($null -eq $entry -or $entry -isnot [System.Collections.IDictionary]) {
        throw "主机「$HostId」的配置不是 JSON 对象，请先修正 hosts.json。"
    }

    $address = $entry['address']
    $user = $entry['user']
    if ($address -isnot [string] -or $address.Trim() -eq '') {
        throw "主机「$HostId」缺 address，请先修正 hosts.json。"
    }
    if ($user -isnot [string] -or $user.Trim() -eq '') {
        throw "主机「$HostId」缺 user，请先修正 hosts.json。"
    }

    $port = $script:DefaultPort
    if ($null -ne (Get-ExactKey -Dictionary $entry -Key 'port')) {
        $parsed = 0
        if (-not [int]::TryParse([string]$entry['port'], [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
            throw "主机「$HostId」的端口「$($entry['port'])」不合法，请先修正 hosts.json。"
        }
        $port = $parsed
    }

    return @{
        key     = $key
        address = $address.Trim()
        port    = $port
        user    = $user.Trim()
    }
}
