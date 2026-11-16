# 入口层：WebView2 窗口宿主（shared/ui-card/webview2.ps1）
#
# 职责只有三件：把一份文档显示出来、等页面回消息、把原始消息交回去。
#   - 不认识业务（「这个按钮代表同意还是拒绝」是调用方的事）；
#   - 不拼 HTML、不碰颜色字号（那是 card-html.ps1 / dist 产物的事）；
#   - 只回传页面 postMessage 出来的 JSON 串，内容是调用方与页面之间的协议。
#
# 尺寸规则（两阶段，见 docs/shared-ui-card.md）：
#   1. 窗口先按目标宽度建在屏幕外、隐藏；页面在 measure 阶段不限高，布局完成后发 ready{height}；
#   2. 宿主把 height 钳到 [160, 760] 与屏高 62%，SetWindowPos 到该尺寸、ShowWindow，再发 shown；
#   3. 页面收到 shown 切 fill 阶段（只有被钳矮时才出现内部滚动，页脚钉住）；
#   4. 等 ready 分两个时钟：先等页面自己加载完（NavigationCompleted，收口 20s，与控制器初始化同档），
#      加载完才起算「报高度」的 2s 宽限；两段都过了还没高度，才按 360 的建窗初值显示（可重试的失败，
#      不写兜底 UI）。旧写法把两段合成「从 NavigateToString 起算 2s」，机器一忙就把高度赌成 360（D-45）。
#
# 依赖：仓库根 vendor\webview2 下三个 DLL，机器上还要有 WebView2 运行时。缺 DLL 或没运行时，
# Show-CardWindow 返回 Action='failed' + Error 文案 —— 外壳没有第二条渲染路径。

Set-StrictMode -Version Latest

# 同 card-html.ps1：函数被调用时 $PSScriptRoot 可能已经是调用方的目录，所以先算好。
$script:CardShellDir = $PSScriptRoot

. (Join-Path $script:CardShellDir 'environment.ps1')
. (Join-Path $script:CardShellDir 'webview2-runtime.ps1')

function Get-CardMaxHeight {
    <#
    .SYNOPSIS
        窗口最高能给多少 CSS 逻辑像素。
    .DESCRIPTION
        卡片是弹窗不是全屏面板：最多占可用高度的 62%（1080p 上约 669），再高就让卡片中部自己滚。
        上限 760、下限 160：卡片高度跟内容走，短卡不留空白，长卡靠屏高 62% 收口。显式给值时同样受这组边界约束。
        $WorkAreaHeight 不传时按 Get-CardScreenArea（活动窗口所在屏）的可用高度算，不再固定主屏（B-24）。
    .PARAMETER WorkAreaHeight
        物理像素。同一个调用点（webview2.ps1 里同一张卡）要与落位传**同一块屏**，否则会一次按主屏限高、一次按副屏落位。
    #>
    [CmdletBinding()]
    param(
        [int]$Requested = 0,
        [int]$WorkAreaHeight = 0,
        [double]$Scale = 0
    )

    if ($Requested -gt 0) { return [Math]::Min(760, [Math]::Max(160, $Requested)) }

    if ($Scale -le 0) { $Scale = Get-DpiScale }
    if ($WorkAreaHeight -le 0) {
        $screenArea = Get-CardScreenArea
        # 解析不出来就报错，不拿 0 去算：0/scale*0.62 = 0 → 被下限抬成 160，等于凭空给一个高度（D-46）。
        if ($null -eq $screenArea -or [int]$screenArea.Height -le 0) {
            throw '解析不出屏幕可用区，算不了限高（Get-CardScreenArea 返回空）'
        }
        $WorkAreaHeight = $screenArea.Height
    }
    $ratio = [int][Math]::Floor((($WorkAreaHeight / $Scale) * 0.62))
    [Math]::Min(760, [Math]::Max(160, $ratio))
}

function Send-CardPageMessage {
    <#
    .SYNOPSIS
        给页面发一条消息（走 WebView2 的 PostWebMessageAsJson）。
    .DESCRIPTION
        页面侧用 chrome.webview.addEventListener('message') 收；这里只发协议消息
        （shown，以及复制回执 copied）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Ctrl,
        [Parameter(Mandatory = $true)][hashtable]$Message
    )

    $Ctrl.CoreWebView2.PostWebMessageAsJson(($Message | ConvertTo-Json -Compress))
}

