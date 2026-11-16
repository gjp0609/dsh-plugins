# 只读的卡片边缘扫描：从一张 PNG 里数「一条边上有几道暗线」（tests/card-border.ps1）
#
# 用途：复核「双边框」。不需要提权、不建窗口、不联网，只读一个 PNG。
#
# 跑法：
#   pwsh -NoProfile -File tests\card-border.ps1 -Png out\approval-square.png
#   pwsh -NoProfile -File tests\card-border.ps1 -Png out\card.png -Inset 24 -BandDepth 8
#   # 壁纸换成纯色 + -Mode screen -ScreenMargin 20 抓图后，顺便验「窗口外只有壁纸色」：
#   pwsh -NoProfile -File tests\card-border.ps1 -Png out\square.png `
#       -Wallpaper '#1e3a5f' -WindowRect '20,20,680,400' -AllowShadow
#   # 洋红底版（render.ps1 -Backdrop magenta）：顺便验「窗口内没有露出窗口底色」
#   pwsh -NoProfile -File tests\card-border.ps1 -Png out\magenta.png -WindowRect '20,20,680,400' -BackdropColor magenta
#   （WindowRect 用图内坐标：x = window.left - capture.left，y = window.top - capture.top，尺寸取 window）
#
# 判定（四条边各自统计）：
#   - 每条边按「垂直于该边」的方向取扫描线：上/下边扫 y（每个 x 一条），左/右边扫 x（每个 y 一条）；
#   - 只认从窗口边往里 BandDepth 像素内**开始**的暗段（再往里就是抬头/正文的字了）；
#   - 中段（距任一角超过 Inset 像素的扫描线）必须恰好 1 段：0 段 = 没有边界，≥2 段 = 多道线；
#   - 角部允许 ≤2 段（弧线在那里本来就会分叉），但两段间距 ≥2px 就按「双边框」判失败并打印坐标。
#
# 为什么默认要求方形（2026-10-27 真机证据，深色桌面上 -Mode screen 抓的图）：
#   窗口 Region 按半径 20 裁圆角，页面 .qc-card 也是 20、::after 又内缩 2px 且半径取 18 —— 三条弧
#   半径/圆心各不相同，中段恰好重合、四角必然分开，于是四角附近出现两条线：
#     左边 y=19 一行：x=0 与 x=2 两段，间距 2px
#     右边 y=5..12 共 8 行：x≈669..671 与 x=673
#     上边 x=673..677 共 4 列：y≈5..7 与 y=8..12
#     下边 x=5..12 共 8 列：y≈256..259 与 y≈261..262
#   方形（不裁 Region、--qc-radius 0、只留 ::after 那条 1px 描边）应该全部 1 段。
#
# 注意：只有 `debug\render.ps1 -Mode screen` 抓的图才有「窗口边缘」。`-Mode preview` 用
# WebView2 的 CapturePreviewAsync，抓到的是页面内容、不含窗口 Region，永远只有一条线，别拿它验双边框。
#
# 退出码：0 = 四条边都过；1 = 有边没过；2 = 参数/文件问题。

