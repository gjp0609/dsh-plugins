# dsh-approval-allow

按配置文件里的**全串锚定正则**，自动同意 DSH 的 `pwsh` / `bash` 审批（**含沙箱提权审批**）。
一份配置里同时放全局规则和按项目分的规则；改文件即热生效，不用重启 DSH；不做卡片交互。

它解决的问题：`git pull origin main`、`git status` 这类天天跑的命令，每次都要点一次审批。
把命令写进名单，命中就自动答「允许一次」，弹窗根本不出现；没命中、命中 deny、配置坏了，
照常弹窗问人。

---

## 前提

- DSH 的 web profile，用插件管理器安装（本插件挂在 profile 上，对**所有会话**生效）。
- 只用 Node 内置模块，不依赖 `@deepseek-ai/*` 包。
- 审批只覆盖 **`pwsh` / `bash` 两个工具通道**。文件写入（fs）、`ssh_run` 的多选卡等
  不经过本插件，仍按原样处理。

## 它做什么

1. 在 `tools/pre-execute` 里记下 `callId → {tool, command}`（仅 `pwsh`/`bash`，有界缓存 256 条、TTL 10 分钟）；
2. 在 `approval/request` 瀑布里用 `req.callId` 取回命令原文，按全局规则 + 当前项目段做锚定正则匹配；
3. **命中 allow 且没有命中任何 deny** → 返回 `'allowed-once'`，等于你点了「允许一次」，弹窗不出现；
4. 其他情况一律 `next()`：没规则、命中 deny、callId 缺失、缓存未命中、工具不是 pwsh/bash、
   JSON 坏了、正则编译失败、匹配抛错——全部交回下游照常问。

放行**只跳过「问」这一步，不绕过沙箱**：写隔离、只读模式仍由 sandbox 决定。
但**提权审批**（`sandbox_permissions` + `justification`）也走同一个白名单：被命中就是自动同意
更宽的模式，这条风险见下面「风险」一节。

## 安装

```text
plugin_manager(action: "install_bundle", target: "C:\\work\\dsh-plugins\\dsh-approval-allow")
```

安装会改 profile 目录（工作区外），需要一次 `danger-full-access` 批准。安装后**重启 DSH**，
插件才会挂上（`index.js` / `lib/*.mjs` 改动同样要重启，见「更新」）。

## 配置在哪

**只有一个目录、一个配置文件**，都在工作区外：

| 文件 | 作用 |
| :--- | :--- |
| `<dataDir>/allow.json` | 唯一配置入口：顶层规则对所有项目生效，`projects` 段按项目标识分 |
| `<dataDir>/approvals.jsonl` | 审批流水，插件自动追加 |
| `<dataDir>/config-errors.log` | 配置诊断，**只有出错时才出现** |

- `dataDir` 默认 `%USERPROFILE%\.dsh\plugin-data\approval-allow`；设了 `DSH_HOME` 就是
  `$env:DSH_HOME\plugin-data\approval-allow`。可用 patch 行配置的 `dataDir` 改名（改它要重启）。
- **不建 `projects\` 之类子目录**，也不按功能拆第二个入口。`.dsh` 下只有 `plugin-data` 一个
  我们的文件夹，里面一个插件一个目录。
- 文件要自己建（插件不会自动生成）：

```powershell
$dir = "$env:USERPROFILE\.dsh\plugin-data\approval-allow"
New-Item -ItemType Directory -Force $dir | Out-Null
notepad "$dir\allow.json"
```

### 为什么不放项目目录

早期版本把项目名单放在 `<项目根>\.dsh\approval-allow.json`，这是**不安全**的：工作区是模型
可写的（`write` / `edit` 不需要审批），被审查方可以自己写一条 allow 规则给自己放行，等于把
审批关掉。所以规则只能放在工作区外、普通 `workspace-write` 沙箱写不到的地方（`dataDir`）。

- 工作区里的 `.dsh\approval-allow.json`、项目根 `allow.json` 等**一律不读、不 stat**；
  旧文件会被静默忽略，不会生效，也不会产生诊断。
- 如果某次调用被提权到 `danger-full-access`，它理论上也能写 `dataDir`；边界仍是沙箱。
  **不要把 `dataDir` 配到工作区里**，那等于把配置交给模型。

### 项目标识

项目规则写成 `projects.<项目标识>`。标识由**会话当前工作目录的绝对路径**算出，不需要手工命名：

1. 路径转小写、分隔符统一成 `/`、去掉末尾 `/`；
2. 可读段（slug）：非 `[a-z0-9]` 的连续字符换成 `-`，去掉首尾 `-`，最多 60 个字符，空则 `root`；
3. 标识 = `<slug>-<sha1(规范化路径) 前 8 位>`。

同一路径永远同一标识（大小写、`/` 与 `\` 写法不同也一样）；不同路径靠 8 位哈希区分。
项目根不是绝对路径时不算标识，只用全局规则。

**怎么知道你项目的标识**（三种任选）：

```powershell
# 1. 直接跑插件带的脚本（输出与运行时同源）
node dsh-approval-allow\scripts\project-id.mjs "C:\work\dsh-plugins"

