# 纯逻辑自检：卡片落位与限高的屏幕解析（不建窗口、不弹窗、不需要多屏、不需要提权）。
#
# 跑法：pwsh -NoProfile -File tests\card-placement.ps1
#
# 覆盖（PREFERENCES B-24：卡片跟活动窗口所在的那块屏走）：
#   - Get-CardPlacement 的 center / corner 都按传进来的那块屏幕算（副屏 Left 为负也算通过）；
#   - Get-CardMaxHeight 的 62% 按同一块屏的可用高度算（900 高的屏就是 floor(900×0.62)=558）；
#   - 不传 -Area 时退到 Get-CardScreenArea（前台窗口 → 光标 → 主屏），返回非空矩形；
#   - Get-CardScreenArea 连调多次不抛「类型已存在」（P/Invoke 的 Add-Type 幂等）；
#   - webview2.ps1 里限高与落位用的是同一块屏（同一个 $screenArea），且不再读 PrimaryScreen。
#
# 屏幕解析本身（前台窗口到底在哪块屏）只有真机双屏能验：这里断的是数学与退化路径。

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:CardDir = Join-Path $script:RepoRoot 'shared\ui-card'
$script:Failures = 0
$script:Total = 0

. (Join-Path $script:CardDir 'environment.ps1')
. (Join-Path $script:CardDir 'webview2.ps1')

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

# 一块假屏：与 Get-CardScreenArea 的返回同形（Right/Bottom 也要有，落位用的是它们）。
function New-FakeArea {
    param(
        [int]$Left,
        [int]$Top,
        [int]$Width,
        [int]$Height
    )
    [pscustomobject]@{
        Left   = $Left
        Top    = $Top
        Width  = $Width
        Height = $Height
        Right  = $Left + $Width
        Bottom = $Top + $Height
    }
}

# 用户实测的那块副屏：1920x1080 摆在主屏左边，所以 Left = -1920。
$script:Secondary = New-FakeArea -Left (-1920) -Top 0 -Width 1920 -Height 1080
# 比 1080 矮的屏：62% 必须按 900 算（按 1080 会算成 669，一眼能看出没跟着走）。
$script:Square = New-FakeArea -Left 0 -Top 0 -Width 1440 -Height 900

# ---- center ---------------------------------------------------------------------

Check 'center：落在传进来的副屏矩形内，且水平/垂直居中' {
    $p = Get-CardPlacement -Width 720 -Height 600 -Position center -Scale 1 -Area $script:Secondary
    if ($p.Left -ne -1320) { return "Left=$($p.Left)，应 -1920+600=-1320" }
    if ($p.Top -ne 240) { return "Top=$($p.Top)，应 (1080-600)/2=240" }
    $a = $script:Secondary
    if ($p.Left -lt $a.Left -or ($p.Left + 720) -gt $a.Right -or $p.Top -lt $a.Top -or ($p.Top + 600) -gt $a.Bottom) {
        return "越出副屏矩形：$($p.Left),$($p.Top)"
    }
    if (($p.Left - $a.Left) -ne ($a.Right - ($p.Left + 720))) { return "水平没居中：左距 $($p.Left - $a.Left)、右距 $($a.Right - ($p.Left + 720))" }
    if (($p.Top - $a.Top) -ne ($a.Bottom - ($p.Top + 600))) { return "垂直没居中：上距 $($p.Top - $a.Top)、下距 $($a.Bottom - ($p.Top + 600))" }
    $true
}

Check 'center：-Area 接受 System.Drawing.Rectangle（与 pscustomobject 同结果）' {
    Add-Type -AssemblyName System.Drawing
    $rect = [System.Drawing.Rectangle]::new(-1920, 0, 1920, 1080)
    $p = Get-CardPlacement -Width 720 -Height 600 -Position center -Scale 1 -Area $rect
    if ($p.Left -ne -1320 -or $p.Top -ne 240) { return "$($p.Left),$($p.Top)" }
    $true
}

Check 'center：窗口比屏还大时夹到可用区左上角，不出现负偏移' {
    $p = Get-CardPlacement -Width 2600 -Height 1400 -Position center -Scale 1 -Area $script:Square
    if ($p.Left -ne 0 -or $p.Top -ne 0) { return "$($p.Left),$($p.Top)" }
    $true
}

# ---- corner ---------------------------------------------------------------------

Check 'corner：落在同一块副屏的右下角，不再固定主屏' {
    $p = Get-CardPlacement -Width 720 -Height 600 -Position corner -Scale 1 -SlotIndex 0 -SlotCount 1 -Area $script:Secondary
    # 右边距 16、下边距 16（Scale=1）：-1920+1920-720-16 = -736；1080-600-16 = 464
    if ($p.Left -ne -736) { return "Left=$($p.Left)，应 -736（落回主屏就是 0 附近）" }
    if ($p.Top -ne 464) { return "Top=$($p.Top)，应 464" }
    $a = $script:Secondary
    if ($p.Left -lt $a.Left) { return '左边界越出副屏（跑到主屏去了）' }
    if (($p.Left + 720) -gt $a.Right -or ($p.Top + 600) -gt $a.Bottom) { return '越出副屏矩形' }
    $true
}

