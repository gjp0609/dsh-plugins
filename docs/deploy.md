# 部署：正式环境怎么更新（`tools/deploy.ps1`）

> **谁维护**：改部署流程的人（协调会话）改脚本时顺手改本文件。
> **什么时候读**：要让改动上线之前、想确认生产在哪、要回滚、要改 profile 的 `link:` 之前。
> **事实来源是脚本**：`tools/deploy.ps1` 与 `tests/deploy.ps1`。本文件与它们冲突时以脚本为准，并回来把这里改对。

## 1. 两个环境是两棵物理上独立的树

| | 正式环境（生产） | 测试环境（开发） |
| :--- | :--- | :--- |
| 在哪 | `%LOCALAPPDATA%\dsh-plugins\production\` | 仓库根与 `.agents\worktrees\<名字>\` |
| 是什么 | **真实拷贝**（不是 junction、不是 `link:` 到仓库） | 源码树，随便改、随便构建、随便删 |
| 谁加载 | profile 里三个插件的 `link:` 指向它 | 没人加载 |
| 谁能改 | **只有 `tools/deploy.ps1 -Tag <tag>`** | 任何会话、任何子智能体、任何工具 |
| 用途 | 只接受"部署"这一个动作 | 开发、调试、验证、出图、跑守卫 |

由此得出三条：

1. **在仓库根改代码、跑构建、覆盖 `dist/index.html` 都不会上线**——DSH 只读生产树；
2. `git merge` 只是"把改动放进测试树"，**不再等于上线**；
3. 上线只有一条路：**打 tag → 跑部署脚本 → 重启 DSH**。

## 2. 上线四步

```powershell
# 1) 测试树里验证完，提交干净（部署脚本会检查 git status --porcelain 为空）
git status --short

# 2) 改了 dsh-ssh-remote 就必须重新打包（产物 index.bundle.js 入库，见第 5 节）
cd dsh-ssh-remote
npm run build
cd ..
git add dsh-ssh-remote/index.bundle.js
git commit -m "构建：重新打包 ssh-remote"

# 3) 给当前 HEAD 打 tag，再部署（tag 必须就钉在 HEAD 上，祖先上的 tag 会被拒绝）
git tag v2026-10-30
pwsh -File tools\deploy.ps1 -Tag v2026-10-30

# 4) 重启 DSH（脚本只换了磁盘上的文件，正在跑的宿主还拿着旧模块）
```

部署成功后脚本最后打印的一定是：

```text
已部署 <tag>（<commit 前 8 位>），文件 <N> 个 → C:\Users\<你>\AppData\Local\dsh-plugins\production
依赖：dsh-ssh-remote 走 index.bundle.js（单文件，无 node_modules）
==================================================
  下一步：重启 DSH 才生效
==================================================
```

（`<N>` 随插件文件增减变化，别当成固定值；最近一次 v0.5 是 62 个文件。）

## 3. 命令示例

```powershell
# 正常部署（-Tag 必填；不带就直接拒绝，退出码 1）
pwsh -File tools\deploy.ps1 -Tag v2026-10-30

# 只看会拷什么、拷到哪，不写任何文件（校验照跑：tag、干净、产物）
pwsh -File tools\deploy.ps1 -Tag v2026-10-30 -DryRun

# 回滚：把最近一份 production.bak.<时间戳> 换回来，并把当前那份改名留档
pwsh -File tools\deploy.ps1 -Rollback

