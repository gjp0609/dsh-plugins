# 断言：整张卡用「等距更纱黑体 SC」（英文名 Sarasa Mono SC）——正文与代码都是它。
#   这是用户定过的偏好（DECISIONS.md D-09），不是我的选择；要改它必须先问用户。
#   CSS 里写了什么不等于真用了什么（族名写错会静默回退），所以两件事都量：
#   ① 计算出的 font-family 栈第一项；② 问渲染引擎「这一节点上真正落笔的字体族」。
# 离屏起窗，不弹给用户看；不需要人工点击。需要提权（受限令牌下 WebView2 起不来）。
#
# 跑法：& <repo>\dsh-approval-notifier\tests\card-font.ps1
[CmdletBinding()]
param(
    [string]$WorkDir = '',
    [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot

if ($WorkDir -eq '') {
    $WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-card-font-' + [Guid]::NewGuid().ToString('n').Substring(0, 8))
}
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# 渲染源只有仓库根 shared/ui-card 一份：card.ps1 → shared.ps1 → 外壳（card-html + webview2）。
. (Join-Path $pluginRoot 'scripts\ui\environment.ps1')
. (Join-Path $pluginRoot 'scripts\ui\card.ps1')

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail })
    $mark = if ($Ok) { 'ok  ' } else { 'FAIL' }
    Write-Host ("{0} {1}{2}" -f $mark, $Name, $(if ($Detail) { "  → $Detail" } else { '' }))
}

$payload = New-ApprovalCardPayload -Data ([ordered]@{
        windowTitle  = 'DSH 审批请求 · 字体自检'
        meta         = ''
        reason       = '允许本次操作使用 danger-full-access 权限：核对字体渲染。'
        command      = 'Get-ChildItem -LiteralPath C:\Windows\Fonts\*.ttc | Measure-Object'
        armDelayMs   = 1000
        closeAfterMs = 0
    })
$html = New-CardDocument -Payload $payload

$env2 = Initialize-CardWebView2
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ClientSize = [System.Drawing.Size]::new(680, 480)
$form.Left = -32000
$form.Top = -32000
$null = $form.Handle

$ctrl = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$ctrl.Dock = [System.Windows.Forms.DockStyle]::Fill
$form.Controls.Add($ctrl)

$script:navDone = $false
$initTask = $ctrl.EnsureCoreWebView2Async($env2)
while (-not $initTask.IsCompleted) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 5 }
if ($initTask.IsFaulted) { throw $initTask.Exception.GetBaseException().Message }
$ctrl.add_NavigationCompleted({ param($sender, $args) $script:navDone = $true })
$ctrl.CoreWebView2.NavigateToString($html)
$deadline = [DateTime]::Now.AddSeconds(20)
while (-not $script:navDone -and [DateTime]::Now -lt $deadline) {
    [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10
}
Start-Sleep -Milliseconds 600
[System.Windows.Forms.Application]::DoEvents()

function Invoke-Cdp {
    param([string]$Method, [hashtable]$Params)
    $json = if ($Params) { $Params | ConvertTo-Json -Compress -Depth 8 } else { '{}' }
    $task = $ctrl.CoreWebView2.CallDevToolsProtocolMethodAsync($Method, $json)
    while (-not $task.IsCompleted) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 5 }
    [string]$task.Result | ConvertFrom-Json
}

# 1) 计算出来的栈 + 这款字是不是真等宽（同一串里窄字与宽字占同样宽度）。
$probe = @'
(() => {
  const measure = (family, text) => {
    const c = document.createElement('canvas').getContext('2d')
    c.font = '14px ' + family
    return Math.round(c.measureText(text).width * 1000) / 1000
  }
  const codeEl = document.querySelector('[data-part="code"]')
  return JSON.stringify({
    sarasaAvailable: document.fonts.check('14px "等距更纱黑体 SC"'),
    bodyFontFamily: getComputedStyle(document.body).fontFamily,
    codeFontFamily: codeEl ? getComputedStyle(codeEl).fontFamily : null,
    sarasaMono: measure('"等距更纱黑体 SC"', 'iiii') === measure('"等距更纱黑体 SC"', 'WWWW'),
    widthSarasa: measure('"等距更纱黑体 SC"', 'MONOMONO 111111 |&>=$'),
    widthSegoe: measure('"Segoe UI"', 'MONOMONO 111111 |&>=$'),
  })
})()
'@
$envelope = Invoke-Cdp 'Runtime.evaluate' @{ expression = $probe; awaitPromise = $true; returnByValue = $true }
$info = [string]$envelope.result.value | ConvertFrom-Json

