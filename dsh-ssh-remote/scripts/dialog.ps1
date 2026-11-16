# 桌面勾选卡入口（scripts\dialog.ps1）：参数解析、STA 重拉、退出码。
#
#   -Mode select    勾选要执行 / 要搬运的行（共享外壳 WebView2 卡片；子代理审批走这里）
#
# 只有这一种模式：本插件的会话侧弹窗就是「执行 / 复制的勾选卡」，勾选卡本身就是审批。
# 新增主机、改密码、改备注、删除主机、接入点导入都在**插件设置页**（浏览器页面）里做，
# 会话侧不再有表单卡与确认卡。
#
# 退出码（调用方 lib/admin.mjs 依赖这组约定）：
#   0 = 有答案；2 = 取消、关窗或到点；1 = 弹窗起不来或输入文件有问题。
#
# 约定：
# - 卡片只有一条渲染路径：仓库根 shared/ui-card 的 WebView2 外壳（本文件不 dot-source 任何
#   自绘控件/控件库）。外壳缺失、缺 DLL、没运行时、起窗口失败 → 写明确 stderr 并非零退出；
#   不再退回第二套界面，命令失败重试即可。
# - 需要 STA（WebView2 的卡片窗口要求）；不是 STA 时自动用 -STA 重新拉起自己并转发结果。
param(
    [ValidateSet('select')]
    [string]$Mode = 'select',
    # 卡片最上面那行小字（缺省由外壳给「SSH · 执行确认」）。
    [string]$Eyebrow = '',
    # 发起这次操作的工作目录：卡片抬头用它标出「哪个项目在问」。
    [string]$WorkDir = '',
    # 仅用于自检参数管道：不弹窗，直接返回固定串。
    [switch]$SelfTest,
    # 待勾选的行（JSON 字符串数组）。
    [string]$OptionsFile = '',
    # 逐行内容（JSON：`[{ label, text }]`）——每行一个勾选框 + 它自己的命令。
    [string]$RowsFile = '',
    # 整段详情（没有 RowsFile 时的兜底）。
    [string]$DetailFile = '',
    # 把答案写成 JSON（{ answered, selected }）；为空则打到 stdout。
    [string]$OutFile = '',
    # 离屏渲染成 PNG 后退出（验收用，外壳的 OnRendered 抓一张再关窗）。
    [string]$RenderTo = ''
)

$ErrorActionPreference = 'Stop'

if ($SelfTest) {
    [Console]::Out.Write('self-test-ok')
    exit 0
}

# WebView2 的卡片窗口需要 STA。不是就以 STA 重新拉起自己，并把子进程的 stdout / 退出码原样转发。
if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) {
    $argList = @(
        '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        '-Mode', $Mode
    )
    if ($WorkDir -ne '') { $argList += @('-WorkDir', $WorkDir) }
    if ($Eyebrow -ne '') { $argList += @('-Eyebrow', $Eyebrow) }
    # 三个文件参数必须一起转发，否则重新拉起后会丢选项与详情。
    if ($OptionsFile -ne '') { $argList += @('-OptionsFile', $OptionsFile) }
    if ($RowsFile -ne '') { $argList += @('-RowsFile', $RowsFile) }
    if ($DetailFile -ne '') { $argList += @('-DetailFile', $DetailFile) }
    if ($OutFile -ne '') { $argList += @('-OutFile', $OutFile) }
    if ($RenderTo -ne '') { $argList += @('-RenderTo', $RenderTo) }
    $child = & pwsh @argList
    [Console]::Out.Write([string]::Join("`n", @($child)))
    exit $LASTEXITCODE
}

function Write-PopupFailure([string]$Reason) {
    <#
    .SYNOPSIS
        弹窗起不来时唯一该做的事：把原因写清楚，让调用方报错、用户重试。
    .DESCRIPTION
        不再有第二条渲染通道，所以这里不「假装跳过」、也不返回空答案——空答案会被当成
        「用户什么都没选」，而实际上人根本没看见卡。
    #>
    [Console]::Error.Write('弹窗起不来：' + $Reason + '（没有第二套界面兜底；修好后重试这次操作）')
}

function Read-JsonFileContent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$Label = 'JSON 文件'
    )
    if (-not (Test-Path -LiteralPath $Path)) { throw "$Label 不存在：$Path" }
    $raw = Get-Content -Raw -LiteralPath $Path
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try {
        return ($raw | ConvertFrom-Json)
    } catch {
        throw "$Label 解析失败：$($_.Exception.Message)"
    }
}

try {
    switch ($Mode) {
        'select' {
            . (Join-Path $PSScriptRoot 'ui\card.ps1')

            # 输入文件的问题和「卡片起不来」是两回事，分开报：前者改参数/文件就能好，
            # 后者是渲染通道坏了。两者都必须非零退出，不能当成「用户什么都没选」。
            try {
                # 逐行内容：勾选框和它自己的命令绑在一起，多行时才分得清哪条命令属于哪一行。
                # 解析失败必须报错退出：静默退回「只有主机名、没有命令」的卡，等于让人在
                # 看不到命令的情况下点头。
                $rows = @()
                if ($RowsFile -ne '') {
                    $parsedRows = Read-JsonFileContent -Path $RowsFile -Label 'rows 文件'
                    if ($null -ne $parsedRows) { $rows = @($parsedRows) }
                    if ($rows.Count -eq 0) { throw "rows 文件是空的：$RowsFile" }
                }

                $options = @()
                if ($OptionsFile -ne '' -and (Test-Path -LiteralPath $OptionsFile)) {
                    try {
                        $parsedOptions = Get-Content -Raw -LiteralPath $OptionsFile | ConvertFrom-Json
                        if ($null -ne $parsedOptions) { $options = @($parsedOptions | ForEach-Object { [string]$_ }) }
                    } catch {
                        # 选项只是显示标签，坏了不影响「勾了哪一行」的映射（行自带 label）。
                        $options = @()
                    }
                }

                $detail = ''
                if ($DetailFile -ne '' -and (Test-Path -LiteralPath $DetailFile)) {
                    $detail = Get-Content -Raw -LiteralPath $DetailFile
                }
                if ($rows.Count -eq 0 -and [string]::IsNullOrWhiteSpace($detail)) {
                    throw 'select 模式需要 -RowsFile 或 -DetailFile（没有正文的卡不能让人点头）'
                }
            } catch {
                [Console]::Error.Write('审批参数有问题：' + $_.Exception.Message)
                exit 1
            }

            $selectParams = @{
                Rows      = $rows
                Options   = $options
                Detail    = $detail
                ProjectDir = $WorkDir
                MaxHeight = 0
                ShotPath  = $RenderTo
            }
            if (-not [string]::IsNullOrWhiteSpace($Eyebrow)) { $selectParams['Eyebrow'] = $Eyebrow }
            $card = Invoke-SshCardSelect @selectParams
            if ($null -eq $card) { throw '卡片没有返回结果' }
            if ($card.shot -eq $true) { exit 0 }

            $answerJson = (@{ answered = [bool]$card.answered; selected = @($card.selected) } | ConvertTo-Json -Compress)
            if ($OutFile -ne '') {
                try {
                    [System.IO.File]::WriteAllText($OutFile, $answerJson, [System.Text.UTF8Encoding]::new($false))
                } catch {
                    [Console]::Error.Write('写审批结果失败：' + $_.Exception.Message)
                    exit 1
                }
            } else {
                [Console]::Out.Write($answerJson)
            }
            if ($card.answered) { exit 0 }
            exit 2
        }
    }
} catch {
    Write-PopupFailure $_.Exception.Message
    exit 1
}
