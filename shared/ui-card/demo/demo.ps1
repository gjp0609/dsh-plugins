# 最小演示宿主：喂一份 JSON 载荷就出一张卡（shared/ui-card/demo/demo.ps1）
#
# 这是「业务层将来怎么写」的示例，不是调试工具：它只做三件事——
#   载荷 JSON → New-CardPayload → New-CardDocument → Show-CardWindow。
# 正式调用方照这个形状写自己的两个函数（造载荷 + 解释回传消息），外壳不认识业务。
#
# 被 dot-source 时只定义函数、不执行任何动作（debug/render.ps1 复用这里的载荷解码）。
# 注意：dot-source 时本文件的 param 块会在**当前作用域**声明 Payload / Width / MaxHeight /
# TimeoutMs / DataDir，调用方的同名变量会被覆盖成默认值——先把要用的值抄成别的名字再 dot-source。
#
# 跑法：
#   pwsh -NoProfile -STA -File shared\ui-card\demo\demo.ps1 -Payload tests\fixtures\approval.json
#
# 载荷结构就是页面认识的那份（见 app/src/types.ts），额外三个只是窗口参数：
#   { "width": 680, "maxHeight": 0, "position": "corner",
#     "eyebrow": "抬头小字", "titleHtml": "<span class=\"card__title-path\">…</span>",
#     "status": "页脚那行字", "armMs": 1000, "closeMs": 0, "keyboard": "default",
#     "body": [ { "kind": "note", "text": "一段正文", "muted": true },
#               { "kind": "code", "command": "ls -la", "lang": "sh" } ],
#     "rows": [ { "label": "第一行", "why": "为什么要它", "text": "ls", "meta": "工作目录 /root", "warn": "覆盖" } ],
#     "buttons": [ { "label": "取消", "action": "dismiss" },
#                  { "label": "确定", "action": "apply", "kind": "primary",
#                    "requiresChecked": true, "labelCount": "确定 {n} 项" } ] }

param(
    [string]$Payload = '',
    [int]$Width = 0,
    [int]$MaxHeight = 0,
    [int]$TimeoutMs = 0,
    [string]$DataDir = '',
    [int]$CornerRadius = 0
)

Set-StrictMode -Version Latest

$script:CardHome = Split-Path -Parent $PSScriptRoot
. (Join-Path $script:CardHome 'card-html.ps1')
. (Join-Path $script:CardHome 'webview2.ps1')

function ConvertFrom-CardDemoPayload {
    <#
    .SYNOPSIS
        读一份 JSON 载荷；读不出来就抛（演示宿主宁可报错，也不要弹一张空卡）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { throw "载荷文件不存在：$Path" }
    $raw = Get-Content -Raw -LiteralPath $Path -Encoding utf8
    try {
        return ($raw | ConvertFrom-Json)
    } catch {
        throw "载荷不是合法 JSON（$Path）：$($_.Exception.Message)"
    }
}

function New-CardDemoPayload {
    <#
    .SYNOPSIS
        JSON 载荷 → 页面认识的标准载荷（只挑载荷字段，窗口参数留在这里）。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Data)

    New-CardPayload -Eyebrow ([string](Get-CardItemValue $Data 'eyebrow' '')) `
        -TitleHtml ([string](Get-CardItemValue $Data 'titleHtml' '')) `
        -Status ([string](Get-CardItemValue $Data 'status' '')) `
        -Body @(Get-CardItemValue $Data 'body' @()) `
        -Rows @(Get-CardItemValue $Data 'rows' @()) `
        -Buttons @(Get-CardItemValue $Data 'buttons' @()) `
        -ArmMs ([int](Get-CardItemValue $Data 'armMs' 0)) `
        -CloseMs ([int](Get-CardItemValue $Data 'closeMs' 0)) `
        -Keyboard ([string](Get-CardItemValue $Data 'keyboard' 'default'))
}

function New-CardDemoDocument {
    <#
    .SYNOPSIS
        载荷 → 外壳文档（不建窗口）。圆角/宽度只是窗口参数，不进载荷。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Payload)

    New-CardDocument -Payload (New-CardDemoPayload -Data $Payload)
}

