# 纯逻辑自检：卡片图标资产（shared/ui-card/assets/card.ico），不建窗口、不需要提权。
#
# 跑法：& tests\card-icon.ps1
#
# 覆盖：
#   - assets/card.ico 存在、能被 [System.Drawing.Icon] 读回、是正方形；
#   - 一个 ICO 里确实有 16/32/48/256 四档（读目录项，不信文件名）；
#   - 每档都是 32bpp、数据落在文件内；
#   - 透明底（四角 alpha=0）+ 直接绘制的内容（有 antd orange-6 的橙色像素，没有铺满的实心块）；
#   - card-256.png 是给人看的 256×256 预览；
#   - 生成脚本在，且注明颜色来自 antd orange 调色板第 6 档。
#
# 图标只是**窗口属性**（任务栏 / alt-tab），卡片内部视觉不掺和（PREFERENCES B-25）。

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:CardDir = Join-Path $script:RepoRoot 'shared\ui-card'
$script:AssetsDir = Join-Path $script:CardDir 'assets'
$script:IconPath = Join-Path $script:AssetsDir 'card.ico'
$script:PreviewPath = Join-Path $script:AssetsDir 'card-256.png'
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
            return
        }
        "FAIL  $Name -> $result"
        $script:Failures++
    } catch {
        "FAIL  $Name -> 抛异常：$($_.Exception.Message)"
        $script:Failures++
    }
}

function Get-IconDirectoryEntries {
    <#
    .SYNOPSIS
        读 .ico 的目录项（size / bpp / 数据长度 / 偏移）。坏文件返回空数组。
    #>
    param([Parameter(Mandatory)][string]$Path)

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 6) { return @() }
    if ([BitConverter]::ToInt16($bytes, 2) -ne 1) { return @() } # type 必须是 1（icon）
    $count = [BitConverter]::ToInt16($bytes, 4)
    if ($count -le 0 -or $bytes.Length -lt (6 + 16 * $count)) { return @() }

    $entries = @()
    for ($i = 0; $i -lt $count; $i++) {
        $offset = 6 + 16 * $i
        # 宽度/高度字节为 0 表示 256（一个字节装不下 256）。
        $width = if ($bytes[$offset] -eq 0) { 256 } else { [int]$bytes[$offset] }
        $height = if ($bytes[$offset + 1] -eq 0) { 256 } else { [int]$bytes[$offset + 1] }
        $entries += [pscustomobject]@{
            Width     = $width
            Height    = $height
            BitCount  = [BitConverter]::ToInt16($bytes, $offset + 6)
            Bytes     = [BitConverter]::ToInt32($bytes, $offset + 8)
            ImageAt   = [BitConverter]::ToInt32($bytes, $offset + 12)
        }
    }
    $entries
}

function Get-IconPixelStats {
    <#
    .SYNOPSIS
        读一档尺寸的位图，返回四角 alpha、橙色像素数、完全不透明像素数。
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][int]$Size
    )

    $icon = [System.Drawing.Icon]::new($Path, $Size, $Size)
    try {
        $bitmap = $icon.ToBitmap()
        try {
            $width = $bitmap.Width
            $height = $bitmap.Height
            $orange = 0
            $opaque = 0
            $visible = 0
            for ($y = 0; $y -lt $height; $y++) {
                for ($x = 0; $x -lt $width; $x++) {
                    $pixel = $bitmap.GetPixel($x, $y)
                    if ($pixel.A -ge 250) { $opaque++ }
                    if ($pixel.A -ge 96) { $visible++ }
                    # antd orange-6 = #FA8C16：只认这个色阶附近的像素（抗锯齿边缘不算）。
                    if ($pixel.A -ge 200 -and $pixel.R -ge 235 -and $pixel.G -ge 115 -and $pixel.G -le 170 -and $pixel.B -le 80) {
                        $orange++
                    }
                }
            }
            [pscustomobject]@{
                Width     = $width
                Height    = $height
                CornerA   = @(
                    $bitmap.GetPixel(0, 0).A
                    $bitmap.GetPixel($width - 1, 0).A
                    $bitmap.GetPixel(0, $height - 1).A
                    $bitmap.GetPixel($width - 1, $height - 1).A
                )
                Orange    = $orange
                Opaque    = $opaque
                Visible   = $visible
            }
        } finally {
            $bitmap.Dispose()
        }
    } finally {
        $icon.Dispose()
    }
}

# ---- 资产存在与可加载 -------------------------------------------------------------

Check '图标：assets/card.ico 存在（产物入库，不靠现场生成）' {
    if (-not (Test-Path -LiteralPath $script:IconPath)) { return "缺 $script:IconPath" }
    if ((Get-Item -LiteralPath $script:IconPath).Length -le 1024) { return '文件小得不像一个多尺寸图标' }
    $true
}

Check '图标：能被 [System.Drawing.Icon] 加载，且是正方形' {
    $icon = [System.Drawing.Icon]::new($script:IconPath)
    try {
        if ($icon.Width -ne $icon.Height) { return "不是正方形：$($icon.Width)x$($icon.Height)" }
        if ($icon.Width -lt 16 -or $icon.Width -gt 256) { return "尺寸异常：$($icon.Width)" }
    } finally {
        $icon.Dispose()
    }
    $true
}

