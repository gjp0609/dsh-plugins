# 复现/回归：同一份载荷渲染 N 次，逐次记窗口高度（shared/ui-card/debug/height-stability.ps1）
#
# 这个文件**不在**外壳的正式运行路径上。它只做一件事：把「偶发高卡片」变成可数的数字。
#
# 现象（R-24 / D-45）：2026-11-12 17:32 真机弹出一张 680×360 的 SSH 执行确认卡，内容只有 ~290，
# 灰框与按钮之间一条 80px 白。360 恰好是外壳的建窗初值（`$fallbackHeight`），也就是「页面没在
# 预算内报高度」的兜底值。既然是**偶发**，就要能量：同一份载荷渲染 N 次，高度必须逐次相同。
#
# 做法：每次起一个**独立进程**跑 debug/render.ps1（跟正式卡片一样是一张卡一个进程、一次冷启），
# 从它写的 *.measure.json 里读「宿主最终采用的高度」，再核对本次有没有落进兜底分支。
#   - 兜底分支的取证：外壳在落到 360 时往 %TEMP%\dsh-card-flash.log 追加一行
#     `kind=height-fallback`（见 webview2.ps1）。这个脚本按「跑前/跑后行数差」数它。
#   - 量高复核的取证：默认带 -Probe（render.ps1 的页内探针 + 注入的量高时间线 trace.js），
#     于是每次都能拿到「报 ready 那一刻 #root 多高」「之后又长到多高」「哪一层被裁了多少像素」。
#
# 判据（任一不成立就 exit 1）：
#   1. N 次都出图成功（measure.json 存在且可解析）；
#   2. N 次高度最大值 − 最小值 ≤ -TolerancePx（默认 2px：只允许 DPI 取整的差别）；
#   3. N 次都没有落进兜底分支（0 条 height-fallback）；
#   4. **测量令内容不被裁**：fill 态每一层盒子 `scrollHeight <= clientHeight`（1px 容差）。
#      被裁就说明窗口比内容矮——这正是「偶尔 271、内容 291」在屏幕上的样子（`超时 20s` 只剩半截）。
#   5. **没量小**：把 data-phase 临时切回 measure 量到的自然高度，必须等于报出去的高度（±TolerancePx）。
#      两者不等 = 页面在布局稳定之前就报了 ready，而宿主只认第一次（D-46）。
#   6. **钳高只许按 62% 上限来**：窗口高度必须等于 Min(上限, 页面报的高度)（下限 160）。
#      窗口比页面报的矮，只允许是一种情形——页面报的真的超过了屏高 62%；其余一律算失败。
#   7. **上限必须能由记录的屏区算出来**：Floor(屏可用高 / scale × 0.62)，夹 160–760。
#      算不出来 = 上限是猜的，而猜出来的上限会静默把卡片压矮 20px（2026-11-12 那场就是 271 vs 291）。
#
# 需要在**提权**下跑（受限令牌里 WebView2 控制器创建不出来，0x8000FFFF，既定边界）。
#
# 跑法：
#   pwsh -NoProfile -File shared\ui-card\debug\height-stability.ps1
#   pwsh -NoProfile -File shared\ui-card\debug\height-stability.ps1 -Runs 20 -Payload tests\fixtures\select.json
#   pwsh -NoProfile -File ...\height-stability.ps1 -DataDir D:\tmp\wv2   # 指定 WebView2 数据目录
#   pwsh -NoProfile -File ...\height-stability.ps1 -Probe:$false         # 只要高度、不跑页内探针（快一些）
#
# 为什么会挂 30 分钟：外壳缺省的 WebView2 数据目录（%LOCALAPPDATA%\dsh-ui-card\webview2）常常被
# 正在跑的宿主卡片占着，CreateAsync 等不到就 ERROR_BUSY(0x800700AA)，子进程再也不返回。
# 所以本脚本默认在 <OutDir>\webview2 建一个专用目录；受限令牌下则会在 40 秒内以 0x8000FFFF 收口
# （那是「必须提权」的既定边界，不是本脚本的问题）。
#
# 产物：<OutDir>\run-<n>.png（render.ps1 出图）、<OutDir>\run-<n>.measure.json（含 probe 字段）、
#       <OutDir>\heights.json（本次 N 次的高度表、每层裁切量与判据结果，一行结论在 `verdict` 字段）。
# 退出码：0 = 五条判据都成立；1 = 有失败项；2 = 参数不对。

