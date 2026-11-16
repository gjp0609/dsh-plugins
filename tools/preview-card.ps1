# 真机自测入口：起一张真的卡片窗口，交给用户自己点（tools/preview-card.ps1）
#
# 为什么有它：截图看不出细节（用户 2026-10-30 定的偏好 B-42：「我还没验收呢」「交互没测试呢」
# 「后续样式/颜色/交互这些尽量我自己测」「你截图其实细节看不出来」）。所以验收靠这张卡：
# 不截图、不写 PNG、不跑探针、不注入点击——窗口起来，用户自己点、自己看；关掉之后
# 控制台打印「验收清单」和「剪贴板核对」，复制到底成没成由用户对着剪贴板判断。
#
# 跑法（不是 STA 会自己用 & pwsh @args 重拉，不闪新窗口）：
#   pwsh -NoProfile -File tools\preview-card.ps1
#   pwsh -NoProfile -File tools\preview-card.ps1 -PayloadFile <载荷.json> -Width 680 -KeepSeconds 900
#
# 载荷默认用内置样本 shared\ui-card\debug\samples\review.json（入库），一段里覆盖
# 长 shell（折叠/滚动/露一行）、PowerShell（类型/变量/操作符/关键字加粗）、
# shell（for 数字、双引号变量、管道、重定向）和一条行内命令（行内框那套按钮）。
#
# 被 dot-source 时只定义函数、不动作（同 demo.ps1 的写法），方便单独验报告那一段。