Check 'corner：SlotIndex 递增时往上错开，且不越出这块屏' {
    $a = $script:Secondary
    $tops = @()
    for ($i = 0; $i -lt 3; $i++) {
        $p = Get-CardPlacement -Width 720 -Height 600 -Position corner -Scale 1 -SlotIndex $i -SlotCount 3 -Area $a
        if ($p.Left -ne -736) { return "槽位 $i 的 Left=$($p.Left)" }
        if ($p.Top -lt ($a.Top + 8)) { return "槽位 $i 越出上边界：Top=$($p.Top)" }
        if (($p.Top + 600) -gt $a.Bottom) { return "槽位 $i 越出下边界：Top=$($p.Top)" }
        $tops += [int]$p.Top
    }
    if (-not ($tops[0] -gt $tops[1] -and $tops[1] -gt $tops[2])) { return "没有逐格往上错开：$($tops -join ' / ')" }
    $true
}

Check 'corner：高 DPI 下边距按 -Scale 放大（16/8 是 100% 的值）' {
    $a = $script:Secondary
    $p = Get-CardPlacement -Width 720 -Height 600 -Position corner -Scale 2 -SlotIndex 0 -SlotCount 1 -Area $a
    if ($p.Left -ne ($a.Right - 720 - 32)) { return "Left=$($p.Left)，应 $($a.Right - 720 - 32)" }
    if ($p.Top -ne ($a.Bottom - 600 - 32)) { return "Top=$($p.Top)，应 $($a.Bottom - 600 - 32)" }
    $true
}

# ---- 62% 高度 -------------------------------------------------------------------

Check 'Get-CardMaxHeight：900 高的屏按 558 算（62%），落在 160–760 之间' {
    $h = Get-CardMaxHeight -WorkAreaHeight 900 -Scale 1
    if ($h -ne [int][Math]::Floor(900 * 0.62)) { return "算出 $h，应 floor(900×0.62)=558" }
    if ($h -lt 160 -or $h -gt 760) { return "不在 160–760 之间：$h" }
    $other = Get-CardMaxHeight -WorkAreaHeight 1080 -Scale 1
    if ($h -eq $other) { return "900 与 1080 算出同一个值 $h，没跟着屏高走" }
    $true
}

Check 'Get-CardMaxHeight：不传 WorkAreaHeight 时问 Get-CardScreenArea，不问主屏' {
    # 函数按调用方作用域查找：在子作用域里定义同名的 Get-CardScreenArea 就能伪装一块 1440x900 的屏，
    # 不用真的插第二块显示器。主屏若不是 900 高，这个断言只有「跟着 Get-CardScreenArea 走」才能过。
    $fake = & {
        function Get-CardScreenArea {
            [pscustomobject]@{ Left = 0; Top = 0; Width = 1440; Height = 900; Right = 1440; Bottom = 900 }
        }
        Get-CardMaxHeight -Scale 1
    }
    if ($fake -ne [int][Math]::Floor(900 * 0.62)) { return "算出 $fake，没跟着那块 900 高的屏走" }
    $true
}

Check 'webview2.ps1：限高与落位用同一个 $screenArea（一张卡不会半主屏半副屏）' {
    $source = Get-Content -Raw -LiteralPath (Join-Path $script:CardDir 'webview2.ps1') -Encoding utf8
    if ($source -notmatch '\$screenArea\s*=\s*Get-CardScreenArea') { return '没有解析一次 $screenArea' }
    if ($source -notmatch 'Get-CardMaxHeight[^\r\n]*-WorkAreaHeight\s+\$screenArea\.Height') { return '限高没用 $screenArea.Height' }
    if ($source -notmatch 'Get-CardPlacement[\s\S]*?-Area\s+\$screenArea') { return '落位没用 $screenArea' }
    if ($source -match 'PrimaryScreen') { return 'webview2.ps1 里还留着 PrimaryScreen' }
    $true
}

# ---- 退化路径（真机、单屏也必须可用） -------------------------------------------

Check 'Get-CardScreenArea：不传参返回非空的物理像素矩形（退到光标/主屏也能用）' {
    $a = Get-CardScreenArea
    if ($null -eq $a) { return '返回 $null' }
    foreach ($name in @('Left', 'Top', 'Width', 'Height', 'Right', 'Bottom')) {
        if ($null -eq $a.PSObject.Properties[$name]) { return "缺字段 $name" }
    }
    if ($a.Width -le 0 -or $a.Height -le 0) { return "矩形为空：$($a.Width)x$($a.Height)" }
    if ($a.Right -ne ($a.Left + $a.Width)) { return "Right=$($a.Right) 与 Left+Width 不符" }
    if ($a.Bottom -ne ($a.Top + $a.Height)) { return "Bottom=$($a.Bottom) 与 Top+Height 不符" }
    $true
}