param(
    [string]$Payload = '',
    [int]$Runs = 10,
    [string]$OutDir = '',
    [int]$Width = 680,
    [int]$MaxHeight = 0,
    [int]$TolerancePx = 2,
    # WebView2 用户数据目录。空 = 在 <OutDir>\webview2 下建一个专用目录：
    # 外壳的缺省目录（%LOCALAPPDATA%\dsh-ui-card\webview2）经常被别的 WebView2 进程占着，
    # CreateAsync 会以 ERROR_BUSY(0x800700AA) 失败，几次跑就全挂。
    [string]$DataDir = '',
    # 页内探针（默认开）：判据 4/5 靠它，关掉就只剩高度与兜底两条。
    [bool]$Probe = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Runs -lt 2 -or $Runs -gt 50) {
    [Console]::Error.WriteLine('用法：height-stability.ps1 [-Payload <json>] [-Runs 2..50] [-OutDir <dir>] [-Width 680] [-MaxHeight 0] [-TolerancePx 2] [-Probe:$true|$false]')
    exit 2
}

$script:CardDir = Split-Path -Parent $PSScriptRoot                                  # shared\ui-card
# 仓库根 = ui-card 的上一级的上一级（shared\ui-card\debug → shared\ui-card → shared → 根）。
$script:RepoRoot = Split-Path -Parent (Split-Path -Parent $script:CardDir)
$script:RenderScript = Join-Path $PSScriptRoot 'render.ps1'
$script:FlashLog = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-card-flash.log'

if ([string]::IsNullOrWhiteSpace($Payload)) {
    # 默认就用真机那张卡的载荷（tests/fixtures/ssh-run.json 里抄的是原命令）。
    $Payload = Join-Path $script:RepoRoot 'tests\fixtures\ssh-run.json'
}
$payloadPath = (Resolve-Path -LiteralPath $Payload).Path
if ([System.IO.Path]::GetExtension($payloadPath) -ne '.json') { throw "载荷要是 .json：$payloadPath" }
if (-not (Test-Path -LiteralPath $script:RenderScript)) { throw "找不到出图脚本：$($script:RenderScript)" }

if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-card-height-stability'
}
if ([string]::IsNullOrWhiteSpace($DataDir)) {
    # 批量跑专用目录（不是外壳缺省）：与正在跑的宿主卡片互不抢目录。
    $DataDir = Join-Path $OutDir 'webview2'
}
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$outRoot = (Resolve-Path -LiteralPath $OutDir).Path
# 只清自己上一轮的 run-* 产物：OutDir 是调用方给的，别的地方不许动。
Get-ChildItem -LiteralPath $outRoot -File -Filter 'run-*.png' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $outRoot -File -Filter 'run-*.measure.json' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

function Get-FlashCount {
    # 数埋点里某个 kind 的行数。日志是「一行一个 JSON」，坏行直接跳过（埋点坏了不算失败）。
    # $Since 非空时只数这个时刻之后的行：日志会被轮转裁剪，用「跑前/跑后两次总数相减」
    # 会算出负数（实测 -3），所以按时间戳算本轮命中数，不做减法。
    param([string]$Kind, [datetime]$Since = [datetime]::MinValue)
    if (-not (Test-Path -LiteralPath $script:FlashLog)) { return 0 }
    $count = 0
    foreach ($line in [System.IO.File]::ReadAllLines($script:FlashLog)) {
        # StrictMode 下读不存在的属性会抛，坏行/旧格式行一律跳过。
        try {
            $record = $line | ConvertFrom-Json
            if ($null -eq $record -or [string]$record.kind -ne $Kind) { continue }
            if ($Since -ne [datetime]::MinValue) {
                $stamp = [datetime]::MinValue
                if (-not [datetime]::TryParse([string]$record.ts, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$stamp)) { continue }
                if ($stamp -lt $Since) { continue }
            }
            $count++
        } catch { }
    }
    $count
}