function ConvertFrom-CardDemoMessage {
    <#
    .SYNOPSIS
        窗口结果 → 演示宿主自己看得懂的结论（正式业务层照这个形状写）。
    .DESCRIPTION
        只认外壳的三种消息：decision（带 value 与 checked）、cancel、expired；
        其余（关窗、超时、认不出来）一律按「没作答」。
    #>
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$Action = '',
        [AllowNull()][string]$Message = ''
    )

    $outcome = [pscustomobject]@{ answered = $false; value = ''; checked = @(); type = $Action }
    if ($Action -ne 'message' -or [string]::IsNullOrWhiteSpace($Message)) {
        if ($Action -eq 'timeout') { $outcome.type = 'expired' }
        return $outcome
    }

    $parsed = $null
    try { $parsed = $Message | ConvertFrom-Json } catch { return $outcome }
    if ($null -eq $parsed) { return $outcome }

    $type = [string](Get-CardItemValue $parsed 'type' '')
    switch ($type) {
        'decision' {
            $outcome.answered = $true
            $outcome.type = 'decision'
            $outcome.value = [string](Get-CardItemValue $parsed 'value' '')
            $outcome.checked = @(Get-CardItemValue $parsed 'checked' @())
        }
        'cancel' { $outcome.type = 'cancel' }
        'expired' { $outcome.type = 'expired' }
        default { $outcome.type = 'unknown' }
    }
    $outcome
}

# ---------------------------------------------------------------------------
# 主流程：只有直接执行时才跑；被 dot-source 时上面那些函数就够了。
# ---------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    if ([string]::IsNullOrWhiteSpace($Payload)) {
        [Console]::Error.WriteLine('用法：demo.ps1 -Payload <json 文件> [-Width 680] [-MaxHeight 0] [-TimeoutMs 0] [-CornerRadius 0]')
        exit 2
    }

    $data = ConvertFrom-CardDemoPayload -Path $Payload
    # 屏只解析一次，限高与落位都按这一块（D-46）；解析不出来直接报错，不拿猜的矩形建窗。
    $screenArea = Get-CardScreenArea
    if ($null -eq $screenArea) { [Console]::Error.WriteLine('解析不出屏幕可用区（Get-CardScreenArea 返回空）'); exit 1 }
    $maxHeight = Get-CardMaxHeight -Requested $MaxHeight -WorkAreaHeight $screenArea.Height -Scale (Get-DpiScale)
    $windowWidth = if ($Width -gt 0) { $Width } else { [int](Get-CardItemValue $data 'width' 680) }
    if ($windowWidth -le 0) { $windowWidth = 680 }
    $radius = if ($CornerRadius -gt 0) { $CornerRadius } else { [int](Get-CardItemValue $data 'cornerRadius' 0) }
    $document = New-CardDemoDocument -Payload $data

    $window = Show-CardWindow -Html $document -Width $windowWidth `
        -MaxHeight $maxHeight -Area $screenArea -TimeoutMs $TimeoutMs -DataDir $DataDir -CornerRadius $radius `
        -Position $(if ([string](Get-CardItemValue $data 'position' 'corner') -eq 'center') { 'center' } else { 'corner' }) `
        -WindowTitle 'DSH 卡片演示'

    if ([string]$window.Action -eq 'failed') {
        [Console]::Error.WriteLine('卡片起不来：' + [string]$window.Error)
        exit 1
    }

    $outcome = ConvertFrom-CardDemoMessage -Action ([string]$window.Action) -Message ([string]$window.Message)
    [pscustomobject]@{
        action        = [string]$window.Action
        type          = [string]$outcome.type
        value         = [string]$outcome.value
        checked       = @($outcome.checked)
        contentWidth  = [int]$window.ContentWidth
        contentHeight = [int]$window.ContentHeight
        windowBounds  = [string]$window.WindowBounds
    } | ConvertTo-Json -Depth 4
}