param(
    [Parameter(Mandatory = $true)][string]$Png,
    [int]$Inset = 20,
    [int]$BandDepth = 6,
    [int]$DarkBelow = 243,
    [int]$MaxReport = 6,
    [string]$Wallpaper = '',
    [string]$WindowRect = '',
    [int]$WallpaperTolerance = 12,
    [switch]$AllowShadow,
    [string]$BackdropColor = '',
    [int]$BackdropTolerance = 12,
    # B-26：卡片自己描 1px 橙边（antd token.colorWarning）。换色那轮没同步这条断言，2026-11-02 改正。
    [string]$EdgeColor = '#FAAD14',
    [int]$EdgeTolerance = 24
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$edgeProbe = [System.Drawing.ColorTranslator]::FromHtml($EdgeColor)
$edgeR = [int]$edgeProbe.R
$edgeG = [int]$edgeProbe.G
$edgeB = [int]$edgeProbe.B

if (-not (Test-Path -LiteralPath $Png)) {
    [Console]::Error.WriteLine("PNG 不存在：$Png")
    exit 2
}
if ($Inset -lt 2 -or $BandDepth -lt 2) {
    [Console]::Error.WriteLine('-Inset / -BandDepth 至少为 2')
    exit 2
}

function Get-CardLuma {
    <#
    .SYNOPSIS
        把 PNG 解成一张亮度表（行优先，0..255 的整数）。
    .DESCRIPTION
        用 LockBits + Marshal.Copy 一次性搬出来：逐像素 GetPixel 在 680x400 上要好几秒。
        亮度按 Rec.709 加权；PNG 只有 32bppArgb 一种来源（WebView2 与 BitBlt 都是），
        通道顺序 BB GG RR AA（小端）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $bitmap = New-Object System.Drawing.Bitmap $Path
    try {
        $width = $bitmap.Width
        $height = $bitmap.Height
        $rect = New-Object System.Drawing.Rectangle 0, 0, $width, $height
        $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
            [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {
            $stride = $data.Stride
            $bytes = New-Object byte[] ($stride * $height)
            [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        } finally {
            $bitmap.UnlockBits($data)
        }

        $luma = New-Object 'int[,]' $height, $width
        for ($y = 0; $y -lt $height; $y++) {
            $row = $y * $stride
            for ($x = 0; $x -lt $width; $x++) {
                $i = $row + $x * 4
                # 0.2126R + 0.7152G + 0.0722B，整数近似（×1024 后取整），够判定用。
                $luma[$y, $x] = [int][Math]::Floor((218 * $bytes[$i + 2] + 732 * $bytes[$i + 1] + 74 * $bytes[$i]) / 1024)
            }
        }

        [pscustomobject]@{ Width = $width; Height = $height; Luma = $luma; Bytes = $bytes; Stride = $stride }
    } finally {
        $bitmap.Dispose()
    }
}

function Get-CardDarkRun {
    <#
    .SYNOPSIS
        沿一条扫描线找「暗段」，只看最前面 Limit 个像素。
    .DESCRIPTION
        返回若干 @{Start;End}（0 起，含端点）。0 与 1 像素宽的线都算一段；两段之间至少隔 1 个亮像素
        才分成两段 —— 这正是「双边框」与「一条线带抗锯齿」的区别。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]]$Luma,
        [int]$Limit,
        [int]$Dark
    )

    $runs = New-Object System.Collections.Generic.List[object]
    $max = [Math]::Min($Limit, $Luma.Count)
    $start = -1
    for ($i = 0; $i -lt $max; $i++) {
        if ($Luma[$i] -lt $Dark) {
            if ($start -lt 0) { $start = $i }
        } elseif ($start -ge 0) {
            $runs.Add([pscustomobject]@{ Start = $start; End = $i - 1 })
            $start = -1
        }
    }
    if ($start -ge 0) { $runs.Add([pscustomobject]@{ Start = $start; End = $max - 1 }) }
    $runs
}

