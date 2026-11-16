# tools/ 的决策记录

本目录只有部署与出图工具，决策编号接在仓库已有编号之后（拆分前最大是 `D-34`，
见 `dsh-ssh-remote/DECISIONS.md` 与 `shared/ui-card/DECISIONS.md`）。

## D-35 拆 `tools/deploy.ps1`：入口 + `deploy-lib/` 六个库（纯结构，行为零变化）

- **现象**：`tools/deploy.ps1` 869 行、38 KB，是全仓最长的 PowerShell 脚本（第二是 `tests/deploy.ps1` 593 行）。
  改一条错误文案或 `deploy.json` 的一个字段，要先滚过 26 个函数；只想确认「git 调用到底还在不在
  脚本作用域」，也得通读 800 行。
- **判定**：是问题，但只在可读性与定位成本上，**不改行为**——这一轮只搬函数，不改参数、默认值、
  错误文案、`throw` 文本、`$script:` 变量名，也不动 `tests/deploy.ps1`（它是行为锁）。
- **根因**：六块的**失败方式不同，排查时看的证据也不同**。路径错是「-Root / -Source 指到哪」；
  校验错是「tag / 干净 / 产物」三道门禁里的具体一条；清单错是「白名单漏了谁、package.json 改成什么」；
  写盘错是「半成品与备份换不回来」；输出错是「DryRun 清单和真实清单不一致」；动作错是「拷贝中途崩了」。
  按证据切，改哪类就只读哪一块。

### 怎么切的

| 文件 | 内容 | 函数数 | 行数（目标） |
| :-- | :-- | :-- | :-- |
| `tools/deploy.ps1`（保留） | `.SYNOPSIS` 等帮助注释头、`param()`、全部 `$script:` 常量、**六个 dot-source**、入口（git 调用 / 分支判断 / 退出码） | 0 | 213（≤240） |
| `tools/deploy-lib/paths.ps1` | `Resolve-FullPath`、`Test-PathEqual`、`Test-PathUnder`、`Test-ExcludedRelativePath`、`New-DeployItem`、`Get-BackupName`、`Get-BackupDirs` | 7 | 105（≤260） |
| `tools/deploy-lib/assert.ps1` | `Assert-SourceRoot`、`Assert-DeployTagState`、`Assert-CleanWorktree`、`Assert-CardArtifact`、`Assert-BundleArtifacts`、`Assert-DeployItemsComplete` | 6 | 173（≤260） |
| `tools/deploy-lib/items.ps1` | `Get-PluginDeployItems`、`Get-DeployItems`、`Get-BundledPackageJson`、`Update-BundledPackageJson` | 4 | 178（≤260） |
| `tools/deploy-lib/backup.ps1` | `Remove-OldBackups`、`Backup-Production`、`Invoke-CopyDeployItems`、`Write-DeployManifest` | 4 | 85（≤260） |
| `tools/deploy-lib/output.ps1` | `Write-NextStep`、`Show-DryRunPlan`、`Write-DependencyNotes` | 3 | 64（≤260） |
| `tools/deploy-lib/actions.ps1` | `Invoke-Deploy`、`Invoke-RollbackDeploy` | 2 | 82（≤260） |

合计 26 个函数，入口里 0 个；旧文件的 26 个 `FunctionDefinitionAst` 全部落位（缺 0、多 0）。
跨文件调用只有一个方向：`items` 里的 `Get-DeployItems` 调 `assert` 里的 `Assert-DeployItemsComplete`，
`actions` 调 `backup` / `items` / `output` 里的函数——都在**同一个 script 作用域**里按名字解析，
所以 dot-source 顺序只影响可读性、不影响正确性（但常量必须先于任何 dot-source）。

### 为什么 `$script:` 常量留在入口，且 dot-source 必须在常量之后

