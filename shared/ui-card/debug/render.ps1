# 验收专用：把一张卡离屏渲染成 PNG，顺手把几何数字落成 JSON（shared/ui-card/debug/render.ps1）
#
# 这个文件**不在**外壳的正式运行路径上，只给「改版前后对比图」和几何/字体核对用。
# 它自己驱动外壳：喂一份载荷（或一份已经生成好的文档），让 Show-CardWindow 正常起窗，
# 在 OnRendered 回调里量尺寸、截一张图、写一份 *.measure.json、关窗。
# OnRendered 由外壳在「页面报过 ready、窗口已显示、切到 fill」之后调用，这里不自己等布局。
# 正式调用方永远不会 dot-source 这个文件。
#
# 需要在**提权**下跑：受限令牌里 WebView2 控制器创建不出来（0x8000FFFF），这是既定边界。
#
# 跑法：
#   pwsh -NoProfile -STA -File shared\ui-card\debug\render.ps1 `
#     -Payload tests\fixtures\approval.json -OutFile out\approval.png
#   pwsh -NoProfile -STA -File ...\render.ps1 -HtmlFile out\card.html -OutFile out\card.png
#
#   -Mode screen       真屏抓图（BitBlt + CAPTUREBLT），用来验证「到底显示出来没有」
#   -ScreenMargin 20   真屏抓图时窗口矩形向外扩 20px（窗口外多出来的白边/杂色只有扩出去才看得见）
#   -Screen 1          把卡片钉到 1 号屏（本机 0 = (0,0) 主屏，1 = (1920,-4) 副屏）；缺省跟着鼠标走
#   -CornerRadius 20   圆角对比图；默认 0 = 方形（窗口不设 Region）
#   -Backdrop magenta  窗口底色与页面 html/body 底色都设成它：卡片没盖住的地方会显形
#   -Position corner   落位（默认 corner = 主屏右下角；center = 鼠标所在屏居中，落位由外壳算）
#   -Probe             页面 ready 之后在页内跑探针（debug\probe.js），把几何/计算样式写进 measure.json 的 probe 字段。
#                      同时把 debug\trace.js 注入文档 <head>（跑在页面脚本之前），于是 probe.trace 里有
#                      「报 ready 那一刻 #root 多高」以及之后每帧的高度变化——量早还是布局真矮靠它分。
#                      只用 getBoundingClientRect + getComputedStyle，**不截图取色**（ClearType 会把 #067D17 混成 #2C8365）。
#                      不带这个开关时，measure.json 的字段与以前一个不差。
#
# 产物：
#   <OutFile>                    PNG
#   <OutFile 同名>.measure.json  几何（窗口/客户区/卡片/抓图矩形）+ 本次参数（-Probe 时多一个 probe 字段）
#
# 退出码：0 = PNG 落盘成功；1 = 起窗/截屏失败；2 = 参数不对。