function Test-CardEdge {
    <#
    .SYNOPSIS
        扫一条边，返回中段/角部的段数统计与失败样本。
    .DESCRIPTION
        $Axis = 'y' 表示扫描线沿 y（上/下边，每个 x 一条）；'x' 表示沿 x（左/右边，每个 y 一条）。
        $Reverse = $true 表示从窗口边往里数（下边从 H-1 往上、右边从 W-1 往左）。
        $CrossSize 是扫描线方向上的总长度，$SpanSize 是沿边走的方向的总长度。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Image,
        [Parameter(Mandatory = $true)][ValidateSet('top', 'bottom', 'left', 'right')][string]$Edge,
        [Parameter(Mandatory = $true)]$Rect,
        [int]$Inset,
        [int]$BandDepth,
        [int]$DarkBelow
    )

    $luma = $Image.Luma
    $alongY = ($Edge -eq 'left' -or $Edge -eq 'right')
    # 扫描范围必须落在窗口矩形内：screen 抓图带 -ScreenMargin 外扩，按整张图取会扫到壁纸
    # （2026-10-27 底边 27 列误报就是这么来的：扫到的是桌面，不是卡片边框）。$Rect 是图内坐标。
    $span = if ($alongY) { $Rect.H } else { $Rect.W }

    $middleFail = New-Object System.Collections.Generic.List[string]
    $cornerFail = New-Object System.Collections.Generic.List[string]
    $middleOk = 0
    $cornerOk = 0
    $emptyMiddle = 0

    for ($p = 0; $p -lt $span; $p++) {
        # 取这条扫描线上的前 BandDepth 个像素（从窗口边往里）。
        $line = New-Object int[] $BandDepth
        for ($d = 0; $d -lt $BandDepth; $d++) {
            # 按窗口矩形把「沿边偏移 p + 向里 d」映射回图内坐标。
            switch ($Edge) {
                'top' { $ax = $Rect.X + $p; $ay = $Rect.Y + $d }
                'bottom' { $ax = $Rect.X + $p; $ay = $Rect.Y + $Rect.H - 1 - $d }
                'left' { $ax = $Rect.X + $d; $ay = $Rect.Y + $p }
                'right' { $ax = $Rect.X + $Rect.W - 1 - $d; $ay = $Rect.Y + $p }
            }
            $line[$d] = $luma[$ay, $ax]
        }

        # @() 兜住「一条线都没有」的情况：Get-CardDarkRun 此时返回 $null，
        # StrictMode 下 $null.Count 会直接抛 "The property 'Count' cannot be found"。
        $runs = @(Get-CardDarkRun -Luma $line -Limit $BandDepth -Dark $DarkBelow)
        $isMiddle = ($p -ge $Inset) -and ($p -lt ($span - $Inset))
        $where = if ($alongY) { "y=$($Rect.Y + $p)" } else { "x=$($Rect.X + $p)" }

        if ($isMiddle) {
            if ($runs.Count -eq 1) {
                $middleOk++
            } elseif ($runs.Count -eq 0) {
                $emptyMiddle++
                if ($middleFail.Count -lt $MaxReport) { $middleFail.Add("$where 没有边界（0 段）") }
            } else {
                $detail = ($runs | ForEach-Object { "第$($_.Start)..$($_.End)px" }) -join ' / '
                if ($middleFail.Count -lt $MaxReport) { $middleFail.Add("$where 有 $($runs.Count) 段：$detail") }
            }
        } else {
            if ($runs.Count -le 1) {
                $cornerOk++
            } elseif ($runs.Count -eq 2 -and ($runs[1].Start - $runs[0].End) -lt 2) {
                # 两段紧挨着 = 一条线被抗锯齿拆开，不算双边框。
                $cornerOk++
            } else {
                $detail = ($runs | ForEach-Object { "第$($_.Start)..$($_.End)px" }) -join ' / '
                if ($cornerFail.Count -lt $MaxReport) { $cornerFail.Add("$where 有 $($runs.Count) 段且间距≥2px：$detail") }
            }
        }
    }

    [pscustomobject]@{
        Edge       = $Edge
        MiddleOk   = $middleOk
        CornerOk   = $cornerOk
        EmptyCount = $emptyMiddle
        MiddleFail = @($middleFail)
        CornerFail = @($cornerFail)
    }
}