param(
    [string]$PayloadFile = '',
    [int]$Width = 680,
    [int]$KeepSeconds = 900
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:PreviewCardHome = Join-Path (Split-Path -Parent $PSScriptRoot) 'shared\ui-card'

function ConvertTo-ComparableText {
    <#
    .SYNOPSIS
        比较用的规范化：换行统一成 \n、去掉首尾空白。
    .DESCRIPTION
        Windows 剪贴板里存的是 CRLF，命令原文是 \n；不归一化会把「行尾差一个字符」误判成没复制对。
    #>
    [CmdletBinding()]
    param([AllowNull()][AllowEmptyString()][string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return (($Text -replace "`r`n", "`n") -replace "`r", "`n").Trim()
}

function Get-CardPreviewCopyTarget {
    <#
    .SYNOPSIS
        卡片里所有「命令本体」：正文代码块 + 行内命令框（行内框复制 text，不含 why 说明行）。
    .DESCRIPTION
        复制按钮去掉的是「说明行 + 首尾空行」（B-32），说明是独立字段，命令字段本身就是命令本体。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Data)

    $targets = [System.Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($block in @(Get-CardItemValue $Data 'body' @())) {
        if ([string](Get-CardItemValue $block 'kind' '') -ne 'code') { continue }
        $index++
        $targets.Add([pscustomobject]@{
                Label   = "正文第 $index 段"
                Command = [string](Get-CardItemValue $block 'command' '')
                Comment = [string](Get-CardItemValue $block 'comment' '')
            })
    }
    foreach ($row in @(Get-CardItemValue $Data 'rows' @())) {
        $text = [string](Get-CardItemValue $row 'text' '')
        if ($text -eq '') { continue }
        $targets.Add([pscustomobject]@{
                Label   = ('行内 ' + [string](Get-CardItemValue $row 'label' ''))
                Command = $text
                Comment = [string](Get-CardItemValue $row 'why' '')
            })
    }
    $targets
}

function Show-CardReviewReport {
    <#
    .SYNOPSIS
        关窗之后打印两段给用户看：验收清单 + 剪贴板核对。纯输出，不改任何东西。
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Data)

    Write-Output ''
    Write-Output '卡片窗口已关闭。下面两段是给验收用的：'
    Write-Output ''
    Write-Output '一、验收清单（自己点一遍，逐条对照）'
    Write-Output '  1. 右上角没有计数：代码框右上角平时什么都不显示，鼠标移进去才出现两个图标按钮，没有「6/9」这类行数。'
    Write-Output '  2. 按钮位置不动：折叠态与展开态，按钮都贴在代码框右上角，距上沿 6px、距右沿 6px，不会左右平移。'
    Write-Output '  3. 折叠能滚 + 露一行：滚轮在框内能上下滚到底；框底剪在第 7 行中间，能看到第 7 行露出一小截。'
    Write-Output '  4. 复制：点复制图标短暂变对勾（失败变红色叉，800ms 没回执也按失败）；剪贴板 = 命令本体，不含框内第一行说明（注释色、无 `#`）。'
    Write-Output '  5. 展开：点展开后不折行，左右和上下都能滚；卡片高度不变（不会把窗口顶高）。'
    Write-Output '  6. 按钮淡出：鼠标移出代码框后，右上角两个按钮约 120ms 淡出，淡出时点不到。'
    Write-Output ''
    Write-Output '二、剪贴板核对（对照上一步：你点过复制之后才准）'

    $clipboard = ''
    try {
        $clipboard = [string](Get-Clipboard -Raw)
    } catch {
        $clipboard = ''
    }

    $clipText = ConvertTo-ComparableText -Text $clipboard
    $display = $clipText -replace "`n", ' ⏎ '
    if ($display.Length -gt 200) { $display = $display.Substring(0, 200) + '…' }
    if ($display -eq '') { $display = '（空）' }
    Write-Output "  剪贴板内容（前 200 字）：$display"

    $targets = @(Get-CardPreviewCopyTarget -Data $Data)
    $matched = $null
    foreach ($item in $targets) {
        if ($clipText -ne '' -and $clipText -eq (ConvertTo-ComparableText -Text $item.Command)) { $matched = $item; break }
    }

    if ($null -ne $matched) {
        Write-Output "  判定：与「$($matched.Label)」命令原文一致（大小写、空格、换行都相同）。"
    } elseif ($clipText -eq '') {
        Write-Output '  判定：剪贴板是空的——没点复制，或复制失败（看图标有没有变红叉）。'
    } else {
        Write-Output '  判定：与卡片里任何一段命令都不一致——没点复制、复制失败，或中间又被别的复制覆盖了。'
    }

    $leaked = $false
    foreach ($item in $targets) {
        if ($item.Comment -ne '' -and $clipText.Contains((ConvertTo-ComparableText -Text $item.Comment))) { $leaked = $true }
    }
    Write-Output ("  说明行是否混进剪贴板：" + $(if ($leaked) { '是（不对，复制只该有命令本体）' } else { '否' }))
    Write-Output ''
}

# ---------------------------------------------------------------------------
# 主流程：只有直接执行时才跑；被 dot-source 时上面那些函数就够了。
# ---------------------------------------------------------------------------
if ($MyInvocation.InvocationName -ne '.') {
    # demo.ps1 的 param 块会覆盖当前作用域的 Width / Payload / MaxHeight / TimeoutMs / DataDir，
    # 所以先把命令行参数抄成 preview* 变量，之后只用它们（同 render.ps1 的做法）。
    $previewPayloadFile = $PayloadFile
    $previewWidth = $Width
    $previewKeepSeconds = $KeepSeconds

    # WebView2 的卡片窗口需要 STA。不是就以 STA 重新拉起自己，并把子进程的输出原样转发。
    # 用 `& pwsh @args`（同一控制台），不用 Start-Process——那会闪一个 Windows Terminal 窗口。
    if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
        $argList = @('-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
        if ($previewPayloadFile -ne '') { $argList += @('-PayloadFile', $previewPayloadFile) }
        $argList += @('-Width', [string]$previewWidth, '-KeepSeconds', [string]$previewKeepSeconds)
        & pwsh @argList
        exit $LASTEXITCODE
    }

    if ($previewWidth -le 0) { $previewWidth = 680 }
    if ($previewKeepSeconds -le 0) { $previewKeepSeconds = 900 }

    # 仓库根从脚本位置推出来（tools\ 的上一级），不写死绝对路径。
    if (-not (Test-Path -LiteralPath (Join-Path $script:PreviewCardHome 'webview2.ps1'))) {
        [Console]::Error.WriteLine("找不到卡片外壳：$($script:PreviewCardHome)")
        exit 1
    }

    if ([string]::IsNullOrWhiteSpace($previewPayloadFile)) {
        $previewPayloadFile = Join-Path $script:PreviewCardHome 'debug\samples\review.json'
    }
    if (-not (Test-Path -LiteralPath $previewPayloadFile)) {
        [Console]::Error.WriteLine("载荷文件不存在：$previewPayloadFile")
        exit 2
    }

    $script:CardHome = $script:PreviewCardHome
    . (Join-Path $script:CardHome 'card-html.ps1')
    . (Join-Path $script:CardHome 'webview2.ps1')
    # demo.ps1 被 dot-source 时只定义函数、不执行主流程；这里复用它的载荷解码。
    . (Join-Path $script:CardHome 'demo\demo.ps1')

    $data = ConvertFrom-CardDemoPayload -Path $previewPayloadFile
    $document = New-CardDemoDocument -Payload $data

    # -Activate 是 Show-CardWindow 的真实参数（webview2.ps1:199 的 [switch]$Activate，内部走
    # Invoke-CardForceShow -Activate），不是自造的名字。别因为「param 块里没看到」就删掉：
    # 删了窗口可能落在别的窗口后面，用户会以为卡片没弹出来。
    # 复核办法：(Get-Command Show-CardWindow).Parameters.Keys 里应有 Activate。
    $window = Show-CardWindow -Html $document -Width $previewWidth `
        -TimeoutMs ($previewKeepSeconds * 1000) -WindowTitle 'DSH 卡片验收预览' -Activate

    if ([string]$window.Action -eq 'failed') {
        [Console]::Error.WriteLine('卡片起不来：' + [string]$window.Error)
        exit 1
    }

    Show-CardReviewReport -Data $data
}