dot-source 的代码在**调用方的作用域**执行，不新建 script scope，所以库里的 `$script:PluginNames`、
`$script:BundledPluginNames`、`$script:BundledPluginFiles`、`$script:BundledPluginDirs`、
`$script:BundleFileName`、`$script:ExcludedDirNames`、`$script:ExcludedFileNames`、
`$script:PluginRequiredFiles`、`$script:UiCardSubDirs`、`$script:KeepBackups`、
`$script:BackupStampFormat` 都解析到主脚本的 script scope。这与 D-34（`sshctl.ps1` 的
`$script:ExitCode`）是同一套机制，两个方向都实测过：`Get-DeployItems` 真按 `$script:PluginNames`
造出三个插件的清单，`Remove-OldBackups` 真按 `$script:KeepBackups = 3` 清到只剩 3 份
（`tests/deploy.ps1` 的 66 条断言覆盖到这两条路径）。

反过来说：**常量若搬进某个 lib、再被别的 lib 读，就变成跨文件的初始化顺序问题**；而 dot-source
顺序写错的表现是「变量读不到」，不是「立刻报错」。留在入口是唯一不需要额外约定的位置，
所以常量段（旧文件 70-90 行）一个字节没动。

### 「git 调用集中」是怎么保住的

`.SYNOPSIS` / `.DESCRIPTION` 那条约束没有被破坏，四条证据：

1. **库函数里一个原生命令都没有**。对六个 lib 做 AST `CommandAst` 扫描，按文件统计到的命令名
   分别是 7 / 8 / 12 / 17 / 6 / 18 个（`Get-ChildItem`、`Copy-Item`、`Move-Item`、`ConvertTo-Json`、
   `Write-Host` …），`git` / `cmd` / `pwsh` / `node` / `npm` / `pnpm` 合计 **0 个**。
2. **入口段逐字保留**：旧文件 764-869 行（`# ---- 入口` 到文件尾）在新文件里是最后 106 行，
   与旧文件 `-ceq` 为真；第 1-90 行（帮助头 / `param()` / 常量）同样逐字保留。
   两处 `cmd /c`（五个 `git` 查询 + `merge-base --is-ancestor`）都还留在脚本作用域。
3. **没有任何 git 调用需要「先报给我」**：`Assert-DeployTagState` 本来就只接收 `$RefExists` /
   `$TagCommit` / `$Head` / `$Relation`，`Assert-CleanWorktree` 只收 `-PorcelainText`——git 的结论
   一直由入口算好再传参。所以不存在「库函数里藏着 git、要不要原样搬进 `actions.ps1`」这道题。
4. 这条约束还写进了新加的三处注释（入口 dot-source 块上方、`assert.ps1` 与 `actions.ps1` 的文件头），
   避免下次「顺手」把 `git` 挪进函数。

### 行数

入口 213 行（帮助头 57 + `param()` 8 + 严格模式 2 + 常量段 21 + 载入块 17 + 入口段 106 + 空行 2），
六个库 105 / 173 / 178 / 85 / 64 / 82，全部在目标内，**没有为凑行数硬拆**：
`items.ps1` 的 178 行是四个函数本身（`Get-DeployItems` 52、`Get-PluginDeployItems` 48、
`Get-BundledPackageJson` 55），`assert.ps1` 的 173 行是六道门禁连同各自的完整中文文案。

### 被否的方案

- **改成 `.psm1` + `Import-Module`**：模块有自己的 module scope，`$script:` 指向模块而不是主脚本，
  11 个 `$script:` 常量全部要改成参数或 `$global:`——既改函数体也改调用面。D-34 已为 `sshctl.ps1`
  否过一次，理由相同。
- **把常量作为参数传给每个函数**：要改 26 个函数签名与全部调用点（`Get-DeployItems -PluginNames …`
  之类），等于重写调用面，超出「纯结构」。
- **抽一个 `Invoke-Git` 辅助函数**把入口那段包起来：正是 `.SYNOPSIS` 明令禁止的写法。本轮实测：
  `cmd /c` 包在函数里会当场报 `StandardOutputEncoding is only supported when standard output
  is redirected`（写对照脚本时踩到过一次），不是理论风险。
- **加 `deploy-lib/all.ps1` 聚合 dot-source**：入口少 5 行，但多一层间接；某个库文件名拼错时，
  失败只会指向聚合文件，定位反而慢。六个显式 dot-source 一行一个文件，拼错时报错行直接指出是谁。