Check '图标：一个 ICO 里含 16/32/48/256 四档' {
    $entries = @(Get-IconDirectoryEntries -Path $script:IconPath)
    if ($entries.Count -ne 4) { return "目录项 $($entries.Count) 个，应为 4" }
    $sizes = @($entries | ForEach-Object { $_.Width } | Sort-Object)
    if (($sizes -join ',') -ne '16,32,48,256') { return "尺寸是 $($sizes -join ',')" }
    $true
}

Check '图标：每档都是 32bpp 的 DIB，数据落在文件内且头里的宽高对得上' {
    $bytes = [System.IO.File]::ReadAllBytes($script:IconPath)
    foreach ($entry in @(Get-IconDirectoryEntries -Path $script:IconPath)) {
        if ($entry.BitCount -ne 32) { return "$($entry.Width) 档是 $($entry.BitCount)bpp" }
        if ($entry.Bytes -le 0) { return "$($entry.Width) 档长度为 0" }
        if (($entry.ImageAt + $entry.Bytes) -gt $bytes.Length) { return "$($entry.Width) 档数据越界（文件被截断？）" }
        # DIB：biWidth 必须等于目录里的宽，biHeight 是两倍（XOR 图 + AND 掩码）。
        $dibWidth = [BitConverter]::ToInt32($bytes, $entry.ImageAt + 4)
        $dibHeight = [BitConverter]::ToInt32($bytes, $entry.ImageAt + 8)
        if ($dibWidth -ne $entry.Width) { return "$($entry.Width) 档 DIB 宽是 $dibWidth" }
        if ($dibHeight -ne ($entry.Height * 2)) { return "$($entry.Width) 档 DIB 高是 $dibHeight，应为 $($entry.Height * 2)" }
    }
    $true
}

# ---- 造型与配色（B-25：透明底 + 直接绘制内容） -------------------------------------

Check '图标：透明底（四角 alpha=0），不是纯色方块托底' {
    foreach ($size in @(16, 48)) {
        $stats = Get-IconPixelStats -Path $script:IconPath -Size $size
        foreach ($alpha in $stats.CornerA) {
            if ($alpha -ne 0) { return "$size 档四角有底色：alpha=$alpha" }
        }
        # 纯色方块托底会让可见像素接近满幅；线条图只占一部分。
        if ($stats.Visible -gt ($stats.Width * $stats.Height * 0.6)) {
            return "$size 档可见像素 $($stats.Visible)/$($stats.Width * $stats.Height)，像铺了一层底"
        }
    }
    $true
}

Check '图标：直接画的是橙色线条（antd orange-6），16 档也还认得出' {
    # GDI+ 只挑得到 16/32/48 这几档（256 那档它不选，Windows 外壳与预览图负责），
    # 所以像素级检查走前三档，256 由目录项 + card-256.png 覆盖。
    foreach ($size in @(16, 32, 48)) {
        $stats = Get-IconPixelStats -Path $script:IconPath -Size $size
        if ($stats.Orange -le 0) { return "$size 档没有 orange-6 的像素" }
        if ($size -eq 16 -and $stats.Visible -lt 30) { return "16 档线条太少（$($stats.Visible) 像素），会看不清" }
    }
    $true
}

Check '图标：card-256.png 是给人看的 256×256 预览（透明底、橙色线条）' {
    if (-not (Test-Path -LiteralPath $script:PreviewPath)) { return "缺 $script:PreviewPath" }
    $bitmap = [System.Drawing.Bitmap]::new($script:PreviewPath)
    try {
        if ($bitmap.Width -ne 256 -or $bitmap.Height -ne 256) { return "预览图是 $($bitmap.Width)x$($bitmap.Height)" }
        if ($bitmap.GetPixel(0, 0).A -ne 0) { return '预览图不是透明底' }
        $orange = 0
        for ($y = 0; $y -lt 256; $y += 2) {
            for ($x = 0; $x -lt 256; $x += 2) {
                $pixel = $bitmap.GetPixel($x, $y)
                if ($pixel.A -ge 200 -and $pixel.R -ge 235 -and $pixel.G -ge 115 -and $pixel.G -le 170 -and $pixel.B -le 80) { $orange++ }
            }
        }
        if ($orange -le 100) { return "预览图里橙色像素太少（$orange）" }
    } finally {
        $bitmap.Dispose()
    }
    $true
}

Check '图标：生成脚本还在，并注明颜色来自 antd orange 调色板第 6 档' {
    $scriptPath = Join-Path $script:AssetsDir 'make-icon.ps1'
    if (-not (Test-Path -LiteralPath $scriptPath)) { return '缺 make-icon.ps1（以后没法改造型）' }
    $text = Get-Content -Raw -LiteralPath $scriptPath -Encoding utf8
    if ($text -notmatch 'orange-6') { return '没写颜色出自 orange 调色板第 6 档' }
    if ($text -notmatch 'FA8C16') { return '没写 orange-6 的具体色值' }
    if ($text -notmatch 'Transparent') { return '绘制里没有透明底' }
    $true
}

# -----------------------------------------------------------------------------------

""
if ($script:Failures -gt 0) {
    "通过 $($script:Total - $script:Failures) / 失败 $($script:Failures)（共 $($script:Total) 项）"
    exit 1
}
"通过 $($script:Total) / 失败 0（共 $($script:Total) 项）"
exit 0