function ConvertFrom-CardMessage {
    <#
    .SYNOPSIS
        页面的 JSON 消息 → 外壳认识的字段；坏消息不抛异常，返回全空。
    .DESCRIPTION
        协议（页面侧见 app/src/bridge.ts）：
          {type:'ready', height}  {type:'resize', height}
          {type:'decision', value, checked?}  {type:'cancel'}  {type:'expired'}
          {type:'copy', text}
        返回对象的字段**恒定存在**：调用方在 StrictMode 下直接读也不会抛。
        Text 只回传、不打印：复制的是命令，不写进任何日志。
    .PARAMETER Json
        CoreWebView2WebMessageReceivedEventArgs.WebMessageAsJson 原样串。
    .OUTPUTS
        [pscustomobject] Type / Value / Checked / Height / Text
    #>
    [CmdletBinding()]
    param([AllowNull()][string]$Json)

    $info = [pscustomobject]@{
        Type        = ''
        Value       = ''
        Checked     = @()
        Height      = 0
        Text        = ''
    }
    if ([string]::IsNullOrWhiteSpace($Json)) { return $info }

    $parsed = $null
    try { $parsed = $Json | ConvertFrom-Json } catch { return $info }
    if ($null -eq $parsed) { return $info }

    # 缺字段时直接点取值在 StrictMode 下会抛，一律走 PSObject.Properties。
    $property = $parsed.PSObject.Properties['type']
    if ($null -ne $property -and $null -ne $property.Value) { $info.Type = [string]$property.Value }
    $property = $parsed.PSObject.Properties['value']
    if ($null -ne $property -and $null -ne $property.Value) { $info.Value = [string]$property.Value }
    $property = $parsed.PSObject.Properties['checked']
    if ($null -ne $property -and $null -ne $property.Value) { $info.Checked = @($property.Value) }
    $property = $parsed.PSObject.Properties['height']
    if ($null -ne $property -and $null -ne $property.Value) {
        $parsedHeight = 0
        if ([int]::TryParse([string]$property.Value, [ref]$parsedHeight)) { $info.Height = $parsedHeight }
    }
    $property = $parsed.PSObject.Properties['text']
    if ($null -ne $property -and $null -ne $property.Value) { $info.Text = [string]$property.Value }
    $info
}

function Test-CardHeightWait {
    <#
    .SYNOPSIS
        等页面报高度的判定：继续等 / 拿到了 / 认输。纯函数——不建窗、不跑消息泵、不自己读时钟。
    .DESCRIPTION
        高度只能来自页面那一次 ready（载荷里没有高度字段），所以宿主的问题只是「等多久算没戏」。
        这里把它拆成两段，因为两段的性质完全不同（D-45）：

          ① 页面还没加载完（NavigationCompleted 未到）：这段耗的是 WebView2 冷启 + 728KB 产物
             解析执行 + React/antd 首渲染 + Shiki 首次分词，长度随机器负载抖到秒级，**不可预测**；
          ② 页面已经加载完（NavDone）：布局已经在眼前，React 的 ready 只比 load 晚几十毫秒，
             这时还报不出来就是页面自己的 bug。

        旧写法把两段合成「从 NavigateToString 起算 2 秒」：等于拿①的耗时间去赌②的窗口，赌输就只剩
        「写死 360」这一条路——2026-11-12 真机那张 680×360 的卡（内容只有 ~290）就是这么来的。
    .OUTPUTS
        'ready'（拿到高度）/ 'wait'（还没到点）/ 'timeout'（这一段等完了，页面没给高度）
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$Height,
        [Parameter(Mandatory = $true)][bool]$NavDone,
        [Parameter(Mandatory = $true)][datetime]$NavigationDeadline,
        [Parameter(Mandatory = $true)][datetime]$ReadyDeadline,
        [Parameter(Mandatory = $true)][datetime]$Now
    )

    # 拿到高度就立刻走：height 优先于任何时钟，NavDone 晚到也不影响（同一次泵里两条消息的次序无关）。
    if ($Height -gt 0) { return 'ready' }
    if ($NavDone) {
        if ($Now -ge $ReadyDeadline) { return 'timeout' }
        return 'wait'
    }
    if ($Now -ge $NavigationDeadline) { return 'timeout' }
    return 'wait'
}