- **按 `Get-*` / `Invoke-*` 前缀切**：`Invoke-Deploy` 要调 `Get-Date`、`Backup-Production`、
  `Update-BundledPackageJson`，按前缀切完两半互相调，等于造一条假边界。
- **把 `Assert-DeployItemsComplete` 放进 `items.ps1`**：它只被 `Get-DeployItems` 调用，放一起看着更顺，
  但「校验」与「造清单」的失败证据不同。跨文件调用在同一作用域里没有额外成本，所以按职责放。
- **保留单文件、只加 `#region`**：折叠能省一次跳转，但「改 DryRun 要滚过 800 行」的成本没变，
  且这类注释一旦不同步就是新的误导。
- **改 `tests/deploy.ps1`**：它是行为锁，改它等于改断言；这一轮一个字节没动，66 条断言照原样全过。

### 怎么复验

```powershell
# 下面的路径以 worktree 为例；合并后在仓库根同样适用。
cd .agents\worktrees\ssh-remote

# 1) 语法：七个文件逐个真实解析。
#    必须用真有值的 $tokens / $errs：题目里 [ref]$null 的写法在 PS 里会报
#    「[ref] cannot be applied to a variable that does not exist」，且 $errs 从未赋值、Count 恒为 0，
#    是假通过。实测 errs 全 0，token 数 938 / 569 / 871 / 1009 / 465 / 300 / 415（证明真的解析了）。
$t = $null; $e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile('tools\deploy.ps1', [ref]$t, [ref]$e)
$e.Count

# 2) 结构：拆分前那份（本轮的父提交）26 个 FunctionDefinitionAst，新文件也是 26 个；
#    Extent.Text 逐字相同 26/26；旧文件 48 行注释在新文件里缺失 0 行。
git show <拆分提交>^:tools/deploy.ps1 > .tmp\old.ps1   # 再逐函数比 Extent.Text

# 3) 入口新旧对照：无参 / -Tag <不存在> / -DryRun（临时 -Root）三种调用，
#    退出码 1 / 1 / 0 相同，stdout 逐字节相同（69 / 139 / 11810 字符），stderr 三处都是空。

# 4) 行为锁（需要先提交，脚本自己有「工作区必须干净」的断言）：
pwsh -NoProfile -File tests\deploy.ps1   # → 66 项通过 / 66 项，退出码 0
```

（四条都是本轮实测，数字取自 2026-11-02 的拆分提交。）

### 与「完全零变化」的边界

- **多了一种失败模式**：六个库文件必须与 `tools\deploy.ps1` 一起待在 `tools\deploy-lib\`，缺一个
  脚本在 dot-source 阶段就失败（「找不到路径」），不会静默跳过。部署侧不受影响——生产树不搬
  `tools\`。但**仓库根就是线上**（junction），所以 `tools\deploy.ps1` 与 `tools\deploy-lib\`
  必须在同一次提交里。
- **行号变了**：`throw` 的行号跟着函数搬到了 lib。`tests\deploy.ps1` 只匹配文案、不看行号，
  实测全过；帮助注释头一个字没改，`Get-Help tools\deploy.ps1` 的输出不变。
- 没有新增 `#Requires`、没有模块清单、没有 `$PSScriptRoot` 之外的路径假设：dot-source 一律
  `Join-Path $PSScriptRoot 'deploy-lib\<name>.ps1'`，与 cwd、盘符无关。

### 没做的（范围外）

- 没跑 `tests\deploy.ps1` 之外的测试：其它 `tests\*.ps1` 没有一个引用 `tools\deploy.ps1` 或
  `tools\deploy-lib\`（`grep -n 'deploy\.ps1' tests\*.ps1` 只命中 `tests\deploy.ps1` 自己的路径常量），
  本轮也没改插件代码、`shared\`、`vendor\`。
- 没碰生产树（`%LOCALAPPDATA%\dsh-plugins\production`）：所有验证都用 `-Root` 指到
  `.agents\deploy-tests\*` / `.tmp\*` 临时目录，跑完即删。
- 没改 `docs/deploy.md`：脚本的对外行为（参数、门禁、清单、输出）没变，文档不用改；
  「库文件在哪」属于结构细节，记在本文件。