function Get-HeightFallbackCount {
    # 落兜底（页面没在预算内报高度、窗口停在写死的 360）的次数。
    param([datetime]$Since = [datetime]::MinValue)
    Get-FlashCount -Kind 'height-fallback' -Since $Since
}

function Get-Field {
    <#
        StrictMode 下读一个可能不存在的属性会直接抛，探针又允许缺字段（-Probe:$false、旧 measure.json），
        所以统一走这里：没有就返回 $null，不把「字段缺失」变成「脚本崩了」。
    #>
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    $property.Value
}

$runStartedAt = Get-Date
# 量高不稳（页面等了两帧仍不一致、按最后一次报的）：只报数，不算失败——高度仍然是最后一次量的，
# 它说明的是「布局在那台机器上两帧之内没停下来」，要的是数字，不是把卡片判死（D-46）。
$unstableBefore = Get-FlashCount -Kind 'measure-unstable'
$samples = [System.Collections.Generic.List[object]]::new()
$pwshExe = (Get-Process -Id $PID).Path

for ($i = 1; $i -le $Runs; $i++) {
    $png = Join-Path $outRoot ('run-{0:D2}.png' -f $i)
    $measureFile = Join-Path $outRoot ('run-{0:D2}.measure.json' -f $i)
    # 变量名不能叫 $args（自动变量）。
    $renderArgs = @(
        '-NoProfile', '-STA', '-File', ('"' + $script:RenderScript + '"'),
        '-Payload', ('"' + $payloadPath + '"'),
        '-OutFile', ('"' + $png + '"'),
        '-Width', [string]$Width,
        '-DataDir', ('"' + $DataDir + '"')
    )
    if ($MaxHeight -gt 0) { $renderArgs += @('-MaxHeight', [string]$MaxHeight) }
    if ($Probe) { $renderArgs += '-Probe' }

    # 只用文件收结果，不捕获 stdout/stderr（受限沙箱下管道会 EPERM）。
    # 也不用 Start-Process -Wait：本机它等的是整棵进程树，WebView2 的 msedgewebview2 子孙留在
    # 那里不退出时它永远不返回（实测卡满 30 分钟、一个产物都没有）。这里自己 WaitForExit 掐时间，
    # 超时就整棵杀掉、按失败记一条——「偶发」要的是数字，不是无限等待。
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $pwshExe
    $psi.Arguments = ($renderArgs -join ' ')
    $psi.UseShellExecute = $false
    $psi.WorkingDirectory = $outRoot
    $process = [System.Diagnostics.Process]::Start($psi)
    $finished = $process.WaitForExit(180000)
    $exitCode = if ($finished -and $process.HasExited) { [int]$process.ExitCode } else { -1 }
    if (-not $finished) {
        try { $process.Kill($true) } catch { }
        try { $process.WaitForExit(10000) | Out-Null } catch { }
    }
    $process.Dispose()
    $record = [ordered]@{
        run              = $i
        exitCode         = $exitCode
        pngBytes         = 0
        contentHeight    = 0
        windowHeight     = 0
        cardHeight       = 0
        # 页面发出的**第一条**消息（协议里是 ready）：类型、它说的高度、那时 #root 多高、代码框/附注条多高。
        firstType        = ''
        firstHeight      = 0
        firstRootHeight  = 0
        firstCode        = 0
        firstStrip       = 0
        # 宿主这一轮按哪块屏、什么缩放、多少上限建的窗（measure.json 的 placement，D-46）。
        maxHeight        = 0
        areaHeight       = 0
        scale            = 0
        naturalHeight    = 0
        underReportedPx  = 0
        rootClientHeight = 0
        rootScrollHeight = 0
        clipped          = @()
        error            = ''
    }

    if (Test-Path -LiteralPath $png) { $record.pngBytes = (Get-Item -LiteralPath $png).Length }
    if ($record.pngBytes -le 0) {
        $record.error = "没有出图（exit $exitCode）"
    } elseif (-not (Test-Path -LiteralPath $measureFile)) {
        $record.error = '没有 measure.json'
    } else {
        try {
            $measure = Get-Content -Raw -LiteralPath $measureFile -Encoding utf8 | ConvertFrom-Json
            $record.contentHeight = [int]$measure.result.contentHeight
            $record.windowHeight = [int]$measure.window.Height
            $record.cardHeight = [int]$measure.card.height

            # ---- 钳高取证（D-46）：这一轮按哪块屏、什么缩放、多少上限建的窗 ----
            $placement = Get-Field $measure 'placement'
            $record.maxHeight = [int](Get-Field $placement 'maxHeight')
            $record.scale = [double](Get-Field $placement 'scale')
            $area = Get-Field $placement 'area'
            if ($null -ne $area) { $record.areaHeight = [int](Get-Field $area 'Height') }

            # ---- 判据 4/5 的取证：探针的 layout（fill / natural 两次量的每层盒子）----
            # 不能叫 $probe：PowerShell 变量名不分大小写，会撞上脚本参数 [bool]$Probe，
            # 把对象赋给布尔变量直接抛「Cannot convert … to type System.Boolean」（实测）。
            $probeData = Get-Field $measure 'probe'
            $layout = Get-Field $probeData 'layout'
            $fill = Get-Field $layout 'fill'
            $natural = Get-Field $layout 'natural'
            if ($null -ne $fill) {
                $record.rootClientHeight = [int](Get-Field $fill 'rootClientHeight')
                $record.rootScrollHeight = [int](Get-Field $fill 'rootScrollHeight')
                # 每一层自己裁掉了多少：>1px 就是「内容放不下」，把层名一起记下来，别只报一个总数。
                $clipped = [System.Collections.Generic.List[string]]::new()
                foreach ($block in @(Get-Field $fill 'code') + @(Get-Field $fill 'header') + @(Get-Field $fill 'footer')) {
                    if ($null -eq $block) { continue }
                    $cut = [int](Get-Field $block 'clipped')
                    if ($cut -gt 1) {
                        $clipped.Add(('{0} 裁掉 {1}px' -f [string](Get-Field $block 'label'), $cut))
                    }
                }
                $record.clipped = @($clipped)
            }
            if ($null -ne $natural) { $record.naturalHeight = [int](Get-Field $natural 'contentHeight') }
            $under = Get-Field $layout 'underReportedPx'
            if ($null -ne $under) { $record.underReportedPx = [int]$under }

            # 页面发的**第一条**消息就是 ready（协议只让它报一次高度），据实记录它说的数字。
            # 以前这里按 type -eq 'ready' 过滤，而探针包装装得太晚、只记到 resize → 恒为 0 的假 0（D-46）。
            $messages = @(Get-Field (Get-Field $probeData 'trace') 'messages')
            if ($messages.Count -gt 0) {
                $first = $messages[0]
                $record.firstType = [string](Get-Field $first 'type')
                $record.firstHeight = [int](Get-Field $first 'height')
                $record.firstRootHeight = [double](Get-Field $first 'rootHeight')
                $record.firstCode = [double](Get-Field $first 'code')
                $record.firstStrip = [double](Get-Field $first 'strip')
            }
        } catch {
            $record.error = 'measure.json 读不出来：' + $_.Exception.Message
        }
    }
    $samples.Add([pscustomobject]$record)
    ('run {0}/{1}: content={2} window={3} 页面报={4}({5} root={6} code={7} strip={8}) 上限={9} 屏高={10} natural={11} 裁切={12} {13}' -f `
            $i, $Runs, $record.contentHeight, $record.windowHeight,
            $record.firstHeight, $record.firstType, $record.firstRootHeight, $record.firstCode, $record.firstStrip,
            $record.maxHeight, $record.areaHeight, $record.naturalHeight,
            $(if (@($record.clipped).Count -eq 0) { '无' } else { @($record.clipped) -join '、' }),
            $record.error) | Write-Output
}

$fallbackAfter = Get-HeightFallbackCount -Since $runStartedAt
$unstableHits = (Get-FlashCount -Kind 'measure-unstable') - $unstableBefore
$heights = @($samples | Where-Object { $_.error -eq '' } | ForEach-Object { $_.contentHeight })
$failures = [System.Collections.Generic.List[string]]::new()
if ($heights.Count -ne $Runs) {
    $failed = @($samples | Where-Object { $_.error -ne '' } | ForEach-Object { "run $($_.run): $($_.error)" })
    $failures.Add("只成功 $($heights.Count)/$Runs 次：" + ($failed -join '；'))
}
$spread = 0
$minHeight = 0
$maxHeight = 0
if ($heights.Count -gt 0) {
    $minHeight = [int](($heights | Measure-Object -Minimum).Minimum)
    $maxHeight = [int](($heights | Measure-Object -Maximum).Maximum)
    $spread = $maxHeight - $minHeight
    # 稳定性：同一份载荷的高度只该有一个值，容差只留给 DPI 取整。
    if ($spread -gt $TolerancePx) { $failures.Add("高度不稳定：跨度 ${spread}px（上限 ${TolerancePx}px）") }
}
# 不做「跑前/跑后相减」：日志轮转会把它算成负数（实测 -3）。直接数本轮开始之后的条目。
$fallbackHits = $fallbackAfter
if ($fallbackHits -gt 0) {
    $failures.Add("有 $fallbackHits 次落进兜底分支（页面没在预算内报高度，窗口停在写死的 360）")
}

# 判据 4：窗口高度必须盖得住内容（任何一层 scrollHeight > clientHeight 都算失败）。
# 这条比「高度一致」更根本：两次都一样矮也是错的，只是错得很稳定。
$overflowed = @($samples | Where-Object { $_.error -eq '' -and @($_.clipped).Count -gt 0 })
if ($overflowed.Count -gt 0) {
    $detail = ($overflowed | ForEach-Object { "run $($_.run)：$(@($_.clipped) -join '，')" }) -join '；'
    $failures.Add("有 $($overflowed.Count) 次的窗口盖不住内容（被裁）：$detail")
}

# 判据 5：报出去的高度必须等于现在的自然高度。
# 不等 = 量早了：页面在布局稳定之前报了 ready，而宿主只认第一次（再报也不改窗口）。
$under = @($samples | Where-Object { $_.error -eq '' -and $_.underReportedPx -gt $TolerancePx })
if ($under.Count -gt 0) {
    $detail = ($under | ForEach-Object { "run $($_.run)：报 $($_.contentHeight)，自然 $($_.naturalHeight)（差 $($_.underReportedPx)px）" }) -join '；'
    $failures.Add("有 $($under.Count) 次报小了：$detail")
}

# 判据 6（D-46）：窗口高度必须**恰好**是 Min(上限, 页面报的高度)，下限 160。
# 这是「页面报 291、窗口 271」那类现象的判定式：只要窗口比页面报的矮，就一定有人在中间改了数，
# 而合法的改法只有一种——真的超过了屏高 62% 的上限。把三者并列写出来，谁改的一眼可见。
$clampedRuns = @($samples | Where-Object { $_.error -eq '' -and $_.firstHeight -gt 0 })
$badClamp = [System.Collections.Generic.List[string]]::new()
foreach ($sample in $clampedRuns) {
    $expected = [Math]::Min($sample.maxHeight, [Math]::Max(160, $sample.firstHeight))
    if ($sample.contentHeight -ne $expected) {
        $badClamp.Add(("run {0}：窗口 {1} ≠ Min(上限 {2}, 页面报 {3}) = {4}" -f $sample.run, $sample.contentHeight, $sample.maxHeight, $sample.firstHeight, $expected))
    }
}
if ($badClamp.Count -gt 0) {
    $failures.Add('窗口高度不等于「上限与页面报高的较小者」：' + ($badClamp -join '；'))
}
# 判据 7（D-46）：上限必须能由记录下来的那块屏算出来（同一块真屏，scale 只除一次）。
# 算不出来的上限 = 猜出来的上限，而猜出来的上限会静默把卡片压矮。
$badArea = [System.Collections.Generic.List[string]]::new()
foreach ($sample in $samples) {
    if ($sample.error -ne '') { continue }
    if ($sample.areaHeight -le 0 -or $sample.scale -le 0) {
        $badArea.Add(("run {0}：没记下可用的屏区（areaHeight={1} scale={2}）" -f $sample.run, $sample.areaHeight, $sample.scale))
        continue
    }
    $expectedMax = [Math]::Min(760, [Math]::Max(160, [int][Math]::Floor((($sample.areaHeight / $sample.scale) * 0.62))))
    if ($sample.maxHeight -ne $expectedMax) {
        $badArea.Add(("run {0}：上限 {1} ≠ 屏高 {2}/scale {3} 的 62% = {4}" -f $sample.run, $sample.maxHeight, $sample.areaHeight, $sample.scale, $expectedMax))
    }
}
if ($badArea.Count -gt 0) {
    $failures.Add('上限与记录的屏区对不上：' + ($badArea -join '；'))
}

$summary = [pscustomobject]@{
    payload      = $payloadPath
    runs         = $Runs
    tolerancePx  = $TolerancePx
    probe        = [bool]$Probe
    # 判据 6 要靠探针记的「第一条消息高度」；-Probe:$false 时它必然是 0，必须让这件事看得出来，
    # 不能表现为「钳高不符 0 次 = 通过」。
    evidenceRuns = $clampedRuns.Count
    heights      = $heights
    min          = $minHeight
    max          = $maxHeight
    spreadPx     = $spread
    fallbackHits = $fallbackHits
    unstableHits = $unstableHits
    flashLog     = $script:FlashLog
    outDir       = $outRoot
    records      = @($samples)
    failures     = @($failures)
    verdict      = $(if ($failures.Count -eq 0) { 'pass' } else { 'fail' })
}
$summaryPath = Join-Path $outRoot 'heights.json'
$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryPath -Encoding utf8

Write-Output ''
Write-Output ("高度：{0}" -f ($heights -join ', '))
Write-Output ("跨度：{0}px（上限 {1}px）  兜底命中：{2}  量高不稳：{3}" -f $spread, $TolerancePx, $fallbackHits, $unstableHits)
Write-Output ("裁切：{0} 次有内容被裁  量小：{1} 次报出去比自然矮  钳高不符：{2} 次  上限算不出：{3} 次" -f `
        $overflowed.Count, $under.Count, $badClamp.Count, $badArea.Count)
Write-Output ("取证：{0}/{1} 次记下了「页面第一条消息的高度」（判据 6 靠它；-Probe:`$false 时是 0）" -f `
        $clampedRuns.Count, $Runs)
Write-Output ("结论：{0}" -f $summary.verdict)
Write-Output ("落盘：{0}" -f $summaryPath)
foreach ($failure in $failures) { [Console]::Error.WriteLine('FAIL  ' + $failure) }
if ($failures.Count -eq 0) { exit 0 }
exit 1