param(
    [string]$Payload = '',
    [string]$HtmlFile = '',
    [string]$OutFile = '',
    [int]$Width = 0,
    [int]$MaxHeight = 0,
    [int]$SettleMs = 300,
    [int]$CornerRadius = 0,
    [string]$Backdrop = '',
    [int]$ScreenMargin = 20,
    [int]$Screen = -1,
    [ValidateSet('center', 'corner')][string]$Position = 'corner',
    [ValidateSet('preview', 'screen')][string]$Mode = 'preview',
    # WebView2 用户数据目录。空 = 外壳的缺省（%LOCALAPPDATA%\dsh-ui-card\webview2）。
    # 缺省目录被别的 WebView2 进程占着时 CreateAsync 会以 ERROR_BUSY(0x800700AA) 失败，
    # 批量出图（debug\height-stability.ps1）就各跑各的目录，互不打扰。
    [string]$DataDir = '',
    [switch]$Probe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# demo.ps1 的参数块里有同名变量（Payload / Width / MaxHeight / TimeoutMs / DataDir / CornerRadius），
# dot-source 会把当前作用域的同名变量覆盖成默认值。所以先把命令行参数抄进 render* 变量，之后只用 render*。
$renderPayload = $Payload
$renderHtmlFile = $HtmlFile
$renderOutFile = $OutFile
$renderWidth = $Width
$renderMaxHeight = $MaxHeight
$renderSettleMs = $SettleMs
$renderCornerRadius = $CornerRadius
$renderBackdrop = $Backdrop
$renderDataDir = $DataDir
$renderScreenMargin = $ScreenMargin
$renderScreen = $Screen
$renderPosition = $Position
# -Screen 会在 OnShown 里把窗口挪到指定屏居中（见下面的 onShown），落位参数就不作数了。
# 如实记成 'screen'，几何断言才知道「这不是落位算出来的位置」，不去误判右下角边距。
$renderPositionRecorded = if ($renderScreen -ge 0) { 'screen' } else { $renderPosition }
$renderMode = $Mode
# 探针开关也抄一份：demo.ps1 的 param 块会覆盖当前作用域的同名变量，之后只用 render*。
$renderProbe = $Probe.IsPresent

$script:CardHome = Split-Path -Parent $PSScriptRoot
. (Join-Path $script:CardHome 'card-html.ps1')
. (Join-Path $script:CardHome 'webview2.ps1')
# demo.ps1 被 dot-source 时只定义函数、不执行主流程；这里复用它的载荷解码。
. (Join-Path $script:CardHome 'demo\demo.ps1')

Add-Type -AssemblyName System.Drawing

function Initialize-RenderNative {
    <#
    .SYNOPSIS
        真屏抓图要的那几个 P/Invoke（只在本文件里用，外壳不认识它们）。
    #>
    if ('DshUiCardRender.Native' -as [type]) { return }
    Add-Type -Namespace DshUiCardRender -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetDC(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern int ReleaseDC(System.IntPtr hWnd, System.IntPtr hDC);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[DllImport("gdi32.dll")] public static extern bool BitBlt(System.IntPtr hdcDest, int x, int y, int w, int h, System.IntPtr hdcSrc, int xs, int ys, uint rop);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
}

function Save-CardPreviewPng {
    <#
    .SYNOPSIS
        用 WebView2 自己的 CapturePreview 落一张 PNG（不受窗口遮挡影响）。
    .DESCRIPTION
        注意：抓的是**页面内容**，不含窗口 Region 的裁剪，所以永远看不到「窗口边缘」。
        验双边框必须用 -Mode screen。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Ctrl,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    $stream = [System.IO.File]::Create($Path)
    try {
        $capture = $Ctrl.CoreWebView2.CapturePreviewAsync([Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat]::Png, $stream)
        $deadline = [DateTime]::Now.AddSeconds(15)
        while (-not $capture.IsCompleted -and [DateTime]::Now -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 10
        }
        if (-not $capture.IsCompleted) { throw 'CapturePreviewAsync 超时' }
    } finally {
        $stream.Dispose()
    }
}

function Save-CardScreenPng {
    <#
    .SYNOPSIS
        真屏抓一张「窗口矩形 ± Margin」的 PNG，返回抓图矩形。
    .DESCRIPTION
        必须用 BitBlt + CAPTUREBLT(0x40CC0020)：Graphics.CopyFromScreen 会漏掉置顶/分层窗口，
        截出来是一张白卡。外扩部分会先夹到窗口所在屏幕的范围内（超出屏幕的 BitBlt 是黑的）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [Parameter(Mandatory = $true)][string]$Path,
        [int]$Margin = 0
    )

    Initialize-RenderNative
    $rect = New-Object DshUiCardRender.Native+RECT
    if (-not [DshUiCardRender.Native]::GetWindowRect($Handle, [ref]$rect)) { throw 'GetWindowRect 失败' }
    $windowWidth = $rect.Right - $rect.Left
    $windowHeight = $rect.Bottom - $rect.Top
    if ($windowWidth -le 0 -or $windowHeight -le 0) { throw "窗口尺寸不可用：${windowWidth}x${windowHeight}" }

    $left = $rect.Left - [Math]::Max(0, $Margin)
    $top = $rect.Top - [Math]::Max(0, $Margin)
    $right = $rect.Right + [Math]::Max(0, $Margin)
    $bottom = $rect.Bottom + [Math]::Max(0, $Margin)

    $center = New-Object System.Drawing.Point (($rect.Left + $rect.Right) / 2), (($rect.Top + $rect.Bottom) / 2)
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    foreach ($candidate in [System.Windows.Forms.Screen]::AllScreens) {
        if ($candidate.Bounds.Contains($center)) { $area = $candidate.Bounds; break }
    }
    $clamped = $false
    if ($left -lt $area.Left) { $left = $area.Left; $clamped = $true }
    if ($top -lt $area.Top) { $top = $area.Top; $clamped = $true }
    if ($right -gt $area.Right) { $right = $area.Right; $clamped = $true }
    if ($bottom -gt $area.Bottom) { $bottom = $area.Bottom; $clamped = $true }

    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0) { throw "抓图矩形不可用：${width}x${height}" }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $destDc = $graphics.GetHdc()
        $screenDc = [DshUiCardRender.Native]::GetDC([System.IntPtr]::Zero)
        try {
            [void][DshUiCardRender.Native]::BitBlt($destDc, 0, 0, $width, $height, $screenDc, $left, $top, 0x40CC0020)
        } finally {
            [void][DshUiCardRender.Native]::ReleaseDC([System.IntPtr]::Zero, $screenDc)
            $graphics.ReleaseHdc($destDc)
            $graphics.Dispose()
        }
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }

    [pscustomobject]@{
        Left    = $left
        Top     = $top
        Width   = $width
        Height  = $height
        Margin  = [Math]::Max(0, $Margin)
        Clamped = $clamped
        Window  = [pscustomobject]@{ Left = $rect.Left; Top = $rect.Top; Width = $windowWidth; Height = $windowHeight }
    }
}