function Get-CardWindowIcon {
    <#
    .SYNOPSIS
        读 assets/card.ico 给窗口用；文件缺失或读坏了返回 $null（窗口继续用系统默认图标）。
    .DESCRIPTION
        PREFERENCES B-25：任务栏 / alt-tab 里要一眼认出是卡片——透明底上直接画橙色线条的「>_」，
        由 assets/make-icon.ps1 生成、产物入库。图标只是**窗口属性**，卡片内部视觉不掺和
        （不加 logo、不改布局、不改间距）。
        缺文件不该让卡片弹不出来：写一次 stderr，然后照常开窗（默认图标）。
    #>
    [CmdletBinding()]
    param([string]$Path = '')

    if ([string]::IsNullOrWhiteSpace($Path)) {
        $Path = Join-Path $script:CardShellDir 'assets\card.ico'
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        [Console]::Error.WriteLine("卡片图标缺失，使用系统默认图标：$Path")
        return $null
    }
    try {
        return [System.Drawing.Icon]::new((Resolve-Path -LiteralPath $Path).Path)
    } catch {
        [Console]::Error.WriteLine("卡片图标读不出来，使用系统默认图标：$($_.Exception.Message)")
        return $null
    }
}

function Show-CardWindow {
    <#
    .SYNOPSIS
        显示一张卡，等页面回消息，返回结果。不抛异常：起不来的原因放在 Error 里。
    .PARAMETER Html
        完整 HTML（New-CardDocument 的产物：React 构建产物 + 本次载荷）。
    .PARAMETER Width
        卡片宽度，CSS 逻辑像素（内部按 DPI 换算成物理像素建窗）。
    .PARAMETER MaxHeight
        窗口最高高度，CSS 逻辑像素；0 = 按屏幕算（屏高 62%，夹 160–760）。
    .PARAMETER Area
        屏幕可用区（物理像素，Left/Top/Width/Height/Right/Bottom）。不传就自己解析一次，
        限高与落位都用这一块。传进来就用它，**不再自己解析**——调用方脚本（render / demo）已经解析过时，
        这样两边算的是同一块真屏；解析不出来（全零/空）直接报错，不拿猜出来的矩形建窗（D-46）。
    .PARAMETER TimeoutMs
        超过这么多毫秒还没消息就按「没作答」收尾（0 = 一直等，由页面自己的倒计时关窗）。
    .PARAMETER CornerRadius
        窗口圆角半径，CSS 逻辑像素；默认 0 = 方形（不设 Region）。
    .PARAMETER WindowBackground
        窗口底色（HTML 颜色名或 #rrggbb，默认白）。只露在卡片没盖住的地方。
    .PARAMETER OnShown
        窗口显示之后的回调 param($ShowInfo, $Form, $Ctrl)：放提示音这类调用方附加动作。
        任务栏闪烁已经由外壳统一做，回调里不要再做一遍。可不传。
        **回调的返回值一律丢弃**：不丢弃的话 PowerShell 会把回调的输出接进本函数的返回值，
        调用方拿到的 $window 就成了 Object[]（2026-11-02 真机点按钮崩溃的根因，见 DECISIONS D-04）。
    .PARAMETER OnRendered
        窗口已显示、页面已切到 fill 之后的回调 param($Form, $Ctrl)：只给验收脚本用（截图后关窗）。
    .OUTPUTS
        Action(message/closed/timeout/failed) / Message / ContentWidth / ContentHeight /
        WindowBounds / ShowInfo / Error —— 字段恒定，调用方不用判空。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Html,
        [int]$Width = 680,
        [int]$MaxHeight = 0,
        [object]$Area = $null,
        [int]$TimeoutMs = 0,
        [string]$DataDir = '',
        # 默认右下角：同一个产品里两种落位（一个角落、一个居中）只能让人怀疑「是不是又有 bug」。
        [ValidateSet('center', 'corner')][string]$Position = 'corner',
        [int]$SlotIndex = 0,
        [int]$SlotCount = 1,
        [int]$CornerRadius = 0,
        [string]$WindowTitle = 'DSH',
        [string]$WindowBackground = '',
        # 层级只有建窗这一个来源：New-CardForm 的 CreateParams 把 WS_EX_TOPMOST(0x8) 交给
        # CreateWindowEx（D-41，取代 D-39）。窗口建好之后非前台进程改不了 Z 序，所以这里**不提供**
        # TopMost 开关、也不设 WinForms 的 TopMost 属性——属性会在窗口被激活时把它重新插回 topmost 层，
        # 第二条层级来源只会让「什么时候在最上面」变得不可推理。
        [switch]$Activate,
        [scriptblock]$OnShown = $null,
        [scriptblock]$OnRendered = $null
    )

    # 等 ready 的两个时钟（D-45，判定在 Test-CardHeightWait）：
    #   - 页面加载收口：与控制器初始化同一档（20s），这一段是冷启 + 产物解析执行，不能拿常数赌；
    #   - 加载完成之后给页面报高度的宽限：正常只需几十毫秒，报不出来是页面 bug，才落 360 的兜底。
    $navigationTimeoutMs = 20000
    $readyTimeoutMs = 2000
    # 兜底高度＝建窗初值：页面到点了还没给高度时，窗口就停在 360（可重试的失败，不写兜底 UI）。
    $fallbackHeight = 360

    $result = [pscustomobject]@{
        Action        = 'failed'
        Message       = ''
        ContentWidth  = 0
        ContentHeight = 0
        WindowBounds  = ''
        ShowInfo      = $null
        Error         = ''
    }

    $form = $null
    $ctrl = $null
    $messageHandler = $null
    $navHandler = $null
    $flashTimer = $null
    $flashTimerHandler = $null
    $script:cardQueue = [System.Collections.Generic.List[string]]::new()
    $script:cardFlags = [pscustomobject]@{ Closed = $false; NavDone = $false }

    # 消息泵：处理已到达的消息，返回这次新看到的终态消息（没有就返回空串）。
    $pump = {
        param($cardState, $queue)
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 10
        while ($queue.Count -gt 0) {
            $raw = $queue[0]
            $queue.RemoveAt(0)
            $message = ConvertFrom-CardMessage -Json $raw
            if ($message.Type -eq 'ready') {
                # 页面等布局稳定等到了预算上限、仍按最后一次报了高度（D-46）：只写一行取证，
                # 不改接管流程（高度已按正常路径用上）、也不回消息。这是「量早」那条窗口的观测线。
                try {
                    if ($raw -match '"unstable"') {
                        $document = ConvertFrom-Json -InputObject $raw
                        $unstable = $document.unstable
                        if ($null -ne $unstable) {
                            Write-CardFlashLog -Fields ([ordered]@{
                                    kind        = 'measure-unstable'
                                    firstHeight = [int]$unstable.first
                                    lastHeight  = [int]$unstable.last
                                    reason      = [string]$unstable.reason
                                    frames      = [int]$unstable.frames
                                    fontsReady  = [bool]$unstable.fontsReady
                                    area        = ('{0},{1} {2}x{3}' -f $screenArea.Left, $screenArea.Top, $screenArea.Width, $screenArea.Height)
                                    scale       = $scale
                                    hwnd        = ('0x{0:X}' -f $form.Handle.ToInt64())
                                })
                        }
                    }
                } catch { }
            }
            if ($message.Type -eq 'ready' -or $message.Type -eq 'resize') {
                if ($message.Height -gt 0) { $cardState.Height = $message.Height }
            } elseif ($message.Type -eq 'copy') {
                # 复制只能由宿主做：卡片是 NavigateToString 出来的，origin 是 about:blank，
                # 不是 secure context，页面里 navigator.clipboard 是 undefined（D-34）。
                # 本函数跑在 STA 线程上，Set-Clipboard 可用；成不成都必须回执，页面按回执显示对勾/红叉。
                $copied = $false
                try {
                    Set-Clipboard -Value ([string]$message.Text)
                    $copied = $true
                } catch {
                    $copied = $false
                }
                Send-CardPageMessage -Ctrl $ctrl -Message @{ type = 'copied'; ok = $copied }
            } elseif ($message.Type -eq 'drag') {
                # 标题被按下（页面发 drag）：**按下即进入系统移动循环**——ReleaseCapture 放掉页面对鼠标的
                # 捕获，再发 WM_NCLBUTTONDOWN(0xA1) + HTCAPTION(2)，等价于「按住系统标题栏拖」。
                # 移动循环由 Windows 自己跑（SendMessage 会一直阻塞到拖动结束，这段时间泵不转，属正常）；
                # **不改窗口过程、不做 hit-test、不做改大小**（用户 2026-11-10：「只做拖动」）。
                # $form 是 Show-CardWindow 的局部变量，这个脚本块也在该函数里执行（同上面 copy 分支用 $ctrl），
                # 动态作用域下可见；取句柄的方式与文件里既有写法一致。
                [void][DshUiCard.Native]::ReleaseCapture()
                [void][DshUiCard.Native]::SendMessage($form.Handle, 0xA1, [System.IntPtr]::new(2), [System.IntPtr]::Zero)
            } elseif ($message.Type -in @('decision', 'cancel', 'expired')) {
                if ($cardState.Terminal -eq '') { $cardState.Terminal = $raw }
            }
        }
    }

    try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $scale = Get-DpiScale
        # 屏幕只解析一次：限高与落位必须用同一块屏（B-24），否则一张卡可能按主屏限高、又按副屏落位。
        # 解析点在建窗之前：窗口一旦创建，前台窗口就可能变成我们自己。
        $screenArea = Get-CardScreenArea
        # 调用方已经解析过就沿用它的那一块（render.ps1 / demo.ps1 会把自己算的那块传进来）：
        # 限高、落位、日志里的 area 必须是同一个对象，否则「钳高用的屏」和「落位用的屏」又能分家。
        if ($null -ne $Area) { $screenArea = $Area }
        if ($null -eq $screenArea -or [int]$screenArea.Height -le 0 -or [int]$screenArea.Width -le 0) {
            throw "解析不出屏幕可用区（Get-CardScreenArea 与调用方都没给）：Left/Top/Width/Height 全零不建窗，见 D-46"
        }
        $MaxHeight = Get-CardMaxHeight -Requested $MaxHeight -WorkAreaHeight $screenArea.Height -Scale $scale
        $logicalWidth = [Math]::Max(320, $Width)
        $environment = Initialize-CardWebView2 -DataDir $DataDir

        # 建窗时就把 WS_EX_TOPMOST 交出去（New-CardForm，D-41）：事后 SetWindowPos 抬不动 Z 序。
        $form = New-CardForm
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $form.BackColor = [System.Drawing.Color]::White
        if (-not [string]::IsNullOrWhiteSpace($WindowBackground)) {
            try { $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml($WindowBackground) } catch { }
        }
        $form.ShowInTaskbar = $true
        $form.Text = $WindowTitle
        # 任务栏 / alt-tab 的图标（B-25）：透明底 + 橙色线条；缺文件就用默认图标，不拦弹窗。
        $icon = Get-CardWindowIcon
        if ($null -ne $icon) { $form.Icon = $icon }
        # 隐藏地按「目标宽度 × 初值高度」建窗：宽度必须一开始就对，页面才能按真实折行量高。
        $form.ClientSize = New-Object System.Drawing.Size(
            [int][Math]::Round($logicalWidth * $scale),
            [int][Math]::Round($fallbackHeight * $scale))
        $form.Left = -32000
        $form.Top = -32000
        $null = $form.Handle

        $ctrl = New-Object Microsoft.Web.WebView2.WinForms.WebView2
        $ctrl.Dock = [System.Windows.Forms.DockStyle]::Fill
        $form.Controls.Add($ctrl)

        $form.add_FormClosed({ param($s, $e) $script:cardFlags.Closed = $true })

        $initTask = $ctrl.EnsureCoreWebView2Async($environment)
        $initDeadline = [DateTime]::Now.AddSeconds(20)
        while (-not $initTask.IsCompleted -and [DateTime]::Now -lt $initDeadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 5
        }
        # 受限令牌下这一步必然失败（0x8000FFFF）；超时也要收口，返回 failed 而不是挂住。
        if (-not $initTask.IsCompleted) { throw 'WebView2 控制器初始化超时（20s）' }
        if ($initTask.IsFaulted) { throw $initTask.Exception.GetBaseException().Message }

        $settings = $ctrl.CoreWebView2.Settings
        $settings.AreDevToolsEnabled = $false
        $settings.AreDefaultContextMenusEnabled = $false
        $settings.IsStatusBarEnabled = $false
        $settings.IsZoomControlEnabled = $false
        # 快捷键全关：这张卡按既定约定「只用鼠标 + Esc」，不给 F5/F12/Ctrl+W 留口子。
        $settings.AreBrowserAcceleratorKeysEnabled = $false
        $settings.IsSwipeNavigationEnabled = $false
        $settings.IsBuiltInErrorPageEnabled = $false

        $messageHandler = [System.EventHandler[Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs]] {
            param($s, $e)
            $script:cardQueue.Add($e.WebMessageAsJson)
        }
        $ctrl.CoreWebView2.add_WebMessageReceived($messageHandler)

        $navHandler = [System.EventHandler[Microsoft.Web.WebView2.Core.CoreWebView2NavigationCompletedEventArgs]] {
            param($s, $e)
            $script:cardFlags.NavDone = $true
        }
        $ctrl.add_NavigationCompleted($navHandler)

        # NavigateToString：卡片不联网、不带外部资源，省掉临时文件与虚拟主机映射。
        $readyWatch = [System.Diagnostics.Stopwatch]::StartNew()
        $ctrl.CoreWebView2.NavigateToString($Html)

        # ---- 阶段 1：等 ready（页面 measure 完成）----
        # 两个时钟量两件事（D-45）：先等页面自己加载完（NavDone），加载完才起算报高度的窗口。
        # 这样「页面慢」只会让卡片晚一点出来，不会再变成「高度写死 360、灰框与按钮之间一条白」。
        $cardState = [pscustomobject]@{ Height = 0; Terminal = '' }
        $navigationDeadline = [DateTime]::Now.AddMilliseconds($navigationTimeoutMs)
        $readyDeadline = [DateTime]::MaxValue
        $navSeen = $false
        $wait = 'wait'
        while ($cardState.Terminal -eq '' -and -not $script:cardFlags.Closed -and -not $form.IsDisposed) {
            & $pump $cardState $script:cardQueue
            if (-not $navSeen -and $script:cardFlags.NavDone) {
                $navSeen = $true
                $readyDeadline = [DateTime]::Now.AddMilliseconds($readyTimeoutMs)
            }
            $wait = Test-CardHeightWait -Height ([int]$cardState.Height) -NavDone $navSeen `
                -NavigationDeadline $navigationDeadline -ReadyDeadline $readyDeadline -Now ([DateTime]::Now)
            if ($wait -ne 'wait') { break }
        }
        $readyTimedOut = ($wait -eq 'timeout')
        if ($readyTimedOut) {
            # 走了写死的 360。真机上「到底卡在导航还是卡在量高」只能靠这一行取证（D-45 的复验步骤）；
            # 埋点**不许**把卡片弄坏，所以整段吞异常。
            try {
                Write-CardFlashLog -Fields ([ordered]@{
                        kind      = 'height-fallback'
                        hwnd      = ('0x{0:X}' -f $form.Handle.ToInt64())
                        navSeen   = $navSeen
                        segment   = $(if ($navSeen) { 'ready' } else { 'navigation' })
                        elapsedMs = $readyWatch.ElapsedMilliseconds
                    })
            } catch { }
        }
        # 钳高：下限 160（卡片贴内容，不再撑出空白）、上限是屏高 62% 与 760；ready 超时才用 360 的初值。
        $logicalHeight = if ($readyTimedOut) {
            $fallbackHeight
        } else {
            [Math]::Min($MaxHeight, [Math]::Max(160, [int]$cardState.Height))
        }
        # 「页面报了 291，窗口却是 271」只有两种可能：页面报小了，或这里被 `$MaxHeight` 钳了（D-46）。
        # 两者的处置完全相反，所以落到上限时必须留一行取证：页面报多少、上限多少、最后用多少、按哪块屏算的。
        # 只在真的钳了才写（正常卡片一行都不写，别把日志刷满）。
        if (-not $readyTimedOut -and $logicalHeight -lt [Math]::Max(160, [int]$cardState.Height)) {
            try {
                Write-CardFlashLog -Fields ([ordered]@{
                        kind         = 'height-clamp'
                        pageHeight   = [int]$cardState.Height
                        maxHeight    = [int]$MaxHeight
                        adoptedHeight = [int]$logicalHeight
                        area         = ('{0},{1} {2}x{3}' -f $screenArea.Left, $screenArea.Top, $screenArea.Width, $screenArea.Height)
                        scale        = $scale
                        hwnd         = ('0x{0:X}' -f $form.Handle.ToInt64())
                    })
            } catch { }
        }
        $result.ContentWidth = $logicalWidth
        $result.ContentHeight = $logicalHeight

        if ($cardState.Terminal -eq '' -and -not $script:cardFlags.Closed) {
            # ---- 阶段 2：定尺寸、落位、SetWindowPos，然后才 ShowWindow ----
            $clientWidth = [int][Math]::Round($logicalWidth * $scale)
            $clientHeight = [int][Math]::Round($logicalHeight * $scale)
            $form.ClientSize = New-Object System.Drawing.Size($clientWidth, $clientHeight)

            # Region 半径只有一个来源：本函数的 -CornerRadius（页面按同一个值画卡片）。
            $regionRadius = [int][Math]::Round($CornerRadius * $scale)
            if ($regionRadius -gt 0) {
                # Region 是无抗锯齿的布尔裁剪（Win10 没有 DWM 圆角接口），半径不合适就当没有。
                $region = New-CardRegion -Width $clientWidth -Height $clientHeight -Radius $regionRadius
                if ($null -ne $region) { $form.Region = $region }
            }

            $placement = Get-CardPlacement -Width $clientWidth -Height $clientHeight -Position $Position `
                -Scale $scale -SlotIndex $SlotIndex -SlotCount $SlotCount -Area $screenArea
            $form.Left = [int]$placement.Left
            $form.Top = [int]$placement.Top

            Initialize-CardNative
            # SWP_NOZORDER | SWP_NOACTIVATE：先就位，显示交给 Invoke-CardForceShow（它有 SW_HIDE 的修法）。
            [void][DshUiCard.Native]::SetWindowPos($form.Handle, [System.IntPtr]::Zero,
                $form.Left, $form.Top, $clientWidth, $clientHeight, 0x0014)
            $showWatch = [System.Diagnostics.Stopwatch]::StartNew()
            $showInfo = Invoke-CardForceShow -Handle $form.Handle -Activate:$Activate.IsPresent
            $result.ShowInfo = $showInfo
            # 显示之后再闪任务栏几秒：置顶保证「这次真的在最上面」，闪烁负责把视线叫过来；
            # 两者都不抢焦点。ShowInTaskbar 这些现场值随日志一起留，供真机取证。
            $flashSession = Invoke-TaskbarFlash -Handle $form.Handle -Note ([ordered]@{
                    card           = $WindowTitle
                    position       = $Position
                    activate       = [bool]$Activate.IsPresent
                    showInTaskbar  = [bool]$form.ShowInTaskbar
                    showWindow     = [bool]$showInfo.showWindow
                    visibleBefore  = [bool]$showInfo.visibleBefore
                    visibleAfter   = [bool]$showInfo.visibleAfter
                    shownToFlashMs = $showWatch.ElapsedMilliseconds
                })

            # 闪了几秒要**自己停**：窗口不在前台时，任务栏的「请求注意」会一直闪到该窗口被激活为止，
            # uCount / dwTimeout 压不住它（D-28 真机结论「一直闪不停，直到卡片关掉」）。所以在
            # uCount × dwTimeout（≈2.5 秒）之后显式发一次 FLASHW_STOP。
            # 用 WinForms Timer：本函数的事件循环是 DoEvents 泵（没有 Application.Run），Timer 正好靠
            # 这条泵准点跑；Start-Sleep 会卡住宿主线程，另起进程则没有意义。
            if ($null -ne $flashSession -and $flashSession.StopAfterMs -gt 0) {
                $flashHandle = $form.Handle
                $flashWatch = $flashSession.Watch
                $flashTimer = New-Object System.Windows.Forms.Timer
                $flashTimer.Interval = [int]$flashSession.StopAfterMs
                $flashTimerHandler = [System.EventHandler] {
                    param($sender, $e)
                    try { $sender.Stop(); $sender.Dispose() } catch { }
                    Stop-TaskbarFlash -Handle $flashHandle -ElapsedMs $flashWatch.ElapsedMilliseconds
                }
                $flashTimer.add_Tick($flashTimerHandler)
                $flashTimer.Start()
            }

            # ---- 让位（D-43）：弹出即置顶，用户第一次按在卡片外面就把自己降回普通层 ----
            # 事件驱动：低层鼠标钩子（WH_MOUSE_LL），没有定时器、没有轮询、不看前台窗口
            # （卡片从不获得前台，那条路实测永远不触发）。装不上也不影响卡片：继续置顶、不抛异常。
            Start-CardTopMostYield -Handle $form.Handle

            # ---- 阶段 3：窗口已可见 → 告诉页面切 fill；计时与滚动都从这一刻开始 ----
            Send-CardPageMessage -Ctrl $ctrl -Message @{ type = 'shown' }
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 150
            [System.Windows.Forms.Application]::DoEvents()

            # 回调的输出必须接住丢掉：不接的话它会混进本函数的返回值，$window 变成 Object[]，
            # 调用方的 [int]$window.ContentWidth 就会收到 @($null, 680) 这种数组并抛 Int32 转换错
            # （2026-11-02 真机点按钮后 card-failed 的根因，见 DECISIONS D-04）。
            if ($null -ne $OnShown) {
                try { $null = & $OnShown $showInfo $form $ctrl } catch { }
            }
            # OnShown 可能挪过窗口（调试脚本按指定屏居中），所以位置要等它跑完再记。
            $result.WindowBounds = "$($form.Left),$($form.Top) $($form.Width)x$($form.Height)"
            if ($null -ne $OnRendered) {
                try { $null = & $OnRendered $form $ctrl } catch { }
            }
            [System.Windows.Forms.Application]::DoEvents()
        }

        # ---- 阶段 4：等终态消息（decision / cancel / expired） ----
        $deadline = if ($TimeoutMs -gt 0) { [DateTime]::Now.AddMilliseconds($TimeoutMs) } else { [DateTime]::MaxValue }
        while ($cardState.Terminal -eq '' -and -not $script:cardFlags.Closed -and -not $form.IsDisposed -and
            [DateTime]::Now -lt $deadline) {
            & $pump $cardState $script:cardQueue
        }
        # 收尾时把已经到达但还没读的消息读完（页面可能在最后一刻发出来）。
        & $pump $cardState $script:cardQueue

        if ($cardState.Terminal -ne '') {
            $result.Message = $cardState.Terminal
            $result.Action = 'message'
        } elseif ([DateTime]::Now -ge $deadline) {
            $result.Action = 'timeout'
        } else {
            $result.Action = 'closed'
        }
        return $result
    } catch {
        $result.Action = 'failed'
        $result.Error = $_.Exception.Message
        return $result
    } finally {
        # 让位钩子先收（幂等：没装就什么都不做）：钩子是进程级的，卡片销毁后不该继续被回调。
        try { Stop-CardTopMostYield } catch { }
        # 定时器先收：窗口都关掉了，再补一次 stop 没有意义（还会让日志多一行 isWindow=false）。
        try { if ($flashTimer) { $flashTimer.remove_Tick($flashTimerHandler); $flashTimer.Stop(); $flashTimer.Dispose() } } catch { }
        try { if ($ctrl -and $ctrl.CoreWebView2 -and $messageHandler) { $ctrl.CoreWebView2.remove_WebMessageReceived($messageHandler) } } catch { }
        try { if ($ctrl -and $navHandler) { $ctrl.remove_NavigationCompleted($navHandler) } } catch { }
        try { if ($form -and $ctrl) { $form.Controls.Remove($ctrl) } } catch { }
        try { if ($ctrl) { $ctrl.Dispose() } } catch { }
        try { if ($form) { $form.Close(); $form.Dispose() } } catch { }
        $script:cardQueue = [System.Collections.Generic.List[string]]::new()
        [System.Windows.Forms.Application]::DoEvents()
    }
}
