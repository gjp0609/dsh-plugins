# card-border.ps1 的自检：用两张合成 PNG 证明「检查器真的能抓到双边框」（tests/card-border.selftest.ps1）
#
# 不需要提权、不建窗口、不读仓库里的图片：自己画两张 680x267 的图，再让检查器去判。
#   方形图：白底 + 最外 1px 描边 —— 必须 PASS；
#   圆角双边框图：深色桌面 + 半径 20 的圆角 + 半径 18/内缩 2px 的内层描边 —— 必须 FAIL，
#                 且失败坐标要落在四角（与真机实测同一形状：左边 y=19 有 x=0 与 x=2 两段）。
#
# 跑法：pwsh -NoProfile -File tests\card-border.selftest.ps1
# 退出码：0 = 两种情形都符合预期；1 = 检查器行为不对。

param(
    [string]$WorkDir = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$checker = Join-Path $PSScriptRoot 'card-border.ps1'
if (-not (Test-Path -LiteralPath $checker)) { throw "找不到检查器：$checker" }

if ([string]::IsNullOrWhiteSpace($WorkDir)) { $WorkDir = Join-Path $env:TEMP ('dsh-card-border-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

$width = 680
$height = 267
# 描边色跟 B-26 一致（antd token.colorWarning #FAAD14）：合成图必须用这个色，
# 否则「方形图应 PASS」会误报——2026-11-02 换色那轮没同步这里。
$borderColor = [System.Drawing.Color]::FromArgb(255, 250, 173, 20)
$desktopColor = [System.Drawing.Color]::FromArgb(255, 30, 30, 30)
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

function New-CardRoundedPath {
    param([int]$W, [int]$H, [int]$Radius)
    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($W - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($W - $diameter, $H - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $H - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $path
}

function Save-CardSyntheticPng {
    <#
    .SYNOPSIS
        画一张合成图：方形（描边在最外 1px）或「圆角 + 内缩 2px 双边框」。
    #>
    param([string]$Path, [ValidateSet('square', 'rounded')][string]$Shape)

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.Clear($white)
        try {
            if ($Shape -eq 'rounded') {
                # 圆角之外是桌面（Region 裁掉的地方，真机上就是这么露出壁纸的）。
                $graphics.Clear($desktopColor)
                $outer = New-CardRoundedPath -W $width -H $height -Radius 20
                $brush = New-Object System.Drawing.SolidBrush $white
                try { $graphics.FillPath($brush, $outer) } finally { $brush.Dispose(); $outer.Dispose() }

                # 页面 ::after：内缩 2px、半径 18 —— 与 Region 的弧差 2px。
                $inner = New-CardRoundedPath -W ($width - 4) -H ($height - 4) -Radius 18
                $graphics.TranslateTransform(2, 2)
                $pen = New-Object System.Drawing.Pen $borderColor, 1
                try { $graphics.DrawPath($pen, $inner) } finally { $pen.Dispose(); $graphics.ResetTransform(); $inner.Dispose() }
            } else {
                # 方形：描边就在窗口最外 1px 上。
                $pen = New-Object System.Drawing.Pen $borderColor, 1
                try {
                    $graphics.DrawRectangle($pen, 0, 0, $width - 1, $height - 1)
                } finally { $pen.Dispose() }
            }
        } finally {
            $graphics.Dispose()
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }
}

$failed = 0
function Check {
    param([string]$Name, [scriptblock]$Body)
    try { $outcome = & $Body } catch { $script:failed++; Write-Output ("FAIL  {0} -> {1}" -f $Name, $_.Exception.Message); return }
    if ($outcome -eq $true) { Write-Output ("PASS  {0}" -f $Name) }
    else { $script:failed++; Write-Output ("FAIL  {0} -> {1}" -f $Name, [string]$outcome) }
}

$squarePng = Join-Path $WorkDir 'square.png'
$roundedPng = Join-Path $WorkDir 'rounded.png'
Save-CardSyntheticPng -Path $squarePng -Shape 'square'
Save-CardSyntheticPng -Path $roundedPng -Shape 'rounded'

Check '方形图：检查器判 PASS（最外 1px 是描边色，四边单线）' {
    $out = & $checker -Png $squarePng 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) { return ('检查器退出码 {0}：{1}' -f $code, ($out -join ' | ')) }
    if (($out -join "`n") -notmatch '通过') { return '没有打印通过结论' }
    $true
}

Check '圆角双边框图：检查器判 FAIL，且失败点落在四角' {
    $out = & $checker -Png $roundedPng 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) { return '检查器把双边框判成通过了' }
    $text = $out -join "`n"
    if ($text -notmatch 'FAIL') { return '没有 FAIL 行' }
    # 真机现象是「四角附近两条线」，四条边都该报出来。
    $edges = @('top', 'bottom', 'left', 'right')
    $hit = @($edges | Where-Object { $text -match ('FAIL  ' + $_) })
    if ($hit.Count -lt 4) { return ('只报了 ' + ($hit -join ',') + '；四角应该都有') }
    $true
}

Write-Output ''
Write-Output ("通过 {0} / 失败 {1}（共 2 项）" -f (2 - $failed), $failed)
if ($failed -gt 0) { exit 1 }
exit 0