function Invoke-CardPageScript {
    <#
    .SYNOPSIS
        在页面里执行一段脚本，返回它 JSON 化后的结果（-Probe 用）。
    .DESCRIPTION
        与 Get-CardPageRect 同一套等待方式：不能在 UI 线程上 .GetAwaiter().GetResult()，
        脚本执行要 UI 线程泵消息，同步等待会互锁。这里用 DoEvents 轮询。
        脚本抛异常 / 返回 undefined / 超时，一律返回 $null——探针失败不许让出图失败，
        调用方自己决定记成 probe.error。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Ctrl,
        [Parameter(Mandatory = $true)][string]$Script,
        [int]$TimeoutMs = 5000
    )

    if ($null -eq $Ctrl -or $null -eq $Ctrl.CoreWebView2) { throw 'CoreWebView2 未就绪（页面没起来？）' }
    $task = $Ctrl.CoreWebView2.ExecuteScriptAsync($Script)
    if ($null -eq $task) { throw 'ExecuteScriptAsync 返回了 $null' }

    $deadline = [DateTime]::Now.AddMilliseconds($TimeoutMs)
    while (-not $task.IsCompleted -and [DateTime]::Now -lt $deadline) {
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 10
    }
    if (-not $task.IsCompleted) { throw "页面脚本超时（${TimeoutMs}ms）" }

    $raw = $task.GetAwaiter().GetResult()
    if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq 'null') { return $null }
    $parsed = $raw | ConvertFrom-Json
    if ($parsed -is [string]) {
        # 脚本自己返回字符串时会再套一层 JSON（ExecuteScriptAsync 总是回 JSON）。
        try { $parsed = $parsed | ConvertFrom-Json } catch { }
    }
    $parsed
}

function Get-CardPageRect {
    <#
    .SYNOPSIS
        从页面里读 #root 的实测矩形与视口尺寸（读两次，取稳定值）。
    .DESCRIPTION
        只量卡片元素本身，不量 documentElement：后者在滚动容器里没有意义。
    #>    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Ctrl,
        [int]$Attempts = 4,
        [int]$SettleMs = 80
    )

    $js = "JSON.stringify((() => { const el = document.getElementById('root'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, bodyScrollWidth: document.body.scrollWidth, bodyScrollHeight: document.body.scrollHeight }; })())"

    $last = $null
    for ($i = 0; $i -lt $Attempts; $i++) {
        Start-Sleep -Milliseconds $SettleMs
        [System.Windows.Forms.Application]::DoEvents()
        if ($null -eq $Ctrl) { throw 'OnRendered 收到的控件是 $null' }
        if ($null -eq $Ctrl.CoreWebView2) { throw 'CoreWebView2 未就绪（页面没起来？）' }
        $task = $Ctrl.CoreWebView2.ExecuteScriptAsync($js)
        if ($null -eq $task) { throw 'ExecuteScriptAsync 返回了 $null' }
        # 不能在 UI 线程上 .GetAwaiter().GetResult()：脚本执行要 UI 线程泵消息，同步等待会互锁，
        # 表现为「页面按钮点了没反应」。这里和 CapturePreview 一样用 DoEvents 轮询。
        $deadline = [DateTime]::Now.AddSeconds(5)
        while (-not $task.IsCompleted -and [DateTime]::Now -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 10
        }
        if (-not $task.IsCompleted) { throw 'ExecuteScriptAsync 超时（5s）' }
        $raw = $task.GetAwaiter().GetResult()
        if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq 'null') { continue }
        $parsed = $raw | ConvertFrom-Json
        if ($parsed -is [string]) { $parsed = $parsed | ConvertFrom-Json }
        if ($null -eq $parsed) { continue }
        # React 是异步渲染：首次读到 0 高只说明还没画完，继续等，不要当结果返回。
        if ([int]$parsed.height -le 0 -or [int]$parsed.width -le 0) { $last = $null; continue }
        if ($null -ne $last -and $last.width -eq $parsed.width -and $last.height -eq $parsed.height) { return $parsed }
        $last = $parsed
    }
    if ($null -eq $last) { throw '读不到卡片尺寸（#root）' }
    $last
}

