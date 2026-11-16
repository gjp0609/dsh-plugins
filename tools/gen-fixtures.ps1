# 生成四类卡片的载荷样本：审批 / 勾选 / 确认 / 表单（不提交，只用来出图 / 验收）
#
# 全部走插件自己的构造函数，不手写 JSON：这样图里的结构与真实调用一致。
# 用法：pwsh -NoProfile -File .session-files/gen-fixtures.ps1

$ErrorActionPreference = 'Stop'
$repo = 'C:\work\dsh-plugins'

function Save-Json($payload, [string]$name) {
    $path = Join-Path $repo "tests\fixtures\$name.json"
    # 用 LF 写：仓库里这些 JSON 是 LF，Set-Content 会写成 CRLF，每次重出都留一行假改动。
    $json = ($payload | ConvertTo-Json -Depth 10) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    "  $name.json  $((Get-Item $path).Length) B"
}

# ---- 审批卡（用通知插件自己的载荷构造） -------------------------------------
. "$repo\dsh-approval-notifier\scripts\ui\shared.ps1"
$approval = New-ApprovalCardPayload -Data ([ordered]@{
        # 宿主真实拼的是「DSH 审批请求 · <工具名>」，工具名取最后一段
        windowTitle = 'DSH 审批请求 · pwsh'
        meta        = 'C:\work\dsh-plugins'
        reason      = '查一下本机 node 进程的启动时间，判断宿主是不是真的重启过；只读，不改任何东西。'
        command     = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq ''node.exe'' } | Select-Object ProcessId, Name, CreationDate'
        armDelayMs  = 1000
        closeAfterMs = 600000
    })
"审批卡："
Save-Json $approval 'approval'

# ---- 勾选卡（用 ssh 插件自己的载荷构造） -------------------------------------
. "$repo\dsh-ssh-remote\scripts\ui\shared.ps1"
$rows = @(
    New-CardRow -Label '192.168.1.11:22 · 主机A' -Why '看一下根分区还剩多少' -Text 'df -h /' -Meta '工作目录 /root · 超时 30s'
    New-CardRow -Label '192.168.1.12:22 · 主机B' -Why '确认服务没挂' -Text 'systemctl status nginx --no-pager' -Meta '工作目录 /root · 超时 30s'
    New-CardRow -Label '192.168.1.14:22 · 主机C' -Why '确认为什么 502' -Text 'tail -n 50 /var/log/nginx/error.log' -Meta '覆盖 · 工作目录 /etc/nginx'
)
$select = New-SshCardPayload -ProjectDir 'C:\work\dsh-plugins' -Rows $rows
"勾选卡："
Save-Json $select 'select'

