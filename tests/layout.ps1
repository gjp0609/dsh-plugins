# 守卫：仓库目录结构不跑偏。
#
# 跑法：pwsh -NoProfile -File tests\layout.ps1
#
# 用户 2026-11-02：「整体目录结构 需要 整理一下 现在 目录结构 不清晰（做完功能有些 临时的删除 旧的更新 等等）」，
# 「应该统一规定好 整体目录结构 不然过几天又乱了」。规则写在 docs\repo-layout.md，这里把它变成断言。
#
# 八条（任一失败即退出码 1）：
#   1. 仓库根只有白名单里的条目（临时物一律不许落在根上）；
#   2. 仓库根没有调试残留（`_*.log` / `_*.ps1` / `_*.txt`）与旧出图目录 `out\`；
#   3. `.session-files\` 顶层只有白名单条目（调试物只能在 tmp\、构建副本只能在 build\）；
#   4. 每个插件目录都有 README.md 与 DECISIONS.md；
#   5. 插件目录里没有构建期副本（node_modules / dist / app / 外壳文件）；
#   6. `docs\repo-layout.md` 在，并且自己声明了由 tests\layout.ps1 守；
#   7. `docs\images\*.png` 不比 `shared\ui-card\dist\index.html` 旧（发版必须重出截图，B-42/C-09）；
#   8. 文档里引用的本地图片路径都真的存在，且没有「残留的 worktree 目录」。

param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:CardDir = Join-Path $script:RepoRoot 'shared\ui-card'
$script:Failures = 0
$script:Total = 0

# 仓库根允许出现的条目（一次性白名单：新增顶层条目必须同时改这里与 docs\repo-layout.md）。
$script:RootAllowed = @(
    '.agents', '.git', '.gitignore', '.session-files',
    'AGENTS.md', 'BACKLOG.md', 'PREFERENCES.md', 'README.md', 'THIRD-PARTY-NOTICES.md',
    'dsh-approval-allow', 'dsh-approval-notifier', 'dsh-rail-pins', 'dsh-ssh-remote',
    'docs', 'shared', 'tests', 'tools', 'vendor'
)

# `.session-files\` 顶层允许的条目；`<日期>-<任务名>` 目录另按正则放行。
$script:SessionAllowed = @('INDEX.md', 'PROJECT_CONTEXT.md', 'TASK_STATE.md', 'tmp', 'build')
$script:SessionDatedDir = '^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$'

# 插件目录里出现即视为「把构建期目录拷贝进去了」。
# node_modules 例外：`dsh-ssh-remote` 要在这里打单文件 bundle（产物 index.bundle.js 入库，依赖不入库）。
$script:BuildCopies = @('dist', 'app', '.tmp')

function Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Body
    )

    $script:Total++
    try {
        $result = & $Body
        if ($result -eq $true) {
            "PASS  $Name"
            return
        }
        "FAIL  $Name -> $result"
        $script:Failures++
    } catch {
        "FAIL  $Name -> 抛异常：$($_.Exception.Message)"
        $script:Failures++
    }
}

# ---- 1. 仓库根白名单 -------------------------------------------------------------

Check '仓库根只有白名单条目（临时物不许落在根上）' {
    $extra = @(Get-ChildItem -LiteralPath $script:RepoRoot -Force |
            Where-Object { $_.Name -notin $script:RootAllowed } |
            ForEach-Object { $_.Name })
    if ($extra.Count -eq 0) { $true } else { '多出：' + ($extra -join ', ') }
}

# ---- 2. 根上没有调试残留与旧出图目录 ---------------------------------------------

Check '仓库根没有调试残留（_*.log / _*.ps1 / _*.txt）与 out\ 目录' {
    $junk = @(Get-ChildItem -LiteralPath $script:RepoRoot -File -Force |
            Where-Object { $_.Name -like '_*.log' -or $_.Name -like '_*.ps1' -or $_.Name -like '_*.txt' } |
            ForEach-Object { $_.Name })
    if ($junk.Count -gt 0) { return '调试残留：' + ($junk -join ', ') }
    # out\ 曾是出图落点，2026-11-02 起统一到 docs\images；根上再出现就是把临时物当交付物了。
    if (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'out')) { return '根上又出现了 out\，出图请落 docs\images' }
    $true
}

# ---- 3. .session-files 顶层白名单 -------------------------------------------------

Check '.session-files 顶层只有白名单条目（调试物进 tmp\、构建副本进 build\）' {
    $dir = Join-Path $script:RepoRoot '.session-files'
    if (-not (Test-Path -LiteralPath $dir)) { return $true }   # 允许整个目录不存在
    $extra = @(Get-ChildItem -LiteralPath $dir -Force |
            Where-Object {
                $_.Name -notin $script:SessionAllowed -and
                -not ($_.PSIsContainer -and $_.Name -match $script:SessionDatedDir)
            } |
            ForEach-Object { $_.Name })
    if ($extra.Count -eq 0) { $true } else { '多出：' + ($extra -join ', ') }
}

# ---- 4. 插件目录必备文件 ---------------------------------------------------------

Check '每个插件目录都有 README.md 与 DECISIONS.md' {
    $missing = @()
    foreach ($plugin in @(Get-ChildItem -LiteralPath $script:RepoRoot -Directory -Force | Where-Object { $_.Name -like 'dsh-*' })) {
        foreach ($required in 'README.md', 'DECISIONS.md') {
            if (-not (Test-Path -LiteralPath (Join-Path $plugin.FullName $required))) {
                $missing += "$($plugin.Name)\$required"
            }
        }
    }
    if ($missing.Count -eq 0) { $true } else { '缺：' + ($missing -join ', ') }
}