function Get-CardRenderHtml {
    <#
    .SYNOPSIS
        输入 → 要渲染的文档：优先用 -HtmlFile，否则按 -Payload 解码成载荷再生成文档。
    #>
    [CmdletBinding()]
    param(
        [string]$PayloadPath,
        [string]$HtmlPath
    )

    if (-not [string]::IsNullOrWhiteSpace($HtmlPath)) {
        if (-not (Test-Path -LiteralPath $HtmlPath)) { throw "HTML 文件不存在：$HtmlPath" }
        return (Get-Content -Raw -LiteralPath $HtmlPath -Encoding utf8)
    }
    if ([string]::IsNullOrWhiteSpace($PayloadPath)) { throw '需要 -Payload 或 -HtmlFile 之一' }

    $data = ConvertFrom-CardDemoPayload -Path $PayloadPath
    New-CardDemoDocument -Payload $data
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($renderOutFile)) {
    [Console]::Error.WriteLine('用法：render.ps1 -Payload <json> | -HtmlFile <html> -OutFile <png> [-Mode preview|screen] [-Backdrop <色>] [-ScreenMargin 20] [-Screen 0|1] [-CornerRadius 0] [-Probe]')
    exit 2
}

try {
    $html = Get-CardRenderHtml -PayloadPath $renderPayload -HtmlPath $renderHtmlFile
    if ([string]::IsNullOrWhiteSpace($html)) { throw '生成的 HTML 是空的' }

    # 量高时间线（只在 -Probe 时）：debug\trace.js 塞进 <head>，跑在页面脚本之前，
    # 于是「报 ready 那一刻 #root 多高」有实测值，而不是事后猜（见 probe.js 的 trace 字段）。
    if ($renderProbe) {
        $tracePath = Join-Path $PSScriptRoot 'trace.js'
        if (-not (Test-Path -LiteralPath $tracePath)) { throw "量高时间线脚本不存在：$tracePath" }
        $traceScript = Get-Content -Raw -LiteralPath $tracePath -Encoding utf8
        $html = $html.Replace('</head>', ('<script>' + "`n" + $traceScript + "`n" + '</script>' + "`n</head>"))
    }

    # 洋红底：页面与窗口同时上色，卡片没盖住的地方就藏不住了。
    if (-not [string]::IsNullOrWhiteSpace($renderBackdrop)) {
        $html = $html.Replace('</head>', ('<style>html, body { background: ' + $renderBackdrop + ' !important; }</style>' + "`n</head>"))
    }

    $outPath = [System.IO.Path]::GetFullPath($renderOutFile)
    $outDir = Split-Path -Parent $outPath
    if (-not [string]::IsNullOrWhiteSpace($outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    $measurePath = Join-Path (Split-Path -Parent $outPath) ([System.IO.Path]::GetFileNameWithoutExtension($outPath) + '.measure.json')

    $windowWidth = if ($renderWidth -gt 0) { $renderWidth } else { 680 }
    # 屏幕只解析一次（D-46）：限高与落位必须按同一块真屏，同一份 measure.json 里还要看得到是哪一块。
    # 解析不出来就抛：验收脚本缺屏是环境问题，不许拿猜的矩形出图（那正是「偶发 271」的温床）。
    $screenArea = Get-CardScreenArea
    if ($null -eq $screenArea) { throw '解析不出屏幕可用区（Get-CardScreenArea 返回空）：不出图，见 DECISIONS D-46' }
    $dpiScale = Get-DpiScale
    $windowMax = Get-CardMaxHeight -Requested $renderMaxHeight -WorkAreaHeight $screenArea.Height -Scale $dpiScale

    $state = [pscustomobject]@{
        Capture   = $null
        Card      = $null
        Window    = $null
        Client    = $null
        HasRegion = $null
        Probe     = $null
        # 这一轮是按哪块屏、什么缩放、多少上限算出来建窗的（排查钳高用，见 D-46）。
        Placement = [pscustomobject]@{
            area             = $screenArea
            scale            = $dpiScale
            requestedMaxHeight = [int]$renderMaxHeight
            maxHeight        = [int]$windowMax
            width            = [int]$windowWidth
        }
    }

    # 显示之后：把窗口挪到指定屏幕（-Screen 缺省时不动，跟着鼠标所在屏）。
    $onShown = {
        param($showInfo, $form, $ctrl)
        if ($renderScreen -lt 0) { return }
        $screens = [System.Windows.Forms.Screen]::AllScreens
        if ($renderScreen -ge $screens.Count) { return }
        $area = $screens[$renderScreen].WorkingArea
        $form.Left = $area.Left + [int](($area.Width - $form.Width) / 2)
        $form.Top = $area.Top + [int](($area.Height - $form.Height) / 2)
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 60
        [System.Windows.Forms.Application]::DoEvents()
    }

    # 窗口已可见、页面已切到 fill：量几何 → 截图 → 关窗。正式路径没有这段。
    # 宿主在 ready 之后才会调这个回调，所以这里不再自己等布局。
    #
    # 回调里的异常会被 webview2.ps1 吞掉（它不能让调试代码影响宿主），所以这里必须自己兜住：
    # 异常写进 <OutFile>.error.txt 并把原文重新抛出；finally 里无条件关窗——
    # 否则回调一炸，窗就一直挂在屏幕上直到 20 秒超时（2026-10-27 真机踩过）。
    $errorPath = Join-Path (Split-Path -Parent $outPath) ([System.IO.Path]::GetFileNameWithoutExtension($outPath) + '.error.txt')
    # 探针脚本只读一次（回调里不再碰文件系统；$PSScriptRoot 在脚本作用域里也最可靠）。
    $probePath = Join-Path $PSScriptRoot 'probe.js'
    $probeScript = ''
    if ($renderProbe -and (Test-Path -LiteralPath $probePath)) {
        $probeScript = Get-Content -Raw -LiteralPath $probePath -Encoding utf8
    }
    $onRendered = {
        param($form, $ctrl)
        try {
            Start-Sleep -Milliseconds $renderSettleMs
            [System.Windows.Forms.Application]::DoEvents()

            $state.Window = [pscustomobject]@{
                Left   = $form.Left
                Top    = $form.Top
                Width  = $form.Bounds.Width
                Height = $form.Bounds.Height
            }
            $state.Client = [pscustomobject]@{ Width = $form.ClientSize.Width; Height = $form.ClientSize.Height }
            $state.HasRegion = ($null -ne $form.Region)
            $state.Card = Get-CardPageRect -Ctrl $ctrl -Attempts 4 -SettleMs 80

            # 探针（-Probe）：几何与计算样式。失败只写 probe.error，不影响出图与其余字段。
            if ($renderProbe) {
                try {
                    if ([string]::IsNullOrWhiteSpace($probeScript)) { throw "探针脚本不存在或为空：$probePath" }
                    $probeResult = Invoke-CardPageScript -Ctrl $ctrl -Script $probeScript
                    $state.Probe = if ($null -eq $probeResult) {
                        [pscustomobject]@{ error = '页面脚本返回空（脚本抛异常，或页面还没就绪）' }
                    } else {
                        $probeResult
                    }
                } catch {
                    $state.Probe = [pscustomobject]@{ error = $_.Exception.Message }
                }
            }

            if ($renderMode -eq 'screen') {
                $state.Capture = Save-CardScreenPng -Handle $form.Handle -Path $outPath -Margin $renderScreenMargin
            } else {
                Save-CardPreviewPng -Ctrl $ctrl -Path $outPath
            }
        } catch {
            $lines = @(
                'onRendered 失败：' + $_.Exception.GetType().FullName
                $_.Exception.Message
                ($_.ScriptStackTrace -join "`n")
            )
            $lines -join "`n" | Set-Content -LiteralPath $errorPath -Encoding utf8
            throw
        } finally {
            try { $form.Close() } catch { }
        }
    }

    # 外壳在自己的函数作用域里 `& $OnRendered`（webview2.ps1 第 402 行），PowerShell 的 scriptblock
    # 默认是**动态作用域**：回调里的 $state / $renderProbe / $probeScript 会沿调用栈重新解析，
    # 撞上外壳里的同名变量（实测：`$state.Window` 报「property cannot be found」、
    # `if ($renderProbe)` 报「Cannot convert PSCustomObject to SwitchParameter」）。
    # GetNewClosure() 把当前值绑死成闭包，回调就只认 render.ps1 自己这份。
    $onShown = $onShown.GetNewClosure()
    $onRendered = $onRendered.GetNewClosure()

    $window = Show-CardWindow -Html $html -Width $windowWidth -MaxHeight $windowMax -Area $screenArea -TimeoutMs 20000 `
        -CornerRadius $renderCornerRadius -WindowBackground $renderBackdrop -Position $renderPosition `
        -DataDir $renderDataDir `
        -WindowTitle 'DSH 卡片出图' -OnShown $onShown -OnRendered $onRendered

    if ([string]$window.Action -eq 'failed') { throw ('卡片起不来：' + [string]$window.Error) }
    if (-not (Test-Path -LiteralPath $outPath)) {
        $detail = if (Test-Path -LiteralPath $errorPath) { Get-Content -Raw -LiteralPath $errorPath } else { '(没有 error.txt，回调可能没被调用)' }
        throw ("没有生成 PNG`n" + $detail)
    }
    $size = (Get-Item -LiteralPath $outPath).Length
    if ($size -le 0) { throw 'PNG 是 0 字节' }

    $measure = [pscustomobject]@{
        png          = $outPath
        mode         = $renderMode
        cornerRadius = $renderCornerRadius
        backdrop     = $renderBackdrop
        position     = $renderPositionRecorded
        screen       = $renderScreen
        screenMargin = $renderScreenMargin
        result       = [pscustomobject]@{
            action        = [string]$window.Action
            contentWidth  = [int]$window.ContentWidth
            contentHeight = [int]$window.ContentHeight
            windowBounds  = [string]$window.WindowBounds
        }
        window       = $state.Window
        client       = $state.Client
        hasRegion    = $state.HasRegion
        card         = $state.Card
        capture      = $state.Capture
        bytes        = $size
        # 钳高的取证（D-46）：按哪块屏、什么缩放、多少上限建的窗。
        # 只有它 + 页面的报高放在一起，才能分清「页面报小了」和「这里被上限钳了」。
        placement    = $state.Placement
    }
    # -Probe：探针与现有字段并列，不挤占、不改名。不带这个开关时这里一行都不加，输出与以前逐字节一致。
    if ($renderProbe) {
        # 变量名不能叫 $probe：PowerShell 变量不区分大小写，它与 [switch]$Probe 是同一个变量，
        # 往里塞 PSCustomObject 会报「Cannot convert PSCustomObject to SwitchParameter」（2026-10-30 真踩）。
        $probeRecord = if ($null -ne $state.Probe) {
            $state.Probe
        } else {
            [pscustomobject]@{ error = '探针未执行（onRendered 没走到这一步）' }
        }
        $measure | Add-Member -NotePropertyName probe -NotePropertyValue $probeRecord
    }
    # 深度 8：probe 里套 block/buttons/colors，比原来深两层。
    $measure | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $measurePath -Encoding utf8

    [pscustomobject]@{
        outFile       = $outPath
        measureFile   = $measurePath
        bytes         = $size
        mode          = $renderMode
        cornerRadius  = $renderCornerRadius
        backdrop      = $renderBackdrop
        position      = $renderPositionRecorded
        contentWidth  = [int]$window.ContentWidth
        contentHeight = [int]$window.ContentHeight
        windowBounds  = [string]$window.WindowBounds
        card          = $state.Card
        capture       = $state.Capture
    } | ConvertTo-Json -Depth 5
    exit 0
} catch {
    [Console]::Error.WriteLine('出图失败：' + $_.Exception.Message)
    # 只打消息看不出是哪个参数绑定的错（例如 switch 收到 PSCustomObject），把栈也打出来。
    $stack = ($_.ScriptStackTrace -split "`n" | Select-Object -First 6) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($stack)) { [Console]::Error.WriteLine('  ' + ($stack -replace "`n", "`n  ")) }
    exit 1
}