# 只看看会回滚到哪一份（同样不写文件）
pwsh -File tools\deploy.ps1 -Rollback -DryRun
```

| 参数 | 默认 | 作用 |
| :--- | :--- | :--- |
| `-Tag` | 无（必填） | 必须存在，且 `git rev-parse <tag>^{commit}` 等于 HEAD |
| `-Root` | `%LOCALAPPDATA%\dsh-plugins\production` | 正式树根。**测试用它指到临时目录**，不要拿它改真生产 |
| `-Source` | 脚本所在仓库的 `git rev-parse --show-toplevel` | 测试树根。不硬编码盘符，指到别处时要真的是仓库顶层 |
| `-DryRun` | 关 | 只打印清单与目标路径，不写任何文件 |
| `-Rollback` | 关 | 换回最近一份备份（当前那份先改名留档） |

## 4. 生产树长什么样

```text
%LOCALAPPDATA%\dsh-plugins\
├── production\                        ← 当前生效的那一份
│   ├── deploy.json                    ← tag / commit / deployedAt / files / bundles / bundleSize / source
│   ├── dsh-approval-notifier\         ← 源码形态：index.js、package.json、locale\、scripts\…
│   ├── dsh-approval-allow\            ← 源码形态：index.js、package.json、lib\、scripts\
│   ├── dsh-ssh-remote\                ← 打包形态：index.bundle.js、package.json、cordis.patch.yml、scripts\、lib\
│   ├── shared\
│   │   └── ui-card\                   ← *.ps1 + dist\index.html + assets\（没有 app\、debug\、demo\）
│   └── vendor\
│       └── webview2\                  ← Microsoft.Web.WebView2.Core.dll / .WinForms.dll / WebView2Loader.dll
├── production.bak.20261030-093000\    ← 每次部署前自动留档，只保留最近 3 份
└── production.bak.20261029-213000\
```

几个容易问的点：

- **`shared\` 必须跟插件同级**：用卡片的两个插件（`dsh-approval-notifier`、`dsh-ssh-remote`）都是**从自己目录向上逐级**找 `shared\ui-card`（最多 6 层），
  所以插件在 `production\dsh-approval-notifier`、外壳在 `production\shared\ui-card` 时，从
  `production\dsh-approval-notifier\scripts\ui` 往上第 4 层正好命中。把外壳塞进插件目录或换成别的层级，
  卡片会起不来（审批退回浏览器、ssh 卡直接失败）。
- **`vendor\webview2` 也是必需的**：`webview2-runtime.ps1` 同样向上找 `vendor\webview2`，从
  `production\shared\ui-card` 往上第 3 层命中。少了三个 DLL，卡片根本起不来——所以部署脚本会搬它们，
  也把"清单里必须有这三个 DLL"作为硬校验。
- **`dsh-ssh-remote` 在正式树里没有 `index.js`、没有 `pnpm-lock.yaml`、也没有 `node_modules`**：
  它上线的是**单文件产物** `index.bundle.js`（`ssh2` 已内联）。源码入口 `index.js` 只留在仓库里，
  部署脚本的白名单不接受它。这也是 `Cannot find module 'asn1'` 那类事故的根治办法：生产树里没有
  依赖树可装、也没有"装漏一个包"的余地。
- **`dsh-approval-notifier` 保持源码形态**：它没有运行时依赖，`index.js` 直接加载，改起来也直观。
- **`dsh-ssh-remote` 的 `package.json` 是部署时改写的**（见第 5 节）：脚本在正式树那边把 `main` 与
  `exports["."]` 指到 `./index.bundle.js`、删掉 `dependencies`，仓库里那一份保持开发形态。
- **没有 `.git` / `app\` / `tests\` / `*.md`**：生产树里只有运行时需要的东西。源码、依赖、测试、
  文档都不进生产，于是"在生产上手改一行"连工具都不顺手——这是"上线要变难"的一部分。

## 5. 为什么不再需要 `node_modules`（打包规则）

`dsh-ssh-remote` 的依赖（`ssh2` 及其 `asn1` 等）在**开发时**打进一个文件：

| 事项 | 规则 |
| :--- | :--- |
| 谁产生产物 | `dsh-ssh-remote` 目录里的 `npm run build` |
| 产物在哪 | **插件根目录**的 `index.bundle.js`（不是 `dist\`——它用 `import.meta.url` 相对定位 `scripts\`） |
| 产物要不要入库 | **要**。和 `shared/ui-card/dist/index.html` 一样，属于"开发时构建、产物入库" |
| 生产树要不要装依赖 | **不要**。部署完直接重启即可 |
| 改了源码怎么办 | 改 `index.js`/`lib\` → `npm run build` → 提交 `index.bundle.js` → 再部署 |

部署脚本对产物有两条**硬校验**（任一不满足就拒绝，一个字节都不写）：

1. `dsh-ssh-remote/index.bundle.js` 不存在 → 报错并提示先跑 `npm run build`；
2. `index.bundle.js` 的修改时间**早于** `index.js` → 说明改了源码却没重新打包，同样拒绝。

第 2 条依赖 `git` 之外的文件时间：`git checkout` 出来的文件时间戳相同，所以"不早于"是可以通过的；
只要重新打包，产物一定比源码新。

### 生产端的 `package.json` 怎么改写

部署脚本把 `dsh-ssh-remote/package.json` **复制到正式树之后**，只改正式树那一份：

- `main` → `./index.bundle.js`；
- `exports["."]` → `./index.bundle.js`（其余子路径导出，如 `./client`，原样保留）；
- 删掉 `dependencies` 字段（生产不装依赖，留着只会让人误以为要去 `npm install`）；
- `files` 里若含 `index.js`，换成 `index.bundle.js`；
- `name` / `type` / `dsh` 等其它字段原样保留。

**仓库里那份 `package.json` 不动**：它描述的是开发形态（`main` 指向源码、有 `dependencies`），
仓库里要能 `npm test`、`npm run build`。`tests/deploy.ps1` 会断言"源树那份没被改写"。

## 6. 为什么生产要放 `%LOCALAPPDATA%`

- **物理上离开仓库**：只要生产还在仓库根，"改个文件"就还是等于上线。挪到用户目录后，仓库根的
  未提交改动、`git merge`、`npm run build` 都碰不到生产。
- **一棵独立的、可整体改名的树**：备份与回滚就是同级目录改名（`production` ↔ `production.bak.<时间戳>`），
  不涉及逐文件比对，失败也能整棵换回来。
- **路径稳定**：profile 在 `~/.dsh` 下，两者都在当前用户目录里，是同一台机器上的稳定绝对路径；
  不写系统目录、不需要管理员权限。
- **只有一条入口**：`tools/deploy.ps1 -Tag <tag>`，而且它自己会校验 tag、工作区干净、产物单文件。

## 7. profile 怎么指向生产（由协调会话做）

**现状（2026-11-02 部署 v0.5 后）**：三个插件都已 `link:` 到生产树下的同名目录，profile 里不再指仓库根：

```text
dsh-approval-notifier  →  %LOCALAPPDATA%\dsh-plugins\production\dsh-approval-notifier
dsh-approval-allow     →  %LOCALAPPDATA%\dsh-plugins\production\dsh-approval-allow
dsh-ssh-remote         →  %LOCALAPPDATA%\dsh-plugins\production\dsh-ssh-remote
```

核对方法（不要靠日志或进程推断）：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"    # dependencies 里的 link: 目标
```

