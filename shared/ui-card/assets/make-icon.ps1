# 卡片图标：生成 assets/card.ico（16/32/48/256）与 assets/card-256.png 预览图。
#
# 为什么是脚本而不是一个手放的 .ico：造型要能调（线条粗细、内缩、断点），
# 手工改二进制不现实；以后想换造型就改这里重跑，产物照旧入库。
#
# 造型（PREFERENCES B-25）：**透明背景上直接画内容**，不铺实心色块托底。
#   `>` 一条折线（圆头、圆转折）+ `_` 一条短下划线 = 终端提示符。16×16 下靠加粗线条与
#   整数坐标保持可辨认；大尺寸等比放，不额外加装饰。
#
# 颜色：antd 调色板 **orange-6 = #FA8C16**（第 6 档，库的标准色阶）。
#   B-20 要求优先用组件库内置 token，但图标在窗口层绘制、拿不到 antd token，
#   所以这里直接写这个色阶，并在本注释里标明出处（这是 B-20 允许的「写死并说明」）。
#
# 跑法：pwsh -NoProfile -File shared\ui-card\assets\make-icon.ps1
#   只改本目录下的两个产物，不碰 dist、不碰网络。

[CmdletBinding()]
param(
    # 产物目录；默认本脚本所在目录。
    [string]$OutDir = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutDir)) { throw '缺少 -OutDir' }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path

# antd orange-6（调色板第 6 档）
$script:IconColor = [System.Drawing.Color]::FromArgb(255, 0xFA, 0x8C, 0x16)

# 一个 ICO 里四档；小尺寸不靠等比缩小（会糊），而是单独给整数坐标与更粗的相对线宽。
$script:IconSizes = @(16, 32, 48, 256)

# 折线 `>` 与下划线 `_` 的坐标（像素）。16 用 .0/.5 对齐半像素，避免反锯齿把两条线糊在一起。
$script:IconShapes = @{
    16  = @{
        # 小尺寸按 256 的比例缩小，但线宽略收（1.9）且折线尽量拉满：
        #   线太粗 + 竖直跨度太短时，两条臂会在拐点处糊成一团（实测过 2.2 的版本）。
        Stroke    = 1.8
        Chevron   = @(
            [System.Drawing.PointF]::new(3.0, 3.5),
            [System.Drawing.PointF]::new(9.0, 8.0),
            [System.Drawing.PointF]::new(3.0, 12.5)
        )
        Underline = @([System.Drawing.PointF]::new(10.2, 12.5), [System.Drawing.PointF]::new(13.4, 12.5))
    }
    32  = @{
        Stroke    = 3.75
        Chevron   = @(
            [System.Drawing.PointF]::new(5.75, 6.75),
            [System.Drawing.PointF]::new(15.25, 16.0),
            [System.Drawing.PointF]::new(5.75, 25.25)
        )
        Underline = @([System.Drawing.PointF]::new(18.75, 25.25), [System.Drawing.PointF]::new(26.5, 25.25))
    }
    48  = @{
        Stroke    = 5.6
        Chevron   = @(
            [System.Drawing.PointF]::new(8.6, 10.1),
            [System.Drawing.PointF]::new(22.9, 24.0),
            [System.Drawing.PointF]::new(8.6, 37.9)
        )
        Underline = @([System.Drawing.PointF]::new(28.1, 37.9), [System.Drawing.PointF]::new(39.8, 37.9))
    }
    256 = @{
        Stroke    = 30.0
        Chevron   = @(
            [System.Drawing.PointF]::new(46.0, 54.0),
            [System.Drawing.PointF]::new(122.0, 128.0),
            [System.Drawing.PointF]::new(46.0, 202.0)
        )
        Underline = @([System.Drawing.PointF]::new(150.0, 202.0), [System.Drawing.PointF]::new(212.0, 202.0))
    }
}

function New-CardIconBitmap {
    <#
    .SYNOPSIS
        画一张指定边长的图标位图（透明底 + 橙色线条）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][int]$Size)

    $shape = $script:IconShapes[$Size]
    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        # 透明底：不铺任何矩形，四周留空的像素 alpha 保持 0。
        $graphics.Clear([System.Drawing.Color]::Transparent)

        $pen = [System.Drawing.Pen]::new($script:IconColor, $shape.Stroke)
        try {
            # 圆头圆转折：细线在 16×16 下也不会削成尖角。
            $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
            $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
            $graphics.DrawLines($pen, [System.Drawing.PointF[]]$shape.Chevron)
            $graphics.DrawLine($pen, $shape.Underline[0], $shape.Underline[1])
        } finally {
            $pen.Dispose()
        }
    } finally {
        $graphics.Dispose()
    }
    $bitmap
}

