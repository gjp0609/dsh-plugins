# 适配层：把「这次审批的数据」弹成一张共享外壳的卡，再把窗口结果翻译成调用方要的结果。
#
#   shared/ui-card/card-html.ps1   造结构（外壳，不在这里）
#   shared/ui-card/webview2.ps1    起窗口、收消息（外壳，不在这里）
#   shared.ps1                     载荷 ↔ 外壳输入、消息 ↔ 业务结果（业务差异都在那边）
#   本文件                         只负责「弹一次、把答案换成调用方要的形状」
#
# 不做：拼 HTML 细节、建窗口、读写 payload/结果文件（那是 prompt.ps1）。
# 只有纯函数才允许被自检直接调（tests\card-select.ps1），弹窗一律走 Invoke-CardApproval。
#
# 函数名一律带 Approval / Card 前缀：shared.ps1 会把外壳的 card-html.ps1、webview2.ps1
# dot-source 进**同一个**脚本作用域，同名函数会静默互相覆盖。

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'shared.ps1')

function New-ApprovalCardShotScript {
    <#
    .SYNOPSIS
        验收专用：窗口可见并量完之后抓一张 PNG，然后无条件关窗。
    .DESCRIPTION
        只有 `prompt.ps1 -RenderTo` 会传这个回调；正式审批路径不截图。
        外壳会吞掉 OnRendered 里的异常，所以这里自己兜住并**无条件**关窗，
        否则窗口会挂到超时（人不在电脑前时就是永远挂着）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    $target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $parent = Split-Path -Parent $target
    if ($parent -ne '' -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }

    {
        param($form, $ctrl)
        try {
            $stream = [System.IO.File]::Create($target)
            try {
                $task = $ctrl.CoreWebView2.CapturePreviewAsync(
                    [Microsoft.Web.WebView2.Core.CoreWebView2CapturePreviewImageFormat]::Png, $stream)
                $deadline = [DateTime]::Now.AddSeconds(10)
                while (-not $task.IsCompleted -and [DateTime]::Now -lt $deadline) {
                    [System.Windows.Forms.Application]::DoEvents()
                    Start-Sleep -Milliseconds 10
                }
            } finally {
                $stream.Dispose()
            }
        } catch {
            # 截不到图不影响关窗（验收失败会在测试里体现，不该由卡片来报错）。
        } finally {
            try { $form.Close() } catch { }
        }
    }.GetNewClosure()
}

function Invoke-CardApproval {
    <#
    .SYNOPSIS
        弹卡并等结果，返回 @{ kind; error; contentWidth; contentHeight; windowBounds }。
    .DESCRIPTION
        kind: allowed-once / rejected / closed / expired / shot；error 非空表示这张卡起不来，
        调用方（prompt.ps1）据此写 error 结果并 exit 1，宿主会把请求继续交给浏览器那张卡。
        关窗、到点、协议解析失败一律按「没决定」处理。
    .PARAMETER OnShown
        窗口显示之后的回调，签名 param($ShowInfo, $Form, $Ctrl)：提示音、任务栏闪烁、屏幕截图、
        自检记录。计时已由外壳在调用它之前启动，这里不需要再通知页面。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Data,
        [int]$SlotIndex = 0,
        [int]$SlotCount = 1,
        [int]$MaxHeight = 0,
        [string]$RenderTo = '',
        [string]$DataDir = '',
        [scriptblock]$OnShown = $null
    )

    $out = [pscustomobject]@{ kind = 'closed'; error = ''; contentWidth = 0; contentHeight = 0; windowBounds = '' }

    # 外壳缺失时连 Test-CardWebView2 都还没定义，所以先判外壳、再判运行时。
    try {
        Assert-ApprovalCardShell
    } catch {
        $out.error = $_.Exception.Message
        return $out
    }

    $probe = Test-CardWebView2
    if (-not $probe.Available) {
        $out.error = $probe.Reason
        return $out
    }

    # 限高只算一次：窗口尺寸与 ready 钳高都用同一个值。
    $MaxHeight = Get-CardMaxHeight -Requested $MaxHeight
    $payload = New-ApprovalCardPayload -Data $Data
    $document = New-CardDocument -Payload $payload

    # 验收出图：外壳没有「离屏渲染」模式，窗口会在右下角闪一下再关（要么提权，要么看不到）。
    $shotScript = $null
    if (-not [string]::IsNullOrWhiteSpace($RenderTo)) {
        $shotScript = New-ApprovalCardShotScript -Path $RenderTo
    }

    # 卡片自己会按 closeAfterMs 倒计时关窗；宿主这边再留一条更宽的兜底线，
    # 万一页面的定时器没跑起来也不至于永远挂着（到点按「没决定」处理，不替你答）。
    $timeoutMs = 0
    $closeAfterMs = [int](Get-CardItemValue $Data 'closeAfterMs' 0)
    if ($closeAfterMs -gt 0) { $timeoutMs = $closeAfterMs + 15000 }

    # 弹出即置顶、但不抢焦点（D-39，取代 D-27 的「不置顶」）：层级只由外壳
    # Invoke-CardForceShow 的那一次 SetWindowPos（HWND_TOPMOST + SWP_NOACTIVATE）决定——
    # 这里不传 -TopMost（外壳已没有这个开关），也不传 -Activate（SW_RESTORE 会抢前台）。
    # 只在输出里认「带 Action 的那个对象」，**不按位置取**：外壳的返回值可能混进别的输出
    # （2026-11-02 真机点按钮崩溃就是 OnShown 回调的返回值漏了进来），按位置取会把别的对象
    # 当成结果，[int]$window.ContentWidth 随即抛「Cannot convert System.Object[] to Int32」、
    # 决定丢掉（见 DECISIONS D-04）。找不到唯一结果就抛一条能读的错——宁可 card-failed 带原因，
    # 也不静默当成「没决定」（那等于把决定丢失伪装成用户没答）。
    $outputs = @(
        Show-CardWindow -Html $document -Width $script:ApprovalCardWidth -MaxHeight $MaxHeight `
            -TimeoutMs $timeoutMs -DataDir $DataDir -SlotIndex $SlotIndex -SlotCount $SlotCount `
            -CornerRadius $script:ApprovalCardCornerRadius `
            -WindowTitle ([string](Get-CardItemValue $Data 'windowTitle' 'DSH')) `
            -OnShown $OnShown -OnRendered $shotScript
    )
    $windows = @($outputs | Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['Action'] })
    if ($windows.Count -ne 1) {
        throw ("外壳没有返回唯一的窗口结果对象（输出 $($outputs.Count) 个，带 Action 的 $($windows.Count) 个）")
    }
    $window = $windows[0]

    if ([string]$window.Action -eq 'failed') {
        $out.error = [string]$window.Error
        return $out
    }

    $out.contentWidth = [int]$window.ContentWidth
    $out.contentHeight = [int]$window.ContentHeight
    $out.windowBounds = [string]$window.WindowBounds

    # 验收出图：窗口已被回调关掉，这里只报「截过了」，不算作答。
    if ($null -ne $shotScript) {
        $out.kind = 'shot'
        return $out
    }

    $out.kind = ConvertTo-ApprovalDecision -Action ([string]$window.Action) -Message ([string]$window.Message)
    $out
}
