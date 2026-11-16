# 卡片几何断言：读 render.ps1 落的 *.measure.json，不建窗口、不需要提权（tests/card-geometry.ps1）
#
# 跑法：
#   pwsh -NoProfile -File tests\card-geometry.ps1 -Measure out\approval.measure.json
#   pwsh -NoProfile -File tests\card-geometry.ps1 -Measure out\card.measure.json -Tolerance 2
#
# 断的是什么（全部拿 Show-CardWindow 的返回值与窗口/页面的实测值对账）：
#   1. 窗口没有额外非客户区：Bounds 宽高 == ClientSize 宽高（FormBorderStyle=None，差 1px 都不行）；
#   2. 返回的 WindowBounds 与窗口真实位置尺寸一致（调用方拿去算位置的就是这个串）；
#   3. 卡片贴住窗口左上角（card.left/top == 0）：有 body padding 或窗口比卡片大就会露馅；
#   4. 卡片宽度 == 客户区宽度（卡片铺满窗口，没有右侧白条）；
#   5. 返回的 ContentWidth/Height == 卡片实测宽高（±Tolerance，量高与返回值必须同源）；
#   6. hasRegion == (cornerRadius > 0)：方形不裁 Region，圆角才裁；
#   7. 页面没有横向溢出（bodyScrollWidth 不超过视口 + 容差）；
#   8. 落位：corner 时窗口贴主屏右下角、两边边距一致且不越界（center 跟着鼠标的屏走，不断言）。
#
# 退出码：0 = 全过；1 = 有不符；2 = 参数/文件问题。

param(
    [Parameter(Mandatory = $true)][string]$Measure,
    [int]$Tolerance = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Measure)) {
    [Console]::Error.WriteLine("measure 文件不存在：$Measure")
    exit 2
}

$data = Get-Content -Raw -LiteralPath $Measure -Encoding utf8 | ConvertFrom-Json
foreach ($field in @('result', 'window', 'client', 'card')) {
    if ($null -eq $data.$field) {
        [Console]::Error.WriteLine("measure 文件缺字段：$field（用 debug\render.ps1 重新出图）")
        exit 2
    }
}

$failed = 0
$passed = 0

function Check {
    param([string]$Name, [scriptblock]$Body)
    try {
        $outcome = & $Body
    } catch {
        $script:failed++
        Write-Output ("FAIL  {0} -> 断言抛异常：{1}" -f $Name, $_.Exception.Message)
        return
    }
    if ($outcome -eq $true) {
        $script:passed++
        Write-Output ("PASS  {0}" -f $Name)
    } else {
        $script:failed++
        Write-Output ("FAIL  {0} -> {1}" -f $Name, [string]$outcome)
    }
}

Check '窗口没有额外非客户区（Bounds == ClientSize）' {
    $w = $data.window; $c = $data.client
    if ($w.Width -ne $c.Width) { return "宽：Bounds $($w.Width) / Client $($c.Width)" }
    if ($w.Height -ne $c.Height) { return "高：Bounds $($w.Height) / Client $($c.Height)" }
    $true
}

Check '返回的 WindowBounds 与窗口真实位置尺寸一致' {
    $expected = '{0},{1} {2}x{3}' -f $data.window.Left, $data.window.Top, $data.window.Width, $data.window.Height
    if ([string]$data.result.windowBounds -eq $expected) { $true }
    else { "返回值 '$($data.result.windowBounds)'，实际 '$expected'" }
}

Check '落位：corner 时贴主屏右下角、两边距一致、不越界' {
    # 落位是纯函数（Get-CardPlacement），能在这里算就不用出图用眼睛看。
    # 只在 measure 里明确记了 position 时才断言：老图（默认还是 center 那会儿生成的）没有这个字段，
    # 套用 corner 规则会得到一堆假 FAIL。重新出一次图就自然有了。
    $prop = $data.PSObject.Properties['position']
    if ($null -eq $prop) { return $true }
    $pos = [string]$prop.Value
    if ($pos -ne 'corner') { return $true }   # center / screen 跟着屏走，不在这里断言
    Add-Type -AssemblyName System.Windows.Forms
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $w = $data.window
    $rightGap = $area.Right - ([int]$w.Left + [int]$w.Width)
    $bottomGap = $area.Bottom - ([int]$w.Top + [int]$w.Height)
    if ($rightGap -lt 0 -or $bottomGap -lt 0) { return "窗口越出工作区：右距 $rightGap、下距 $bottomGap（工作区 $($area.Width)x$($area.Height)）" }
    if ([Math]::Abs($rightGap - $bottomGap) -gt 2) { return "两边边距不一致：右 $rightGap、下 $bottomGap" }
    if ($rightGap -gt 96) { return "右下角边距过大：$rightGap（应只有 16×DPI 缩放）" }
    $true
}

Check '卡片贴住窗口左上角（没有 body padding / 偏移）' {
    $card = $data.card
    if ([Math]::Abs([int]$card.left) -gt 0) { return "card.left=$($card.left)" }
    if ([Math]::Abs([int]$card.top) -gt 0) { return "card.top=$($card.top)" }
    $true
}

Check '卡片宽度铺满客户区（右侧没有白条）' {
    $delta = [Math]::Abs([int]$data.card.width - [int]$data.client.Width)
    if ($delta -le $Tolerance) { $true } else { "card.width=$($data.card.width)，client.Width=$($data.client.Width)" }
}

Check 'ContentWidth/Height 与卡片实测尺寸一致' {
    $dw = [Math]::Abs([int]$data.result.contentWidth - [int]$data.card.width)
    $dh = [Math]::Abs([int]$data.result.contentHeight - [int]$data.card.height)
    if ($dw -le $Tolerance -and $dh -le $Tolerance) { $true }
    else { "返回 $($data.result.contentWidth)x$($data.result.contentHeight)，实测 $($data.card.width)x$($data.card.height)" }
}

Check 'hasRegion 与 cornerRadius 对得上（方形不裁 Region）' {
    $expected = ([int]$data.cornerRadius -gt 0)
    if ([bool]$data.hasRegion -eq $expected) { $true }
    else { "cornerRadius=$($data.cornerRadius) 但 hasRegion=$($data.hasRegion)" }
}

Check '页面没有横向溢出（bodyScrollWidth ≤ 视口 + 容差）' {
    $overflow = [int]$data.card.bodyScrollWidth - [int]$data.card.viewportWidth
    if ($overflow -le $Tolerance) { $true } else { "bodyScrollWidth=$($data.card.bodyScrollWidth)，viewport=$($data.card.viewportWidth)" }
}

if ($null -ne $data.capture) {
    Check '抓图范围包住窗口（含 -ScreenMargin 外扩）' {
        $cap = $data.capture
        if ($cap.Width -lt $data.window.Width) { return "抓图宽 $($cap.Width) < 窗口宽 $($data.window.Width)" }
        if ($cap.Height -lt $data.window.Height) { return "抓图高 $($cap.Height) < 窗口高 $($data.window.Height)" }
        if (-not $cap.Clamped) {
            $want = 2 * [int]$data.screenMargin
            if (($cap.Width - $data.window.Width) -lt $want -and ($cap.Height - $data.window.Height) -lt $want) {
                return "外扩不足：抓图 $($cap.Width)x$($cap.Height)，窗口 $($data.window.Width)x$($data.window.Height)，margin=$($data.screenMargin)"
            }
        }
        $true
    }
}

Write-Output ''
Write-Output ("通过 {0} / 失败 {1}（共 {2} 项）" -f $passed, $failed, ($passed + $failed))
if ($failed -gt 0) { exit 1 }
exit 0