$image = Get-CardLuma -Path $Png
Write-Output ("扫描 {0}（{1}x{2}，暗像素阈值 {3}，边带 {4}px，角部 {5}px）" -f `
        (Split-Path -Leaf $Png), $image.Width, $image.Height, $DarkBelow, $BandDepth, $Inset)

# 窗口矩形（图内坐标）。screen 抓图带外扩时边带必须按它取；preview 抓图恰好就是窗口内容，
# 不给 -WindowRect 就整张图当窗口。
$rect = $null
if (-not [string]::IsNullOrWhiteSpace($WindowRect)) {
    $parts = @($WindowRect -split '[,x ]+' | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 4) {
        $rect = [pscustomobject]@{ X = [int]$parts[0]; Y = [int]$parts[1]; W = [int]$parts[2]; H = [int]$parts[3] }
    }
}
if ($null -eq $rect) {
    $rect = [pscustomobject]@{ X = 0; Y = 0; W = $image.Width; H = $image.Height }
}
$rectOk = ($rect.X -ge 0) -and ($rect.Y -ge 0) -and (($rect.X + $rect.W) -le $image.Width) -and (($rect.Y + $rect.H) -le $image.Height)
if (-not $rectOk) {
    Write-Output ("FAIL  窗口矩形 {0},{1} {2}x{3} 超出图片 {4}x{5}" -f $rect.X, $rect.Y, $rect.W, $rect.H, $image.Width, $image.Height)
}

$failed = 0
foreach ($edge in @('top', 'bottom', 'left', 'right')) {
    $result = Test-CardEdge -Image $image -Edge $edge -Rect $rect -Inset $Inset -BandDepth $BandDepth -DarkBelow $DarkBelow
    $problems = @($result.MiddleFail) + @($result.CornerFail)
    if ($problems.Count -eq 0) {
        Write-Output ("PASS  {0,-6} 中段单线 {1} 条，角部正常 {2} 条" -f $edge, $result.MiddleOk, $result.CornerOk)
        continue
    }
    $failed++
    Write-Output ("FAIL  {0,-6} 中段单线 {1} 条 / 无边界 {2} 条 / 角部正常 {3} 条" -f `
            $edge, $result.MiddleOk, $result.EmptyCount, $result.CornerOk)
    foreach ($item in $problems) { Write-Output ("      {0}" -f $item) }
}