Add-Check '本机装了这个字体（document.fonts.check）' ([bool]$info.sarasaAvailable)
Add-Check '它是等宽字体（窄字与宽字同宽）' ([bool]$info.sarasaMono) ("sarasa={0} segoe={1}" -f $info.widthSarasa, $info.widthSegoe)

# 计算值会保留写成的那串（带引号、带逗号），取第一项比。
function Get-FirstFamily {
    param([string]$Stack)
    if ([string]::IsNullOrWhiteSpace($Stack)) { return '' }
    $first = ($Stack -split ',')[0]
    return ($first -replace '"', '').Trim()
}
$bodyFirst = Get-FirstFamily $info.bodyFontFamily
$codeFirst = Get-FirstFamily $info.codeFontFamily
Add-Check '正文栈里排第一的就是它' ($bodyFirst -like '等距更纱黑体*') $bodyFirst
Add-Check '代码栈里排第一的也是它' ($codeFirst -like '等距更纱黑体*') $codeFirst

# 2) 真落笔的字体：问渲染引擎，不看 CSS。
$null = Invoke-Cdp 'DOM.enable' @{}
$null = Invoke-Cdp 'CSS.enable' @{}
$doc = Invoke-Cdp 'DOM.getDocument' @{ depth = 1 }
$fallbacks = @('Segoe UI', 'Microsoft YaHei', 'Consolas', 'Cascadia Mono', 'Cascadia Code', 'Arial', 'Times New Roman')
# 同一款字体在 Chromium 里报英文族名（"Sarasa Mono SC"），中文族名只是我们的写法，
# 两个名字都算对；判据是「没掉到系统默认字体上」。
$expectPattern = '^(等距更纱黑体|Sarasa Mono SC|Sarasa Term SC)'
$painted = [ordered]@{}
foreach ($sel in @('[data-part="title"]', '[data-part="note"]', '[data-part="code"]')) {
    $query = Invoke-Cdp 'DOM.querySelector' @{ nodeId = $doc.root.nodeId; selector = $sel }
    if (-not $query.nodeId) { Add-Check "找到节点 $sel" $false; continue }
    $fonts = Invoke-Cdp 'CSS.getPlatformFontsForNode' @{ nodeId = $query.nodeId }
    $list = @($fonts.fonts)
    $detail = ($list | ForEach-Object { "$($_.familyName)×$($_.glyphCount)" }) -join ' + '
    $painted[$sel] = $detail
    $primary = $list | Sort-Object -Property glyphCount -Descending | Select-Object -First 1
    $ok = $primary -and ($primary.familyName -match $expectPattern)
    Add-Check "$sel 真用的是等距更纱黑体" ([bool]$ok) $detail
    $usedFallback = @($list | Where-Object { $fallbacks -contains $_.familyName })
    Add-Check "$sel 没有回退到系统默认字体" ($usedFallback.Count -eq 0) (($usedFallback | ForEach-Object { $_.familyName }) -join ', ')
}

$form.Dispose()

$failed = @($checks | Where-Object { -not $_.Ok }).Count
Write-Host ''
Write-Host ('总结：{0}' -f $(if ($failed -eq 0) { '全部通过' } else { "$failed 项失败" }))
Write-Host ('实际落笔：{0}' -f (($painted.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '；'))

$report = [ordered]@{
    at      = (Get-Date).ToString('o')
    workDir = $WorkDir
    checks  = $checks
    fonts   = $info
    painted = $painted
    failed  = $failed
}
$reportPath = Join-Path $WorkDir 'card-font.json'
($report | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host "报告：$reportPath"

exit $(if ($failed -eq 0) { 0 } else { 1 })
