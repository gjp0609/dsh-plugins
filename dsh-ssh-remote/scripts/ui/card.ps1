# 适配层：把 SSH 的「行数据」变成一张共享外壳的卡，再把窗口结果翻译成调用方要的答案。
#
#   shared/ui-card/card-html.ps1   造结构（外壳，不在这里）
#   shared/ui-card/webview2.ps1    起窗口、收消息（外壳，不在这里）
#   shared.ps1                     载荷 ↔ 外壳输入、消息 ↔ 业务结果（业务差异都在那边）
#   本文件                         只负责「弹一次、把答案换成调用方要的形状」
#
# 不做：拼 HTML 细节、建窗口、读写临时文件（那是 dialog.ps1）。

Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot 'shared.ps1')

function New-SshCardShotScript {
    <#
    .SYNOPSIS
        验收专用：窗口可见并量完之后抓一张 PNG，然后无条件关窗。
    .DESCRIPTION
        只有 `dialog.ps1 -RenderTo` 会传这个回调；正式审批路径不截图。
        外壳会吞掉 OnRendered 里的异常，所以这里自己兜住并**无条件**关窗，
        否则窗口会挂到超时（人不在电脑前时就是永远挂着）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

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

function Invoke-SshCardSelect {
    <#
    .SYNOPSIS
        弹共享外壳的卡片并等结果，返回 `@{ answered; selected; action; shot }`
        （selected 是勾选行的标签）。
    .DESCRIPTION
    关窗、到点、协议解析失败一律按「一行都不选」，与网页卡片里空选择同义。
    抛异常表示这张卡根本弹不出来（外壳缺失 / 缺 DLL / 没运行时 / 起窗口失败）；
    调用方必须写 stderr 并非零退出——不再有第二条渲染路径可以退。
    #>
    [CmdletBinding()]
    param(
        [object[]]$Rows = @(),
        [string[]]$Options = @(),
        [AllowEmptyString()][string]$Detail = '',
        [string]$Eyebrow = 'SSH · 执行确认',
        [string]$ProjectDir = '',
        [string]$CancelLabel = '跳过',
        [int]$Width = 680,
        [int]$MaxHeight = 0,
        [string]$ShotPath = ''
    )

    Assert-SshCardShell

    # 限高只算一次：窗口尺寸与 ready 钳高都用同一个值。
    $MaxHeight = Get-CardMaxHeight -Requested $MaxHeight
    $labels = @(Get-SshRowLabels -Rows $Rows -Options $Options)

    $payload = New-SshCardPayload -Rows $Rows -Options $Options -Detail $Detail `
        -Eyebrow $Eyebrow -ProjectDir $ProjectDir -CancelLabel $CancelLabel
    $document = New-CardDocument -Payload $payload

    $shotScript = $null
    if (-not [string]::IsNullOrWhiteSpace($ShotPath)) { $shotScript = New-SshCardShotScript -Path $ShotPath }

    # SSH 的卡片一律不自动关闭（没有自超时）：不传 -TimeoutMs 就是 0 = 一直等，只能人工关。
    # 也不传 -Activate：置顶已经解决可见性，再 SW_RESTORE 就是抢前台、打断用户（D-39）。
    $window = Show-CardWindow -Html $document -Width $Width -MaxHeight $MaxHeight `
        -CornerRadius $script:SshCardCornerRadius -WindowTitle 'dsh-ssh-remote' `
        -OnRendered $shotScript

    if ([string]$window.Action -eq 'failed') {
        $reason = [string]$window.Error
        if ([string]::IsNullOrWhiteSpace($reason)) { $reason = '外壳返回 failed，但没给原因' }
        throw $reason
    }

    # 验收出图：窗口已被回调关掉，这里只报「截过了」。
    if ($null -ne $shotScript) {
        return [pscustomobject]@{
            answered      = $false
            selected      = @()
            action        = 'shot'
            shot          = $true
            contentWidth  = [int]$window.ContentWidth
            contentHeight = [int]$window.ContentHeight
        }
    }

    $decision = ConvertTo-SshDecision -Action ([string]$window.Action) -Message ([string]$window.Message) -Labels $labels

    # shot 一律给出来：调用方在 Set-StrictMode 下读不到属性会抛异常，
    # 而那个异常会被当成「卡弹不出来」→ 调用方报错，用户已经批过一次的那张卡就白批了。
    [pscustomobject]@{
        answered = [bool]$decision.answered
        selected = @($decision.selected)
        action   = [string]$decision.action
        shot     = $false
    }
}