Check 'Get-CardScreenArea：连调两次不抛「类型已存在」，P/Invoke 有 GetForegroundWindow' {
    $null = Get-CardScreenArea
    $null = Get-CardScreenArea
    $native = 'DshUiCard.Native' -as [type]
    if ($null -eq $native) { return 'DshUiCard.Native 没编译出来' }
    if ($null -eq $native.GetMethod('GetForegroundWindow')) { return 'Native 里没有 GetForegroundWindow' }
    $true
}

Check '不传 -Area 的落位：落在 Get-CardScreenArea 那块矩形内，两次结果一致' {
    $a = Get-CardScreenArea
    $first = Get-CardPlacement -Width 320 -Height 240 -Scale 1
    $second = Get-CardPlacement -Width 320 -Height 240 -Scale 1
    if ([int]$first.Left -ne [int]$second.Left -or [int]$first.Top -ne [int]$second.Top) {
        return "两次结果不同：$($first.Left),$($first.Top) / $($second.Left),$($second.Top)"
    }
    if ($first.Left -lt $a.Left -or $first.Top -lt $a.Top -or
        ($first.Left + 320) -gt $a.Right -or ($first.Top + 240) -gt $a.Bottom) {
        return "越出可用区：$($first.Left),$($first.Top)（区 $($a.Left),$($a.Top) $($a.Width)x$($a.Height)）"
    }
    $true
}

# ---- 退让链：三分支用假数据逐条钉死（D-46） -------------------------------------
# 以前这一段只能靠「真插第二块显示器」才能测到，选择逻辑和 WinForms 缠在一个函数里。
# 抽成 Resolve-CardScreenArea（纯函数）之后，每条分支都能在这里给确定输入、要确定输出。

Check 'Resolve-CardScreenArea：三块都在时用前台窗口那块（不跟光标/主屏走）' {
    $foreground = [pscustomobject]@{ Left = 1920; Top = -4; Width = 1858; Height = 1080; Right = 3778; Bottom = 1076 }
    $cursor = [pscustomobject]@{ Left = 0; Top = 0; Width = 1858; Height = 1080; Right = 1858; Bottom = 1080 }
    $primary = [pscustomobject]@{ Left = 0; Top = 0; Width = 1440; Height = 900; Right = 1440; Bottom = 900 }
    $a = Resolve-CardScreenArea -ForegroundArea $foreground -CursorArea $cursor -PrimaryArea $primary
    if ($null -eq $a) { return '三块都在却返回 $null' }
    if ($a.Left -ne 1920 -or $a.Height -ne 1080) { return "用了错的屏：$($a.Left),$($a.Top) $($a.Width)x$($a.Height)" }
    $true
}

Check 'Resolve-CardScreenArea：前台拿不到 → 退到光标那块' {
    $cursor = [pscustomobject]@{ Left = 1920; Top = -4; Width = 1858; Height = 1080; Right = 3778; Bottom = 1076 }
    $primary = [pscustomobject]@{ Left = 0; Top = 0; Width = 1440; Height = 900; Right = 1440; Bottom = 900 }
    $a = Resolve-CardScreenArea -ForegroundArea $null -CursorArea $cursor -PrimaryArea $primary
    if ($null -eq $a) { return '返回 $null' }
    if ($a.Left -ne 1920) { return "没退到光标那块：Left=$($a.Left)" }
    $true
}

Check 'Resolve-CardScreenArea：只剩主屏 → 用主屏（不能返回 $null）' {
    $primary = [pscustomobject]@{ Left = 0; Top = 0; Width = 1440; Height = 900; Right = 1440; Bottom = 900 }
    $a = Resolve-CardScreenArea -ForegroundArea $null -CursorArea $null -PrimaryArea $primary
    if ($null -eq $a) { return '返回 $null' }
    if ($a.Width -ne 1440 -or $a.Height -ne 900) { return "用了错的矩形：$($a.Width)x$($a.Height)" }
    $true
}