要点：

- 三个 `link:` 都指向 `production\` 下的同名目录，**不要**指仓库根；
- 生产树的层级不要动（插件与 `shared\`、`vendor\` 同级，见上一节），否则卡片找不到外壳与 DLL；
- 改 profile 属于工作区外写入（需要一次 `danger-full-access` 批准），由**协调会话**做，子会话不做；
- 改完**重启 DSH** 才会加载新的插件路径（**例外**：profile 的 `patchReload: live` 会让「往 `bundles` 里加/删条目」即时生效，见下条）。

### 新增一个插件（2026-11-02 实测）

三件事按顺序做完即生效，**不需要重启**：

1. `tools\deploy.ps1 -Tag <tag>` 把插件拷进生产树（脚本已按 `$script:PluginNames` 认插件，别手工拷）；
2. profile 的 `package.json`：`dependencies` 加 `"<插件>": "link:<生产树路径>"`，`dsh.profile.bundles` 加一行同名条目；
3. 在 `%USERPROFILE%\.dsh\profiles\web\node_modules\` 下建 **junction**（`mklink /J`）指向生产树目录——另外两个插件就是 junction，不跑 `pnpm install` 也能解析（`Node` 按目录查包）。

实测依据（`dsh-approval-allow`）：第 2、3 步做完后，宿主立刻挂载了新插件（`patchReload: live`），审计文件开始出现记录，无需重启。改**已加载插件**的路径仍要重启。

注意：`pnpm-lock.yaml` 这时与 `package.json` 不一致。下次在 profile 里跑 `pnpm install` 会按 `link:` 重新链接并更新锁文件，**不会**破坏 junction；但**不要**跑 `--frozen-lockfile`。

## 8. 部署时脚本会拦什么、会做什么

不满足就**拒绝**（退出码 1，一个字节都不写）：

1. 没给 `-Tag`；
2. `refs/tags/<tag>` 不存在；
3. tag 不钉在当前 HEAD（在祖先上、或完全无关，报错里会写出两边的 commit）；
4. `git status --porcelain` 非空（有未提交改动）；
5. `shared\ui-card\dist\index.html` 不存在，或不是单文件产物（有 `<script src>` / `<link href>`）；
6. `dsh-ssh-remote\index.bundle.js` 不存在（报错里提示先跑 `npm run build`）；
7. `dsh-ssh-remote\index.bundle.js` 比 `index.js` 旧（改了源码没重新打包）；
8. `-Root` 落在要被拷贝的目录里（会自己拷自己）。

满足之后按顺序做：

1. 现有 `production` 改名 `production.bak.<yyyyMMdd-HHmmss>`（同一秒重复部署时补 `-2`），只留最近 3 份；
2. 按白名单逐个文件拷贝到 `production\`；`dsh-ssh-remote` 只拷 `index.bundle.js`、`cordis.patch.yml`、
   `package.json` 与 `scripts\`、`lib\`（源码、锁文件、依赖、测试都不搬）；
3. 改写正式树里 `dsh-ssh-remote\package.json`（`main` / `exports["."]` 指到产物、删 `dependencies`）；
4. 写 `production\deploy.json`（`tag` / `commit` / `deployedAt` / `files` / `bundles` / `bundleSize` / `source`）；
5. 打印收尾行、依赖形态（`依赖：dsh-ssh-remote 走 index.bundle.js（单文件，无 node_modules）`）
   与"下一步：重启 DSH 才生效"。

**拷贝中途任何异常**：删掉本次产出的半成品、把备份换回原名、报错退出（非零退出码），正式树保持
部署前的状态。回滚只认最近一份备份，回滚本身也会把当前那份留档，所以"回滚的回滚"也能做。

## 9. 沙箱下的写法约束（改脚本前先看这条）

`tools/deploy.ps1` 里所有 `git` 调用都写在**脚本作用域**，并用 `cmd /c "... > 临时文件"` 把输出落到
文件再读。原因：受限沙箱下 PowerShell 直接捕获原生输出会失败
（`StandardOutputEncoding is only supported when standard output is redirected`），而**包进函数**会让
PowerShell 把该命令的 stdout 接进管道，于是必然踩到这条（实测）。

所以：

- 不要为了"更好看"把 git 调用挪进函数；
- 运行 `deploy.ps1` **不要接管道**（`.\deploy.ps1 -Tag x | Tee-Object` 之类）；
- 测试同理：`tests\deploy.ps1` 每次调用都是"算命令串 → 脚本作用域发 cmd → 读结果"。

### 构建（esbuild / vite）也要躲这条

`npm run build` 在**默认临时目录**里清理文件会 `Access is denied`，构建当场失败。
构建前把临时目录指到工作区内（在副本目录里执行，别 cd 到仓库根）：

```powershell
$tmp = Join-Path (Get-Location).Path '.tmp\build-tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP  = $tmp
npm run build   # 产物在副本的 dist 下，拷回 worktree 再提交
```

这条原本在 `AGENTS.md` §1，2026-10-30 精简 AGENTS 时挪到这里（命令类细节不进规范）。

## 10. 测试

```powershell
& .\tests\deploy.ps1
```

- 全程用 `-Root` 指到工作区里的临时目录（`.agents\deploy-tests\...`，被 `.gitignore` 忽略），
  **不碰真正的 `%LOCALAPPDATA%`**；
- `-Source` 也不是工作树，而是同一临时目录下的一份**工作树副本**，副本自带一个新建的 git 仓库：
  - 生产树只带打包产物，真实产物要 `npm run build` 才有，测试不真打包；
  - 往工作树里丢一个未跟踪的假产物会让 `git status` 变脏，部署的干净校验会先把它挡下来，
    测不到想测的分支；
  - 副本里造几个字节的假 `index.bundle.js` 并提交，工作树一个字节都不动，测试 tag 也只在副本仓库里打；
- tag 是临时打的（`deploy-selftest-*`：A/B/C 在 HEAD 上，`old` 在 `HEAD~1`（没有产物的那一版）上，
  `missing` 不打），跑完必定删掉；收尾会再查两遍——副本仓库与工作树里都没有测试 tag；
- 覆盖的断言：不带 tag / tag 不存在 / tag 在祖先上 / 工作区脏 / **缺产物** / **产物比 `index.js` 旧**
  （用 `Set-ItemProperty -Name LastWriteTime` 造）/ 正常部署（清单与三棵树 + 外壳产物）/
  生产里**没有** `index.js`·`node_modules`·`pnpm-lock.yaml`、**有** `index.bundle.js` /
  生产 `package.json` 的 `main`·`exports["."]`·`dependencies` 与 `files` 改写正确、源树那份没被动 /
  `deploy.json` 的 `bundles`·`bundleSize` / `dsh-approval-notifier` 仍是源码形态 /
  生产树里没有 `node_modules`·`app`·`.git`·`tests`·`*.md` / 连跑两次出一份备份 / 回滚 / `-DryRun`
  一个文件都不建、清单里有产物没有源码 / 拷贝失败自动回滚；
- 测试要求**工作区干净**（脚本自己有干净校验）：先提交再跑。
