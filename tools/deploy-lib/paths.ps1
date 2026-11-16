# tools/deploy.ps1 的路径层（D-35）：路径规范化与包含判断、排除表、清单条目、备份命名与列举。
# 由 tools/deploy.ps1 用 dot-source 载入，不单独执行；常量（$script:ExcludedDirNames 等）
# 留在入口，靠同一个 script 作用域解析。

function Resolve-FullPath {
    <#
    .SYNOPSIS
        把相对/绝对路径变成去掉尾分隔符的绝对路径（不要求路径存在）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    [System.IO.Path]::GetFullPath($full).TrimEnd('\', '/')
}

function Test-PathEqual {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Left, [Parameter(Mandatory)][string]$Right)

    [string]::Equals($Left.TrimEnd('\'), $Right.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Test-PathUnder {
    <#
    .SYNOPSIS
        判断 Child 是否落在 Parent 里面（含相等）。用来挡住「正式树在源码树里」这种会自我递归的配置。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Child, [Parameter(Mandatory)][string]$Parent)

    $c = $Child.TrimEnd('\') + '\'
    $p = $Parent.TrimEnd('\') + '\'
    $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

function Test-ExcludedRelativePath {
    <#
    .SYNOPSIS
        插件目录里按相对路径判断是否排除：目录段命中排除表、或文件名命中 *.md。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RelativePath)

    $segments = $RelativePath -split '[\\/]'
    if ($segments.Count -gt 1) {
        foreach ($segment in $segments[0..($segments.Count - 2)]) {
            if ($script:ExcludedDirNames -contains $segment) { return $true }
        }
    }
    $leaf = $segments[-1]
    foreach ($pattern in $script:ExcludedFileNames) {
        if ($leaf -like $pattern) { return $true }
    }
    $false
}

function New-DeployItem {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FullPath, [Parameter(Mandatory)][string]$RelativePath)

    [pscustomobject]@{
        Full     = $FullPath
        Relative = $RelativePath
        Bytes    = (Get-Item -LiteralPath $FullPath).Length
    }
}

function Get-BackupName {
    <#
    .SYNOPSIS
        production.bak.<yyyyMMdd-HHmmss>；同一秒内重复部署时补 -2、-3，避免改名撞车。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$RootPath, [Parameter(Mandatory)][datetime]$Stamp)

    $parent = Split-Path -Parent $RootPath
    $leaf = Split-Path -Leaf $RootPath
    $base = "$leaf.bak.$($Stamp.ToString($script:BackupStampFormat))"
    $candidate = $base
    $index = 2
    while (Test-Path -LiteralPath (Join-Path $parent $candidate)) {
        $candidate = "$base-$index"
        $index++
    }
    $candidate
}

function Get-BackupDirs {
    <#
    .SYNOPSIS
        按名字倒序列出备份目录（时间戳格式可按字典序排，最近的在前）。
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