# 2. 打开 patch 行的 debug: true 并重启，下一次审批会打印：
#    [approval-allow] {"event":"approval","phase":"config",...,"projectId":"...","configPath":"..."}

# 3. 普通盘符路径也可以手算（重复分隔符 / UNC 路径请用前两种，避免和规范化规则不一致）
$p = 'C:\work\dsh-plugins'.ToLowerInvariant().Replace('\','/').TrimEnd('/')
$slug = ($p -replace '[^a-z0-9]+','-').Trim('-')
if ($slug.Length -gt 60) { $slug = $slug.Substring(0,60).TrimEnd('-') }
if ($slug -eq '') { $slug = 'root' }
$hash = [Convert]::ToHexString(
  [Security.Cryptography.SHA1]::HashData([Text.Encoding]::UTF8.GetBytes($p))
).ToLowerInvariant().Substring(0,8)
"$slug-$hash"
```

例：`C:\work\dsh-plugins` → `c-work-dsh-plugins-ca92ba23`。

### 项目根从哪来

**项目根 = 会话当前工作目录**（DSH 的 `workingDirectory` 服务，一手来源；拿不到才退
`session.header.cwd`）。**不是宿主进程的 `process.cwd()`**。在 `C:\work\proj` 的会话里，
项目标识按 `C:\work\proj` 算；`cd` 到子目录就按子目录算，不向上找 `.git`。
两个来源都拿不到项目根时，**只用全局规则**。

## 配置格式

这是**严格 JSON**，不支持 `//` 注释；要写说明用 `_` 开头的键（如 `_readme`）或规则里的 `note`。

```json
{
  "version": 1,
  "deny": [
    {
      "id": "no-force-push",
      "tool": "pwsh",
      "match": "^git push .*--force.*$",
      "note": "强推永远问"
    }
  ],
  "allow": [
    {
      "id": "git-commit",
      "tool": ["pwsh", "bash"],
      "match": "^git commit -m ('.*'|\".*\")$",
      "note": "提交信息任意"
    },
    {
      "id": "read-only-git",
      "tool": "pwsh",
      "match": "^git (status|log|diff|show)( .*)?$",
      "note": "只读查看"
    }
  ],
  "projects": {
    "c-work-dsh-plugins-ca92ba23": {
      "allow": [
        {
          "id": "this-project-build",
          "tool": "pwsh",
          "match": "^pnpm run build$"
        }
      ],
      "deny": [
        {
          "id": "this-project-clean",
          "tool": "pwsh",
          "match": "^git clean -[a-z]*f[a-z]*$"
        }
      ]
    }
  }
}
```

### 字段

| 字段 | 必填 | 说明 |
| :--- | :--- | :--- |
| `version` | 是 | 必须是 `1`；其他值整份文件作废 |
| `deny` / `allow` | 否 | 全局规则数组；缺省等于空数组 |
| `projects` | 否 | 项目段对象：键是项目标识，值是 `{ deny, allow }` |
| `id` | 是 | 非空字符串，审计里的 `rule` 就是它；全局与项目建议不要重名 |
| `tool` | 是 | 工具名精确匹配、`"*"`、或非空字符串数组。本插件只会看到 `pwsh` / `bash` |
| `match` | 是 | **必须全串锚定**：以 `^` 开头、以 `$` 结尾 |
| `note` | 否 | 只给人看，不参与匹配 |

`_` 开头的键（如 `_readme`）按注释忽略。规则里不认识的键 → 该条作废；顶层不认识的键 →
整份文件作废（防止把 `denny` 这种拼写错误静默吞掉）。

`projects` 段是宽容的，坏一块不拖垮全局：

- `projects` 不是对象 → **只忽略 projects 段**，顶层规则照常生效，并写诊断；
- 项目键不符合 `<slug>-<8位十六进制>` → 忽略该项并写诊断；其它合法标识属于别的项目，
  只在该项目下查找，不影响当前项目；
- 项目值不是对象、有未知字段、`deny`/`allow` 不是数组 → **只忽略该项**并写诊断；
- 项目段里的单条规则坏了（不锚定、坏正则、未知字段）→ 只作废该条，兄弟规则照常生效。

### 合并与优先级

- 全局 `allow` ∪ 当前项目段的 `allow`，全局 `deny` ∪ 当前项目段的 `deny`；
- **deny 优先**：同一条命令同时命中 allow 和 deny → 照常问。deny 是刹车，全局与项目段都生效；
- 顺序不影响结果：先扫全部 deny，再扫 allow。

### 正则怎么写

- `match` 是 **JS 正则**，不带任何 flag（区分大小写）。要一次放过多个写 `(a|b)`。
  直接写正则正文，**不要写 `/.../` 定界符**（那会被当成字面斜杠）。
- 匹配对象是模型给出的 `command` **原文**：不展开变量、不做 shell 解析；首尾空格/换行也算。
- **必须整条命令匹配**，不是「包含」也不是「前缀」。`^git pull` 这种会作废（连 `$` 都没有），
  因为 `git pull; rm -rf ~` 也能被前缀匹配放过。
- 除了 `^`/`$`，匹配时还要求命中区间覆盖整条命令。原因是 JS 的 `$` 在「末尾换行之前」也成立：
  `^git status$` 能匹配 `"git status\n"`，本插件用长度校验把这个口子堵掉。
- `.` / `.*` **不匹配换行**。多行命令要么写 `[\s\S]*`，要么给整段脚本单独写一条规则。
- 匹配在主进程里跑；别写嵌套量词（如 `(a+)+`）这种会回溯爆炸的正则，卡住会拖慢审批。
- 例：
  - `^git commit -m '.*'$` —— bash 里单引号提交信息；
  - `^git commit -m ".*"$` —— PowerShell 里双引号提交信息；
  - `^git commit -m ('.*'|".*")$` —— 两种引号都认；
  - `^git pull origin main$` —— 只放过这一条；
  - `^git pull( origin [A-Za-z0-9._/-]+)?$` —— `git pull` 与 `git pull origin <分支>`；
  - `^npm run (build|test)$`、`^pnpm (build|test)$`。
- 别写 `^.*$`（等于把审批关了）；别写 `^git .*$`（强推、`reset --hard` 都会被放过）。

## 热更

每次 `approval/request` 前对 `allow.json` 做一次 `stat`，比对 `mtimeMs` 和 `size`：

- 变了就重读、重编译、立刻按新规则走；**不装 watcher、不重启 DSH**；
- 没变就复用上次编译结果，开销可忽略；
- 全局规则和项目段在同一个文件里，改哪一段都是同一次热更；
- 极少数文件系统时间粒度粗、且改完大小与 mtime 都没变时，可能这一轮读不到；再存一次即可。

坏文件不会让插件崩：坏 JSON / 顶层结构错 → 整份作废；`projects` 段或单个项目项坏 → 只忽略
坏的那一块；单条规则错 → **只作废该条**，其余规则照常生效。所有情况都 fail-closed，并把诊断
追加到 `<dataDir>/config-errors.log`（一行一条 JSON：`ts` / `source` / `file` / `ruleId` / `error`）。

## 审计

每次真正走到审批的 `pwsh` / `bash` 请求追加一行到 `<dataDir>/approvals.jsonl`：

```json
{"ts":"2026-11-01T15:00:00.000Z","tool":"pwsh","command":"git status","outcome":"auto-allowed","rule":"read-only-git","reason":null}
```

- 六个键**永远都在**，缺值写 `null`，方便统计会话直接 `group by`：
  - `outcome`：`"auto-allowed"`（自动同意）或 `"asked"`（交回下游问了人）；
  - `rule`：命中的规则 `id`；没命中为 `null`；
  - `reason`：`asked` 的原因——`no-rule` / `deny-rule` / `cache-miss` / `tool-mismatch` /
    `call-id-missing` / `evaluation-error: …`；`auto-allowed` 为 `null`；
  - `command`：命令原文（`asked` 且拿不到命令时为 `null`）；
  - `ts`：UTC ISO 8601。
- 只记「走到审批」的请求；本来就不需要审批的命令不会出现。其他工具的审批也不记。
- 文件里是**命令原文**，可能带 token / 密码等参数；它只该留在本机，不要放进仓库或共享目录。
- 文件只追加、不自动轮转；统计会话读完后自己截断即可（别在审批进行时写它）。
- 写失败（目录不可写、磁盘满）只打一条 `console.warn`，**不影响审批结果**。

## 风险

**提权审批也在白名单范围内**：命中 allow 就自动同意 `sandbox_permissions` 的提权，
那一次调用会以更宽的模式执行（例如 `danger-full-access`），**写隔离/只读对这次调用不再成立**。
安全完全由规则的严格度负责：

- 只写你天天用、参数形态固定的命令；不要用 `.*` 兜住整个子命令树；
- 用 `deny` 做刹车：强推、`git reset --hard`、`rm -rf`、`Remove-Item -Recurse` 等；
- 规则越宽，自动同意的越不可挽回。写宽了等于把审批关掉。
- **写坏的 deny 规则不会生效**（不会变成「一律多问」），只是这道刹车没了；改完配置看一眼
  `config-errors.log`，确认没有规则被作废。
- **`dataDir` 必须在工作区外**；配到工作区里，模型就能改配置给自己放行。默认路径是安全的。

另外：白名单命中的是「命令 + 工具名」，不解析命令内容。同一条命令换个写法（加 `;`、
前后拼别的命令、多行脚本）就不会命中——这是刻意的 fail-closed，见「不做什么」。

## 不做什么

- **不读工作区里的配置**：项目目录里的 `.dsh\approval-allow.json` 等连 `stat` 都不做；
  配置只在 `dataDir`。
- **不建项目子目录、不按功能拆入口**：所有规则都在同一个 `allow.json`，`dataDir` 只允许
  `allow.json` / `approvals.jsonl` / `config-errors.log` 三个文件。
- **不拆复合命令**：`;`、`&&`、`||`、`|`、换行都不拆。一条规则要么匹配整条命令，要么不匹配。
  要放就写整条正则。
- **不管 `ssh_run`**：那套多选卡是 `dsh-ssh-remote` 自己的审批通道，不经过 `approval/request`
  的这条白名单。也不管 fs 写文件等其他工具的审批。
- **不做前缀/包含匹配**：`match` 必须 `^…$`，失配即作废。
- **不做卡片上的实时交互**：没有「总是允许」按钮；名单由你/另一个会话直接改文件维护。
- **不绕过沙箱**：只跳过「问」，不改变 sandbox 的判定。
- **不自动创建规则文件**：目录/文件不存在就等于没有规则；需要时自己建。

## 更新

| 你改了什么 | 怎么生效 |
| :--- | :--- |
| `index.js`、`lib/*.mjs` | **重启 DSH**（ESM 模块缓存 + profile 不热重载源码） |
| `allow.json`（全局规则或 `projects` 段） | **不用重启**，下一次审批请求即生效 |
| patch 行的 `dataDir` / `enabled` / `debug` | **重启 DSH** |
| `README.md` / `DECISIONS.md` | 无影响 |

## 自测

```powershell
node dsh-approval-allow\tests\allow.test.mjs
```

纯 Node + `assert`，不用 `node --test`（本机沙箱下 test runner 会 `spawn EPERM`）。
覆盖锚定校验、提交命令匹配/不匹配、deny 优先、工具过滤、项目标识、单一配置文件、工作区配置
忽略、`projects` 段异常、全局/项目合并、坏 JSON、坏正则、热更、缓存命中/未命中、callId 缺失、
非 shell 工具、审计字段与写失败等 28 项。

## 已知限制 / 未验

- 没有在真实 DSH 进程里挂载过（本 worktree 只跑了纯 Node 自测）；`approval/request` 与
  `tools/pre-execute` 的事件签名按 DSH 源码核对，但未在真机上走一次「该不问的不问、该问的还问」。
- 项目标识依赖 `workingDirectory` 服务的实际取值；测试里用假上下文，真实多项目会话未验。
- 项目根是按「当前工作目录」直读，不向上找 `.git`：在项目子目录里 `cd` 过就按子目录的标识找
  项目段，而不是父项目的段。
- 若别的插件在 `tools/pre-execute` 更早的位置直接返回 `ask`/`deny`、没有调用 `next()`，
  本插件来不及缓存命令，那次审批会照常问（fail-closed）；这是刻意的，不猜命令。
- 缓存的 callId 在 10 分钟内保留；同一 callId 的后续审批（例如先普通审批、再提权审批）会继续用同一条命令。