Check 'Resolve-CardScreenArea：三块都空/宽高为 0 → 返回 $null（不造全零矩形）' {
    $zero = [pscustomobject]@{ Left = 0; Top = 0; Width = 0; Height = 0; Right = 0; Bottom = 0 }
    $height0 = [pscustomobject]@{ Left = 0; Top = 0; Width = 1920; Height = 0; Right = 1920; Bottom = 0 }
    foreach ($case in @(
            @{ Name = '全空'; Value = (Resolve-CardScreenArea) },
            @{ Name = '全零矩形'; Value = (Resolve-CardScreenArea -ForegroundArea $zero -CursorArea $zero -PrimaryArea $zero) },
            @{ Name = '高度为 0'; Value = (Resolve-CardScreenArea -ForegroundArea $height0 -CursorArea $height0 -PrimaryArea $height0) }
        )) {
        if ($null -ne $case.Value) { return "$($case.Name) 却返回了 $($case.Value.Width)x$($case.Value.Height)" }
    }
    $true
}

Check 'Resolve-CardScreenArea：返回值必是传进去的某一块（不会凭空造矩形）' {
    $blocks = @(
        [pscustomobject]@{ Left = 1920; Top = -4; Width = 1858; Height = 1080; Right = 3778; Bottom = 1076 },
        [pscustomobject]@{ Left = 0; Top = 0; Width = 1858; Height = 1040; Right = 1858; Bottom = 1040 }
    )
    # 两块候选的像素组合一共 2×2 = 4 种，每种都必须原样返回其中一块。
    foreach ($first in @($null, $blocks[0])) {
        foreach ($second in @($null, $blocks[1])) {
            $a = Resolve-CardScreenArea -ForegroundArea $first -CursorArea $second -PrimaryArea $null
            if ($null -eq $a) { continue }
            $hit = @($blocks | Where-Object { $_.Left -eq $a.Left -and $_.Top -eq $a.Top -and $_.Width -eq $a.Width -and $_.Height -eq $a.Height })
            if ($hit.Count -eq 0) { return "造了一个新矩形：$($a.Left),$($a.Top) $($a.Width)x$($a.Height)" }
        }
    }
    $true
}

Check 'Get-CardScreenArea：返回值必须等于某块真屏的 work area（不是拼出来的）' {
    Add-Type -AssemblyName System.Windows.Forms
    $a = Get-CardScreenArea
    if ($null -eq $a) { return '返回 $null（本机至少有一块屏，不该如此）' }
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    $hit = @($screens | Where-Object {
            $_.WorkingArea.Left -eq $a.Left -and $_.WorkingArea.Top -eq $a.Top -and
            $_.WorkingArea.Width -eq $a.Width -and $_.WorkingArea.Height -eq $a.Height
        })
    if ($hit.Count -eq 0) {
        $all = ($screens | ForEach-Object { "$($_.DeviceName)=$($_.WorkingArea)" }) -join '；'
        return "返回 $($a.Left),$($a.Top) $($a.Width)x$($a.Height)，但不是任何一块屏的可用区（$all）"
    }
    $true
}

Check 'Get-CardScreenArea：连调 20 次结果一致（没有随机的窗口矩形混进来）' {
    $first = Get-CardScreenArea
    for ($i = 1; $i -le 20; $i++) {
        $again = Get-CardScreenArea
        if ($null -eq $again) { return "第 $i 次返回 \$null" }
        if ($again.Left -ne $first.Left -or $again.Top -ne $first.Top -or
            $again.Width -ne $first.Width -or $again.Height -ne $first.Height) {
            return "第 $i 次变了：$($again.Left),$($again.Top) $($again.Width)x$($again.Height)（首次 $($first.Left),$($first.Top) $($first.Width)x$($first.Height)）"
        }
    }
    $true
}

Check 'Get-CardMaxHeight：解析不出屏区时抛错，不拿 0 算出 160' {
    $threw = $false
    try {
        & {
            function Get-CardScreenArea { $null }
            Get-CardMaxHeight -Scale 1
        } | Out-Null
    } catch {
        $threw = $true
    }
    if (-not $threw) { return '没抛错（会静默变成 160 的假上限）' }
    $true
}

Check 'Get-CardPlacement：没有可用屏区时抛错，不落到 (0,0)' {
    $threw = $false
    try { Get-CardPlacement -Width 320 -Height 240 -Scale 1 -Area $null -Position center | Out-Null } catch { }
    # -Area $null 等价于不传 → 会去问系统；系统有屏时不抛。这里直接给一块全零矩形。
    $zero = [pscustomobject]@{ Left = 0; Top = 0; Width = 0; Height = 0; Right = 0; Bottom = 0 }
    try { Get-CardPlacement -Width 320 -Height 240 -Scale 1 -Area $zero -Position center | Out-Null } catch { $threw = $true }
    if (-not $threw) { return '全零区域没抛错，落位会算到 (0,0)' }
    $true
}

# ---------------------------------------------------------------------------
""
if ($script:Failures -gt 0) {
    "通过 $($script:Total - $script:Failures) / 失败 $($script:Failures)（共 $($script:Total) 项）"
    exit 1
}
"通过 $($script:Total) / 失败 0（共 $($script:Total) 项）"