function Get-CardIconDibBytes {
    <#
    .SYNOPSIS
        Bitmap → ICO 里那种 32bpp 的 DIB（BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码）。
    .DESCRIPTION
        不用 PNG 压缩条目：DIB 是最老也最稳的一种，Explorer、任务栏与 [System.Drawing.Icon]
        都直接认，256 也照装。透明由 alpha 通道决定，AND 掩码全 0（不额外遮）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][System.Drawing.Bitmap]$Bitmap)

    $width = $Bitmap.Width
    $height = $Bitmap.Height
    $maskRowBytes = [int]([Math]::Floor(($width + 31) / 32) * 4)
    $maskBytes = $maskRowBytes * $height
    $bytes = [byte[]]::new(40 + ($width * $height * 4) + $maskBytes)

    [BitConverter]::GetBytes([int]40).CopyTo($bytes, 0)
    [BitConverter]::GetBytes([int]$width).CopyTo($bytes, 4)
    # 高度写两倍：XOR 图 + AND 掩码各一份。
    [BitConverter]::GetBytes([int]($height * 2)).CopyTo($bytes, 8)
    [BitConverter]::GetBytes([int16]1).CopyTo($bytes, 12)
    [BitConverter]::GetBytes([int16]32).CopyTo($bytes, 14)
    # biCompression / biSizeImage 等其余字段保持 0。

    $offset = 40
    for ($y = $height - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $width; $x++) {
            $pixel = $Bitmap.GetPixel($x, $y)
            $at = $offset + ($x * 4)
            $bytes[$at] = $pixel.B
            $bytes[$at + 1] = $pixel.G
            $bytes[$at + 2] = $pixel.R
            $bytes[$at + 3] = $pixel.A
        }
        $offset += $width * 4
    }
    $bytes
}

function New-CardIconFile {
    <#
    .SYNOPSIS
        把四档尺寸装进一个 .ico（ICONDIR + 每档目录项 + DIB 数据）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Drawing.Bitmap[]]$Bitmaps
    )

    $images = @()
    foreach ($bitmap in $Bitmaps) {
        $images += [pscustomobject]@{ Size = $bitmap.Width; Bytes = (Get-CardIconDibBytes -Bitmap $bitmap) }
    }

    $headerSize = 6 + (16 * $images.Count)
    $offset = $headerSize
    $stream = [System.IO.MemoryStream]::new()
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([int16]0) # reserved
        $writer.Write([int16]1) # type = icon
        $writer.Write([int16]$images.Count)
        foreach ($image in $images) {
            # 256 在目录项里用 0 表示（一个字节装不下 256）。
            $writer.Write([byte]$(if ($image.Size -ge 256) { 0 } else { $image.Size }))
            $writer.Write([byte]$(if ($image.Size -ge 256) { 0 } else { $image.Size }))
            $writer.Write([byte]0)  # 调色板颜色数
            $writer.Write([byte]0)  # reserved
            $writer.Write([int16]1) # planes
            $writer.Write([int16]32) # bpp
            $writer.Write([int]$image.Bytes.Length)
            $writer.Write([int]$offset)
            $offset += $image.Bytes.Length
        }
        # 显式给 (byte[], 起点, 长度)：PowerShell 会把这个三元重载认成「写一个 byte」，
        # 整个 DIB 就只剩 1 字节，.ico 变成 74 字节的残废文件（Icon 直接拒绝加载）。
        foreach ($image in $images) {
            $stream.Write([byte[]]$image.Bytes, 0, $image.Bytes.Length)
        }
        $writer.Flush()
        # 长度自检：目录里写的偏移 + 数据长度必须与流的长度对得上。
        if ($stream.Length -ne $offset) { throw "ICO 长度不对：$($stream.Length) ≠ $offset" }
        [System.IO.File]::WriteAllBytes($Path, $stream.ToArray())
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

$bitmaps = @()
try {
    foreach ($size in $script:IconSizes) {
        $bitmaps += (New-CardIconBitmap -Size $size)
    }

    $iconPath = Join-Path $OutDir 'card.ico'
    New-CardIconFile -Path $iconPath -Bitmaps $bitmaps

    # 256 单独导出成 PNG：人要看图标长什么样，不应该去翻 .ico。
    $previewPath = Join-Path $OutDir 'card-256.png'
    $bitmaps[-1].Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    foreach ($bitmap in $bitmaps) { $bitmap.Dispose() }
}

# 自检：生成完立刻按 Windows 的方式读回来，尺寸不对就当场报错（别等到弹窗才发现没图标）。
$check = [System.Drawing.Icon]::new($iconPath)
try {
    if ($check.Width -ne $check.Height) { throw "图标不是正方形：$($check.Width)x$($check.Height)" }
    "已生成 $iconPath（$((Get-Item -LiteralPath $iconPath).Length) 字节，含 $($script:IconSizes -join '/') 四档；回读 $($check.Width)x$($check.Height)）"
} finally {
    $check.Dispose()
}
"已生成 $previewPath（256×256 预览）"