# ---- 5. 插件目录里没有构建期副本 -------------------------------------------------

Check '插件目录里没有 dist / app 构建期副本，也没有外壳文件的逐字节副本' {
    $hits = @()
    # 外壳文件的「正身」按内容算：同名不同内容不算副本（如 notifier 自己的 scripts\ui\environment.ps1，
    # 它定义 Test-WritableDir / Get-ProcessIntegrity 这些通知器专属函数，被 prompt.ps1 与两个断言脚本使用）。
    $shellHashes = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $script:CardDir -File -Filter '*.ps1' -ErrorAction SilentlyContinue)) {
        $shellHashes[(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash] = $file.Name
    }
    foreach ($plugin in @(Get-ChildItem -LiteralPath $script:RepoRoot -Directory -Force | Where-Object { $_.Name -like 'dsh-*' })) {
        foreach ($name in $script:BuildCopies) {
            if (Test-Path -LiteralPath (Join-Path $plugin.FullName $name)) { $hits += "$($plugin.Name)\$name\" }
        }
        foreach ($file in @(Get-ChildItem -LiteralPath $plugin.FullName -Recurse -File -Filter '*.ps1' -Force -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch '\\node_modules\\' })) {
            $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
            if ($shellHashes.ContainsKey($hash)) {
                $hits += "$($plugin.Name)\...\$($file.Name)（与 shared\ui-card\$($shellHashes[$hash]) 逐字节相同）"
            }
        }
    }
    if ($hits.Count -eq 0) { $true } else { '命中：' + ($hits -join ', ') }
}

# ---- 6. 结构规范文档在位且自证 ---------------------------------------------------

Check 'docs\repo-layout.md 在位，且声明了由 tests\layout.ps1 守' {
    $path = Join-Path $script:RepoRoot 'docs\repo-layout.md'
    if (-not (Test-Path -LiteralPath $path)) { return '缺 docs\repo-layout.md' }
    $text = Get-Content -LiteralPath $path -Raw
    if ($text -notmatch 'tests[/\\]layout\.ps1') { return '规范里没写「由 tests\layout.ps1 守」，防复发就没有抓手' }
    $true
}

# ---- 7. 截图不比产物旧（发版必须重出） -------------------------------------------

Check 'docs\images 的截图不比卡片产物旧（发版必须重出，B-42 / C-09）' {
    $dist = Join-Path $script:RepoRoot 'shared\ui-card\dist\index.html'
    if (-not (Test-Path -LiteralPath $dist)) { return '缺 shared\ui-card\dist\index.html' }
    $distTime = (Get-Item -LiteralPath $dist).LastWriteTimeUtc
    $images = @(Get-ChildItem -LiteralPath (Join-Path $script:RepoRoot 'docs\images') -File -Filter '*.png' -ErrorAction SilentlyContinue)
    if ($images.Count -eq 0) { return 'docs\images 里一张截图都没有' }
    $stale = @()
    foreach ($image in @($images | Where-Object { $_.LastWriteTimeUtc -lt $distTime })) {
        $stale += ('{0}（{1}）' -f $image.Name, $image.LastWriteTime.ToString('MM-dd HH:mm'))
    }
    if ($stale.Count -eq 0) { $true } else { '比产物旧：' + ($stale -join ', ') + ' → 跑 tools\preview-card.ps1 或 debug\render.ps1 重出' }
}

# ---- 8. 文档里的图片路径真实存在 + 没有残留 worktree -----------------------------

Check '文档引用的本地图片都存在' {
    $missing = @()
    $docs = @(Get-ChildItem -LiteralPath $script:RepoRoot -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.agents\\|\\\.session-files\\|\\\.git\\' })
    foreach ($doc in $docs) {
        $text = Get-Content -LiteralPath $doc.FullName -Raw
        foreach ($m in [regex]::Matches($text, '!\[[^\]]*\]\(([^)]+\.(?:png|jpg|jpeg|gif))\)')) {
            $rel = $m.Groups[1].Value
            if ($rel -match '^[a-z]+://') { continue }
            $target = Join-Path $doc.DirectoryName ($rel -replace '/', '\')
            if (-not (Test-Path -LiteralPath $target)) {
                $missing += "$($doc.Name) → $rel"
            }
        }
    }
    if ($missing.Count -eq 0) { $true } else { '图不存在：' + ($missing -join ', ') }
}

Check '没有残留的 worktree 目录（登记表与实际目录一一对应）' {
    $registry = Join-Path $script:RepoRoot '.git\worktrees'
    $wtRoot = Join-Path $script:RepoRoot '.agents\worktrees'
    $registered = @()
    if (Test-Path -LiteralPath $registry) {
        $registered = @(Get-ChildItem -LiteralPath $registry -Directory | ForEach-Object { $_.Name })
    }
    # 登记了但目录已被手删 → git 里留着坏条目；有目录但没登记 → 删不干净的残留。
    $orphans = @()
    if (Test-Path -LiteralPath $wtRoot) {
        $actual = @(Get-ChildItem -LiteralPath $wtRoot -Directory -Force | ForEach-Object { $_.Name })
        $orphans = @($actual | Where-Object { $_ -notin $registered })
    }
    if ($orphans.Count -eq 0) { $true } else { '未登记的残留工作树：' + ($orphans -join ', ') + ' → git worktree prune 或手删' }
}

# ---------------------------------------------------------------------------

""
if ($script:Failures -gt 0) {
    "通过 $($script:Total - $script:Failures) / 失败 $($script:Failures)（共 $($script:Total) 项）"
    exit 1
}
"通过 $script:Total / 失败 0（共 $script:Total 项）"
exit 0