# ---------------------------------------------------------------------------
# 可选：壁纸色断言 —— 窗口矩形之外（-ScreenMargin 外扩出来的那圈）应当只有壁纸色。
# 前提：用户把壁纸换成纯色。尺寸/偏移取自 render.ps1 的 *.measure.json：
#   WindowRect 的图内坐标 = window.left - capture.left, window.top - capture.top, window.width, window.height
# ---------------------------------------------------------------------------
if (-not [string]::IsNullOrWhiteSpace($Wallpaper)) {
    $parts = @()
    if (-not [string]::IsNullOrWhiteSpace($WindowRect)) { $parts = @($WindowRect -split '[,x ]+' | Where-Object { $_ -ne '' }) }
    if ($parts.Count -ne 4) {
        Write-Output 'FAIL  壁纸扫描：-WindowRect 需要 "左,上,宽,高"（图内坐标）'
        $failed++
    } else {
        $wall = [System.Drawing.ColorTranslator]::FromHtml($Wallpaper)
        $rx = [int]$parts[0]; $ry = [int]$parts[1]; $rw = [int]$parts[2]; $rh = [int]$parts[3]
        $bytes = $image.Bytes
        $stride = $image.Stride
        $bad = New-Object System.Collections.Generic.List[string]
        $shadow = 0
        $outside = 0
        for ($y = 0; $y -lt $image.Height; $y++) {
            $insideRow = ($y -ge $ry) -and ($y -lt ($ry + $rh))
            for ($x = 0; $x -lt $image.Width; $x++) {
                if ($insideRow -and $x -ge $rx -and $x -lt ($rx + $rw)) { continue }
                $outside++
                $i = $y * $stride + $x * 4
                $b = $bytes[$i]; $g = $bytes[$i + 1]; $r = $bytes[$i + 2]
                $delta = [Math]::Max([Math]::Abs($r - $wall.R), [Math]::Max([Math]::Abs($g - $wall.G), [Math]::Abs($b - $wall.B)))
                if ($delta -le $WallpaperTolerance) { continue }
                # 窗口阴影：三个通道都不比壁纸亮就算阴影（-AllowShadow 时才放行）。
                if ($AllowShadow -and $r -le $wall.R -and $g -le $wall.G -and $b -le $wall.B) { $shadow++; continue }
                if ($bad.Count -lt $MaxReport) {
                    $bad.Add(('({0},{1}) #{2:x2}{3:x2}{4:x2} 与壁纸 #{5:x2}{6:x2}{7:x2} 差 {8}' -f $x, $y, $r, $g, $b, $wall.R, $wall.G, $wall.B, $delta))
                }
            }
        }
        if ($bad.Count -eq 0) {
            Write-Output ("PASS  壁纸扫描：窗口外 {0} 个像素都是壁纸色（宽容差 {1}{2}）" -f `
                    $outside, $WallpaperTolerance, $(if ($shadow -gt 0) { "，另有 $shadow 个阴影像素" } else { '' }))
        } else {
            $failed++
            Write-Output ('FAIL  壁纸扫描：窗口外有 {0} 个非壁纸像素（示例）：' -f $bad.Count)
            foreach ($item in $bad) { Write-Output ("      {0}" -f $item) }
        }
    }
}

# ---------------------------------------------------------------------------
# 必查：窗口最外 1px 必须就是描边色 —— 否则窗口内侧有一圈卡片底色（白壁纸下看不见，
# 深色壁纸下就是一圈白线）。给了 -WindowRect 就按那个矩形取（screen 抓图带外扩），
# 否则按整张图取（preview 抓图恰好就是窗口内容）。
# ---------------------------------------------------------------------------
$outerFailed = 0

function Get-CardEdgeSample {
    <#
    .SYNOPSIS
        取一条边最外 1px、中段 60% 的像素颜色，返回中位数与最大通道差。
    #>
    param($Image, $Rect, [string]$Edge)

    $bytes = $Image.Bytes
    $stride = $Image.Stride
    $reds = New-Object System.Collections.Generic.List[int]
    $greens = New-Object System.Collections.Generic.List[int]
    $blues = New-Object System.Collections.Generic.List[int]

    if ($Edge -eq 'top' -or $Edge -eq 'bottom') {
        $span = $Rect.W
        $from = $Rect.X + [int]($span * 0.2)
        $to = $Rect.X + [int]($span * 0.8) - 1
        $y = if ($Edge -eq 'top') { $Rect.Y } else { $Rect.Y + $Rect.H - 1 }
        for ($x = $from; $x -le $to; $x++) {
            $i = $y * $stride + $x * 4
            $blues.Add($bytes[$i]); $greens.Add($bytes[$i + 1]); $reds.Add($bytes[$i + 2])
        }
    } else {
        $span = $Rect.H
        $from = $Rect.Y + [int]($span * 0.2)
        $to = $Rect.Y + [int]($span * 0.8) - 1
        $x = if ($Edge -eq 'left') { $Rect.X } else { $Rect.X + $Rect.W - 1 }
        for ($y = $from; $y -le $to; $y++) {
            $i = $y * $stride + $x * 4
            $blues.Add($bytes[$i]); $greens.Add($bytes[$i + 1]); $reds.Add($bytes[$i + 2])
        }
    }

    $r = ($reds | Sort-Object)[[int]($reds.Count / 2)]
    $g = ($greens | Sort-Object)[[int]($greens.Count / 2)]
    $b = ($blues | Sort-Object)[[int]($blues.Count / 2)]
    [pscustomobject]@{ Edge = $Edge; R = $r; G = $g; B = $b; Spread = ([Math]::Max($r, [Math]::Max($g, $b)) - [Math]::Min($r, [Math]::Min($g, $b))) }
}

foreach ($edge in @('top', 'bottom', 'left', 'right')) {
    $sample = Get-CardEdgeSample -Image $image -Rect $rect -Edge $edge
    $luma = [int][Math]::Floor((218 * $sample.R + 732 * $sample.G + 74 * $sample.B) / 1024)
    # 期望值是 **B-26 的橙色描边**（antd token.colorWarning #FAAD14，叠白底后实测 250,173,20）。
    # 2026-11-02 修正：这条原先按「近灰 + 比白暗」判（Spread > 14 就算漏底色），是灰描边年代的写法；
    # B-26 把描边换成橙色后它一直误判（不在常规套件里，没被跑出来）。设计变了改断言，不改实现。
    $deltaR = [Math]::Abs($sample.R - $edgeR)
    $deltaG = [Math]::Abs($sample.G - $edgeG)
    $deltaB = [Math]::Abs($sample.B - $edgeB)
    if ($luma -ge 250) {
        $outerFailed++
        Write-Output ("FAIL  {0,-6} 最外 1px 是白 rgb({1},{2},{3})：窗口内侧有一圈白边" -f $edge, $sample.R, $sample.G, $sample.B)
    } elseif ($deltaR -gt $edgeTolerance -or $deltaG -gt $edgeTolerance -or $deltaB -gt $edgeTolerance) {
        $outerFailed++
        Write-Output ("FAIL  {0,-6} 最外 1px 不是描边色：实测 rgb({1},{2},{3})，期望 rgb({4},{5},{6})±{7}" -f $edge, $sample.R, $sample.G, $sample.B, $edgeR, $edgeG, $edgeB, $edgeTolerance)
    } else {
        Write-Output ("PASS  {0,-6} 最外 1px 是描边色 rgb({1},{2},{3})" -f $edge, $sample.R, $sample.G, $sample.B)
    }
}
if ($outerFailed -gt 0) { $failed++ }

# ---------------------------------------------------------------------------
# 可选：背景色断言 —— 窗口矩形**内部**（除最外 2px 描边带）不该出现窗口底色。
# 配合 render.ps1 -Backdrop magenta 用：卡片没盖住的地方会显形成洋红，这条就能机器抓到，
# 不用再靠眼睛在白底上看白边。
# ---------------------------------------------------------------------------
if (-not [string]::IsNullOrWhiteSpace($BackdropColor)) {
    $backdrop = [System.Drawing.ColorTranslator]::FromHtml($BackdropColor)
    $bytes = $image.Bytes
    $stride = $image.Stride
    $bad = New-Object System.Collections.Generic.List[string]
    $scanned = 0
    for ($y = $rect.Y + 2; $y -lt ($rect.Y + $rect.H - 2); $y++) {
        for ($x = $rect.X + 2; $x -lt ($rect.X + $rect.W - 2); $x++) {
            $scanned++
            $i = $y * $stride + $x * 4
            $b = $bytes[$i]; $g = $bytes[$i + 1]; $r = $bytes[$i + 2]
            $delta = [Math]::Max([Math]::Abs($r - $backdrop.R), [Math]::Max([Math]::Abs($g - $backdrop.G), [Math]::Abs($b - $backdrop.B)))
            if ($delta -le $BackdropTolerance) {
                if ($bad.Count -lt $MaxReport) {
                    $bad.Add(('({0},{1}) rgb({2},{3},{4}) 是窗口底色 —— 卡片没盖住' -f $x, $y, $r, $g, $b))
                }
            }
        }
    }
    if ($bad.Count -eq 0) {
        Write-Output ("PASS  背景扫描：窗口内 {0} 个像素都被卡片盖住了（没有 {1}）" -f $scanned, $BackdropColor)
    } else {
        $failed++
        Write-Output ('FAIL  背景扫描：窗口内有 {0} 处露出窗口底色 {1}（示例）：' -f $bad.Count, $BackdropColor)
        foreach ($item in $bad) { Write-Output ("      {0}" -f $item) }
    }
}

if ($failed -eq 0) {
    Write-Output '通过：四条边都只有一条边界线（方形）'
    exit 0
}
Write-Output ("失败：{0} 项检查没过（双边框 / 圆角未归零 / 窗口外有多余渲染）" -f $failed)
exit 1
