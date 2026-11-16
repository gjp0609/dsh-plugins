# 决策记录（ssh 插件）

> 历史证据路径说明：本文与 `shared/ui-card/DECISIONS.md` 里出现的 `out\*.png`、`out\*.measure.json`
> 是 2026-11-02 之前临时出图的落点。该目录已删除，临时产物改落 `.session-files\tmp\`，
> 正式截图统一进 `docs\images\`（见 `docs/repo-layout.md` §4）。引用这些路径只表示「当时看过这张图」。


改这块代码之前先读这里：一条一段，写清「为什么这么做」和「怎么复验」，**被否掉的方案也留在里面**，
下次不用重新发现。跨插件通用的结论放仓库根 `docs/`，不放这里。

## D-30 `nativeSelector` 改名 + 审计补 `phase`（BACKLOG 第 9 条 / 第 26 条遗留小项）

- **现象（两件互不相干的小问题）**：
  1. `lib/approval.mjs` 里那个函数叫 `nativeSelector`，但它的参数是 `dialog`（共享外壳的桌面卡片），
     返回的是「把审批问题交给卡片、再把勾选标签映射回行号」的函数；它**从来没选过原生窗口**。
     C-10 之后宿主内置弹窗那条路已经删了，名字里剩下的「native」是历史包袱——照着名字改代码的人
     会以为这里还有「原生弹窗」分支。
  2. 审计只记「跑完」之后的结果：一次 `ssh_run` 卡在等卡片、卡在建连接、还是卡在执行中，日志里
     完全看不出来。D-26 那次排查只能靠会话日志「只有 `tool/call`、没有 `tool/result`」反推，
     还差点反推错方向（以为是执行卡住，实际卡在等卡片）。
- **判定**：都是问题，但都在观测/命名层面，不改行为：① 名字与语义不符，属于会持续误导的债；
  ② 审计缺阶段，属于「下次同类事故还要重新人肉推理」的债。按 C-07，这里没有不可挽回的错误，
  所以只做最小改动，不加新机制。
- **根因**：
  1. 这个函数诞生时它的返回值确实是「选一个审批通道」（宿主弹窗 or 桌面卡），后来通道只剩一条
     （C-10 / D-22），函数名没跟着收；`askApproval` 的 `fallbackSelect` 参数名同理。
  2. 审计的 `record()` 是「一次操作一条结果」的模型，没有「进行中」的概念；卡住时工具永远走不到
     写结果那一步，所以日志里什么都不会出现——**而那正是最需要日志的时刻**。

### 一、改名（纯改名，行为零变化）

| # | 旧值 | 新值 | 位置（**改前**行号） | 处数 |
| :-- | :-- | :-- | :-- | :-- |
| 1 | `export function nativeSelector(dialog)` | `export function cardApprovalChannel(dialog)` | `lib/approval.mjs:181`（定义，含 docstring） | 1 |
| 2 | `import { … nativeSelector }` → `fallbackSelect: nativeSelector(dialog)` | `import { … cardApprovalChannel }` → `fallbackSelect: cardApprovalChannel(dialog)` | `lib/run.mjs:10`、`lib/run.mjs:228` | 2 |
| 3 | 同上 | 同上 | `lib/copy.mjs:24`、`lib/copy.mjs:765` | 2 |
| 4 | 注释里的 `nativeSelector(dialog)` | `cardApprovalChannel(dialog)` | `tests/run.test.mjs:56` | 1 |

合计 **6 处**引用（改前 `grep -n nativeSelector` 6 条，改后 0 条）。参数、返回值、错误文案一个字没动：
`(dialog) => undefined | (question, { signal }) => Promise<number[]>`，找不到卡片仍然返回 `undefined`，
`askApproval` 仍然抛原来那条 `ApprovalUnavailableError`。

为什么选 `cardApprovalChannel` 而不是题目举的那两个例子：

- `resolveSelectorPath`：还在说「selector / path」，把「选通道」当成了它的职责，可它现在只做一个
  通道（C-10），名字里不该再暗示有岔路；
- `pickApprovalChannel`：`pick` 同样暗示「从多个里挑一个」，而它拿到 `dialog` 就只产出那张卡的问法，
  拿不到就返回 `undefined`——它是「把卡片接成通道」，不是「挑通道」；
- 选 `cardApprovalChannel`：参数是卡（`dialog`），返回的是「问一次卡片、拿回勾选行」的通道函数，
  和 `askApproval({ fallbackSelect })` 的用法一一对应；没有卡片时返回 `undefined` 也读得通
  （「没有卡片通道」）。

### 二、审计补 `phase`

取值只有三个（`audit.mjs` 导出的 `PHASES`）：`approval` / `connect` / `exec`。

**写法：进入某阶段时追加一条**（`event: "enter"`），跑完再按目标追加结果（`event: "result"`），
不覆盖、不合并。选它而不是「一次运行一条带 `phases` 时间线的记录」，理由：

- 卡住时工具**不会**走到「写汇总」那一步——汇总记录等于不存在，而那正是要排查的时刻。
  进入阶段就落盘，日志里至少留下「最后一次动静停在 `approval`，之后 40 分钟没有下一条」这种证据。
- 追加模型不需要在内存里维护时间线，也不用在异常/取消/提前返回的每条路径上补写汇总
  （那些路径本来就有七八条，最容易漏）；只要还有下一条阶段事件，时间线自然闭合。
- 代价：一次调用会有多条记录，读的时候得按 `callId` 过滤。`callId` 取 `exec.callId`（宿主给的），
  是同一批记录唯一的关联键；没有它，并发的两次 `ssh_run` 会混成一条假时间线。为此新增了 `callId` 字段。

每条记录的实际形状（`audit.mjs` 白名单已放行 `event` / `phase` / `callId` 三个新字段；
**既有字段一个没删、没改名**）：

```json
{"ts":"2026-10-29T01:00:00.000Z","kind":"run","event":"enter","phase":"approval","callId":"call-7"}
{"ts":"2026-10-29T01:00:02.000Z","kind":"run","event":"enter","phase":"connect","callId":"call-7"}
{"ts":"2026-10-29T01:00:04.000Z","kind":"run","event":"enter","phase":"exec","callId":"call-7"}
{"ts":"2026-10-29T01:00:06.000Z","kind":"run","target":"192.168.1.11:22 · Web 1","command":"uname -a","approved":true,"exitCode":0,"ms":40,"stdoutBytes":81,"stderrBytes":0,"event":"result","phase":"exec","callId":"call-7"}
```

（上面四条是用 `createAudit` 真实落盘后读回的原样输出；字段顺序由白名单决定，新字段排在既有字段之后，
老字段的位置没变。）

写入点（都在各自 `execute` 里，只加不挪）：

| 工具 | `approval` | `connect` | `exec` |
| :-- | :-- | :-- | :-- |
| `ssh_run` | `askApproval` 之前 | 等预连接落地之前（仅当有远端目标） | 执行循环之前（仅当有勾选的行） |
| `ssh_copy` | `askApproval` 之前 | 预检循环之前（预检要先连两端；全 WSL 也记，见下第 3 点） | 搬运循环之前 |

两个容易误读的点，写在这里：

1. **`ssh_run` 的预连接在弹卡前就发起了**（K-003，用读卡时间覆盖握手）。所以 `connect` 事件的 `ts`
   不是「开始握手」的时刻，而是「工具开始等握手落地」的时刻——`phase` 回答的是「现在卡在哪」，
   不是「网络动作何时开始」。若按前者记，卡在卡片上时日志的最后一条会变成 `connect`，
   恰好掩盖要排查的现象。
2. **纯 WSL 的 `ssh_run` 没有 `connect`**：WSL 不建 SSH 连接，硬记一条 `connect` 会让时间线说谎。
   三个取值是「字段允许的取值」，不是「每次调用都要凑齐三遍」。
3. **搬运的 `connect` 覆盖的是「预检」这段窗口，哪怕两端都是 WSL**：预检要做网络/端点 I/O，
   它一样会卡住；如果只在「有远端」时记，全 WSL 的搬运卡在预检就又变成一条记录都没有——
   那正是这次要消灭的盲区。所以搬运不细分「有没有远端」，`connect` 一律落在预检开始处。

不记的东西：密码、命令输出、卡片 Markdown（原有约束不变）；阶段事件里连 `target` / `command` / 行数
都没记——它只回答「卡在哪、卡多久」，具体是哪条命令由同一次调用的 `result` 或会话日志按 `callId` 对上。

### 三、断言改动表（旧值 → 新值）

**改名没有改任何断言的期望值**（旧名字只出现在一条注释里，注释不是断言）。下面三条是「审计变成多条
记录」这一**有意的结构变化**导致的观测面收窄，不是放宽——对结果记录本身的检查一条没减：

| # | 位置 | 旧值 | 新值 | 为什么 |
| :-- | :-- | :-- | :-- | :-- |
| 1 | `tests/run.test.mjs`「审计只记元信息」 | `assert.equal(env.audit.records.length, 1)` + `records[0]` | 先 `filter((e) => e.event === 'result')`，再 `assert.equal(records.length, 1)` + `records[0]` | 阶段事件也是审计记录；这条用例只针对结果那一条（target / command / approved / stdoutBytes / 无正文 五项断言原样） |
| 2 | `tests/run.test.mjs`「断链归因」 | `assert.equal(env.audit.records[0].dropped, true)` | `find((e) => e.event === 'result')` 后断言 `dropped === true` | 同上：`records[0]` 现在是 `approval` 阶段事件 |
| 3 | `tests/copy.test.mjs`「字节原样到达」 | `audit.records.length === 1` + `records[0]`（kind / bytes / 无内容 三项） | 先按 `event === 'result'` 过滤，再断言同样三项 | 同上 |

新增用例（没有放宽任何既有断言）：

| # | 用例 | 位置 | 钉住什么 |
| :-- | :-- | :-- | :-- |
| 1 | 审计阶段：`approval → connect → exec` 逐条追加，`callId` 串起时间线 | `tests/run.test.mjs` | 事件顺序 `enter:approval, enter:connect, enter:exec, result:exec`；三个 `phase` 取值都有落点；每条都带同一个 `callId` |
| 2 | 审计阶段：纯 WSL 调用没有 `connect` | `tests/run.test.mjs` | `enter:approval, enter:exec, result:exec`（不编一个「连接」出来） |
| 3 | 审计阶段：搬运记 `connect → approval → exec` | `tests/copy.test.mjs` | 预检在前（connect 早于 approval）；结果那一条照旧带 `bytes` |
| 4 | 审计：`phase` / `event` / `callId` 真的落盘，密码与输出正文被白名单挡掉 | `tests/audit.test.mjs` | 白名单漏一个字段，代码「记了」日志里却没有；顺手钉住 `ts` 有序（相邻之差能算阶段耗时） |
| 5 | 审计：阶段只收三个取值 | `tests/audit.test.mjs` | `phaseEntry` 对未知 `phase` 直接抛错，拼错的值不许悄悄进日志 |
| 6 | 改名完整性：旧名字在 `lib/**`、`scripts/**`、`tests/**`、`index.js`、`README.md` 里一处不剩 | `tests/audit.test.mjs` | 防止只改一半；反向断言 `export function cardApprovalChannel(dialog)` 确实在 |

### 怎么复验

```powershell
cd dsh-ssh-remote
node --test --test-isolation=none "tests/*.test.mjs"
```

→ **125 项全通过 / 0 失败**（admin 13、audit 3、copy 34、dialog 4、pool 23、run 27、state 15、wsl 6）。

工作树里没有 `node_modules` 时 `pool.test.mjs` 会因缺 `ssh2` 加载失败，这不是代码问题：从正式树接一个
junction（`node_modules` 在 `.gitignore` 里）再跑；报 `spawn EPERM` 是受限沙箱在拦管道，改直接调用。

改名核对：

```powershell
rg -n nativeSelector dsh-ssh-remote    # 改前 6 条，改后 0 条
rg -n cardApprovalChannel dsh-ssh-remote
```

审计核对（真机）：跑一次 `ssh_run`，只看审计文件——`approval` 那条与 `connect` 那条的 `ts` 之差
就是「你读卡读了多久」，`exec` 那条到 `result` 之差是命令耗时；把卡片挂在屏幕上不点，
文件里应该停在 `approval` 且不再增长。

### 没做的（范围外）

- `askApproval({ fallbackSelect })` 的参数名没改：C-10 之后它已经不是「兜底」而是唯一通道，
  但改名会连带改调用点与文档，这一轮只要求 `nativeSelector`；留作下一轮命名清理的入口。
- 没给阶段事件加 `target` / `command` / 行数：先只解决「卡在哪、卡多久」，需要时再加。
- **`package.json` 的 `scripts.test` 没有跟着加**（它只列了六组，本来就缺 `dialog`，现在又缺 `audit`）：
  该文件不在本轮的允许改动范围，README 已写明以 `node --test --test-isolation=none "tests/*.test.mjs"` 为准，
  需要协调会话补一行。
- 没动 `shared/ui-card/**`（另一路会话在改代码块高亮）；`dropped` 等既有审计字段一个字没动。

## D-31 打包成单文件 `index.bundle.js`：生产树不再需要 `node_modules`

- **现象**：2026-10-30 重启宿主后，生产树（`%LOCALAPPDATA%\dsh-plugins\production\`）里的
  `dsh-ssh-remote` 加载失败，报 `Cannot find module 'asn1'`——`ssh2` 的依赖没搬全。
- **判定**：是问题，而且是**结构性**的，不是「这次忘了装」：生产树是真实拷贝，
  `node_modules` 被部署脚本故意排除，「装一次的依赖」不属于任何一次部署产物，
  下一次改依赖就再坏一次；而且靠人记得去装，本身就不该是上线流程的一环。
- **根因**：三层叠在一起——
  1. 部署是白名单拷贝，`node_modules` 在排除表里（这条本身是对的：不该拿依赖目录去覆盖生产）；
  2. 生产树里那份 `node_modules` 是**手工**装过一次的残留，`ssh2` 的传递依赖（`asn1` /
     `bcrypt-pbkdf` / `tweetnacl` / `safer-buffer`）没有全部落进去；
  3. pnpm 的布局是 `node_modules\.pnpm\…` + 顶层符号链接/junction，**拷不动**——
     就算把目录整个搬进生产，链接也会断在别处。
- **候选**（代价按「明天改一行依赖会怎样」算）：
  - A. 生产树装 `node_modules`：每次动依赖都要人工重装，pnpm 布局不可拷贝，坏了要等重启才发现；
  - B. 把 `ssh2` 整包 vendor 进仓库，生产里从 `vendor/` 相对引用：能跑，但第三方源码入库、
    升级要手动同步两份，且 `ssh2` 的 `require('cpu-features')` 之类仍然要额外处理；
  - C. **esbuild 打成单文件 `index.bundle.js`**：依赖内联，产物一份、无链接、可拷贝。
- **结论**：选 C。单机自用、体积不是成本（AGENTS §0：本地磁盘加载、不发包），
  837.5 KB 换来「生产树只要搬文件、搬完就能跑」，比 A/B 都稳。

### 关键取舍

| 取舍 | 选定 | 理由 / 被否的方案 |
| :-- | :-- | :-- |
| 产物放哪 | **插件根目录 `index.bundle.js`** | `index.js` 的 `SCRIPT_DIR` 是 `dirname(fileURLToPath(import.meta.url)) + 'scripts'`。放 `dist/` 会让它变成 `dist\scripts\…`，DPAPI / 卡片 / CLI 三条路径全错。实测见下 |
| `main` / `exports["."]` 指哪 | **保持源码**，由部署脚本在生产改写 | 若改成指向 bundle，开发树就得每次 `pnpm build` 才生效，破坏「junction 下改一行下一次调用就生效」的体验（README「测试环境」一节的前提）；源码是开发入口、产物是生产入口，分界由 `deploy.ps1` 一处完成 |
| `cpu-features` / `nan` | **external** | `ssh2` 的可选原生加速；打包进来等于把预编译 .node 塞进产物，跨机器必坏。external 后运行时 `require` 失败，`ssh2` 自动走纯 JS 回退 |
| CJS 依赖怎么进 ESM | `--banner:js` 补 `require` / `__dirname` / `__filename` | esbuild 把 CJS 模块包进 `__commonJS`，里面的 `require('net')` 变成 `__require("net")` 代理。ESM 里 `require` 不存在 → `Dynamic require of "net" is not supported`；补上 `require` 后 `ssh2` 内联的 poly1305 胶水又引用 `__dirname` → `ReferenceError: __dirname is not defined in ES module scope`。banner 用 `createRequire(import.meta.url)` / `fileURLToPath(import.meta.url)` 补齐，两处都过 |
| `lib/client.js` 要不要也打包 | **不打包** | 它是浏览器侧半边，只 `document.createElement('style')`，**不含 `ssh2`**、没有 CJS 依赖要内联；生产照原样放 `lib\`，`exports["./client"]` 不变 |
| 产物是否入库 | **入库** | AGENTS §0「开发时构建、产物入库」；生产树由 `deploy.ps1` 搬文件，不跑构建 |

### 怎么复验

```powershell
cd dsh-ssh-remote
pnpm build
node -e "import('./index.bundle.js').then(m => console.log(Object.keys(m)))"
# → [ 'apply', 'inject', 'optionalService', 'renderHostsSection', 'resolveDataDir' ]

node --test --test-isolation=none "tests/*.test.mjs"
# → 125 项全通过 / 0 失败（admin 13、audit 3、copy 34、dialog 4、pool 23、run 27、state 15、wsl 6）
```

纯净目录（只有产物 + `scripts\` + `lib\` + `cordis.patch.yml` + `package.json`，无 `node_modules`）：

```text
EXPORTS apply,inject,optionalService,renderHostsSection,resolveDataDir
TOOLS ssh_status,ssh_admin,ssh_run,ssh_copy
SPAWN_ARGV [["pwsh",…,"-File","<clean>\scripts\unprotect.ps1","-Path","<clean>\data\vault.dat"]]
```

`SPAWN_ARGV` 是这套打包唯一真正容易坏的地方：用假 `subprocess` 截 `argv`，看第一个 DPAPI 调用
拿到的脚本路径是不是 `scripts\unprotect.ps1`（而不是源码目录、也不是 `dist\scripts`）。
负控（把同一份产物放进 `dist\` 再跑）得到 `<…>\dist\scripts\unprotect.ps1`，证明这条断言有效、不是摆设。

生产树的形态（`main` / `exports["."]` 被改写成 `./index.bundle.js`）用 junction 模拟过一次：
`import('dsh-ssh-remote')` 正常导出五个名字，`import.meta.resolve('dsh-ssh-remote/client')`
仍解析到 `lib/client.js`。

### 没做的（范围外，留给协调会话）

- **没有「产物与源码同步」的自动守卫**：改 `index.js` / `lib/**` 后忘了 `pnpm build`，
  生产跑的就是旧代码，而现有 125 项测试一条都不会红。README 已写 `pnpm build` +
  `git diff --exit-code -- index.bundle.js` 的手工核对；要变成断言（例如测试里重建一份到临时目录
  再比字节）得由协调会话来加，子会话不改测试。
- **`tools/deploy.ps1` 与 `docs/deploy.md` 没动**（不在本工作树允许改的范围）：需要
  ① 排除 `dsh-ssh-remote\index.js`；② 清单要求 `index.bundle.js`；③ 拷贝后改写
  `main` / `exports["."]`；④ `Write-DependencyHints` 对 ssh-remote 失效。清单写在 README
  「给 `tools/deploy.ps1` 的交接」里。
- 没给产物做 minify：`--minify` 能再小一半，但崩溃栈会变成不可读的短名字；本地加载不差这 400 KB，
  出问题时能直接对行号更重要。

## D-32 拆 `lib/copy.mjs`：按「路径 / 命令构造 / 条目解析 / 传输」四块切（纯结构，行为零变化）

- **现象**：`lib/copy.mjs` 843 行，是 `lib/` 里最长的一个（37 KB；第二的 `admin.mjs` 20 KB）。
  改一行 `buildSinkCommand` 也得在「审批 → 审计 → 200 行 JSON schema → 流中继」里滚一遍。
- **判定**：是问题，但只在可读性与定位成本上，**不改行为**——所以这一轮只搬符号，
  不动字符串、正则、错误文案、超时值，也不动 `tests/copy.test.mjs`（它是行为锁）。
- **根因**：一个文件里并排躺着四件互不相干的事：① 路径字符串处理（纯函数，谁都能用）；
  ② shell 命令文本的构造与对端回执的解析（纯函数，只认字符串）；③ 模型参数 → 条目 → 卡片行
  （纯函数，认识 `hosts.mjs` 的标签，不认识流）；④ 开通道、灌字节、等退出码（唯一碰 I/O 的一段）。
  前两件加第三件占了 300 行却和传输零耦合，靠读整个文件才能确认这一点本身就是成本。

### 怎么切的（以及为什么按这四条）

| 新文件 | 内容 | 依赖 |
| :-- | :-- | :-- |
| `lib/copy/paths.mjs` | `CopyError`、`shQuote`、`assertPath`、`stripTrailingSlash`、`splitPath`、`joinPath`、`formatBytes` | 无（叶子） |
| `lib/copy/commands.mjs` | `buildProbeCommand`、`parseProbe`、`parseWroteBytes`、`buildSourceCommand`、`buildSinkCommand` | `paths` |
| `lib/copy/items.mjs` | `normalizeItems`、`parseEndpoint`、`describeFlags`、`describeAction`、`itemsToRows` | `paths`、`hosts` |
| `lib/copy/transfer.mjs` | `settle`、`withDeadline`、`raceAbort`、`isEarlyClose`、`relayBytes` + 私有的 `transferItem`、`probePath`、`preflight` | `paths`、`commands`、`hosts`、`endpoint` |
| `lib/copy.mjs`（保留） | `createCopyTool` 本体 + 把上面 19 个符号**原样再导出** | 全部 |

依赖是单向的：`copy.mjs → {items, transfer, paths}`，`transfer → {commands, paths, hosts, endpoint}`，
`items → {paths, hosts}`，`commands → paths`，`paths → 无`。没有环。
选这四条而不是别的维度，是因为它们各自有**自己的失败方式**：路径错是参数错（`code: 'args'`），
命令拼错是 shell 语法/对端不认，条目错是模型给的参数不合法，传输错是流和退出码——
四类错在排查时看的是不同证据，按证据切，改哪类就只读哪一块。

### 两个与直觉不同的落点（都是为了避免环）

1. **`CopyError` 落在 `paths.mjs`，不是 `items.mjs`**。`assertPath`（paths）要抛它，
   `parseEndpoint`（items）又要用 `assertPath`；类放 items 就变成 `paths ↔ items` 互相 import。
   ESM 能跑这种环，但那正是这次要避免的东西。类搬走后 `items.mjs` 照常 import 它，
   对外导出面不变（`copy.mjs` 仍然导出 `CopyError`）。
2. **`parseProbe` 落在 `commands.mjs`**。它和 `buildProbeCommand` 是一对（一个写预检脚本、
   一个读它的 `key=value` 输出），拆开就要两个文件互相知道对方的格式。顺便记一笔：
   它在原文件里写成 `*/export function parseProbe(`（注释和 `export` 同一行），
   所以 `grep -E '^export '` 数出来是 19 个，实际导出是 **20 个**——核对导出面必须用
   `import()` 取 `Object.keys`，不能信 grep。

### 行数：`transfer.mjs` 346 行，超过 300 的目标

题目表格给 `transfer.mjs` 的 ~270 只算了那 5 个导出符号（约 102 行），但 `createCopyTool`
私有依赖的 `transferItem`（147 行，开两条通道 + 等退出码 + 三道校验）和
`probePath` / `preflight`（58 行，预检）也属于传输段，`copy.mjs` 放不下，必须住在这里。
要压到 300 以下只有两条路，都改变题目给的结构，所以没擅自做：

- 新增第 5 个模块 `copy/preflight.mjs`（约 70 行）：职责上说得通（「预检」= 只读探测 → 计划），
  但那是题目没要的第五个文件，先报给协调会话定；
- 把预检塞进 `items.mjs`（81 + 58 ≈ 140 行，仍在 180 内）：依赖方向不会成环，
  但 `items.mjs` 就会从「纯解析」变成会做 `io.runText` 的模块，把题目自己写明的分层弄脏。

### 被否的切法

- **按「导出 / 非导出」切两个文件**（`exported.mjs` + `internal.mjs`）：行数好看，但两半互相调用
  （`transferItem` 用 `buildSinkCommand`），等于造一条假边界，读代码还得跳两个文件。
- **按「纯函数 / 有副作用」切两半**：得到的 `io.mjs` 会有 500 多行，里面同时住着审批、审计、
  JSON schema、卡片渲染、流中继——混职责原样保留，只是换了个文件名。
- **把传输再拆 relay / exit / preflight 三个文件**：`preflight` 只有 58 行且和 `probePath` 是一对，
  再拆会剩下二十来行的文件，属于为凑行数硬拆。
- **目录里再套 `copy/index.mjs` 当 barrel**：import 路径会变成 `./copy/index.mjs`，
  收益只是把 `copy.mjs` 换成 `copy/index.mjs`，职责一点没变，还多一层。
- **改 `tests/copy.test.mjs` 的 import**：它是行为锁，改它等于改断言；所以 `copy.mjs` 必须
  继续原样导出全部 20 个名字。

### 怎么复验

```powershell
cd dsh-ssh-remote
node --check lib/copy.mjs          # 另外四个 lib/copy/*.mjs 同样
node tests/copy.test.mjs           # → 34 项全过（拆分前基线也是 34）
node tests/run.test.mjs            # → 27 项全过
node tests/pool.test.mjs           # → 23 项全过
```

导出面与「一字未改」的机器核对（这次实际用的两条，建议以后拆文件沿用）：

```js
// 1) 名字：拆分前后各 Object.keys(m).sort()，20 个名字逐字一致
import('./lib/copy.mjs').then((m) => console.log(Object.keys(m).sort().join('\n')))

// 2) 文本：把 git HEAD 的旧 copy.mjs 也 import 进来，逐符号比 Function.prototype.toString()
//    （函数体内注释也算在内）→ 20/20 完全相同
```

全量：`node --test --test-isolation=none "dsh-ssh-remote/tests/*.test.mjs"` → **8 个测试文件全过 /
0 失败，断言 125 条**（admin 13、audit 3、copy 34、dialog 4、pool 23、run 27、state 15、wsl 6），
和 D-30 记的基线一致。

### 没做的（范围外）

- 没跑 `pnpm build`、没碰 `index.bundle.js`：构建由协调会话做（沙箱下 esbuild 起不来），
  合并前记得 `pnpm build` 并按 D-31 核对产物与源码同步。
- `lib/` 下其它长文件（`pool.mjs`、`admin.mjs`、`run.mjs`）没动。

## D-33 拆 `lib/pool.mjs`：按「生命周期 / 建连 / 执行」三块切（纯结构，行为零变化）

- **现象**：`lib/pool.mjs` 601 行，`ConnectionPool` 一个类塞了三件互不相干的事——
  ① 池子自身的状态与回收（status/close/dropEntry/closeAll/startSweeper/sweep/enforceLimit/serial，约 87 行）；
  ② 建连（connect，146 行：认证、冷却、取消、ready 后的常驻监听器）；③ 执行（run 128 行、
  channels 43 行、openChannel 90 行）。改 `run` 的截断策略要在建连的 `ready`/`abort` 逻辑后面滚 300 行。
- **判定**：是问题，但只在可读性与定位成本上，**不改行为**——所以这一轮只搬符号，
  不动字符串、正则、错误文案、超时值，也不动 `tests/pool.test.mjs`（418 行，它是行为锁）。
- **根因**：三块的**失败方式不同**，排查时看的证据也不同。生命周期错是「该关的没关 / 该留的被淘汰」，
  证据是 `entries` 大小与 `busy` 计数；建连错是「认证 / 网络 / 取消」，证据是 `PoolError.code`
  与 `config`；执行错是「退出码 / 断链 / 输出截断」，证据是 `dropped`/`signalName`/stdout 尾部。
  按证据切，改哪类就只读哪一块。

### 怎么切的

| 新文件 | 内容 | 依赖 |
| :-- | :-- | :-- |
| `lib/pool/lifecycle.mjs` | `AUTH_COOLDOWN_MS`、`EXIT_SETTLE_MS`、`PoolError`、`status`、`close`、`dropEntry`、`closeAll`、`startSweeper`、`sweep`、`enforceLimit`、`serial` | 无（叶子） |
| `lib/pool/connect.mjs` | `connectEntry` + 私有的 `endpointOf` | `lifecycle` |
| `lib/pool/exec.mjs` | `runCommand`、`openChannels`、`openChannel`、`wrapCommand`、`tailBytes` | `lifecycle`、`connect` |
| `lib/pool.mjs`（保留） | `ConnectionPool` 类本体（12 个方法全是一行委托）+ 把 6 个符号**原样再导出** | 上面三个 |

依赖单向：`pool.mjs → exec → connect → lifecycle`，`lifecycle` 不 import 任何 pool 模块。没有环。

### 一个与直觉不同的落点：常量与 `PoolError` 放进了 `lifecycle.mjs`

题目给的表格写的是「`pool.mjs` 保留 `AUTH_COOLDOWN_MS`/`EXIT_SETTLE_MS`/`PoolError`」，
但 `connect.mjs` 要 `PoolError` + `AUTH_COOLDOWN_MS`、`exec.mjs` 要 `PoolError` + `EXIT_SETTLE_MS`。
它们若留在 `pool.mjs`，两个模块就只能**反向 import `pool.mjs`**，正好是这次要避免的环
（ESM 能跑这种环，但初始化顺序会变成「先加载 pool.mjs 才敢执行 connect」）。
所以这三个符号下沉到唯一不 import 别人的 `lifecycle.mjs`，`pool.mjs` 用
`export { … } from './pool/lifecycle.mjs'` 再导出——**对外名字与对象身份都不变**
（`PoolError` 是同一个类，`instanceof` 在 `pool.test.mjs` 里照旧成立）。
这和 D-32 把 `CopyError` 放进 `paths.mjs` 是同一手法。

### `this` 显式化的边界

- **只显式化「池子本身」**：模块函数的第一个参数是 `pool`（就是原来的 `this`），
  `host`/`entry`/`signal`/`command` 本来就是参数，不动。函数体内**不出现 `this`**。
- **没有把 `this` 拆成 6 个参数**（entries、queues、authCooldown、sweeper、getSettings、now）：
  那样 `dropEntry`/`enforceLimit` 要同时收 entries + now + getSettings，签名长短不一，
  而且 `connect` 还得再收 `vault`/`createClient`——改动面比搬代码大得多，
  违反「纯结构拆分」的边界。
- **边界就在这**：依赖从隐式 `this` 变成显式 `pool` 参数，但 `pool` 的**字段形状**
  （`entries`/`queues`/`authCooldown`/`sweeper`/`getSettings`/`vault`/`createClient`/`now`）
  仍由构造函数约定，没有引入 interface 或类型声明。个人自用插件不为「将来换实现」付这个成本（D-05）。
- **类方法签名逐字保留**，包括 `{ signal } = {}`/`{ cwd, timeoutMs, signal } = {}` 这种默认参数——
  一是语义不变，二是 `Function.prototype.length` 也不变（`connect` 仍是 1）。
  方法体只剩 `return xxx(this, …)` 一行。

### 被否的切法

- **常量与 `PoolError` 留在 `pool.mjs`，`connect`/`exec` 反向 import**：造环，见上一节。
- **新增第 4 个 `lib/pool/errors.mjs`（约 20 行）**：语义上最干净，但题目只给了三个文件；
  D-32 遇到同类问题（`transfer.mjs` 超长时的第 5 个文件）也是先报协调会话定，没有擅自加。
- **通过 `pool.PoolError` 注入错误类**：`new pool.PoolError(...)` 让错误构造变成运行期查表，
  `instanceof` 还依赖构造函数赋值时机，比直接 import 更难读、更容易坏。
- **把 `channels`/`openChannel` 挪进 `connect.mjs`**：能压 `exec.mjs` 的行数，但
  「建连」文件里长出「开字节流通道」，名字与内容不符，且 `connect.mjs` 会涨到约 295 行，
  只是把超标从 A 文件搬到 B 文件。
- **留在 601 行只加 `// #region` 注释**：`grep`/折叠能省一次跳转，但「改 run 要滚过建连」的成本一点没变，
  而且这类注释一旦不同步就是新的误导。
- **改 `tests/pool.test.mjs` 的 import**：它是行为锁，改它等于改断言；所以 `pool.mjs` 必须继续导出
  原来的 6 个名字。

### 行数：`exec.mjs` 307 行，超过 220 的目标

`exec.mjs` 装的是题目表格指定的 `run`(128) + `channels`(43) + `openChannel`(90) + `wrapCommand`/`tailBytes`(25)，
加文件头与 import 就是 307，**没有水分**。要压到 220 只有两条路，都要改题目给的结构，所以没擅自做：

- 新增 `lib/pool/channels.mjs`（约 135 行，只放 `channels` + `openChannel`）：职责上说得通
  （「一次性命令」vs「长期双工通道」是两种使用方式，`openChannel` 也不排队），
  依赖方向仍单向（`channels → exec`，`exec` 只给 `wrapCommand`）。但那是题目没要的第 4 个文件；
- 把 `wrapCommand`/`tailBytes` 提到第 4 个文件：只有 25 行，且它们是 `run`/`openChannel` 的私有格式化，
  拆出去属于为凑行数硬拆。

其余三个都在目标内：`pool.mjs` 133（≤220）、`connect.mjs` 162（≤220）、`lifecycle.mjs` 128（≤180）。

### 怎么复验

```powershell
cd dsh-ssh-remote
node --check lib/pool.mjs            # 另外三个 lib/pool/*.mjs 同样
node tests/pool.test.mjs             # → 23 项全过（拆分前基线也是 23）
node tests/run.test.mjs              # → 27 项全过
node tests/copy.test.mjs             # → 34 项全过
node --test --test-isolation=none "tests/*.test.mjs"
# → 8 文件全过 / 0 失败 / 断言 125 条（13+3+34+4+23+27+15+6），与 D-30 基线一致
```

导出面与「一字未改」的机器核对（这次实际用的两条，沿用 D-32 的做法）：

```js
// 1) 名字：拆分前后各 Object.keys(m).sort() → 都是 6 个
//    AUTH_COOLDOWN_MS, ConnectionPool, EXIT_SETTLE_MS, PoolError, tailBytes, wrapCommand
// 2) 文本：把 git HEAD 的旧 pool.mjs 复制成 lib/__baseline_pool.mjs，逐符号比
//    Function.prototype.toString()；类方法要先归一化（this. → pool.、去掉首行签名、去缩进），
//    结果 12/12 方法体完全相同；wrapCommand / tailBytes / PoolError 是 3/3 逐字相同。
//    另查「基线里每一行注释是否原样出现在新文件里」→ 缺失 0 行。核对完立刻删掉临时文件。
// 3) 无环：lifecycle / connect / exec 各自单独 import 一次，都能独立加载并只看到自己的导出。
```

### 没做的（范围外）

- 没跑 `pnpm build`、没碰 `index.bundle.js`：构建由协调会话做，合并前记得 `pnpm build`
  并按 D-31 核对产物与源码同步。
- `lib/` 下其它长文件（`admin.mjs`、`run.mjs`、`copy/transfer.mjs`）没动。
- 没有为 `exec.mjs` 超标新增第 4 个文件：见上面「行数」，等协调会话定。

## D-34 拆 `scripts/sshctl.ps1`：入口 + `lib/{hosts-store,prompts,commands}` 三个库（纯结构，行为零变化）

- **现象**：`scripts/sshctl.ps1` 809 行，一个文件里并排三件事：存储层（hosts.json / vault.dat 读写、
  DPAPI 包装、addrHash、主机配置解析，约 285 行）、交互层（读密码、读确认，约 53 行）、命令层
  （7 个子命令 + 排序 + 用法，约 345 行）。改 `Save-VaultEntries` 要在「子命令分发 → 23 个函数 → catch」
  里滚一遍；只想看 `remove` 怎么删 vault，也得先翻过加密与 JSON 校验。
- **判定**：是问题，但只在可读性与定位成本上，**不改行为**——所以这一轮只搬函数，不改参数、默认值、
  错误文案、`[Console]::Error` / `Write-Error` 的文字、`$script:` 变量名，也不动任何 `tests/*.test.mjs`
  与 `tests/*.ps1`（它们是行为锁）。
- **根因**：三块的**失败方式不同，排查时看的证据也不同**。存储错是「文件不存在 / JSON 坏 / vault 版本不认 /
  addrHash 对不上」，证据是 hosts.json 与 DPAPI 报错；交互错是「没有终端 / 输入为空 / 没敲 yes」，
  证据是 stdin 与退出码 2；命令错是「参数多一个少一个 / id 重复 / 主机不存在」，证据是退出码与用法行。
  按证据切，改哪类就只读哪一块。

### 怎么切的

| 文件 | 内容 | 函数数 | 行数（目标） |
| :-- | :-- | :-- | :-- |
| `scripts/sshctl.ps1`（保留） | 注释头、`param()`、`$script:ExitCode = 0` 与路径常量、**三个 dot-source**、分发 `switch`、`catch` | 0 | 129（≤160） |
| `scripts/lib/hosts-store.ps1` | `Get-ExactKey`、`New-OrderedMap`、`New-HostsDocument`、`Read-/Save-HostsDocument`、`Invoke-ProtectText`、`Invoke-UnprotectText`、`Test-VaultVersionOne`、`Read-/Save-VaultEntries`、`Get-AddrHash`、`Get-RemoteHostSpec` | 12 | 293（≤420） |
| `scripts/lib/prompts.ps1` | `Read-HostPassword`、`Read-HostConfirmation` | 2 | 56（≤90） |
| `scripts/lib/commands.ps1` | `Get-SortedHostIds`、`Invoke-Status/List/Add/Set/Remove/Export/Import`、`Show-Usage` | 9 | 349（≤400） |

合计 23 个函数，入口里 0 个。入口按「存储 → 交互 → 命令」的顺序 dot-source；三个库在**载入时只有函数定义**，
互相不 import、不 dot-source，运行期靠同一个脚本作用域解析函数名，所以这个顺序只是可读性，不是依赖。
依赖方向单向：`sshctl.ps1 → 三个 lib`，lib 之间没有环。

行数都是搬完的实数，没有压：`hosts-store` 293 行是同一份文件格式的读写（再拆会切开 hosts.json 与 vault 的
原子写/备份逻辑）；`commands` 349 行是 9 个函数本身 + 各自的用法与警告文案，`Show-Usage` 的 here-string
就占 14 行。

### `$script:` 为什么安全（这次实测，不靠文档）

dot-source 的代码在**调用方的作用域**里执行，不新建 script scope，所以库里的 `$script:X` 解析到主脚本的
script scope。两条方向都实测过：

1. **入口写、库读**：`$script:HostsPath` / `$script:VaultPath` / `$script:ProtectScript` /
   `$script:UnprotectScript` / `$script:HostIdPattern` / `$script:DefaultPort` 全在入口算好，
   库里的 `Save-HostsDocument`、`Invoke-ProtectText`、`Invoke-Add` 直接用——`add` 真写进了临时
   `hosts.json`、`set` 真写进了临时 `vault.dat`，不是靠回退到某个默认值。
2. **库写、入口读**：`$script:ExitCode` 由库里的 `Invoke-*` 写，入口最后 `exit $script:ExitCode` 读。
   实测 `remove` 在没确认时由 `Invoke-Remove` 设 2、入口原样返回 **2**；`export` 同理。
   另用一对最小的 `main.ps1` + `lib.ps1` 做过复现（库函数里 `$script:X = 7`，入口 `exit $script:X`
   → 进程退出码 **7**），确认不是「恰好读到 0」。

### 被否的方案

- **改成 `.psm1` 模块 + `Import-Module`**：模块有自己的 module scope，`$script:` 指向模块而不是主脚本，
  `$script:ExitCode` 就写不回入口；要改成「函数返回状态码、入口汇总」，那是改函数体与调用约定，
  超出「零变化」。dot-source 换来的正是「库文件和原来一样共享同一个 script scope」。
- **把路径/常量作为参数传给每个函数**：要改 23 个函数签名（`Save-HostsDocument -HostsPath …` 等），
  等于重写调用点，也是改行为面。
- **库自己算路径**（`Join-Path $PSScriptRoot '..\protect.ps1'`）：`-DataDir` 与 protect/unprotect 的
  路径归属会从入口散到库里，`$PSScriptRoot` 的含义也从「入口所在目录」变成「lib 目录」，更容易错。
- **按「导出 / 非导出」或「纯函数 / 有副作用」切**：D-32 已经否过一次，理由相同——两半互相调用，
  等于造一条假边界，读代码还得跳两个文件。
- **合并成一个 `sshctl.core.ps1`**（827 行）：只是把「一个大文件」换成「一个大文件 + 一个入口」，
  定位成本一点没降。
- **改 `tests/*.test.mjs` / `tests/*.ps1` 的 import 或断言**：没有测试直接引用 `scripts/sshctl.ps1`
  （`grep -n sshctl tests/` 为 0 条），本来也不需要改；行为锁不动。

### 怎么复验

```powershell
cd dsh-ssh-remote
# 1) 语法：四个文件都必须是 0
#    在 pwsh -NoProfile -Command 里执行下面这行（cmd 重定向到文件再读，避免沙箱下消费 native 输出）：
#      $t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('<file>',[ref]$t,[ref]$e); $e.Count
#    注意：题目给的 [ref]$null 写法在 PS 里会报「[ref] cannot be applied to a variable that does not exist」，
#    而且 $e 从未赋值、$e.Count 恒为 0——必须用真实的 tokens/errs 变量，否则这条检查是假通过。
#    → sshctl 0 / hosts-store 0 / prompts 0 / commands 0（token 数 425 / 1579 / 297 / 1819，证明真的解析了）

# 2) 结构：函数体逐字比对 + 注释一行不少（AST）
#    旧文件 23 个 FunctionDefinitionAst，新文件也是 23 个，Extent.Text 逐字相同 23/23；
#    旧文件 74 行注释在新文件里缺失 0 行。

# 3) 真实调用（临时数据目录，不碰真凭据）：`-DataDir .tmp\home-<guid>` 隔离。
#    sshctl.ps1 不读 DSH_HOME（grep 0 处），所以隔离靠 -DataDir；另测过设了 DSH_HOME 之后
#    该目录仍是空的、数据只落在 -DataDir。
#    30 个用例跑同一批子命令（list/status/help/--help/-h/无参/未知子命令/export 有/无确认/
#    export 无 vault/import 缺文件/add 带端口/add 省略端口/list/status/add 重复/add 非法 id/
#    add 参数太少/太多/set/status/set 不存在的主机/export/import 回灌/status/remove 无确认/
#    remove 有确认/remove 再删一次/remove 另一台/final list/final status），
#    旧文件（`git show HEAD:…` 放到 .tmp\old\ 并带一份 protect/unprotect）与新文件
#    退出码 30/30 相同；stderr 逐字节相同；stdout 只有 status 打印的数据目录路径不同
#    （归一化两处 tmp 路径后逐字节相同），文件落盘状态也相同（hosts.json 逐字节相同，
#    vault.dat / vault.dat.bak 大小相同）。

# 4) 测试
node --test --test-isolation=none "tests/*.test.mjs"
# → 8 个文件全过 / 0 失败 / ok 行 125 条（13+3+34+4+23+27+15+6），与 D-30/D-32/D-33 基线一致。
```

退出码覆盖：`0`（list/status/help/add/set/export/import）、`1`（未知子命令/参数错/重复添加/
主机不存在/vault 不存在/导入文件不存在）、`2`（export 与 remove 未确认）——三档都在新旧两版里对上了。

### 与「完全零变化」的边界

- **新增一种失败模式**：`scripts\lib\` 三个文件必须随脚本一起拷贝，缺一个脚本在 dot-source 时就失败。
  部署侧不用改：`tools/deploy.ps1` 的 `BundledPluginDirs` 已含 `scripts`，且用
  `Get-ChildItem -Recurse -File` 递归搬，`scripts\lib\*.ps1` 会跟着走（已核对源码，未跑部署）。
- **行号变了**：`Write-Error` / `exit` 在入口里的行号从 805/809 变成 125/129，`throw` 的行号跟着函数
  搬到了 lib。这些行号只在 `-Verbose` / `$_.InvocationInfo` / 调试器里可见；`-File` 非交互模式下
  `Write-Error` 只打一行 `Write-Error: 错误：…`，实测新旧 stderr 完全相同。函数体文本本身一个字符没动。
- 没有为「多个库文件」加 `#Requires` 或版本检查：入口已经有 `#Requires -Version 7.0`，
  dot-source 进来的代码跑在同一个 runspace 里，不需要第二份。

### 没做的（范围外）

- 没跑 `pnpm build`、没碰 `index.bundle.js`：PowerShell 侧不进 JS 包；产物核对由协调会话做。
- 没改 `README.md` 的 CLI 一节（命令与 `-DataDir` 用法未变）；要写「`scripts\lib\` 三个库不单独执行」
  可以留给文档会话。


## D-36 `ssh_admin add_host` 从「卡上只问密码」改成「卡上填表」（载荷 `form.fields`）

- **现象**：`add_host` 分两步——模型先给 id/地址/端口/用户/简称，落盘后另弹一张只问密码的卡。
  要改用户名、改简称、看一眼即将写入的地址，用户只能先让模型重来一遍；地址错了也没有「当面核对」的机会。
- **判定**：算问题（用户 2026-11-02：「把新增主机从卡上只问密码改成卡上填表」）。
  判定标准：一张卡里同时能看到并修改 `地址（只读）/ 用户名 / 密码 / 简称`，点「保存」才落盘。
- **根因**：协议里只有「单字段输入区」（`payload.input`），业务要多个值就只能多弹几次卡；
  卡的数量由载荷能力决定，而不是由这次操作需要确认几件事决定。
- **候选与代价**：① 给 `input` 加 `repeat`/数组 → 一个字段要同时表达「单值」和「多行」，
  页面里长出两套判断，且老密码卡的取值路径与新的混在一起；② 连着弹两张卡（参数卡 + 密码卡）
  → 两次确认、取消语义含糊（取消哪一张算没加？），且第二张卡拿不到用户在上一张卡里改过的用户名；
  ③ 新加 `form`，页面把老 `input` **归一**成单字段 form → 一套渲染路径，一张卡填完。
- **结论**：走 ③。

### 为什么用 `form`，而不是给 `input` 加 `repeat`

`input` 的语义是「一个输入区、值是一个字符串」，协议里对应 `{ kind: 'password', placeholder }`；
「一行一个执行单位」这种结构在 `rows[]` 里已经有过一次。给 `input` 加 `repeat` 等于把
「一个值」和「一组值」塞进同一个键：调用方要按数组长度分支、页面要按两种形态取值、回传时 `input`
到底是字符串还是对象也说不清。新开 `form.fields[]` 之后：`input` 原样保留（`set_password` 这类单字段卡
一个字节都不用改），`form` 只表达多字段。两个键互斥、同时给时以 `form` 为准（`types.ts` 的注释与
`tests/card-shell.ps1` 的「form 与 input 互斥」断言都钉住这一条）。

### 单字段归一化的理由

页面内部只有一条渲染路径：`normalizeForm()` 把 `payload.input` 变成
`{ id: 'input', label: placeholder || '密码', type: 'password', required: false }` 一个字段。
理由有三条：

1. **不漂移**：密码卡的框、只读灰底、必填禁用如果各写一遍，改一处另一处就会不一致（这个仓库已经
   因为「两套渲染」返工过，见 AGENTS §4）。归一化后 `Input.Password` 在 `App.tsx` 里只出现 **1 处**，
   `card-shell.ps1` 用计数断言钉住。
2. **视觉与行为不变**：单字段时仍走「隐藏 `<label for>` + 一个铺满宽度的密码框」，不出现可见 label
   （可见 label 会多占一行、把卡撑高）；`required: false` 是照规格写的，老密码卡「空值不可提交」由
   `legacyInput` 单独守着，所以行为一个字没变。
3. **新能力只加在 `form` 上**：`fields[]` 的 `readOnly` / `required` / 多字段布局都只在多字段分支出现，
   密码卡不可能被这些新规则影响到。

### 密码不外泄的三个检查点

1. **进载荷之前**：`ConvertTo-CardField` 只在 `value` 非空时写键，而 `admin.mjs` 的密码框
   **永远不给 `value`** —— 所以载荷 JSON 里搜不到密码（`admin-form.test.mjs` 断言
   `password.value === undefined`；JSON 自检里断言 `'value' in password === false`）。
2. **传输途中**：字段表（不含密码）走临时文件；**密码只从 stdout 的 JSON 回来**，不写答案文件、
   不进 `argv`（`askForm` 测试断言 `argv` 里没有密码、没有 `-OutFile`，临时目录用完即删）。
   选 stdout 而不是 `-OutFile` 是这次特意改的：`select` 的答案没有敏感值，表单答案有。
3. **出业务层之前**：`ConvertTo-SshFormDecision` / `Invoke-SshCardForm` 只把字段作为返回值，
   不打印、不写文件（`card-select.ps1` 的「不打印字段值」断言）；`addHost` 的返回值只有
   `已添加主机「简称」：地址:端口，用户 xxx`，错误文案只说「用户名/密码不能为空」、不回显值
   （`admin-form.test.mjs` 对 message / lines / render 文本三处都断言搜不到密码）。

密码在磁盘上仍然只有一份：`vault.dat`（DPAPI，且 `addrHash` 绑地址+端口+用户名，
改了用户名之后旧密码不会被误用——`vault.mjs` 的 `passwordFor` 会拒绝）。

### 用户 2026-11-02 追加的口径：密码必填

表单里 `password.required = true`，提交按钮的禁用条件是 `user 空 || password 空`；
`password` 空时业务侧还会再报错并**一个文件都不写**（页面是第一道闸，业务是第二道闸）。
理由：这个插件现在只有密码登录（`lib/pool/connect.mjs` 只从 vault 取 `passwordFor()`），
留空新增出来的主机必然连不上。所以「密码留空＝不保存」这条路已经删除。

### 被否方案

- **给 `input` 加 `repeat`**：见上（一个键表达两种形态）。
- **两张卡**：两次确认、取消语义含糊、第二张卡拿不到第一张卡的修改。
- **保留 `setPassword: false`**：密码必填后这条分支不存在；留着就是「传了不生效」的兼容层
  （AGENTS §0 明令删）。工具 schema 里也已删除（`admin.test.mjs` 有一条断言专门守它）。
- **密码留空＝不保存**：被用户口径否掉（见上）。
- **让模型传密码**：模型不该也拿不到密码，`admin.mjs` 的工具 schema 里没有 password 参数。
- **用 antd `Form` 组件**：这张卡是一次性收集、没有校验提示/联动/异步提交态，`Form` 只会多一层
  受控状态与额外的 a11y 结构；`Input` + 受控 `values` 更小、更好量高。
- **多字段 label 置上**：四个字段各多一条标签行，整卡高约 +80px，正好撞 B-07「不要过高」；
  「地址/用户名/密码/简称」都 ≤4 字，64px 左列足够对齐。
- **回车提交（多字段也绑）**：4 个字段里回车的直觉是「填下一项」，绑主按钮会误确认；
  只在单字段（老密码卡）时保留回车提交，多字段不绑。
- **`askPassword` 一并删除**：`set_password` 还在用它（单字段密码卡），删了要再造一张一样的卡；
  按规格保留，只把 `add_host` 换到 `askForm`。
  **（D-38 已推翻这一条：`set_password` 与密码卡整体删除，改密码复用 `add_host` 的表单卡。）**

### 复验

```powershell
# 1) 语法
node --check dsh-ssh-remote\lib\admin.mjs
#    改动的 5 个 .ps1 用 Parser::ParseFile 逐份解析 → 0 错误

# 2) 类型（不跑 npm run build：产物由协调会话构建）
#    app/node_modules 不在 worktree 里，用 junction 指到仓库根的同一份依赖再跑 tsc：
#      node <repo>\shared\ui-card\app\node_modules\typescript\bin\tsc --noEmit -p shared\ui-card\app\tsconfig.json
#    → exit 0（0 错误）；跑完即删 junction（[System.IO.Directory]::Delete，不碰目标）

# 3) 单测（9 个文件 / 135 条 ok / 0 失败）
cd dsh-ssh-remote
node --test --test-isolation=none "tests/*.test.mjs"

# 4) 渲染与载荷断言
pwsh -NoProfile -File tests\card-shell.ps1      # 81/81
pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1   # 57/57

# 5) 载荷 JSON 自检：New-SshFormPayload → ConvertTo-CardPayloadJson → JSON.parse →
#    字段 id 顺序 addr,user,password,label、密码没有 value、没有 input/keyboard/armMs、主按钮唯一
```

**产物未重建**：`shared/ui-card/dist/index.html` 仍是旧产物，新的表单渲染要等协调会话
`npm run build` 之后才看得见。`tests/card-shell.ps1` 不比对产物与源码，所以 81 项全绿；
但**没有重建就看不到表单卡**——这不是断言失败，是构建步骤没跑。

### 边界（这次没做）

- 没动「输入区」的老密码卡（`payload.input`）：`askPassword` / `Invoke-SshCardPassword` 一行未改，`set_password` 行为不变。
  **（D-38 已删除它们；外壳那条能力当时仍在，见 D-38 的边界——R-12 已删除。）**
- 没做「字段级错误提示」：必填只体现为「主按钮禁用」，没有红字提示（一张一次性的小卡，
  空着不让点已经够清楚；加提示要引入 Form 的校验态）。
- 没做 `tags` 的编辑：标签仍是工具参数，卡里不出现（这次的四个字段是用户点名的）。
- **必填判据用「去掉空白之后还是空」**（`App.tsx` 的 `requiredMissing` 用 `.trim()`）：`user` 侧与业务层
  （`admin.mjs` 也对 `user` 做 `trim()`）一致；`password` 侧比 `set_password` 那张卡稍严——纯空白的密码
  在页面上就点不了「保存」。取舍：业务层对密码**不做 trim、不做任何改写**（密码是数据，不是标识符），
  所以只在「判断是否为空」这一步按空白处理；纯空白密码几乎必然是误输入，早拦比存进去再连不上好。
  反过来如果按「精确空串」判，`user` 填三个空格就能点保存、等业务层报错，把第二道闸提前到用户面前
  反而不如按钮直接灰掉清楚。

## D-37 搬运行的卡片正文：说明文字不按 shell 高亮（行协议加 `lang`，正文改成两行 `Source:` / `Target:`）

- **现象**（用户 2026-11-02 真机）：`ssh_copy` 的多选卡里，每一行框内被当成 shell 命令渲染——
  框里是 `源: \`/tmp/a\`` / `目标: \`/tmp/b\`` / `原因: …`，反引号原样露出来，`源:` / `目标:`
  还被涂成命令行颜色。用户原话要的格式：

  > 复制那个最好是：
  > # 原因xxxxxx
  > Source:
  > Target:

  即框内第一行 `# <原因原文>`，然后 `Source: <源路径>`、`Target: <目标路径>`，路径**不带反引号**，
  这几行**不是命令、不按 shell 高亮**；框底那条 meta（`[覆盖 · 目录] 36 B` 这类）保持不变。
- **判定**：算问题。判定标准（可验收）：载荷里该行 `why` 不含 `#`、`text` 是两行
  `Source: …` / `Target: …`（无反引号、无「源 / 目标」中文前缀）、`lang === 'text'`、`meta` 仍带体积/标志；
  同时 `ssh_run` 的行必须保持原样（`lang` 键缺省 = 按 `sh` 高亮，`text` 仍是命令原文）。
- **根因**：行协议里只有 `text` 一个正文字段，而页面把它**硬编码**成 `lang="sh"`（`App.tsx`）。
  搬运行的正文是从 `fields` 拼出来的（`源：\`…\``），它同时承担「给人读的字段」和「代码框内容」两种语义，
  渲染端只能二选一，于是说明文字被当成命令涂色。`fields` 本身还带着反引号——那是 Markdown 的值，
  在代码框里就是字面反引号。
- **候选与代价**：
  ① 页面按行内容猜（含反引号 / 中文冒号就退纯文本）→ 渲染端猜业务语义，换个措辞就失效；
  而且 `ssh_run` 的命令里带中文注释时会被误判成纯文本（真命令丢高亮）。
  ② 搬运行改用 `code`（围栏代码块）→ `code` 的语义是「要执行的东西」，`# 原因` 会变成真注释、
  复制按钮会复制出两行伪命令，且 `buildApprovalQuestion` 的 code 分支会把它包进围栏。
  ③ 行协议加 `lang`（缺省 `sh`），搬运行的正文单独给 `text` → 语义显式，run 卡零改动。
- **结论**：走 ③。

### 为什么给行加 `lang`，而不是让页面猜

「这行是命令还是说明」是**业务知识**，只有产出行的那一层知道（`itemsToRows` 知道自己在描述路径，
`stepsToRows` 知道自己在描述命令）。让渲染层从字符串猜，等于把业务判断搬进 `App.tsx`，
下一次改措辞（比如 `Source:` 换成 `From:`）就会静默退回错误渲染，而没有任何断言能提前发现。
显式字段的代价只有一行：`CardRow.lang?: string`，缺省值 `'sh'` 让所有既有调用方（`ssh_run`、
审批插件的行）一个字节都不用改——`lang` 为空/缺键时页面行为与改动前逐字相同。

高亮侧的语义已经现成：`highlight.ts` 的 `detectLanguage()` 认不出语言就返回 `null` → 纯文本。
`lang: 'text'` 不是新增语法，而是走「认不出」这条既有退路，所以不需要给 Shiki 装任何东西。

### 为什么搬运卡不用 `sh`

搬运卡那三行里**没有一条会被执行**：执行的是 `cat` / `tar` 管道（由 `buildSinkCommand` 拼，模型和用户都不看它）。
把它标成 `sh` 有两个具体后果（用户都看见了）：① `源:` / `Target:` 行首被当成命令名涂色（颜色在暗示
「这是一条命令」）；② 路径两边的反引号是 Markdown 的值语法，进了代码框就是字面字符。
用户要的「复制那个」里，路径是要**读**的，不是要**跑**的——说明文字用纯文本，才与「看到的＝数据」一致。

### `fields` 与行数据怎么共存（选了「在 `fields` 之外另给 `text` / `lang`」）

两条路要的措辞不同：浏览器审批文案要中文 `源 / 目标`（值带反引号，Markdown 列表里好看），
桌面卡要 `Source: / Target:`（纯文本、不带反引号）。行数据只有一份，所以二选一：

- **选了 A：`itemsToRows` 同时给 `fields`（浏览器文案）与 `text` + `lang`（卡片正文）**，
  `buildApprovalQuestion` 在非 code 分支里「有 `row.text` 就照抄、没有才从 `fields` 拼」。
- 否了 B：在 `cardApprovalChannel` 里把 `fields` 转成 `Source: / Target:`。
  理由：`cardApprovalChannel` 只认识 `question.rowPlain`（已经压平的文本），拿不到 `fields`；
  要转就得把 `fields` 一路带到 `rowPlain` 里，等于在协议里多传一份「结构化字段」，
  而这份字段除了拼两行字符串没有任何用处。转换写在**产出行的那一层**（`itemsToRows`），
  与 `describeFlags` / `meta` 同一个位置，改一处就够。

行对象因此是 `{ target, head, meta, fields, text, lang, why }`；`fields` 的用途一个字没动
（`buildApprovalQuestion` 的 Markdown 列表仍写 `- 源：\`…\``），`meta` / `warn` / `target` / `head` 也都没动。

### 被否方案

- **页面按内容猜语言**：见上（渲染层猜业务语义）。
- **搬运行改用 `code`**：见上（`code` 语义是「要执行的东西」，复制按钮会复制出伪命令）。
- **在 `cardApprovalChannel` 里转换 `fields`**：见上（拿不到结构化字段，且要多传一份）。
- **给搬运行在 `why` 里自己拼 `#`**：`App.tsx` 已经统一拼 `# ${row.why}`，行里再带一个就是 `# # 原因`；
  `card-select.ps1` 新增断言专门守「`why` 不含 `#`」。
- **搬运行也保留 `- 原因：…` 那一行（Markdown 列表）**：桌面卡不走 Markdown，`rowPlain.why` 现在是
  原因原文，由外壳渲染成第一行 `# 原因`——这正是用户要的「第一行 # 原因xxxxxx」。
- **把 `lang` 做成枚举并校验（`sh | text | powershell`）**：高亮侧本来就是「认不出就纯文本」的开放集合
  （`highlight.ts` 的 `SHELL_LANGS` / `PS_LANGS`），在协议层再列一遍等于两份白名单；
  这里只透传字符串，认不出自然退纯文本。

### 断言改动（只增不改）

- `tests/copy.test.mjs`：**新增** 1 条（`搬运行：卡片正文两行 Source/Target 不带反引号，lang=text`），
  并在既有 `C-10：搬运审批只走桌面卡片` 里**新增** 3 行断言（`why` / `text` / `lang` 走完整路径）。
  既有断言一条未改。
- `tests/run.test.mjs`：**新增** 1 条（`run 行仍按 sh 高亮：桌面卡行不带 lang（空 = sh），text 就是命令原文`）。
  既有断言一条未改（含 `stepsToRows` 的字段集合断言 `['code','head','meta','target','why']`，它证明 run 侧行对象没变）。
- `tests/card-select.ps1`：**新增** 2 条（搬运行的 `lang`/两行正文/`why` 无 `#`/meta 带体积；run 行没有 `lang` 键）。
  既有断言一条未改。
- `tests/card-shell.ps1`：**未改**（81 项全过）。它读 `App.tsx` 源码的断言是
  `<CodeText code=\{row\.text\}`，改成 `lang={row.lang ?? 'sh'}` 后仍命中；它也不比对产物与源码。

### 复验

```powershell
# 1) 语法
node --check dsh-ssh-remote\lib\copy\items.mjs
node --check dsh-ssh-remote\lib\approval.mjs

# 2) 类型（不跑 npm run build；用 junction 指仓库根 node_modules，跑完即删）
#    node <repo>\shared\ui-card\app\node_modules\typescript\bin\tsc --noEmit -p shared\ui-card\app\tsconfig.json
#    → exit 0

# 3) 单测（9 个文件 / 137 条 ok / 0 失败，基线 135 + 这次新增 2 条）
cd dsh-ssh-remote
node --test --test-isolation=none "tests/*.test.mjs"

# 4) 载荷与适配层断言
pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1   # 59/59（基线 57 + 2）
pwsh -NoProfile -File tests\card-shell.ps1                   # 81/81

# 5) 载荷自检（rows.json → New-SshCardPayload → ConvertTo-CardPayloadJson）：
#    搬运卡 → why 无 #、text 两行 Source/Target、lang=text、meta=「文件 36 B」、warn=「覆盖」
#    run 卡  → 没有 lang 键、text=「uname -a」、meta=「工作目录 /root · 超时 30s」
```

**产物未重建**：`shared/ui-card/dist/index.html` 与 `dsh-ssh-remote/index.bundle.js` 都没重建，
新的 `lang` 渲染要等协调会话构建后才看得见；真机弹窗与出图也没做（这里只证明载荷与源码契约）。

### 边界（这次没做）

- 没动 `ssh_run` 的行协议与渲染：`stepsToRows` 一行未改，`lang` 缺省即 `sh`。
- 没动浏览器审批文案的措辞：`fields` 仍是中文 `源 / 目标` + 反引号。
- **复制按钮的行为**：`row.text` 有值时行内框右上角就有复制/展开（B-29），搬运卡这一行现在会复制出
  `Source: …` + `Target: …` 两行（不是只复制路径）。接受这个取舍：这行本来就要能复制路径，
  两行一起复制比只复制一半更不容易错；真要「只复制一个路径」得给行再加一个「复制目标」字段，
  属于另一件事。
- **`why` 里带换行**时第一行仍是 `# ` 开头、后续行不带前缀（`App.tsx` 用 `pre-wrap` 原样显示）。
  原因由 `normalizeItems` 的 `why` 传入，目前没有折叠换行——与 `ssh_run` 的 `why` 同一个现状，这次不改。
- 没做「说明文字也支持 Markdown」：`text` 就是纯文本，`Source:` / `Target:` 是字面量。

## D-38 `ssh_admin add_host` 改成 upsert：一张表单卡既是新增也是修改，删掉「单改密码」

- **现象**（用户 2026-11-02 原话）：

  > 这个好像是 单独的密码修改？
  > 这个可以不用了吧
  > 可以复用 新增主机 那个
  > 既是新增有时修改
  > 只由 user@hostname 确定唯一性

  即：`ssh_admin` 里「新增主机」（表单卡）与「重设密码」（单字段密码卡）是两件事、两张卡；
  用户要的是**同一张卡**——填的地址/用户名/端口已经存在就是改那台，不存在就是加一台。
- **判定**：算问题（多余的一条写路径 + 一张只为它存在的卡）。判定标准（可验收）：
  ① 工具动作里没有 `set_password`，调用只得到「不认识的 action」；
  ② 同一 `用户名+地址+端口` 再走一次 `add_host` → `hosts.json` 主机数量不变、那台的密码被更新；
  ③ 改已有主机时密码留空 → `vault.dat` **逐字节不变**；
  ④ 只差端口 → 新增一条（与原来那台并列）。
- **根因**：密码是主机的一个属性，却被建模成「另一种操作」。旧 `upsertHost` 以 **id** 为键、
  已存在就拒绝（"请先 remove_host，或显式给 overwrite"），于是「改密码」只能另开一条动作 +
  另开一张单字段卡；卡的数量由载荷能力决定，而不是由这次操作要确认几件事决定——这与 D-36
  是同一条根因的第二次发作（D-36 修了「新增要两张卡」，这次修「改密码要另一张卡」）。
- **候选与代价**：
  ① 保留 `set_password`，只把 `add_host` 改成 upsert（两张卡都在）→ 两条路径写同一份 vault，
  判据还不一致（id vs 三元组），迟早互相打脸；用户已明说「可以不用了」。
  ② `add_host` 改 upsert，`set_password` 留作「只改密码的快路」→ 同上，多一条只在一个地方用的路径，
  再加一张只为它存在的卡（含 `dialog.ps1` 的一个模式、`payload.input` 的构造）。
  ③ 只留 `add_host` 的 upsert，把 `set_password` 连同密码卡、`-Mode password`、
  `New-SshPasswordPayload` / `Invoke-SshCardPassword`、`dialog.askPassword` 一起删（AGENTS §0：
  旧路径直接删，不留兼容层）→ 一条写路径、一张卡、一个判据。
- **结论**：走 ③。

### 为什么判重是 `user + 地址 + 端口`（不含 id）

1. **与密码绑定同口径**：`addrHash` 就是 `sha256(address|port|user)`。判重口径与密码绑定口径不一致，
   就会出现「判成同一台、密码却被 `passwordFor()` 以 `address-changed` 拒用」的死角；
2. **这三项才是身份**：它们唯一决定「连到哪台机器的哪个账号」；简称、标签、id 都只是给人看的，
   改简称不该变成另一台主机；
3. **端口必须算**：同一地址上跑两个 sshd 是两台机器，漏了端口就会把其中一台的密码覆盖掉；
   **用户名必须算**：同一台机器的两个账号，密码与家目录都不同，合并同样是覆盖密码。
4. **id 不参与**：id 是 `hosts.json` 的键、vault 的键、`ssh_run` 的引用名，是**存储与引用**的标识，
   不是身份。把它当身份就退回旧行为——改地址/用户名必须先删再建（连密码一起丢）。

### 为什么保留短 id（不做 `user@host:port` 当键）

1. **vault 以 hostId 为键存 DPAPI 密文**：换键 = 迁移整份密码库。这是一次不可逆的数据操作，
   失败没有退路（`.bak` 只有一份、且同样是密文），收益只是「键更好看」；
2. **`ssh_run` / `ssh_copy` 的 `hosts` / `target` 用的就是这个 id**：改写法等于改工具入参与模型习惯，
   这次明确不动（用户只点了卡片这件事）；
3. **短 id 到处出现**：勾选行、结果行、错误信息、`ssh_list` 都有它，`root@192.168.1.11:22` 反复出现是噪声；
   B-22 定的 `地址:端口 · 别名` 之所以可读，正因为它短。
代价：三元组与 id 是两套东西，得在代码里显式写清「id 不参与判重」（`hostIdentity` / `findHostByIdentity`
的注释 + `admin.test.mjs` 的「id 只由地址派生」一条）。

**id 由地址生成**（模型不再传 id）：默认就是地址（`192.168.1.12`），被占用了才退到 `地址-端口`、
`地址-端口-2`……。理由：让模型顺手给 id 会诱导它按 id 判重（正是要摆脱的行为）；而地址派生的键
在 `list` 与 `hosts` 参数里最好认。更新已有主机时 id 不变——换了 id 就等于丢密码。

### 为什么密码留空＝不改

- 表单卡的密码框**永远不预填**（D-36 的结论：值一旦进载荷就等于进了页面）。所以打开编辑态时它本来就是空的，
  「空」没有第二种含义可用；
- 若把空当成「清空密码」，一次只想改简称的操作就会把密码删掉——那不是「可重试的失败」，
  而是要把密码重新找回来（可能只有用户手里有）。按 AGENTS §0，不可挽回的一步要按最严标准防护；
- 反过来，**新增时留空必须失败**：这个插件只有密码登录，没有密码的新主机必然连不上。所以
  `password.required` 在新增态为 `true`、编辑态为 `false`，业务侧（`addHost`）按同一判据再判一次
  （页面是第一道闸，业务是第二道闸）；
- 于是密码只有两种结果：空 = 不动、非空 = 覆盖。没有第三种含糊状态。

### 冷读发现并修掉的风险：卡片里改用户名可能把密码写到**另一台**主机上

第一稿把「用户名是判据的一部分」直接落到代码上：卡片回来按 `用户+地址+端口` 重新判重，
命中哪台就写哪台。冷读时发现一个反例：地址 `192.168.1.11:22` 上已经配了 `deploy` 和 `root` 两台
（同一台机器的两个账号是完全合法的配置）。用户为 `deploy` 打开卡、顺手把用户名改成 `root`
（比如想「给 root 也设个密码」）——按第一稿，这次写入会**落到 root 那条记录上**，把 root 的密码
改成用户刚敲的那串。用户以为在给 deploy 设密码，实际改的是另一台机器的凭据：这不是「可重试的失败」，
是把凭据写到错的地方（AGENTS §0 的不可挽回那一类）。

处置（改成）：卡片弹出前就记住「这张卡指的那台」（`existing`）；卡片回来重新判重后，若命中的是
**另一台**已配置的主机，直接拒绝并说明——`卡片里改的用户名指向另一台已配置的主机「root1」…
这次没有写入任何文件。要改那台请重新发起 add_host（user: root）`。
允许的两种结果因此只有：落在原来那台（正常修改）、或落在一台新主机（换账号＝新增）。
代价是多一次 `findHostByIdentity` 与一条错误路径；收益是「密码永远写到卡片标题上写着的那台」。

被否的两种处置：

- **编辑态把用户名设成只读**：能彻底消灭这条路径，但模型把用户名打错时（`deplioy`）用户在卡上
  也改不了，只能整轮重来；而地址已经只读了，再锁一个字段会让人以为「这张卡什么都不能改」。
  另外它挡不住「新增态里恰好敲出另一台的账号」这一半。
- **不拒绝、静默按新判据写**：就是第一稿，把凭据写错机器的风险留给用户自己发现（而且他不会发现——
  返回消息里写的是「已更新主机「root 账号」」，但他刚操作的是 deploy 的卡）。

### 顺手修掉的一个坑

改完密码后清掉该主机的认证冷却（`pool.authCooldown.delete(host.id)`）。冷却本来是「密码认证失败后
60 秒内别再试」（防锁号），但用户重填密码的动机往往**正是**刚才失败过——不清掉就会出现
「刚改完密码，还是连不上，再等一分钟」。只清冷却、不关已有连接：正在跑的命令不该被一次改密码掐断。

### 删掉的 API / 函数（谁在用、删了谁替代）

| 删掉的 | 原来谁在用 | 现在谁替代 |
| :--- | :--- | :--- |
| `ssh_admin` 的 `set_password` 动作 | 模型（工具 schema 的 enum + 分发） | `add_host`：同三元组再填一次＝改，密码非空即覆盖 |
| schema 参数 `setPassword` / `overwrite` | 模型 | 都没有了：判重不需要 `overwrite`，密码不由模型传 |
| `createAdmin().setPassword(hostId, exec)` | 上面那个动作 | `addHost()` 内的 upsert 分支 |
| `createDialogRunner().askPassword()` | `setPassword` | `askForm()`（唯一会带密码的卡） |
| `Invoke-SshCardPassword`（`scripts/ui/card.ps1`） | `dialog.ps1 -Mode password` | `Invoke-SshCardForm` |
| `New-SshPasswordPayload`（`scripts/ui/shared.ps1`） | `Invoke-SshCardPassword` | `New-SshFormPayload`（编辑态：密码字段不给 `required`、占位「留空＝不改密码」） |
| `dialog.ps1` 的 `-Mode password` 分支与 `-Mode` 默认值 `password` | 无（`lib/*.mjs` 只传 confirm / select / form） | `-Mode` 默认 `select`，`ValidateSet('confirm','select','form')` |
| `upsertHost(document, input, { overwrite })` 的第三参与 id 校验 | `addHost`、单测 | `upsertHost(document, input)`：判重靠三元组，id 由 `suggestHostId()` 生成 |

**`vault.setPassword()` 没删**：它是 vault 的写接口（`addHost` 与 `state.test.mjs` 都在用），
删的是「单改密码」这条**动作/卡片**路径，不是密码库的写能力。

### 断言改动（逐条对照）

`tests/admin.test.mjs`（13 → 22 条）：

- 改 `upsertHost：id 已存在默认拒绝，overwrite 才覆盖` → **拆成 3 条**：
  「判重只看 user+地址+端口，命中＝更新那台（id 不变）」、「新增时生成短 id（默认就是地址），简称留空用地址」、
  「只差端口 / 只差用户名都是另一台（id 让路，不覆盖别人的密码）」。为什么：`overwrite` 与「已存在即拒绝」
  这条语义整个消失，留着就是断言一个不存在的规则。
- 新增「id 只由地址派生（小写、非法字符换 -）」：`suggestHostId` 的清洗必须产出合法 id（IPv6 地址会带 `:`）。
- 改 `upsertHost：非法 id / 空地址 / 非法端口都抛错` → 「空地址 / 空用户名 / 非法端口都抛错」：
  id 不再由模型给，非法 id 不可能从这条路径进来。
- 改 `add_host：写入 hosts.json…`：id 由 `web1` 改成生成的 `192.168.1.11`；新增态 `password.required === true`、
  占位 `输入密码`。为什么：模型不再传 id（`id` 参数只剩 `remove_host` 用）。
- 新增 4 条覆盖验收 ①②③ + 用户名改动：「同一台再填一次＝更新，主机数不变、密码被更新、id 不变」、
  「已有主机密码留空＝不改密码（vault.dat 一个字节都不变）」（逐字节比对密文）、
  「留空密码只对已有主机成立——新增还是必须填密码」、「只差端口＝另一台主机（两条，各自的密码）」、
  「卡片里改了用户名＝按新三元组判重（原主机与它的密码原样留着）」。
- 改 `set_password：给已有主机重设密码…` 与 `set_password：取消不改密码；主机不存在则报错` →
  **1 条**「set_password 动作已不存在：调用只得到「不认识的 action」，不写任何文件」（验收 ④）。
  为什么：被测对象已经删除，不能留着断言一个删掉的动作还能工作。
- 新增「卡片里改成另一台已配置主机的用户名 → 拒绝写入（免得把密码写到别的机器）」：
  这条是冷读出来的风险的守卫（见上一节），断言两边密码都没被动、`hosts.json` 一个字没改。
- 改 `工具 schema`：删掉 `setPassword` 之外再断言 `overwrite` 已删、`enum` 只有三个值、
  `id` 的说明只提 `remove_host`、`user`/`port` 的说明写了「判重」。
- 新增「工具参数缺 address 或 user 时先报错，不弹卡」：旧代码靠 `upsertHost` 抛错，新代码在弹卡前自己校验。
- 改末条「未知 action 与内部异常」：第二次 `add_host` 由「报已存在」改成「已更新」，因为那正是新行为。

`tests/admin-form.test.mjs`（10 → 13 条）：

- 改「四个字段的形状」：新增态密码 `required === true`、占位 `输入密码`；id 期望改成生成的 `192.168.1.12`。
- 新增「编辑态：预填用户名与简称、密码不必填且占位『留空＝不改密码』」（规格第 3 条）。
- 新增「编辑态：只改简称、密码留空 → 落盘新简称，密码原样（没有第二张卡）」。
- 改「fields 正常回传」：不再在卡里改用户名（改用户名＝另一台，已由 admin.test 覆盖），改断言简称落盘。
- 改「新增时 password 空」：报错文案从 `密码不能为空` 改成 `新增主机的密码不能为空`（两种态现在不一样）。
- 新增「对话框：单改密码的能力已删除（dialog runner 上不再有 askPassword）」。
- 假弹窗 `formDialog` 加了可变的 `state`：同一张卡先新增后编辑，测试能在中途把密码改成空。

`tests/dialog.test.mjs`（4 → 4 条，1 条重写）：`密码卡与确认卡…` → `确认卡与表单卡…`：
`askPassword` 没了，换成 `askForm`（唯一带密码的卡）也要跟进程退出结算、也要收整棵进程树。

`tests/run.test.mjs`（28 → 28 条，1 行改）：`dialog: { askPassword: … }` → `dialog: { confirm: … }`。
那一条测的是「dialog 缺 `selectRows` 就报错」，用的假对象不该再引用已删的 `askPassword`。

`tests/card-select.ps1`（58 → 53 条）：

- 删 3 条密码载荷断言（抬头/输入区/键盘）与 5 条假窗口密码映射断言（拿到密码、空输入按取消、
  cancel/expired/timeout/closed、起不来、不打印）——被测函数已删除。
- 新增「契约：单改密码那张卡已删除」（函数不存在、三个 `.ps1` 里连名字都不出现、插件不再构造
  `InputSpec`、`dialog.ps1` 的 `ValidateSet` 只剩三种模式）。
- 新增「表单卡（编辑态）：密码不必填（`required` 键不写）、占位『留空＝不改密码』，其余字段与新增态一致」。
- 新增「映射（假窗口）：编辑态表单卡交回空密码 → 仍算填完」：把「留空＝不改」与「取消」在协议层分开。

### 复验

```powershell
# 1) 语法（改动的每个 .mjs 各一条）
node --check dsh-ssh-remote/lib/admin.mjs
node --check dsh-ssh-remote/lib/hosts.mjs
node --check dsh-ssh-remote/lib/vault.mjs
node --check dsh-ssh-remote/lib/pool/connect.mjs
node --check dsh-ssh-remote/index.js
#    改动的 4 个 .ps1 用 Parser::ParseFile 逐份解析 → 0 错误

# 2) 单测：9 个文件 / 149 条 ok / 0 失败（基线 137，本次 +12）
cd dsh-ssh-remote
node --test --test-isolation=none "tests/*.test.mjs"

# 3) 适配层断言：53/53（基线 58：删 8 条密码卡、加 3 条新规格）
pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1

# 4) 载荷自检：编辑态 fields → 密码没有 value、没有 required 键、placeholder=「留空＝不改密码」
```

### 边界（这次没做 / 需要协调会话）

- **`index.bundle.js` 未重建**：运行路径用的是它，插件源码改了不重建就等于没上线；由协调会话构建。
- **没真机点一遍**（B-42）：编辑态的预填、密码留空的占位是这套卡第一次出现的样子，
  离屏图也不算数，需要人工弹一次、改一次简称。
- **`tools/gen-fixtures.ps1` 第 47 行仍在调 `New-SshPasswordPayload`**（仓库根工具，本次不在可改范围）：
  跑它生成四张卡的样本时会抛错。协调会话应删掉那一段，同时清理 `tests/fixtures/password.json`
  与 `docs/images/card-password.png`。
  **（R-12 已办：那两行注释改成「随 R-12 整条删除」，样本与图也已删。）**
- **外壳仍保留 `payload.input`（单字段输入区）**：边界说了不动 `shared/ui-card/**`，
  插件这边已经不再构造 `input` 载荷（`card-select.ps1` 的新契约断言钉住）。
  `shared/ui-card/app/src/fixtures/password.ts` 与 `docs/shared-ui-card.md` 里那几行也随之过时。
  **（R-12 已把外壳这条能力整条删除，见 `shared/ui-card/DECISIONS.md` 的 R-12。）**
- **`sshctl.ps1 set <id>` 仍在**：这是本机 CLI 的交互路径（`Read-Host -AsSecureString`），
  不经过卡片、也不暴露给模型，本次不删；`vault.mjs` 的缺密码提示仍写着「或 sshctl set」。
- **没做「改地址」**：地址在卡上只读，三个身份项里只有用户名能在卡里改；改地址＝换一台机器，
  按判据天然是新增，旧的「改地址会让密码失效」这条规则随之消失（也就不用再提示 remove_host）。

## D-39 删掉卡片自超时（`AutoCloseMs` 整条链）：SSH 卡片永不自动关闭

- **出处**：用户 2026-11-10 明确说「这个功能不需要」（指卡片到点自己关的 `-AutoCloseMs`）。
  此前 BACKLOG #6/#14 把「自动关闭」收敛成一个输入口：`-AutoCloseMs` 同时决定页面倒计时
  （`payload.closeMs` + 页脚「剩余 m:ss」）与宿主兜底超时（`closeMs + 15s`，`Get-SshWindowTimeoutMs`）。
- **判定**：算问题（多余能力，且与同轮的「弹出即置顶」方向相反：置顶之后不再需要「到点自己关」来
  避免长期占屏）。判定标准（可验收）：① `AutoCloseMs` 这个名字在 SSH 的产品代码里一处不剩
  （参数、透传、计算函数）；② 三张卡弹出来都不带窗口超时（`-TimeoutMs` 缺省 0 = 一直等）；
  ③ 载荷里不再出现 `closeMs`。
- **根因**：不是缺陷，是**需求取消**。自超时当初为「审批别永远挂着」而加，实际代价是「人不在电脑前 /
  正在看别的东西，卡自己没了，这次操作等于没发生」；置顶之后卡片就是「等你处理」，到点消失与它冲突。
  按 AGENTS §0「正确性优先于兼容性」，不需要的能力直接删，不留参数、不留「传了不生效」的兼容层。
- **删除清单**：

  | 位置 | 删了什么 |
  | :--- | :--- |
  | `lib/admin.mjs` 的 `selectRows()` | 参数 `timeoutMs = 0`，以及 `if (…timeoutMs > 0) argv.push('-AutoCloseMs', …)` |
  | `lib/approval.mjs` 的 `cardApprovalChannel()` | 调用里那行死参数 `timeoutMs: 0` |
  | `scripts/dialog.ps1` | `[int]$AutoCloseMs` 与它的注释、STA 重拉 argv 里的 `'-AutoCloseMs', $AutoCloseMs`、三处 `-AutoCloseMs $AutoCloseMs` |
  | `scripts/ui/card.ps1` | 三个 `Invoke-SshCard*` 的 `[int]$AutoCloseMs` 与注释、三处 `-CloseMs $AutoCloseMs`、三处 `-TimeoutMs (Get-SshWindowTimeoutMs $AutoCloseMs)` |
  | `scripts/ui/shared.ps1` | `Get-SshWindowTimeoutMs`（`closeMs + 15s` 那一层兜底）整个函数 |
  | `tools/gen-fixtures.ps1` | 表单卡样本的 `-CloseMs 600000` 与「与真实调用一致」的注释 |
  | `tests/dialog.test.mjs:122` | 原来只断言 argv 不含 `-AutoCloseMs`；改成同时断言 `-AutoCloseMs` / `-TimeoutMs` / `-CloseMs` 都不在，且 `dialog.ps1` 源码里没有 `AutoCloseMs` |
  | `tests/card-select.ps1` | 新增「不自超时」一条（三张卡 `TimeoutMs=0`、载荷无 `closeMs`、产品代码无 `AutoCloseMs`/`Get-SshWindowTimeoutMs`） |

- **保留（与本条无关，别顺手删）**：
  - 外壳的通用能力 `payload.closeMs`：`shared/ui-card/card-html.ps1` 的 `-CloseMs`、`app/src/App.tsx`
    的倒计时、`Show-CardWindow -TimeoutMs`——审批卡还在用；
  - `dsh-approval-notifier/scripts/ui/shared.ps1:164` 的 `-CloseMs $closeAfterMs`（审批卡 10 分钟无人
    处理自动关，`payload.closeMs` 的通用用法，本轮**不动**）；
  - `New-SshCardPayload` / `New-SshConfirmPayload` / `New-SshFormPayload` 自己的 `-CloseMs` 参数：
    那是通用能力在适配层的入口，删了等于把外壳能力私有化；SSH 现在没有任何调用方传它，
    所以实际效果就是永不自动关。
- **后果**：SSH 的三张卡（勾选 / 确认 / 表单）**一律永不自动关闭**，只能人工关（关窗 = 不算答；
  点「停止」是杀掉子进程，那是 C-11 的取消路径，不是自超时）。`-TimeoutMs` 不传 = 0 = 一直等，
  所以 `Show-CardWindow` 的兜底超时这条也不再需要。
- **怎么复验**：
  - `node --test --test-isolation=none "dsh-ssh-remote/tests/*.test.mjs"`（dialog 4 条在内）；
  - `pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1` → **55/55**（基线 53）；
  - 真机（要部署 + 重启宿主）：弹一张勾选卡**什么都不点**，等到明显超过旧下限（≥5s，实际观测 10 分钟）
    卡片仍在，页脚没有「剩余 m:ss」。
- **边界 / 未做**：
  - **`index.bundle.js` 未重建**（运行路径用它）：本轮的 `lib/*.mjs` 改动要等协调会话 `pnpm build`。
    重建前 bundle 仍会传 `-AutoCloseMs`，但 `dialog.ps1` 已无这个参数——实测 PowerShell 会把未知命名
    参数放进 `$args`（不报错），所以**不会崩**，只是「不自超时」的行为要等重建后才落在运行路径上。
    `tests/plugin-bundle.ps1` 会因此报「产物比 lib\*.mjs 旧」（mtime 口径），这是构建前的预期失败。
    ——**已在 `7c0e9a9` 完成**：bundle 已重建，产物里搜不到 `AutoCloseMs`
    （`tests/card-select.ps1` 现在直接扫 `index.bundle.js` 内容守这一条，mtime 口径判不出来）。
  - `docs/shared-ui-card.md`（§5/§6.1 表格与第 136/163–166 行）仍在描述 `-AutoCloseMs` 与
    `Get-SshWindowTimeoutMs`，文档归协调会话。
    ——**已在 `4d15512` 完成**：§6.1 表格那一行改成「已删（2026-11-10，见 ssh D-39）：ssh 三张卡不传
    `closeMs`、`TimeoutMs = 0`，永不自动关」。
  - `tests/fixtures/form.json`（入库样本）里仍有 `"closeMs": 600000`，与新的生成器不一致；重出样本
    会往仓库根写文件（`tools/gen-fixtures.ps1` 的 `$repo` 硬编码成主仓库根），本轮不动。

## D-40 批量接入（`ssh_jms`）：导入的主机与普通主机**外部同构**，差异全部收在 `lib/jms/`

- **出处**：用户 2026-11-11 口述，逐字要点：「新工具 `ssh_jms`，填写 appid 和 secret，获取该账号能看到的
  所有资产，弹多选卡让我勾要导入哪些，导入完就结束」；「导入后的主机要和正常主机**外部同构**：混在
  `ssh_admin list` 里、`ssh_run` / `ssh_copy` 用法一样、审批卡一样」；「**不要在列表、卡片、错误信息里
  出现 "JumpServer"、"JMS"、"令牌" 等字样**」；「差异只在内部：插件自己签令牌、连到服务器」；
  「多选卡显示名称 + IP，已导入的标『已导入』且默认不勾」。
- **判定**：算需求（新增能力）。可验收标准：① 除新工具 `ssh_jms` 外，既有四个工具的参数、产物形状、
  卡片文案一字不改；② `hosts.json` 里导入的主机与普通主机同一形状 + 一段内部标记 `via`；③ 用户可见文案
  全文扫描无产品名；④ 签名串与切片有固定向量断言（固定时间 → 已知 HMAC、固定前缀 → 逐字节相同）。
- **根因/结构**：外部同构的代价是「怎么连」这件事必须收敛到**一个点**。连接池只认 `address|port|user`
  与一个 `password`，所以把「自签凭据」做成**取密码的同一步**（`lib/pool/connect.mjs` 里
  `isJmsHost(host)` 一个分支），而不是给 pool 加一条连接路径。于是 lifecycle / exec / 超时 / 断链判断 /
  审批 / 复制全都不需要知道这件事存在——这就是「外部同构」在代码里的意思。

- **分层**（新增 `lib/jms/` 一层，只放这一类逻辑；四层约束不变，且这一层不认识卡片也不认识表格）：

  | 文件 | 职责 | 不认识什么 |
  | :--- | :--- | :--- |
  | `lib/jms/sign.mjs` | HTTP 签名：待签串 + `Authorization` 头（纯函数） | 配置、网络、主机 |
  | `lib/jms/api.mjs` | 三个请求：资产清单 / 资产账号 / 连接凭据 | 卡片、密码库、hosts |
  | `lib/jms/config.mjs` | `config.json` 的 `jms` 块 + `vault.dat` 的 `jms:secret` 条目 | 资产语义 |
  | `lib/jms/hosts.mjs` | `via` 标记、资产 → host 记录、表单字段与选择行的形状 | 连接、签名 |
  | `lib/jms/remote.mjs` | `host` → 连接三元组（现签凭据 + 接入端口 + 账号用户名） | 卡片、hosts.json |
  | `lib/jms/stream.mjs` | stdout 前缀与首尾标记的切片器（`Transform`） | 谁在用 |
  | `lib/jms/tool.mjs` | `ssh_jms` 工具：两张卡 + 校验 + 落盘 | 建连细节 |

- **连接凭据与连接池键的关系**（两条别混）：
  - 凭据是**一次性**的（约 5 分钟、用一次就废），所以它只能活在「一次 `client.connect()`」里；
  - 池的键是 `address|port|user`，代表「这台机器的这条连接」；
  - 两者的关系只有「建连时现取一个」：凭据**不进键、不缓存、不复用**，过期只影响下一次重连，
    已经建立的会话照跑。
  - 反过来（把凭据放进键）每次签出来的值都不同，池子永远命中不了，一台机器会堆出无数连接。
- **122 字节前缀**：接入点每个 exec 通道的 stdout 前面有一段固定前缀（实测 122 字节），不是命令输出，
  但会粘在第一行前面。两条路径分开处理：
  - **读字节流**（`ssh_copy` 的 `cat` / `tar -cf -`、预检）包首尾标记
    `printf '@@DSH_B@@'; <cmd>; printf '@@DSH_E@@'`，接收侧用 `createMarkerStripper()` 切片
    （跨块也认；**没有开始标记就报错**——前缀会被当成文件内容写进目标端，坏的是数据）；
  - **跑一条命令**（`ssh_run`）用 `wrapExecCommand` 包成
    `printf '<B>'; ( <cmd> ) 2>&1; __dsh_rc=$?; printf '\n@@DSH_RC=%s@@\n' "$__dsh_rc"; printf '<E>'`，
    接收侧先 `stripMarkedText()` 切一刀（**没有开始标记就原样返回**，理由见下），再用
    `parseExecOutput()` 取走退出码标记（真机复验后改的，理由见本节末「真机复验后的修正」）；
  - **写数据**（目标端 `cat > tmp` / `tar -xf -`）不用管：前缀只加在 stdout，落地回执
    （`dsh-ssh-wrote=`）在 stderr，解析侧只认那一行。stderr 一律不切：切了会吃掉真实报错；
  - 标记名用 `@@DSH_B@@` / `@@DSH_E@@` 而**不是**含产品名的 `@@JMS_*`：命令原文会进超时错误文案，
    带产品名等于把它泄进用户可见的错误信息，与本次要求直接冲突。
- **为什么 exec 也要包装**（第一版只包了搬运，留了个坑）：「与普通主机看起来没有区别」也包括输出本身——
  每条命令的 stdout 都多一段部署提示，人看着突兀，模型按 JSON / `key=value` 解析也会被第一行带偏。
  包装的代价必须精确控制：`( … )` 子 shell 让 `cd` / 变量 / `set -e` 不漏到外层；`__dsh_rc` 取这个名字
  是因为它在子 shell **外面**，原命令里的同名变量泄漏不出来、不会互相覆盖；多行命令的右括号另起一行，
  否则末行是 `# 注释` 时括号会被注释吃掉、变成语法错误。退出码怎么交回来见下一节。
- **为什么起始标记缺失时「原样返回」而不是报错**（exec 与字节流在这里故意不同）：`ssh_run` 面对的是
  任意命令与任意主机状态——`via` 标记可能被手改、通道可能在打印标记前就被远端掐掉、包装也可能被以后
  的改动绕过。这时报错会让一条本来成功的普通命令莫名失败；留一段前缀只是难看，不影响判读。
  字节流相反：前缀会被当成文件内容写进去，坏的是数据，所以那里必须失败。两条路径各按「坏了什么」
  选严格程度，不是两个口径。
- **被否的方案**：
  - **自动全量同步**（启动或 `ssh_status` 时把资产全导进来）：用户要的是「勾哪些导哪些」；
    自动同步会让人不注意时目标清单变长，且 `remove_host` 删掉的主机会被下次同步复活。
  - **列表 / 卡片 / 错误里写产品名**：直接把要求否掉的词写进界面。产品独有的信息只留在内部标记
    `via` 与 `config.json` 里。
  - **走 SFTP**：接入点不给 sftp 通道；`ssh_copy` 本来就是 cat/tar 对流（D-32），加一条 SFTP
    等于两套搬运实现。
  - **另开一份密钥存储**：密钥与主机密码都是「本机加密存储」，`vault.dat` 已有 DPAPI + 绑定哈希 +
    `.bak` 回滚，另开一份就是第二个坑。
  - **给 pool 加一条「导入主机」连接路径**：lifecycle / exec / 复制都要认识两种连接，外部同构立刻破功
    （错误文案、超时、断链判断会分叉）。
  - **把凭据写进 `hosts.json`**：一次性凭据写盘只会在下次启动时过期，还会把 `hosts.json` 变成密码文件。
  - **多选卡复用 8 行审批上限**：8 行是「一次执行多少条命令」的阅读节奏，资产清单是库存；到 8 行就把一次
    导入切成几轮。这里按清单长度给 `maxRows`（卡片本身滚动）。
  - **接管同身份的直连主机**（初版的行为）：真实环境不存在这种数据——导入的主机不会同时有一条同身份的
    直连记录（用户 2026-11-11：「不会有这种情况 被 jumpserver 接管的主机不会出现直连的情况」）。
    留着这条分支只会多一条**改写用户自己配的主机**的路径（补 `via`、换标签），所以整条删掉：
    同身份且已是导入条目才更新，万一同身份的是直连条目就只让路新增，一个字都不改。
- **与派活提示词的偏离（都在这里说明，代码按这里写）**：
  1. 标记名 `@@DSH_B@@` / `@@DSH_E@@`（理由见上）；
  2. 资产 IP 撞上已有主机 id 时用 `suggestHostId` 的 `IP-22` / `IP-22-2`（提示词里写的 `jms-<ip>`）：
     id 会进 `ssh_run` 的 `hosts` 参数与 `ssh_admin list`，带产品名就违反本次要求；
  3. 表单字段叫「接入端口」而不是「KoKo 端口」；`ssh_status` / `ssh_admin list` 里那台主机显示
     「凭据已接入」而不是「无密码」（它本来就没有密码这条路径）；
  4. 多选卡里**已导入的行只标「已导入」**，与其它行一样默认不勾（外壳没有「预勾选」协议）；
     勾了已导入的行＝按三元组更新那台（`applyAssetImports` 的 `updated`）。

- **怎么复验**（命令都在 worktree 里跑）：

  ```powershell
  # 1) 单测：9 个文件 / 149 条 ok / 0 失败（基线 149；本轮没加 .mjs 测试，新断言在 tests\jms.ps1）
  node --test --test-isolation=none "tests/*.test.mjs"
  # 2) 适配层：60/60（签名向量、字节流切片、执行包装与退出码标记、hosts 标记与 targetLabel 去重、
  #    set_label、两张卡的行与端口默认值、禁词扫描、接线）
  pwsh -NoProfile -File tests\jms.ps1
  # 3) 既有卡片断言不受影响：55/55
  pwsh -NoProfile -File tests\card-select.ps1
  # 4) 改了 lib\** / index.js 就要重建运行路径产物（在 worktree 里跑，esbuild 从仓库根 node_modules 借）
  npm run build   # → index.bundle.js
  ```

  单测要在 worktree 里有 `node_modules`：`New-Item -ItemType Junction` 指到仓库根那份，
  跑完用 `[System.IO.Directory]::Delete($path, $false)` 删 junction（别删目标）。

- **未验**：
  - 资产清单只取第一页（`?limit=100`），>100 台的账号会导不全；
  - `wrapExecCommand` 的退出码标记只做了字符串与纯函数断言（`@@DSH_RC=1/0/127` 解析、取最后一个、
    剔除干净），**没在真机跑过**「`false` → 退出码 1」「`exit 5` + stderr 合并 → 文本可见、退出码 5」；
  - **解析不到退出码标记时退回通道 code 的分支未验**（真机上通道给的恒为 0；这条只在「包装被绕过 /
    输出被截断 / 通道在标记前关」时才会走到，按「未验」记，不当作已验证）；
  - 真机未验：真实接入点的签名与三个接口、连接凭据、登录通道、前缀的实际内容与长度、
    表单卡与多选卡的真弹与勾选、`ssh_copy` 真机搬运（含目录）、`ssh_run` 真机输出
    （前缀是否真的切干净、多行命令与注释末行是否真能跑）、合并与部署。

### 真机复验后的修正（2026-11-11，v0.23 + 真实接入点）

真机（`ssh_run` 打导入主机）暴露出四处「导入主机与普通主机行为不一致」，逐条定因与处置：

1. **退出码恒为 0、stderr 丢失**：接入点的 exec 通道**不回 exit-status**（`false` 也报 0），
   也**不给 stderr 通道**（`echo OUT; echo ERR >&2; exit 5` 只看得到 `OUT`）。
   - **为什么退出码要自己带回**：通道退出码不可信，`exit $__dsh_rc` 交回去也没人看。改成把真实退出码
     写成 `\n@@DSH_RC=<n>@@\n` 混在 stdout 里，读侧 `parseExecOutput` 取**最后一个**（命令自己 echo
     同名串也骗不过），再把它从可见文本里连前后换行一起删掉，`exec.mjs` 用这个值当退出码
     （`resolveExitCode`：标记优先，解析不到才退回通道 code，两边都没有＝`null` → 仍走 `dropped`）。
   - **为什么合并 stderr**（`2>&1`）：没有 stderr 通道，不并进 stdout 就永久丢失报错文本。
     **代价**：`ssh_run` 的 `stderr` 字段从此对导入主机一直是空的——不是丢，是并入 stdout 了；
     报错文本在 stdout 里可见，退出码也是真实的。`dropped` 判定一个字没改（通道在结束标记前关仍是 dropped）。
2. **卡片行重复** `192.168.1.16:22 · 192.168.1.16`：很多资产的名称就是 IP，`IP:22 · IP` 等于同一句
   念两遍。修法：多选卡行标题只在**名称与地址不同**时才追加 ` · 名称`；**删掉行里那段
   「资产：… / 地址：…」正文**（它让同一个 IP 在卡片上出现三遍）——没有 `text` 时外壳不画代码框，
   行只剩标题与「已导入」。导入主机的 `label` 同理：资产名等于地址或缺省时就用地址，不造重复串。
   `targetLabel()` 去重规则：**`label` 与 `id` 或 `address` 相同（大小写不敏感、先 trim）时不拼 ` · label`**，
   对普通主机同样生效；`id` 也参与比较是因为 `label` 缺省时会退回 `id`。
3. **备注写死成资产名且不能改**：`ssh_admin` 增加 `set_label`（`id` + `label`）。
   - **为什么不弹卡**：它只改一个给人看的名字，不动地址/端口/用户名/密码，可重试、改错再改一次即可，
     不是不可挽回的操作（AGENTS §0）；多一张卡只是多一次点击。结果里回显 `id` 与「旧 → 新」，
     留空退回地址，与 `add_host` 的 `label` 规则同一条。
   - 对导入主机与普通主机都可用（判重不看 `label`，所以不存在「改备注变成另一台」）。
4. **接入端口默认值**：标准默认是 **2222**（用户环境里改成 52222 是环境差异，不是默认值）。
   表单未填过配置时预填 2222、占位写 2222；`config.mjs` 的 `DEFAULT_JMS_PORT` 与
   `normalizeJmsConfig` 的兜底同为 2222。

另外：`lib/approval.mjs` 的 `rowPlain` 在没有 `text` 时也把 `lang` 带下去——行协议里 `lang` 是
「键在不在」的语义，与正文是否存在无关；正文为空时外壳本来就不画代码框。

## D-41 插件维护接口：宿主侧自建前缀路由（设置页与工具共用一份实现）

- **需求**：下一步的「插件设置页」需要一个宿主侧操作接口——浏览器用同源 `fetch` 调，宿主执行真实动作
  （读写 `hosts.json` / `config.json` / vault、真连一次、调接入点）。**一份实现在宿主**，界面与工具共用；
  这一步不写浏览器代码（`lib/client.js` 未改），也不动 `ssh_admin` 的会话入口。
- **文件**：`lib/api/routes.mjs`（路由表 / 鉴权 / 请求体 / 状态码）、`lib/api/handlers.mjs`（主机动作 + 装配）、
  `lib/api/gateway.mjs`（接入点动作）、`lib/api/shared.mjs`（入参清洗 / 连接视图等小工具）。
  拆成四份是因为主机与接入点各自一件事，合成一份会超 400 行（仓库规范 §2）。
  注：派活提示词里写的 `lib/state.mjs` 在本仓库实际是 **`lib/store.mjs`**（`tests/state.test.mjs` 测的就是它）。

### 一、先确认的接口事实（2026-11-11，DSH `0.2.1-rc.2`，装在本机 profile 的那一份）

证据路径都相对 `node_modules/@deepseek-ai/`（版本随 DSH 安装，不是仓库文件）：

| # | 问题 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| 1 | `ctx.webServer` 怎么注册 | `register({ kind: 'exact'` \| `'prefix', path, handler })`，handler 是 `(req: IncomingMessage, res: ServerResponse) => void \| Promise<void>`，**自己拥有整个响应生命周期**（可以挂着不结束，例如 SSE） | `dsh-host-webserver/lib/types/index.d.ts:34-40`（WebRoute + handler 注释 `:38`）、`:174`（register 返回 disposer） |
| 1b | 前缀怎么匹配 | `'prefix'` 的 `p` 匹配 `p` 与 `p/<任何>`，多个前缀时**最长优先**；没有 fallback 时未命中回 404 | `dsh-host-webserver/lib/types/index.d.ts:31`；`lib/index.js:494-505`（match）、`:376-394`（未命中 → fallback / 404） |
| 1c | handler 抛错会怎样 | **宿主只回空 body 的 400** 并把错误写进日志（`res.writeHead(400); res.end()`），所以 400/403/500 必须自己写、自己给 JSON | `dsh-host-webserver/lib/index.js:395-405` |
| 2 | 鉴权用哪个 | `ctx.connection.requestRejection(req)` 返回 `undefined \| 401 \| 403`：`403`＝Host/Origin 围栏不过，`401`＝没有已认证的浏览器 cookie / API 凭据（或连接已 dispose）。**它不写响应**，由调用方决定怎么回 | `dsh-client-connection/lib/index.js:737-740`（requestRejection）、`:742-750`（admit 的三种结局）；围栏语义 `lib/types/api-request-trust.d.ts:37-44` |
| 2b | 为什么不 `authorizeIndex` | `authorizeIndex(req,res)` 会自己写 401 或抛「重定向到干净 `./`」，那是 **HTML 入口**的语义（换 cookie / 引导浏览器导航）；API 要的是 JSON 错误 | `dsh-client-connection/lib/index.js:805-810`；`lib/types/browser-auth.d.ts:31-44` |
| 3 | 本插件怎么拿 ctx / 怎么 effect / 卸载摘路由 | `apply(ctx, config)`；`ctx.effect(() => disposer, label)` 在卸载/重载时执行 disposer；`webServer.register` 返回的就是「摘掉这条路由」的 disposer，所以卸载自动摘除，不留旧 handler | 本插件 `index.js:100`（apply）、`:152-158`（注册）、`:169`/`:173`/`:192`（既有 effect 用法）；`dsh-host-webserver/lib/index.js:326-333` |
| 4 | 请求体怎么读 | 手工 `for await (const chunk of req)` + 64 KB 上限，不引第三方框架；声明了 `content-length` 就先挡一道，超限 `req.resume()` 把流排空再回 400 | 本插件 `lib/api/routes.mjs` 的 `readJsonBody`；同一套写法见 `dsh-host-open-in-app/lib/index.js:1176`、`:1191-1210` |
| 5 | 真实用例 | 宿主自己的插件就是这么挂 API 路由的：先 `requestRejection`（拒绝就 `res.statusCode = rejection; res.end()`），再判方法、再写 JSON | `dsh-host-open-in-app/lib/index.js:1263-1282` |

结论：**照抄宿主自己的做法**——`kind: 'prefix'` 一条路由 + `requestRejection` 鉴权 + 自己写 JSON 状态码。

### 二、为什么自建路由，而不是 Typert Remote

- Typert 的客户端半边靠 `$mount` 把生成器产物挂进页面，而**生成器没有随 DSH 安装**（本机 profile 里只有运行时，
  没有 codegen；`lib/client.js` 也只是一段客户端脚本，不参与构建期生成）。要用它就得先给插件补一套生成/构建链，
  在「一个设置页、九个接口」的量级上属于把成本放到最贵的地方。
- 这条路由的消费者**只有同源页面**：`fetch('/plugin-data/ssh-remote/api/...')` 天然带 cookie、天然同源，
  不需要再发明一套 RPC 描述、校验与序列化；接口形状写在一处（`API_ROUTES` + handlers），下一步的界面照表写即可。
- 代价要认：**没有 Typert 的 schema 校验与类型生成**。补偿是：入参在 handler 里逐项校验（400 + 中文说明），
  形状由 `tests/api.test.mjs` 钉住（20 条用例覆盖形状、状态码与凭据不外泄）。

### 三、为什么鉴权必须用 `requestRejection`

这条路由挂在**本机 HTTP 服务**上，浏览器能打到它，就同时打开了两个经典 confused-deputy 通道：
DNS rebinding（Host 指向攻击者域名、socket 却落到本机）与跨站请求（恶意页面直接 POST）。只校验「从 127.0.0.1 来的」
不够：回环地址不是身份。宿主的 `requestRejection` 正是这两件事的围栏（Host 围栏**所有**请求都过，浏览器形态的请求
再加 Origin/同源），并且在通过围栏后还要求「已认证的浏览器会话」——也就是 **Host 对了、人也得是这台机器上的登录者**。

规则：`requestRejection(req)` 只要不是 `undefined`，**一律回 403 + `{error}`，不回任何业务数据**，并且把请求体排空
（否则 keep-alive 连接上的下一个请求会被这半截 body 污染）。未授权时不写盘、不建接入点客户端（测试里断言
`vault.dat` 都不存在）。鉴权函数自己抛错也按拒绝处理（fail closed），不把错误细节回给调用方。

### 四、密码 / 密钥的传输与落盘边界

| 通道 | 形式 | 边界 |
| :-- | :-- | :-- |
| 浏览器 → 宿主 | POST JSON 里的 `password` / `secret` 字段（HTTPS 由宿主 listener 决定；本机回环时是明文 HTTP） | **只在这一次请求的内存里存在**：不写日志、不进 URL、不进返回值；请求体上限 64 KB |
| 宿主内存 → vault | `store.vault.setPassword()` / `setCredential()`（DPAPI 密文，`vault.dat`） | 与 `ssh_admin` 同一套：先写密码库、再落 `hosts.json`；写失败就什么都不写 |
| 返回值 | `passwordSaved: bool`、`hasSecret: bool` | 永远不回显值；`gateway/status` 只回答「有没有可用的密钥」 |
| 错误文本 | `errorText()` 只取 `error.message`，去换行、截 300 字，并**把这次请求体里的 `password` / `secret` 整串替换成 `***`** | 上游库报错不受我们控制，所以按「宁可多抹」处理；不带堆栈（测试断言 `/\bat .*\.mjs:\d+/` 不出现） |

密钥绑定沿用 D-40 的规则：`jms:secret` 用 `addrHash(地址|接入端口|appid)` 绑定，改了地址 / appid / 接入端口之后
旧密钥自动失效（状态如实显示未配置），**不把旧密钥悄悄发给另一个接入点**。

### 五、为什么路由前缀用 `gateway` 而不是产品名

- 「不许出现产品名」是硬要求：路径会出现在浏览器开发者工具、代理日志、错误信息与下一步的界面文案里。
  `/plugin-data/ssh-remote/api/gateway/...` 只说「这是一台接入点」，换个来源系统也只改实现、不改接口。
- 内部实现沿用既有的 `lib/jms/*` 与 `store.jms`（D-40 已经定了这套名字，改它只会制造第二套叫法）；
  **对外**（路由、返回值字段、错误文案）统一用 `gateway` / 「接入点」。`source: 'gateway' | 'direct'` 同理，
  不把「经哪个系统导入」泄给界面。

### 六、数据写入：`StateStore` 是唯一写入口

- 新增 `store.updateHosts(mutate)`：在**串行队列**里读当前文档 → 改 → 原子写 → 重载。两个并发保存（设置页连点、
  两处同时改）不会各自基于旧快照写盘、互相覆盖；`mutate` 抛错（校验失败）就一个字节都不写。
- 新增 `store.saveJmsConfig(config)`：同样进队列，调既有的 `writeJmsConfig`（只覆盖 `jms` 三个字段，
  `config.json` 里的超时与 `_说明` 原样保留）后重载。
- 纯逻辑一律复用：`upsertHost`（判重＝地址+端口+用户名）、`setHostLabel`（备注留空退回地址）、
  `applyAssetImports`（同身份已导入＝更新；同身份直连条目让路新增、一个字都不改）。这里不复制任何一条规则。
- 写 `hosts.json` **不绕过 store**：绕过就会和 `fs.watch` 的 250ms 合并重载形成「写→重载→再写」的回环，
  还会让内存与磁盘各说一套（D-38 之前踩过「半写窗口」的坑，`readJsonFile` 对空文件直接报错就是为它）。
- 写入后的连接处置与 `ssh_admin` 对齐：改身份 → 关连接 + 清认证冷却；只改密码 → 只清冷却（关掉会把
  正在执行的会话打断）；删主机 / 导入更新 → 关连接 + 清冷却。

### 七、被否方案

- **`commands` 命名空间**（把动作发进会话命令、让宿主转给插件）：命令与参数会写进**会话记录**（`session.v4.jsonl*`），
  密码一旦走那里就等于落进历史文件，与「密码只在内存里过一手」直接冲突。**绝不用于凭据**，这一条没有折中。
- **`sshctl.ps1` 之类的 CLI + 子进程**：设置页要的是「点一下就生效」，起子进程既慢又要处理 stdout 解析与
  密码传输（命令行参数、临时文件都是新的泄露面）；而且等于把业务再实现一遍。
- **把 `password` 放在 URL query**：会进浏览器历史、代理日志、Referer；只收 JSON body。
- **用 `userQuestions` / 桌面卡片代填**：设置页是浏览器里的表单，弹桌面卡等于让用户在两处输入同一件事。
- **改 `hosts.json` 的格式**（例如把密码放同一个文件）：D-38/D-40 的边界不动——元数据明文、凭据只进 vault。

### 八、状态码与形状（下一步做界面时照这张表）

| 码 | 什么时候 | body |
| :-- | :-- | :-- |
| 200 | 动作完成（**包括 `hosts/test` 的 `ok:false`**：连不上是结果，不是接口错误） | 见各接口 |
| 400 | 入参校验失败 / 还没配置接入点 / 未知主机 id / 请求体过大或不是 JSON 对象 | `{error}` |
| 403 | `requestRejection` 拒绝（未授权）；鉴权函数自己抛错也按这条 | `{error}` |
| 404 | 前缀下没有这个接口 | `{error}` |
| 405 | 方法不对（`Allow` 头给出允许的方法） | `{error}` |
| 500 | 宿主内部异常（例如 vault 不可用），文本不含堆栈、不含凭据 | `{error}` |
| 502 | 接入点那一侧失败（网络 / 认证 / 权限） | `{error}` |

### 九、复验

- `node --test --test-isolation=none "tests/*.test.mjs"`：10 个文件全过（新增 `tests/api.test.mjs` 20 条用例）。
- `pwsh -NoProfile -File tests/jms.ps1` 60 项、`tests/card-select.ps1` 55 项：全过（本次未改卡片与导入逻辑）。
- `node --check` 过所有改动文件；`npm run build` 重建 `index.bundle.js`（产物里能搜到 `plugin-data/ssh-remote/api`）。
- 未验：真浏览器 `fetch`（下一步界面）、真实接入点（协调会话真机验）、真机 SSH 连接下的 `hosts/test` 延迟。

## D-42 设置页「SSH 主机」：设置左栏的一级页（`settings.section`）

- **需求**：主机清单与接入点要在**界面上**维护（新增/改备注/测试/删除、存接入点/拉资产/勾选导入），
  不再让用户看着模型弹卡输密码。这一步只写浏览器半边，宿主接口沿用 D-41（九个 POST，前缀
  `/plugin-data/ssh-remote/api`）。
- **落点**：先按「内置插件里的一个标签页」做了第一版，真机截图给用户看后**被否**，改成设置左栏的
  一级页（与「通用设置 / 模型 / 内置插件 / Agent 预设 / 认证」并列）——见下面第二节，已改。
- **文件**：`lib/client.js`（页面 + 原有审批卡样式注入，1431 行，拆分例外见 D-43）、
  `tests/client.test.mjs`（15 项）。

### 一、先确认的五条契约（2026-11-11，DSH `0.2.1-rc.2`；证据路径相对 `node_modules/@deepseek-ai/`）

| # | 问题 | 结论 | 证据 |
| :-- | :-- | :-- | :-- |
| 1 | 客户端模块契约 | `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 返回 exports，加载器读 `exports.inject: string[]` 与 `exports.apply(ctx)`。`inject` 里的名字保证 `apply` 时这些服务已就位（`slots`、`locale`） | `dsh-client-ui-settings-web-search/lib/client.js:1-9`（load / factory / 三条 require）、`:483-489`（inject 数组）、`:522-526`（`exports.NS/apply/inject` + `return module.exports`） |
| 2 | `ctx.slots.register` 签名 | `({ name, id, order, label, locale, inject?, children? }, Component)`；`label` 可以是 `() => string`（语言变化时宿主重读）；必须包在 `ctx.slots.inject(name, () => register(...))` 里，等槽被声明后再挂。**`settings.section` 的组件会额外收到 `{ close }`**（关闭设置面板） | 一级页：`dsh-client-ui-settings-general/lib/client.js:1293-1303`（通用设置）、`dsh-client-ui-settings-account/lib/client.js:4777-4783`（认证）；子标签：`dsh-client-ui-settings-plugin-inventory/lib/client.js:757-764`；渲染 props：`...general/lib/client.js:337`（`renderSlot("settings.section", { close: onClose }, …)`） |
| 3 | 能 `require` 什么 | **冻结的 11 个 id**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`-ui-slots`、`-ui-primitives`、`-ui-dockkit`。其余 id 一律不存在 | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 里的 `function SZ()`（压缩成一行，`SZ` 在字符偏移 ≈ 916 200 处，表里 11 个 id 可逐个搜到） |
| 3b | primitives 的实际导出名与签名 | 本页用到的都在：`Button`（`{ variant='ghost', size='md', icon, className, ...rest }` → `<button type="button">`，`className` 最后合并，所以能挂自定义类名）、`Input`（透传原生 props，`onChange(event)`）、`Modal`（`{ open, onClose, title, closeLabel, description, children, footer, className, contentClassName, headless, … }`，`open` 为真时 `createPortal` 到 `document.body`——那是宿主自己的行为，本插件没改 body）、`Tag`（`{ tone='outline', className, children }`，色调只有 `outline/solid/neutral/quiet/success/info/warning/danger`）、`IconEditOutlineRegular`（`size`）。**没有 `Modal.confirm`**：出货产物里 0 命中，所以删除确认只能自己画 | `index-CN7NIWNw.js` 的 `n2=C.forwardRef(function({variant:t="ghost",size:r="md",…})`（偏移 ≈ 640 400）、`function S_({open:e,onClose:t,title:r,closeLabel:i,…})`（偏移 ≈ 843 000）、`function o4({tone:e="outline",className:t,…})`；色调列表在 `index-BxpfOGf3.css` 的 `._tag_…_4[data-tone=…]` |
| 4 | 文案 | `ctx.effect(() => ctx.locale.register(NS, { zh, en }), …)`；`const t = ctx.locale.bind(NS)`；槽上写 `locale: NS` 后宿主把 `t` 注进组件 props | `dsh-client-ui-settings-web-search/lib/client.js:494-495`；`dsh-client-ui-settings-plugins/lib/client.js:168-169` |
| 5 | 同源请求怎么写 | 宿主没有「插件自有 API」的客户端封装，所以自己拼：`fetch(new URL('plugin-data/ssh-remote/api/…', document.baseURI), { method:'POST', credentials:'same-origin' })`。`document.baseURI` 是宿主客户端解析同源路径的既有写法（换端口 / 反向代理 / 子路径都不用改代码） | `dsh-client-file-upload/lib/client.js:263`（`new URL(request.path, document.baseURI).href`）、`dsh-client-connection/lib/client.browser.js:1349`（baseURI 兜底） |

### 二、落点：设置左栏一级页（`settings.section`），不是「内置插件」的子标签

**第一次做错了，改的过程记在这里。** 第一版注册的是「内置插件」页的子标签槽
（`settings.plugins.tab`，官方 `settings-plugin-inventory` 的「插件清单」就走这个槽）：技术上能跑，
真机也能看到 tab，但用户看了截图立刻否掉——原话是「这不是内置插件吗？不应该放在这里 外面的列表里吗？
比如这个认证插件？」。判断标准很清楚：**它本该是左栏那一列里的一项**，跟「认证」平级，而不是某个
页面的内部标签；放在「内置插件」里等于宣称「这是内置插件的一部分」，语义也不对。

- `settings.section` 是设置面板声明的一级页槽：`{ kind: 'list', scope: 'root' }`
  （`dsh-client-ui-settings-general/lib/client.js:1258-1261`）；左栏导航就是拿
  `ctx.slots.entries("settings.section")` 拼的（同文件 `:1140-1155`），选中项连同 `{ close }`
  一起渲染（同文件 `:337`）。官方占用者：认证 `-10`、通用 `0`、模型 `10`、内置插件 `15`、预设 `20`。
- 本页取 **order 30**（现有最大是 20，留 21–29 给以后插进来的人，不靠算出来的值）。
- 组件 props：`settings.section` 会给 `{ close }`（点它关整个设置面板）。本页不需要主动关面板
  （每个动作都有自己的返回提示），所以**不声明** `close`，只收 `t`。
- 页面里保留一个 `h2` 页头，文字就是左栏那一项（`t('nav')`），点进来不至于像一截碎片。

**被否的落点**：
- `settings.plugins.tab`（第一版）：用户否掉，见上；且那是别页的内部标签，耦合了「内置插件」页。
- 插件卡片详情页 `plugins.bundle.config`：一个插件一张卡的区域，主机表 + 资产表塞进去太窄。
- 只在工具/文档里维护（不做界面）：用户明确要在界面上维护。

**一次性只留一个入口**：改成 `settings.section` 时把旧的 `settings.plugins.tab` 注册整段删掉，
不留兼容开关、不留两处入口；`tests/client.test.mjs` 有一条断言直接扫源码，出现
`settings.plugins.tab` 就红——防止哪天「顺手加回来」变成两套界面。


### 三、凭据在这条链上的边界（浏览器一侧）

- 两个密钥框都是 `type="password"` + `autoComplete="new-password"`（后者防浏览器把已存密码填回来）；
  **留空＝不改**，与 `hosts/save` / `gateway/save` 的语义一致（D-40）。
- 保存成功立刻清空：主机弹窗保存后关闭即销毁；接入点存完 `setForm({ …, secret: '' })`。
  页面**从不接收**密钥——`gateway/status` 只回答 `hasSecret`，没有可回显的东西。
- 不进 `localStorage` / `sessionStorage`、不进 URL、不 `console.log`；单测有一条断言直接扫源码。
- 403 换成人话「无法访问本机维护接口，可能需要重新登录」，不把宿主的 JSON 原样抛给用户；
  400/500/502 的 `{error}` 是宿主写好的中文说明，原样显示。
- 单测固定了「密钥框的值永远是空串」：假渲染器把 `Input` 的 `value` 当文字渲染，回显一次就会红。

### 四、为什么导入主机与直连主机长得一样

表格只有 **地址:端口 / 账号 / 备注 / 状态 / 操作** 五列：没有来源列、没有来源标签、没有 id
（`hostView` 的 `source` 字段这一页根本不读，单测断言渲染文字里不出现 `gateway` / `direct` / id）。
理由与 D-40 一致：来源是实现细节，用户关心的是「这台机器能不能用」。改备注走 `hosts/label`，两种主机同一条路
（D-40 已定「判重不看 label」，所以改备注不会变成另一台）。

### 五、界面动作 → 接口（读代码照这张表）

| 界面动作 | 接口 | 之后 |
| :-- | :-- | :-- |
| 首屏 | `hosts/list` + `gateway/status`（并发） | 失败＝错误条 + 重试；已拿到的数据不清空 |
| 新增 / 编辑主机 | `hosts/save` | 用返回的 `host` 就地替换那一行，不整表重拉 |
| 行内改备注 | `hosts/label` | 同上；Enter 存、Esc 取消、失焦取消 |
| 测试 | `hosts/test` | **200 也是结果**：`ok:true` → 「123 ms」绿字，`ok:false` → 红字原因；3 秒后自动收起 |
| 删除 | `hosts/remove` | 先就地二次确认（没有 `Modal.confirm` 可用），成功后从列表移除 |
| 保存接入点 | `gateway/save` | 「已保存」+ 用返回状态刷新徽标；密钥框清空 |
| 拉取资产 | `gateway/assets` | 画资产表；已导入的行禁选 + 「已导入」 |
| 导入选中 | `gateway/import` | 一行结果（新增 n / 更新 m / 跳过原因）→ 刷主机表 → 静默重拉资产清单 |

**一处与需求清单的偏差**：操作列除了「测试」「删除」，还多一个「编辑」。需求里没写这个按钮，但改地址 / 改账号 /
换密码只有 `hosts/save` 这一条路，没有入口的话用户改个端口就得「删掉重建」，还会把密码一起丢掉。编辑走同一个
`hosts/save`（带 `id`，密码留空＝不改），弹窗与新增是同一个组件。

### 六、被否方案

- **Typert 的客户端 `$mount`**：D-41 已经否过（生成器不随 DSH 安装），这一步没有新增理由。
- **把页面拆成多个客户端文件**：见 D-43。
- **用 primitives 的 `Checkbox` 做资产多选**：它的 `label` 是可见文字，会和「名称」列重复；改用原生
  `<input type="checkbox">` + `aria-label`，样式只动 `accent-color`。
- **用 `InlineEditor` 改备注**：它是多行编辑（Enter 换行），而这里要的是单行 Enter 保存 / Esc 取消。
- **乐观更新**（先改 UI 再发请求）：失败要回滚，回滚反而让人怀疑「到底改没改」；一律等响应再改。
- **每个动作整表重拉**：多一次往返，还会闪一下表格；用返回值就地替换。
- **给 `hosts/test` 加客户端超时提示**：接口自己同步返回 `{ok, ms}`，再包一层只会更慢。

### 七、复验

- `node --test --test-isolation=none "tests/*.test.mjs"`：**11 个文件、31 个顶层用例全过**
  （`tests/client.test.mjs` 15 项：加载契约 / 槽契约（`settings.section` + 源码里不再出现
  `settings.plugins.tab`）/ effect / 字典完整性 / 文案键 / 产品名 / 请求路径与方法 / 凭据边界 /
  六组渲染断言 / `node --check`）。
- `tests/jms.ps1` **60 项**、`tests/card-select.ps1` **55 项**：全过（本次没动卡片与工具）。
- `npm run build` 重建 `index.bundle.js`（这次确实要重建：`index.js` 改了）。产物里
  `ctx.inject(["webServer", "connection"]` 与 `plugin-data/ssh-remote/api` 都在，
  `sshRemote` / `__ModuleLoader__` / `sshrm-` / `settings.plugins.tab` 仍然 0 命中（客户端代码不进宿主产物）。
- 审批卡 CSS 逐条比对：改动前后 13 条规则文本一致（只把注入动作抽成 `mountStyle` 复用）。
- 未验：真浏览器渲染（深浅色、窄宽度、表格换行）、真实点击（新增 / 编辑 / 测试 / 删除 / 拉取 / 导入）、
  真实 `fetch` 打到宿主接口（403 文案只在单测里按状态码断言；接口 405 的真机问题见 D-44）、
  真实接入点的资产清单与「已导入」回填。

## D-43 例外：`lib/client.js` 单文件 1465 行（超 §2 的 400 行）

- **现象**：仓库规范 §2 要求单文件超约 400 行就查职责；这一份 1465 行（页面 + 文案 + 样式 + 审批卡注入；多接入点那张列表又加了约 220 行、一个账号一行又加了约 35 行），
  按「处理逻辑 / 渲染 / 布局控件 / 入口」四层看，它同时是入口（`__ModuleLoader__`）与布局层（两张卡片），
  文字与样式占了约 500 行。
- **为什么不能拆**：加载器只认识 `factory(require)` 与上面那张冻结的 11 个 id 表；普通 `require('./page.js')`
  解析不到（表里没有相对 id），产物里也没有 tsdown 的 `require.async` 分片——那是打包器切出来的，
  而本插件的运行路径是**零构建**（`lib/*.js` 直接就是上线代码）。
- **拆的代价（被否）**：给客户端引入 esbuild 打包步骤 —— 多一份产物、多一条「忘了构建就上线旧代码」的坑，
  而这一步的界面只有两张卡片、一个弹窗。权衡后选择不拆，按规范记例外，而不是把「零构建」丢掉。
- **补偿**：文件内按五段分区（审批卡样式 / 常量与文案 / 组件 / 样式 / 注册），纯逻辑（`apiUrl`、`callApi`、
  `describeError`、`parsePort`、`hostNote`、`TextField`）与组件分开；18 条单测钉住契约、字典、渲染结构与样式声明，
  改坏会红而不是靠眼睛。
- **重判时机**：再加第二个设置页、或这一页出现第三张卡/第三个弹窗时，拆分（连同打包步骤）就值得做了。

## D-44 维护接口在真机上是 405：apply 时刻取服务 → 改 `ctx.inject` 晚绑定

### 一、现象与判定（真机，v0.25 已部署并重启）

设置页能打开、左栏/标签也在，但首屏报「请求失败，请稍后重试。」。直接 curl：

| 请求 | 真机结果 | 应该是 |
| :-- | :-- | :-- |
| `POST /plugin-data/ssh-remote/api/hosts/list` | **405，空 body，无 `Allow` 头** | 200 JSON（或未授权时 403 JSON） |
| `GET` 同路径 | **404，空 body** | 405 JSON + `Allow`（我们的 `hosts/list` 只收 POST） |
| `POST /plugin-data/ssh-remote/api/nope` | **405，空 body** | 404 `{error:'不认识的接口'}` |

判定标准：**我们的 handler 一旦挂上，就不会回「空 body + 没有 Allow」**——`lib/api/routes.mjs` 的
404/405 都带 `{error}`，405 还带 `Allow`。所以这三条响应的形状说明请求压根没进我们的路由，
405 是 DSH 自己的静态处理器给的（它只按方法判、不认路径）。结论：**前缀路由没注册**，不是界面问题。

### 二、根因

`index.js` 原来在 `apply` 里 `optionalService(ctx, 'webServer')` / `optionalService(ctx, 'connection')`
**取一次**，两个都在才注册，否则整段跳过。插件的 `apply` 常常早于这两个服务就位（它们由别的插件在更晚的
fiber 里提供），于是「取不到 → 静默跳过 → 永远不注册」。没有日志、没有报错，界面上就表现为整条前缀 404/405。

这是**时序缺陷**，不是配置问题：`optionalService` 本身没错（`systemPrompt` 用它是对的），错在把「晚到的服务」
当成「不存在」。

### 三、改法：`ctx.inject(['webServer','connection'], (scope) => …)`

```js
ctx.inject(['webServer', 'connection'], (scope) => {
  const routes = createApiRoutes({ handlers: …, authorize: (req) => scope.connection.requestRejection(req) })
  scope.effect(() => routes.register(scope.webServer), 'ssh-remote: 维护接口 …')
})
```

- cordis `Context.inject` 的语义就是「服务可用才激活」：`registry.d.ts:101-109`
  “Run a callback once the requested dependencies are available … the callback is **unloaded and re-run
  whenever a required service changes**”，是 `ctx.plugin({ inject, apply })` 的简写；`RegistryService.inject`
  同义（`:185`）。官方三处这么用：`dsh-api-gateway/lib/index.js:772`/`:775`、
  `dsh-api-remote-access/lib/index.js:157`、`dsh-agent-loop/lib/index.js:1612`。
- 回调里现造 handlers/routes：store / pool 是同一份，重生一份路由对象只为拿到当前 `scope` 的服务引用。
- disposer 交给 `scope.effect`：服务被换掉或插件卸载时子 scope 卸载 → 路由自动摘掉，不会留下指向旧 handler 的路由。

### 四、为什么不是模块级 `inject`

模块级 `inject = [..., 'webServer', 'connection']` 是**硬依赖**：这两个服务不存在的组合（headless / CLI）
里整个插件都不会加载，`ssh_run` / `ssh_copy` / `ssh_admin` / `ssh_status` / `ssh_jms` 全部消失。
本插件的主业是 SSH 工具，设置页是附加物——不能为了一个页面把工具链拖下水。`inject` 是「缺了就不加载」，
`ctx.inject` 是「缺了就等」，这正是这里要的差别。

### 五、被否方案

- **模块级 `inject`**：见上，headless 组合直接没有插件。
- **`ctx.on('ready')` / `ctx.on('internal/service')` 里再取一次**：`internal/service` 是服务注册/注销的广播，
  不是「全部就绪」，还得自己判断「我要的两个是不是都在」，等于把 `ctx.inject` 的语义手写一遍。
- **定时器重试（每 200ms 试一次 `ctx.get`）**：自造生命周期，服务消失时不知道该不该摘路由，
  插件卸载后定时器还可能继续跑。
- **在 `apply` 里 `try { ctx.get('webServer') }` 加 try/catch**：就是原来的写法，取不到照样静默跳过。
- **把维护接口挪进单独的小插件 / 让工具自己起 HTTP**：一份实现拆两处，且要新开端口或复用宿主的鉴权，
  比修一个服务取法贵得多。

### 六、复验

- 单测（`tests/api.test.mjs`）：① 服务缺失 → `apply` 不抛错、不挂任何路由、五个工具照常注册、
  `ctx.inject` 只声明 `['webServer','connection']`、`ctx.get` 只被问过 `systemPrompt`；
  ② 服务晚到 → 用带 `webServer`/`connection` 的 scope 调回调，路由挂上一条、能真的回 200、
  scope 的 disposer 执行后路由被摘掉。
- 全量：11 文件 / 31 用例全过；`jms.ps1` 60 项、`card-select.ps1` 55 项全过。
- 产物：`npm run build` 重建，`ctx.inject(["webServer", "connection"]` 与 `plugin-data/ssh-remote/api` 都在产物里。
- 真机（协调会话做，需要部署 + 重启）：未登录时应看到 **403 + `{error:'未授权：这次请求不能访问本机维护接口'}`**，
  登录后 200 JSON；不再是 405 空 body。
- 未验：真机重启后的实际响应（本会话不部署、不重启）；`webServer` 热重载时路由是否正确重挂
  （单测覆盖了 disposer，但没在真机上触发过服务变更）。

## D-45 接入点从单例改成列表：`jms.gateways[]`，一个接入点一份密钥（用户 2026-11-12 三条）

### 一、现象与判定

原来 `config.json` 里只有**一套**接入点（`jms.address` / `jms.appid` / `jms.port`），设置页也只有一张卡：
只能接一个来源，换来源＝覆盖上一套配置，原有的主机立刻「凭据对不上」。

用户 2026-11-12 定三条：① 每个接入点**各自**「拉取资产」，不做下拉切换；② 数量不限；③ 每张卡可以删。
迁移要求：现有那个（`192.168.1.16` 那套）自动成为「默认」、名称可改，已导入的主机自动归它名下、不用重导。

判定标准：同时接两个来源、各自拉各自的资产、删掉其中一个不影响另一个；旧数据零操作升级。

### 二、数据形状

`config.json`：

```json
{ "jms": { "gateways": [ { "id": "default", "label": "默认", "address": "https://192.168.1.18", "appid": "ak-x", "port": 2222 } ] } }
```

- `id`：稳定短串，**首个固定 `default`**，其余由地址派生（小写、非字母数字换成 `-`、撞名加 `-2`）；
  改地址**不改 id**——`via.gatewayId` 与 vault 键都跟着它，id 一漂，主机就找不到自己的来源了。
- `label`：给人看的名称，缺省＝地址；只在界面上用，不参与任何判定。
- `port`：登录通道的接入端口（旧字段名 `kokoPort` 已废弃，新形态统一叫 `port`）。

vault：一个接入点一条，键 `jms:<gatewayId>:secret`，绑定哈希 `addrHash({ address, port, user: appid })`。
**一个接入点一份密钥**，删掉一个不会带走另一个；改地址 / appid / 端口之后旧密钥自动失配（`hasSecret:false`），
与「主机地址改过就不复用旧密码」是同一条规则。

`hosts.json` 的 `via` 多一个字段：`{ gatewayId, assetId, accountAlias, accountUser }`。
旧记录没有 `gatewayId`：`viaGatewayId()` 一律当 `default`（迁移出来的那个接入点），
`normalizeHostSource()` **仍然不要求** `gatewayId`——要求了旧 `hosts.json` 的主机会被当成「来源标记不完整」丢掉，
那正是 `tests\jms.ps1` 第 655-656 行在守的语义。

### 三、迁移：只读兼容、写时迁（读路径不写盘）

- **读**：`normalizeJmsConfig()` 看到旧形态（顶层 `address` / `appid` / `kokoPort`）就在内存里换算成
  「一个 id `default`、名称「默认」」的接入点；旧 vault 键 `jms:secret` 在 `readJmsSecret()` 里作为兜底
  （仅 `default`，绑定对不上就当没有）。**读路径一个字节都不写**——`fs.watch` 盯着 `config.json`，
  读时写盘会自己触发自己，热加载打成环。
- **写**：`store.saveJmsConfig()` 是唯一入口，做两件事：
  ① `migrateLegacyJmsSecret()` 把旧键搬到 `jms:default:secret`；② `writeJmsConfig()` 落新形态（保留文件里其它键）。
  迁移**幂等**：新键已存在 → 不动；旧键不存在 → 不动；旧键与新配置绑定不匹配（用户改过地址）→ 不动。
  所以「先跑一次工具、再在设置页存一次」不会把密钥弄丢或弄成两份。
- 现有 `192.168.1.16` 不用重导：它的 `via` 没有 `gatewayId` ⇒ 按 `default`，而旧配置正好迁成 `default`。

### 四、接口（`lib/api/gateway.mjs`）

| 接口 | 入参 | 出参 |
| :-- | :-- | :-- |
| `gateway/list` | 无 | `{gateways:[{id,label,address,appid,port,hasSecret,configured}]}` |
| `gateway/save` | `{id?, label, address, appid, port, secret?}` | `{gateway, created, passwordSaved}` |
| `gateway/remove` | `{id}` | `{removed:true, id, hostsKept}` |
| `gateway/assets` | `{gatewayId}` | `{gatewayId, assets:[…], skipped}` |
| `gateway/import` | `{gatewayId, assets:[assetId]}` | `{gatewayId, imported:[…], skipped}` |

- `gateway/save` **带 `id` 就改那一个（id 不变），不带就新建**（id 由地址派生）；密钥留空＝不改。
- `gateway/status` **已删除**，不留兼容层：多接入点下「当前那个」这个概念本身没了，
  留一个只回答「第一个」的接口等于给界面留一条会走错的路。
- 错误码沿用：接入点不存在 / 地址或 appid 没填 / 密钥不可用 → `400`；接入点侧失败 → `502`。

### 五、删掉一个接入点之后

- **它导入的主机保留**，`gateway/remove` 返回 `hostsKept`；界面上明说「连接时会提示接入点已不存在」。
  主机是用户的机器清单，删配置不该顺手删机器。
- 连接时报 `PoolError`（code `gateway-missing`）：
  「主机「x」来自接入点「y」，但它已经被删除了：请重新导入这台主机，或把接入点加回来」。
- 已建立的会话**不主动踢**：还开着的工作不该因为一次配置改动被打断。
- 跨接入点导入同一身份（地址+端口+用户名）：**让路新增**，不接管、不补 `via`——改写 `via` 等于把一台机器的
  凭据归属悄悄换到另一个来源上。同一个接入点重复导入才是「更新那一条」。

### 六、界面（`lib/client.js`）

B 卡从「一张配置卡」变成「接入点列表 + 新增接入点」：每张卡标题用名称（未配置显示「未配置」），
字段名称 / 地址 / appid / 端口（默认 2222）/ 密钥（留空＝不改、永不回显），动作保存 / 删除（二次确认）/ 拉取资产，
下面挂这一张卡自己的资产表与「导入选中 N 台」。删卡后列表少一张、主机不动。

`ssh_jms` **仍然只编辑「默认」接入点**（不存在就新建）：卡片仍是一张表单卡一个接入点，
这样 `tests\jms.ps1` 的 60 项基线不用重建，工具描述里也加一句「多个接入点在设置页管理」。

### 七、被否方案

- **下拉切换接入点（只显示当前那个的资产）**：用户明确否。切一下就等于把「已经在列表里的主机」的来源
  从 A 换成 B，或者每次切都要重配一遍；而且「有几个来源各自导过什么」在下拉里看不见。
- **删接入点连主机一起删**：用户明确否。删的是一份配置，不是那些机器。
- **保留 `gateway/status` 当作「首个接入点」的兼容层**：没有调用方，只会让人以为还存在单接入点语义。
- **接入点加「启用 / 停用」开关**：没有场景（不想用就删），多一个状态就多一条「停用后连不上算谁的」要解释。
- **每个接入点一份 `hosts.json`**：同一台机器可能被两个来源导入，合并显示时同一身份会撞车，
  列表还得跨文件拼，代价比在一条记录上多一个字段大得多。

### 八、复验

- `tests/api.test.mjs`：7 条接入点用例——list 不回密钥（两个接入点各自 `hasSecret` 不串）、
  save 带 id 更新 / 无 id 新增、remove 后主机仍在且别人的密钥不动、assets 按 `via.gatewayId` 判已导入、
  import 写进 `via.gatewayId` 且跨接入点不接管、未配置 / 不存在的接入点 400 且不建客户端、
  迁移（旧配置 → `default`、vault 键迁移、再写一次幂等、绑定不匹配不迁、`gateway/status` 已下线 404）。
- `tests/client.test.mjs`：10 条路由、每张卡的拉取 / 导入 / 删除都带 `gatewayId`、两张卡各自渲染、
  密钥框永远为空、表格不折行样式。
- 全量：11 文件 / 33 用例；`tests\jms.ps1` 60 项；`tests\card-select.ps1` 55 项。
- 未验（本会话做不了）：真机上两个真接入点各拉一次资产、真机删接入点后连接报错的实际文案、
  真机窄宽下多张卡的堆叠与折行。

## D-46 设置页铺满可用宽度、表格不折行：上限在外壳的 564px，不在我们这边

### 一、现象与判定

真机截图：设置面板很宽，内容只占中间约 560px，右边一大片空白；「已连接」折成两行；备注与操作列挤在一起。

判定：页面在设置面板内**铺满可用宽度**；任意单元格**不折行**（地址 / 账号 / 状态 / 操作 one line，
备注单行 + 省略 + `title` 全文）；状态列要放得下「已连接」。

### 二、根因（实测 CSS，不是猜）

外壳 `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js` 第 60 行是 `SettingsRoot.module.css` 的字符串，
其中（同一行内，按选择器截取）：

| 选择器 | 关键声明 | 开发者工具里量到的意义 |
| :-- | :-- | :-- |
| `.VOzbGW_panel` | `width:800px; max-width:calc(100vw - 48px)` | 整个设置面板固定 800px 宽 |
| `.VOzbGW_nav` | `width:188px; flex:none; padding:22px 12px 0` | 左栏占 188px，不参与伸缩 |
| `.VOzbGW_content` | `flex:1; min-width:0` | 右侧内容区吃剩下的宽度 |
| `.VOzbGW_options` | `flex:1; min-height:0; padding:0 24px 24px` | 内容区左右各 24px 内边距 |

所以**可用宽度 = 800 − 188 − 48 = 564px**，与用户看到的「约 560」一致；卡片内再减两侧各 16px 内边距 ≈ **532px**。
面板里没有任何样式允许超过 800px，这一页无论怎么写都不会更宽。

我们自己的 `.sshrm-section` 还写着 `max-width:760px`——在这 564px 里**从不生效**（它只在更宽的容器下才有影响），
属于「写了但永远不触发」的死规则，还让人误以为是它限制了宽度。

### 三、改法

- `.sshrm-section`：删掉 `max-width:760px`，改 `width:100%; min-width:0`（父容器给多少用多少，并在注释里写清 564 的来源）。
- `.sshrm-table`：`table-layout:fixed`（自动布局下 `text-overflow` 不生效，列宽也不受控），列宽按百分比给：
  主机表 `25% / 13% / 自动 / 12% / 32%`（备注列吃掉剩下的 18% 之外的部分），资产表 `4% / 26% / 18% / 15%`。
- `td`：`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`；备注单独单行省略 + `title` 全文，
  地址也补上 `title`（被省略时能看全）。
- 操作列：`overflow:visible`（二次确认的「确认删除」不能被裁），按钮 `gap:0; flex-wrap:nowrap` 挤在一行。
- 地址 / 账号 / 状态这几列用等宽字体（数字与小数点对齐，扫一眼就能比）。
- **字号一律不动**（12 / 13px 沿用）：回收宽度只能靠列宽与按钮间距，不能靠缩字。

### 四、被否方案

- **改外壳 `panel` 宽度 / 覆盖 `.VOzbGW_panel`**：那是宿主的 DOM 与样式，改了会影响所有设置页，
  而且下一次宿主升级就被打回原形。这条按用户要求只留证据（上表），不动外壳。
- **表格外层加横向滚动**：手机上可以，桌面端 564px 里出现横向滚动条比省略更难受；不折行的诉求本来就该由列宽解决。
- **缩字号换空间**：用户明令不许。
- **把备注列去掉 / 折叠进详情**：备注是这一页最常改的东西，藏起来等于把操作变远。

### 五、复验

- `tests/client.test.mjs` 第 17 条：`.sshrm-section` 不得出现 `max-width`、`width:100%;min-width:0` 存在、
  `table-layout:fixed`、`td` 的 `nowrap` + `ellipsis`、备注省略、操作列 `nowrap`、等宽字体、主机表五列宽度（见第六节）、`title` 全文。
- 未验：真浏览器渲染下的实际观感（深浅色、更窄的窗口、多张接入点卡堆叠），这些要真机看。

### 六、列宽比例由用户指定（2026-11-15）

第一轮真机反馈（原话）：

> 宽度还是有问题的
> 20 10 44 10 16  这样比较合适
> 最后的操作列 用的flex 那每个按钮就不需要padding了
> 直接 space between即可

截图里的表头是五列 `地址:端口 | 账号 | 备注 | 状态 | 操作`，所以这组数字就是这五列的百分比（合计 100）。
同一张表的第二轮反馈：

> 资产这个 后三列改为 20 10 10 账号怎么还带有括号里面ip可以只留账号
> 另外 已导入怎么是特殊tag样式  要么都是tag 要么都不是

#### 1. 两组列宽

| 表 | 列 | 宽度 |
| :-- | :-- | :-- |
| 主机表 | 地址:端口 / 账号 / 备注 / 状态 / 操作 | **20% / 12% / 42% / 10% / 16%**（用户指定；账号先给 10%，同日因为 `example` 被截提到 12%，见第 8 节） |
| 资产表 | 勾选 | **28px 固定**（14px 复选框 + 12px 右内边距 + 2px 余量），不参与百分比 |
| 资产表 | 名称 / 地址:端口 / 账号 / 状态 | **剩余宽度的 58% / 20% / 12% / 10%** |

资产表为什么用 `width:calc((100% - 28px) * .58)` 而不是直接写 `58%`：固定列那 28px 不会从百分比里扣掉，
四个百分比合计 100% 再叠加 28px，固定布局下没有 `auto` 列兜底，表格会横向溢出 28px。
`calc((100% - 28px) * 比例)` 表达的是「把剩余宽度按这组比例分」，两边的比例仍是 58:20:12:10。

#### 2. 为什么是百分比，不是 px

外壳给的内容区是 **564px**（`800 − 188 − 48`，见第二节），再减卡片左右内边距 32px ≈ **532px**。
但这 532px 是 100% 缩放、当前窗口下的值：窗口变窄、系统缩放调大、换一台机器都会变。
px 定宽在窄容器里立刻变挤（操作列先被裁），百分比跟着容器走，比例关系不变。
配合 `.sshrm-table th,.sshrm-table td{box-sizing:border-box}`：百分比把单元格的 12px 右内边距也
算进去，五列才真的合计 100%；否则每列各自再加内边距，合计超过 100% 又变成横向溢出。

#### 3. 为什么备注拿最大的一份（42%）

备注是这张表里**唯一允许长的列**（主机名/用途随手写），也是唯一挂了 `title` 看全文的列；
地址、账号、状态都是短值（`192.168.1.11:2222`、`example`、`已连接`），给固定的小份额就够。
42% ≈ 223px 让备注靠宽度而不是省略号活着，同时把操作列压到 16% ≈ 85px——正好放下
「编辑 测试 删除」三个两字按钮（零内边距下合计 78px）。资产表同理：名称是唯一的长列，拿 58%。
备注从 44% 让出 2% 给账号列，理由见第 8 节；它可截断且带 `title`，让宽度不损失信息。

#### 4. 操作列：零内边距 + space-between

- 容器本来就是 flex；三个按钮的 antd 默认内边距（左右各若干 px）在 85px 里装不下三个词，
  所以 `.sshrm-hostsTable .sshrm-actions button{padding:0;margin:0;min-width:0;gap:0;white-space:nowrap}`。
  选择器多带一层 `.sshrm-hostsTable` 是为了压过 antd 的默认内边距，不靠 `!important`。
- 三个动作之间 `justify-content:space-between; gap:0`：均分整列，不加额外间距。
- **二次确认态例外**：那一行是「删除这台主机？」+ 确认 + 取消，合计约 169px 塞不进 85px；
  摊开会把「取消」顶出卡片右边界，所以加 `sshrm-actionsAsk` 保持 `flex-end`（与改之前一致，
  溢出仍靠 `.sshrm-cellActions{overflow:visible}` 可见）。按钮照样零内边距。

#### 5. 资产表账号列与状态列

- **账号列只写 `username`**：原来渲染 `${username} (${alias})`（别名与用户名不同时补括号），
  用户明确「可以只留账号」。不需要靠括号区分同机多账号——一行本来就只放一个账号，
  `example` 与 `root` 各占一行。
- **状态列统一成纯文本 + 状态色**：以前「已导入」是 `Tag`、「未导入」是纯文本，两行长得不一样。
  用户给了两条路（都 tag / 都不 tag），选「都不」：`Tag` 自带左右内边距，10% ≈ 53px 的列里会被裁；
  而纯文本 + `sshrm-statusOn`（绿）/ `sshrm-statusOff`（次要色）与主机表的「已连接 / 未连接」
  是同一套视觉语言，两张表一致。

#### 6. 被否方案

- **自动分配 / 按内容定宽**：这正是「宽度还是有问题的」的来源——内容一变列宽就跳，状态列还会被挤到折行。
- **账号列改 `width:max-content` / `auto`，让窄列按最长账号自己撑开**：单列能躲开截断，但会破掉
  `table-layout:fixed` 下「五列比例固定、谁也不许跳」的一致性——其余四列仍是百分比，账号列一变宽，
  合计就超过 100%，备注被反向挤压，正是这一轮要消灭的行为；而且内容一变（换个 8 字符账号）列宽又跳。
  正解是给足比例（12%），不是退出比例体系。
- **px 定宽（如备注 234px）**：只在当前窗口/缩放下成立，换个 DPI 就挤；用户要求的是比例。
- **固定列 + 四个 100% 百分比（直接写 58%/20%/12%/10%）**：28px 不在百分比里，必然横向溢出 28px。
- **给固定列也写百分比（如 5%）**：勾选列只剩 26px，14px 复选框加间距后没有余量，且违背「固定窄列」。
- **用 `!important` 压 antd 内边距**：多带一层祖先选择器就能压过，留 `!important` 以后没人敢删。
- **只给「已导入」加 tag**：用户点了这条路——两行状态形态不同，扫一眼会以为 Tag 是另一种含义。
- **账号列显示 `用户名 (资产名)`**：多账号靠行数表达就够，括号既重复又占掉 10% 里的一截。

#### 7. 复验

- `tests/client.test.mjs`：主机表五列 20/12/42/10/16 且合计 100、资产表勾选列 28px + `calc` 四列 58/20/12/10（比例合计 1）、
  `box-sizing:border-box`、不得出现 `width:auto`、操作按钮 `padding:0` + `gap:0` + 容器 `space-between`、
  二次确认态 `flex-end`、状态列/账号列显式 `nowrap`、状态 10% 装得下「已连接」、账号 12% 装得下 `example`（且 10% 装不下）、
  账号格文字等于 `username` 且不含 `(`、状态格两种状态同为 `span` 且只差 `className`/文字、
  不再出现 `h(Tag, { tone: 'neutral' }, t('imported'))`。
- 未验（要真机看）：真浏览器里百分比是否按 20/12/42/10/16 落地、`已连接`/`example` 是否完整不裁、
  操作列三个按钮在 16% 里的实际留白、极窄窗口与 125%/150% 缩放下的观感。
  本轮改动时试图用无头 Edge 量列宽，被沙箱的命名管道限制挡住（`mojo ... platform_channel.cc: Check failed`），
  所以只有算术与静态断言，没有像素证据。

### 七、账号列 10% → 12%（同日追加，覆盖上文 10%）

现象：资产账号 `example` 在 10% 下被省略号截（7 个字符 ≈ 50.6px vs 内容宽 ≈ 41px）。
判定：这是宽度分配问题，不是内容问题——`example` 就是必须完整看见的账号名。
结论：账号列 12%（内容宽 ≈ 52px），2% 从备注扣（44% → 42%），资产表同步 名称 58% / 账号 12%；
同步列 58:20:12:10 仍合计 100，`calc((100% - 28px) * 比例)` 写法不变。
为什么从备注扣：备注是两表里唯一可截断列（单行 + `ellipsis` + `title` 看全文），扣 2% 只让省略号提前一点；
从地址扣会把 `192.168.1.18:2222` 这种最长的端点挤掉，从状态/操作扣则直接裁字。
被否：账号列 `max-content`/`auto`（见被否方案第 2 条——退出比例体系会连带挤压备注）。
复验：`tests/client.test.mjs` 第 18 条改成新比例、第 20 条按 12% 重算并断言 `example`（7 × 12px × 0.602em ≈ 50.6px）
≤ 内容宽 51.8px，同时断言 10% 下确实放不下（≈ 41px < 50.6px）。真机像素仍未验。

### 八、资产表列宽就是字面量 20/12/10（同日再追加，**覆盖第六节第 1 小节与第七节的 calc 写法**）

现象（真机）：第一版资产表写成 `calc((100% - 28px) * .58 / .2 / .12 / .1)`，宽度看着「没生效」——
名称列被挤短、账号与状态按内容自己撑宽，正是自动布局的表现。用户随后定死口径：

> 为啥要算 我说了10 就 10

判定：资产表四列**直接写字面量**，不再做任何减法/展开；名称列为唯一长列，靠布局吃掉剩余宽度。

根因：`calc((100% - 28px) * .58)` 这种「括号内减法再乘数字」的写法**浏览器不保证支持**，
Chromium 会**整条丢弃**该 `width` 声明（不是只丢这一项里的乘法）。声明一丢，该列表头就没有宽度，
`table-layout:fixed` 的列宽约束失效、退化成自动布局：名称列被内容压短、地址/账号/状态按内容撑开。
换言之，用户看到的「宽度没变」不是比例选错，而是规则根本没进 CSSOM。

结论：勾选列 `28px`（固定列，无法用百分比），名称列**不写 `width`**（`table-layout:fixed` 下未定宽的
那一列自动占满剩余宽度，这本来就是「名称拿大头」的最短表达），其余三列 `20%` / `12%` / `10%`。
三列都是字面量，**不再为勾选列的 28px 去做减法**：剩下的宽度交给名称列，不需要算。

> **更正（2026-11-15，用户原话「不是说12吗 怎么是10」）**：最早按用户口述的「20 10 10」把资产表账号列实现为
> `10%`，用户随后明确要 `12%`（与主机表账号列一致），故更正为 20/12/10。
> 算术：内容区按 532px 算，`12%` 内容宽 = 532×12% − 12px ≈ **51.8px** ≥ `example` 的 7×12×0.602 ≈ **50.6px**，
> 放得下；`10%` 只有 532×10% − 12px ≈ **41px**，不够，账号名会被省略号截。——这才是取 12% 而不是 10% 的理由。

被否方案：

- **`calc((100% - 28px) * r)`（第一版）**：见根因——浏览器丢整条声明，fixed 退化 auto，是最坏的一种「静默失效」。
- **`calc(r% - npx)` 展开（如 `calc(58% - 16.24px)`）**：语法上广泛支持、也确实能扣掉 28px，但要写四个带小数的数，
  读数的人得先复算才知道「就是 58/20/12/10」；用户明确要求「10 就 10」，名称列又天然吃掉余量，纯属多余。
- **给 `calc` 加 `!important`**：声明被解析阶段丢弃时 `!important` 也救不回来；只会让后人不敢删。
- **改回 `auto`（自动布局）**：这正是「宽度还是有问题」的来源，内容一变列宽就跳。
- **改 `index.bundle.js`**：`lib/client.js` 是浏览器半边，不进宿主 bundle，改产物无效也不需要构建。

复验：`tests/client.test.mjs` 第 17 条断言名称列**不存在** `th:nth-child(2)`；
第 18 条钉住资产表只有 `28px` + `20%` + `12%` + `10%`，并加**反向断言**——资产表列宽里不得再出现 `calc(`；
第 20 条断言两张表的账号列同为 12%、内容宽相等且都 ≥ `example` 的 50.6px，同时保留
「10% 时内容宽 ≈41px < 50.6px 放不下」的算术（用来解释为什么是 12% 而不是 10%）。未验：真机像素——
看资产表名称列是否显著变宽、账号列 `example` 是否完整不裁即可判定。

### 九、两张列表为什么改 CSS Grid（2026-11-15，B-46）

#### 1. 现象

真机：备注单元格进入行内编辑后，输入框右边被切掉一截，看起来像「框没画完」。

量出来的解释：`.sshrm-inlineInput` 是 `width:100%` + `min-width:120px`，而它默认是 `content-box`——
`100%` 解析的是单元格的**内容宽**，可它自己还有 `.5px` 边框与 `6px` 左右内边距；
备注列那点宽度下，输入框的 border-box 比单元格内容区**多 13px（6+6+0.5+0.5）**，多出来的部分被
`td{overflow:hidden}` 剪掉。用户看到的是「输入框右端消失」，不是宽度算错。

#### 2. 根因

不是输入框一个控件的问题，是 table 这套布局本身的牵制：

- **列宽**由 `table-layout:fixed` + `th:nth-child(n){width:百分比}` 决定；
- **内边距**只能写在单元格上，百分比宽度又要靠 `box-sizing:border-box` 才能把它算进 100%；
- **内容的可用宽度** = 列宽 − 单元格右内边距，但任何「宽度:100%」的子元素默认在 **content-box**
  下解析父元素的内容宽，再叠加自身边框与内边距——于是「子元素比格子宽」是必然结果，
  只能靠 `min-width`/`calc` 逐个补偿，而浏览器对括号内减法再乘数字的 `calc` 会整条丢弃（见第八节）。

换言之：**table 下「列宽 / 单元格内边距 / 子元素盒模型」三者互相牵制，百分比列 + 单元格 padding
无法让子元素精确贴合内容区**。补这个漏就会坏那个。

#### 3. 结论

两张列表整体换 CSS Grid（用户 2026-11-15 B-46：「后续的前端技术尽量使用现代布局方式」）：

- 列宽只在列表容器上定义一次，做成自定义属性：主机表
  `--sshrm-hosts-cols:20% 12% minmax(0, 1fr) 10% 104px`、资产表
  `--sshrm-asset-cols:28px minmax(0, 1fr) 20% 12% 10%`；
- 抬头行与每一行数据都是 `div.sshrm-grid`，只写 `grid-template-columns:var(--sshrm-…)`
  ——**一个来源**，不存在「表头一份、数据行另一份」的漂移；
- 单元格统一 `.sshrm-gridCell`：`box-sizing:border-box;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap`。`min-width:0` 是 grid 的关键：默认 `min-width:auto`
  会让内容把轨道撑破，设成 0 才是「列宽由模板说了算，内容自己让路」；
- 行内编辑框：`box-sizing:border-box;width:100%;min-width:0`——`100%` 现在直接对应格子内容盒，
  边框与内边距都算在这 100% 里，**不需要任何补偿**，所以原来为 table 写的 `min-width:120px` 删除；
- 分隔线画在**行容器的上界**（`.sshrm-gridRow{border-top:…}`，抬头行紧接的第一行用
  `.sshrm-gridHead + .sshrm-gridRow{border-top:0}` 去掉），**不用 `:last-child` 给最后一行收尾**：
  提示行 `.sshrm-noteRow` 是行容器的**兄弟节点**（紧随它所属那一行），最后一行带提示时
  它就不是最后一个子元素，`:last-child` 会失效、在它下面多画一条线（`:last-of-type` 同样无效，
  noteRow 也是 `div`）。画上界之后不存在「收尾」这件事：第一行不画、其余每行一条，永远连续；
  单元格按 `align-items:center` 各自居中（等价于原来的 `vertical-align:middle`）；
- 提示行（`tr.sshrm-noteRow > td[colspan=5]`）改成紧随其后的 `div.sshrm-noteRow`，
  整行宽、左右内边距与数据行对齐（左贴 0、右侧让出最后一列不吃的内边距）。

列宽数字本身一个都没改：20/12/10 与 28px、104px 就是第六、七、八节定下的那组；
操作列的零内边距 + `space-between`、二次确认态 `flex-end`、按钮 `padding:0` 全部原样保留。

#### 4. 被否方案

1. **只给行内输入框加 `box-sizing:border-box`**：能修好这一处（13px 不再溢出），
   但 table 的牵制还在——下一处「宽度:100% + 内边距」的子元素照样会多出来，
   而且列宽仍要靠百分比 + 单元格 padding + `border-box` 三者对齐，属于同一类问题的下一次复发。
2. **把操作列或备注列调宽**：按症状改，不是按结构改。调宽只是让溢出晚 13px 出现；
   窗口变窄/缩放变大时又会回来，且改的是已经定稿的比例。
3. **用 `overflow:hidden` 遮住**：这正是现状——尾部看不见而已，输入框右端与边框仍然缺失，
   用户点了编辑还是看不到完整框；遮盖不等于贴合。
4. **保留 table、用 `position:absolute` 把输入框铺满单元格**：要额外加 `position:relative`、
   算 top/left/right，属于给 table 打补丁，复杂度比换 grid 高。

#### 5. 复验方式

- `node --test --test-isolation=none "dsh-ssh-remote/tests/client.test.mjs"`：25 项全过。其中
  10 / 11 / 12 / 13 从查 `tags.includes('table')` 改成查 `.sshrm-hostsTable` / `.sshrm-assetTable`
  与 `.sshrm-grid` 的条数；17 从 `.sshrm-table td` 规则改成 `.sshrm-gridCell` 规则，并钉住行上界的两条
  边框规则 + **反向断言**源码里不得出现 `.sshrm-gridRow:last-child`（最后一行带提示时它不成立）；
  18 从抓 `th:nth-child(n){width}` 改成抓 `--sshrm-hosts-cols` / `--sshrm-asset-cols` 的模板字面量
  （含「模板只定义一处」），原来「五列合计 100%」改成等效断言：百分比合计 42% + `minmax(0, 1fr)`
  与 104px / 28px 各自存在 + 长列剩余宽度 > 0；20 从 `td:nth-child` 规则改成从模板里取百分比再算同一组算术；
  21 / 22 / 23 只把 DOM 介质从 `td` 改成 `.sshrm-gridCell`；新增第 24 条守介质——
  `client.js` 不得再出现 `table-layout` / `.sshrm-table` / `th:nth-child`，
  且必须出现 `grid-template-columns` 与 `minmax(0, 1fr)`。
  `example` 的 50.6px、状态列 39px、两表账号列相等、资产表列序、账号格只含 username、
  状态格纯 span 且 props 只有 className —— 全部保留，没有放宽。
- `node --check dsh-ssh-remote/lib/client.js` 通过。
- 自查：`Select-String` 在 `client.js` 里查 `table-layout|\.sshrm-table|th:nth-child|<table|<thead|<tbody|<tr|<td|<th`
  无命中（只剩注释里对历史的说明）。

#### 6. 未验清单

- **真机像素**：浏览器里两张列表的实际列宽、备注行内编辑框是否完整可见、复选框与名称列的
  留白、极窄窗口（<560px）与 125%/150% 缩放下的观感——本轮只有静态断言与算术，没有渲染证据；
  B-42 也要求这类交互由用户自己在真机点一遍。
- 备注行内编辑态下 grid 行高变化（输入框带边框与内边距，可能比一行文字高 4~6px）：静态断言
  看不出实际观感，需要真机进入编辑态确认。
- 多接入点堆叠时两张列表的对齐（同一张卡内资产表与主机表分属不同卡片，列宽各自独立）。

### 十、操作列 104px → 80px（同日，用户指定）

#### 1. 现象与判定

用户真机看设置页的主机表：「编辑部分 最右侧改为 80px 现在的一百多太宽」。

判定：操作列（末列）宽度从 104px 收到 **80px**，其余四列（`20% 12% minmax(0, 1fr) 10%`）
与资产表模板一字不动。这是纯列宽调整，不牵动字号、内边距、按钮文案与布局方式。

#### 2. 结论

`--sshrm-hosts-cols` 末列由 `104px` 改为 `80px`：

```
--sshrm-hosts-cols:20% 12% minmax(0, 1fr) 10% 80px
```

80px 是用户给的数字（不是我们推导的），用户已在自己的环境里实机验证过这个宽度可用。
末列单元格 `padding-right:0`，所以 80px 的轨道宽就是 `.sshrm-actions` 容器可用的内容宽，
按钮与容器自身都没有额外内边距。

#### 3. 风险（如实记录，不实施）

按 14px 字号推导：关闭态三个两字按钮「编辑 / 测试 / 删除」各约 28px（2 × 14px 汉字），
合计约 **84px > 80px** 内容区，理论上末字可能被裁约 4px。用户实机看过之后没有要求加宽，
故按用户口径保留 80px；若真机确实出现裁切，再按用户新口径调整（不是我们自行改回 104）。

#### 4. 被否方案

- **保持 104px**：用户明确说太宽，这是要解决的问题本身。
- **加宽到 88px 等中间值**：用户给的是 80px，且已实机验证；自行改数字等于否定用户的验证结果。
- **把按钮字号降到 12px 换空间**：用户明确「不要改字号」，且字号是 D-46 第三节定下的「字号一律不动」。
- **按钮改图标省宽度**：确实更省，但要同时改文案、加大量的可访问性/断言改动，超出「只改宽度」的范围。
- **动 antd `size="sm"` / `height` / `line-height` / `letter-spacing` / `gap`**：都是为凑宽度去改样式，
  用户的要求只有列宽一个数字，其余一律不碰。

#### 5. 复验

- `tests/client.test.mjs` 第 18 条：主机表模板期望 `'20% 12% minmax(0, 1fr) 10% 80px'`，
  百分比合计 42% 的显式断言保留，`endsWith('80px')` 钉住末列；第 17 条不含 104px 字面量，无需改。
  未新增字号相关断言（字号不在本次口径内）。
- 未验：真机上关闭态三个按钮与确认态（「删除这台主机？」+「确认删除」+「取消」，本就溢出、
  靠 `overflow:visible` 可见）是否完整不裁——只有静态断言，没有像素证据。

### 十一、去掉单元格 padding、行高 40px、列宽改实测值（2026-11-16，用户实机量宽）

#### 1. 现象

用户看完第十节的 80px 之后连着给了三条，随后又给了整组宽度：

> 左右不用padding 可以移除单元格padding
> 直接用行高40就行了
> hight: 40px

> 宽度：128px 64px minmax(0, 1fr) 50px 84px

现象是：列宽怎么调都「差一点」——按轨道宽算放得下的内容（`example`、三个操作按钮），
在真机上仍被省略号截掉或贴边；用户按自己量出来的数给宽度时，也没有把单元格内边距算进去。

#### 2. 根因

grid 只定了轨道宽，单元格自己还有 `padding:8px 12px 8px 0`（表头 `0 12px 6px 0`、
末列 `padding-right:0`）：

- **内容可用宽 = 轨道宽 − 单元格左右内边距**，用户量宽度时量的是「看得见的列宽」，
  拿到的是轨道宽；把用户给的数直接写进模板，内容可用宽就比用户的数少 12px，
  本来「勉强放得下」的内容显示不全；
- 反过来调轨道宽又要把 padding 加回去重算，**每次量宽都要重算一遍**，这就是「宽度总差一点」
  的来源，也是第十节里 80px 与 84px 打架的原因（80px 是轨道宽，`padding-right:0` 才让它等于内容宽，
  而表头/其余列的 12px 右内边距仍在叠加）。

#### 3. 结论

单元格零 padding + `height` 控行高 + 列宽写用户实测值，**轨道宽即内容可用宽**：

- `--sshrm-hosts-cols:128px 64px minmax(0, 1fr) 50px 84px`（地址:端口 / 账号 / 备注 / 状态 / 操作）；
  资产表模板 `28px minmax(0, 1fr) 20% 12% 10%` 不动；
- `.sshrm-gridCell` 只保留 `box-sizing:border-box;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap`，**没有任何 `padding`**；
- 删掉 `.sshrm-gridHead .sshrm-gridCell{padding:…}`（字号/颜色/对齐改由 `.sshrm-gridHead`
  行容器继承给单元格）与 `.sshrm-gridRow .sshrm-gridCell{padding:…}`，也删掉
  `.sshrm-gridCell:last-child{padding-right:0}`（已无意义）；
- 行高用 `height`：`.sshrm-gridRow{height:40px}`（配 `.sshrm-grid` 已有的 `align-items:center`
  垂直居中 + 已有的 `border-top` 分隔线），`.sshrm-gridHead{height:28px;padding-bottom:6px}`
  保持与数据行的呼吸；`.sshrm-noteRow` 的 `padding:0 0 6px` 保留（它是独立块，不是单元格）；
- 字号（12/13px）、按钮规则与 `size="sm"`、`justify-content`、`gap` 一律不动，也不加列间距：
  用户就是按「无左右 padding 且无列间距」量的宽度。资产表勾选列 28px 里复选框贴左属于预期。

#### 4. 被否方案

- **保留 padding，只调轨道宽**：每次量宽都要把左右 padding 加进去重算，用户给的数永远对不上；
  本轮的问题正是这么来的。
- **用 `gap` 代替 padding**：`gap` 同样占轨道宽，内容可用宽还是小于用户量的数，只是把减法挪了个地方。
- **给单元格加 padding 但把轨道宽加大**：这正是用户说的「本来勉强放得下」的成因——
  数对不上、每次都要试；而且 padding 是左右各一份，加了就要在两处维护同一件事。
- **给勾选列单独加内缩**：用户只要求「移除单元格 padding」，单独补一处内缩会把「零内边距」
  这条规则又变成例外，且 28px 的余量只有 2px，内缩必然挤压 14px 复选框。

#### 5. 复验

- `node --test --test-isolation=none "dsh-ssh-remote/tests/client.test.mjs"`：**25 项全过**。
  第 17 条改为断言 ①`.sshrm-gridCell` 规则不含 `padding`；②`.sshrm-gridRow` 含 `height:40px`；
  ③`.sshrm-gridHead` 含 `height:28px` + `padding-bottom:6px`；并新增反向断言——源码里不得再出现
  `8px 12px 8px 0`、`0 12px 6px 0`、`padding-right:0`，也不得再有
  `.sshrm-gridHead .sshrm-gridCell{…}` / `.sshrm-gridRow .sshrm-gridCell{…}` 这类靠单元格给节奏的规则；
  分隔线上界的断言从「整条规则字符串相等」改成「行容器规则里含 `border-top`」（规则末尾多了 `height`）。
- 第 18 条：主机表模板期望 `'128px 64px minmax(0, 1fr) 50px 84px'`，逐位核对
  `columnsOf` 为 `['128px','64px','minmax(0, 1fr)','50px','84px']`、百分比列为空、
  `minmax(0, 1fr)` 只出现一次、`endsWith('84px')`；原来「百分比合计 42」改成
  「四个固定轨道合计 128+64+50+84 = 326px，备注列在 532px 里还剩 206px」。
- 第 20 条改像素口径：状态列 `50px ≥ 3×13 = 39px`；账号列 `64px ≥ 7×12×0.602 ≈ 50.6px`；
  操作列 `84px == 3×2×14 = 84px`（**刚好、零余量**）；资产表账号列仍是百分比 `12%`，
  零内边距后内容宽 `532×12% = 63.84px ≥ 50.6px`，并记录口径变化：10% 口径 = 53.2px
  也已经够，**「必须 12%」的旧算术理由随单元格 padding 一起失效**，12% 保留只因资产表模板本轮不改。
- `node --check dsh-ssh-remote/lib/client.js` 通过。
- 第 19 条（`space-between`、按钮零内边距）一字未动；列序、账号格只含 `username`、
  状态格纯 `span` 等原文断言全部保留，没有放宽。

#### 6. 未验

- **真机像素**：浏览器里 128/64/1fr/50/84 五列的实际落地、`已连接` 与 `example` 是否完整不裁、
  84px 里三个按钮是否真的零余量（差 1px 就会末尾贴边或裁字）、40px 行高的视觉密度、
  勾选列复选框贴左的观感——本轮只有静态断言与算术，没有渲染证据（B-42 也要求用户自己真机点一遍）。
- 表头 `height:28px + padding-bottom:6px`（content-box 实际占 34.5px）与数据行 40.5px
  的搭配是否顺眼，没量过真图。
- 极窄窗口（<560px）与 125%/150% 缩放下，四个固定 px 轨道不再随容器缩放，
  备注列会被压到 0 甚至溢出（`minmax(0, 1fr)` 下限是 0）——这是「按实测像素定宽」的已知代价，
  用户当前窗口下不出现，未做额外处理（不加横向滚动、不加媒体查询）。

### 十二、资产表也改像素、勾选列居中（2026-11-16，同一次真机反馈）

#### 1. 现象

第十一节把主机表整组改成实测像素之后，用户紧接着给了两条（原话）：

> 下面也应该改为像素啊
> 原因是本来设置页就是固定宽度的
> 直接用像素即可
> 保持统一

> 另外 复选框贴左 改为居中

现象：同一张设置页里两张表用了两套口径——主机表是像素、资产表还是
`28px minmax(0, 1fr) 20% 12% 10%`；勾选列的 14px 复选框贴在 28px 轨道的左边。

#### 2. 判定

- 口径统一到像素：设置页的内容宽由外壳固定（564px 减卡片内边距 ≈ 532px，见第二、六节），
  百分比在这里没有任何收益——它只是把「用户在真机上量出来的宽度」和实际渲染**脱开**：
  量的是像素、写的是百分比，每次对不上就得反算一遍，第十一节的问题正是这么来的；
- 「保持统一」落在**同类列取同一个数**上：地址:端口、账号、状态三列与主机表同值；
- 复选框在 28px 轨道里水平居中，但**不加内边距**：第十一节刚把单元格 padding 全删掉
  （轨道宽 = 内容可用宽），28px 的余量只有 2px，内缩必然挤压 14px 复选框本身。

#### 3. 结论

```
--sshrm-hosts-cols:128px 64px minmax(0, 1fr) 50px 84px     （不动，第十一节定的）
--sshrm-asset-cols:28px minmax(0, 1fr) 128px 64px 50px     （本次改）
```

- 资产表列序：勾选 28px / 名称 `minmax(0, 1fr)` / 地址:端口 128px / 账号 64px / 状态 50px。
  名称列照旧吃剩余（532 − 270 = 262px），勾选列 28px 不变；
- **两张表的模板里都不再有 `%`**：设置页固定宽度下百分比只是换个地方算同一件事；
- 勾选列居中新增一条规则：

```
.sshrm-assetTable .sshrm-gridCell:first-child{display:flex;align-items:center;justify-content:center}
```

  用 flex 在轨道里居中（B-46 本来就只许 grid/flex），**不改复选框自身尺寸/样式**，也不给单元格加 padding；
- 其余一律不动：字号（12/13px）、按钮规则与 `size="sm"`、数据行 `height:40px`、
  表头 `height:28px`、单元格零 padding、无 `gap`、无 `calc`，主机表模板一字未改。

#### 4. 被否方案

- **资产表保留百分比**：这正是「下面也应该改为像素啊」要解决的问题；同页两张表两套口径，
  下次量宽还要分辨哪张表该用哪种算法。
- **把百分比换算成「当前窗口下的像素」写进去（如 532px 下的 `20% = 106px`）**：窗口/缩放一变
  就对不上，等于把百分比的不确定性固化成假精度；用户给的是「同类列同值」，不是「换算后的数」。
- **给勾选格加 padding 制造内缩**：第十一节刚以「左右不用 padding」为由删掉所有单元格 padding，
  再补一处就是把它降级成「有例外的规则」；且 28px 里只剩 2px 余量，内缩会挤压复选框。
- **把勾选列加宽来「看起来居中」**：用户只要求外观居中，列宽 28px 是既有的固定列口径，不动。

#### 5. 复验

- `node --test --test-isolation=none "dsh-ssh-remote/tests/client.test.mjs"`：**25 项全过**。
  - 第 17 条新增：`.sshrm-assetTable .sshrm-gridCell:first-child` 规则存在，含 `display:flex` /
    `align-items:center` / `justify-content:center`，且**不含 `padding`**（居中不靠内缩）；
  - 第 18 条：资产模板期望 `'28px minmax(0, 1fr) 128px 64px 50px'`，`columnsOf` 逐位核对为
    `['28px','minmax(0, 1fr)','128px','64px','50px']`、`percentsOf(assets)` 为空、
    `minmax(0, 1fr)` 只出现一次、四个固定轨道合计 `28+128+64+50 = 270px`、名称列在 532px 里剩 262px；
    原来「百分比合计 42」「`percentsOf` = [20,12,10]」「只有勾选列是 px」按新事实重写；
    新增**反向断言**：`hosts` / `assets` 两个模板里都不得出现 `%`；
  - 第 20 条改「两表同类列同宽」的像素口径：地址 128px、账号 64px（两表）都 ≥ `example` 的
    `7×12×0.602 ≈ 50.6px`、状态 50px（两表）≥「已连接」三个 13px 汉字 39px，
    并断言两表**账号列、状态列数值相等**；按 `532×12%` 的旧百分比算术已删除；
  - 第 21 / 22 / 23 条不含资产表百分比或左对齐的旧事实，一字未动：列顺序、
    账号格只含 `username`、状态格纯 `span` 且 `props` 只有 `className` 全部保留，没有放宽。
- `node --check dsh-ssh-remote/lib/client.js` 通过。
- 顺带修正 `assetStatusCell` 注释里「10% ≈ 53px 的列里会被裁」为 50px（百分比口径已不存在）。

#### 6. 未验

- **真机像素**：128/64/50 与主机表同值后，资产表的地址:端口与账号是否真的不裁、名称列 262px 的观感、
  28px 轨道里复选框是否看起来真的居中——本轮只有静态断言与算术，没有渲染证据（B-42 要求用户真机点一遍）。
- 极窄窗口（<560px）与 125%/150% 缩放下，资产表的四个固定 px 轨道不再随容器缩放，
  名称列会被压到 0（`minmax(0, 1fr)` 下限是 0）——与第十一节主机表是同一条已知代价，未做额外处理。

### 十三、操作列容器显式占满单元格（2026-11-16，同一次真机反馈）

#### 1. 现象

第十二节改完之后用户又发现（原话）：

> 另外发现 sshrm-actions 怎么不是满宽？导致按钮挤在一起。我算的宽度是满宽刚好有一点空间。
> 现在是 sshrm-actions 没占满

现象：操作列（84px）里的三个按钮挤在左边一小截，没有按 `space-between` 摊到整列。

#### 2. 根因

`.sshrm-cellActions` 原来只有 `text-align:right;overflow:visible`，它是**块级**单元格，
里面的 `.sshrm-actions` 是 `display:flex` 的块级子元素——宽度靠「块级默认撑满父容器」这一条隐式规则拿到的。
单元格一旦不再是块级上下文（或子元素参与 flex 布局、宽度由内容决定），
`.sshrm-actions` 就退化成**内容宽**：三个按钮自然贴在一起，父容器宽度 84px 与它无关，
`justify-content:space-between` 也就没有可摊开的空间——不是列宽不够，是容器没占满。

#### 3. 结论

两层都写死宽度归属，不依赖任何隐式规则（**列宽 84px 不动**，那是用户实测值）：

```
.sshrm-cellActions{display:flex;align-items:center;overflow:visible}
.sshrm-actions{display:flex;align-items:center;justify-content:space-between;gap:0;flex-wrap:nowrap;flex:1 1 auto;min-width:0;width:100%}
.sshrm-actionsAsk{justify-content:flex-end}          （不动：右对齐、允许溢出）
```

- 单元格改成 flex 容器：`overflow:visible` 保留（二次确认那一行「删除这台主机？」+ 确认 + 取消
  约 169px 塞不进 84px，要能溢出显示），`text-align:right` 随之删除（对齐由 flex 负责）；
- `.sshrm-actions` 追加 `flex:1 1 auto;min-width:0;width:100%`：无论单元格是 block 还是 flex，
  它都占满整条 84px 轨道，三个按钮各占一头一尾；
- 按钮的 `padding:0;margin:0;min-width:0;gap:0;white-space:nowrap` 一字不动，
  字号与按钮尺寸也不动（第十节已定「字号一律不动」）。

#### 4. 被否方案

- **把 84px 改宽**：用户算出来的就是「满宽刚好有一点空间」，问题不在列宽而在容器没铺满；
  改宽只是把挤在一起变成「更宽的挤在一起」，还否掉用户的实测值。
- **加 `gap` 撑开三个按钮**：`gap` 是固定间距，84px 里三个两字按钮本身已经刚好零余量，
  再加 gap 会把末字顶出轨道（第十一节已明确「不加列间距」）。要摊开只能靠容器满宽 + `space-between`。
- **只给 `.sshrm-actions` 加 `width:100%`**：父单元格是 flex 容器时 `width:100%` 有解析歧义
  （相对谁算），补 `flex:1 1 auto` 才是 flex 语境下的「占满剩余」，两条一起写才两头都成立。

#### 5. 复验

- `node --test --test-isolation=none "dsh-ssh-remote/tests/client.test.mjs"`：**25 项全过**。
  第 19 条新增：`.sshrm-cellActions` 含 `display:flex` / `align-items:center` / `overflow:visible`；
  `.sshrm-actions` 含 `width:100%`、`flex:1 1 auto`、`min-width:0`；保留原有的
  `justify-content:space-between`、`gap` 为 0、`.sshrm-actionsAsk{justify-content:flex-end}`、
  按钮 `padding:0`。**没有**新增任何字号断言，84px 与主机表模板一字未改。
- `node --check dsh-ssh-remote/lib/client.js` 通过。

#### 6. 未验

- **真机像素**：浏览器里三个按钮是否真的分到 84px 的两端、末字是否被轨道裁掉
  （84px 与三个两字按钮合计 84px 是零余量，见第十节第 3 条风险）；二次确认态的溢出是否仍完整可见。
  本轮只有静态断言，没有渲染证据（B-42 要求用户真机点一遍）。

### 十四、资产行整行可点（2026-11-16，用户真机反馈）

#### 1. 现象

用户原话：「checkbox应该是这一行点击都能操作」。

资产表每一行（一个「资产 × 账号」）只有最左边 28px 勾选格里的 14px 复选框能点，
点在名称 / 地址:端口 / 账号 / 状态这些格子上什么都不发生——要勾一行得先用鼠标去命中那个小方框。

#### 2. 根因

勾选状态只挂在 `input.sshrm-check` 上：`onChange` 是唯一的状态入口，行容器
`div.sshrm-grid.sshrm-gridRow` 上没有任何点击路径。所以可点区域就等于复选框自身的 14px 命中区，
行里其余部分只是展示文字。

#### 3. 结论

行容器挂 `onClick`，走**同一个** `toggle`，勾选框 `stopPropagation` 防双触发，只有可勾行加 pointer 观感：

```js
const pickable = imported === false && account !== null && busy === null
h('div', {
  key,
  className: cx('sshrm-grid sshrm-gridRow', pickable ? 'sshrm-gridRowPick' : undefined),
  onClick: () => {
    if (!pickable) return
    toggle(key, !selected.has(key))
  },
}, /* …勾选格… */ h('input', {
  className: 'sshrm-check',
  checked: selected.has(key),
  disabled: imported || account === null || busy !== null,
  onClick: (event) => event.stopPropagation(),
  onChange: (event) => toggle(key, event.target.checked),
}), /* …其余五格… */)
```

```
.sshrm-gridRowPick{cursor:pointer}
.sshrm-gridRowPick:hover{background:var(--dsw-alias-interactive-bg-hover)}
```

- **`toggle` 的真实签名是 `toggle(key, checked)`**（`setSelected` 里 `if (checked) add / else delete`），
  收的是目标状态而不是「切换」，所以行点击传 `!selected.has(key)` 现算目标值；
- 可勾判断与 `disabled` 用的是同一组条件（已导入 / 无账号 / 正在忙），**不可勾的行点击直接返回**：
  不调 `toggle`、不报错，也不带 `sshrm-gridRowPick`，观感与改动前一致；
- 勾选框自己 `stopPropagation`：点方框时事件不再冒泡到行容器，否则 `onClick` 与 `onChange`
  各切一次、勾选等于没动。**没有**让行点击去模拟点击 input——那条路要么双触发，要么绕开原生控件；
- hover 底色用现有 token `--dsw-alias-interactive-bg-hover`（与 `.sshrm-iconButton:hover` 同一套语言），
  不加动画、过渡、图标、新文案；
- 列宽模板（两表都不动）、`height:40px`、表头 `height:28px`、零 padding、勾选居中、字号、按钮规则、
  `aria-label` 内容、`toggle` 的业务语义一个都没改；
- 键盘可达性不退化：勾选框仍是唯一的表单控件，行点击只是附加的鼠标快捷方式，
  没有把行做成 `role="checkbox"`，也没有加 `tabindex`。

#### 4. 被否方案

- **把行做成 `role="checkbox"` + `tabindex="0"` + 键盘处理**：等于在行上再实现一套 checkbox 语义，
  而勾选框本身已经有原生语义；两套并存会出现「读屏报两次」「Tab 停两次」「空格键到底归谁」，
  超出「整行能点」这条需求。行点击只是鼠标快捷方式，键盘用户照旧用勾选框。
- **用 `<label>` 包住整行**：HTML 上确实能点 label 即勾选，但 label 会把行内所有文字
  （名称 / 地址 / 账号 / 状态）算进它的可读文本，点一下读屏就念一长串；而且 label 的
  `for` 与嵌套 checkbox 两种关联方式在「行容器是 grid」的结构里还得再挑一种，复杂但没有收益。
- **让行 `onClick` 里 `.click()` 模拟点勾选框**：行点击会先触发 input 的 click，冒泡回来又切一次
  （除非再加 stopPropagation 一层），而且等于用程序点击替代原生交互，比直接调 `toggle` 多一环。
- **只加 `cursor:pointer` 不加 hover**：能点的地方没有悬停反馈，用户还是要靠试；
  hover 与 `cursor` 是同一件事的两面，且现有按钮语言已经有这套 token，不需要新颜色。

#### 5. 风险

- **整行可点之后，拖选地址 / 账号文本会先触发勾选**：在行内按下鼠标拖选文字，松开时
  mousedown/mouseup 落在同一行上，浏览器会派发一次 `click`，于是本来只想复制地址却把行勾上了
  （或取消勾选）。**本轮不额外加 `getSelection()` 判断**：一是选中文本后 `window.getSelection()`
  在点击瞬间的取值在跨浏览器/跨时机下并不可靠（`click` 时选区可能已被收起），二是这会把
  「整行可点」降级成「有例外的行可点」，用户要的是简单直接。真机上如果这个误触真的碍事，
  再按用户口径决定是否处理（例如改成只在勾选格或行空白处响应）。
- 双击一行会切换两次（勾上又取消），与单击语义叠加；这是「整行即开关」的必然结果，
  不做双击节流（没有需求，且加延时反而让单击变慢）。
- hover 底色铺满 40px 行（含勾选格与状态格），与 0.5px 上界线叠加后的观感只有静态断言，没有像素证据。

#### 6. 复验

- `node --test --test-isolation=none "dsh-ssh-remote/tests/client.test.mjs"`：**26 项全过**
  （基线 25，本次新增第 25 条「资产行整行可点」）。
  - 行容器：源码切片里同时出现 `className: cx('sshrm-grid sshrm-gridRow'`、
    `pickable ? 'sshrm-gridRowPick' : undefined`、`onClick: () => {`、`if (!pickable) return`、
    `toggle(key, !selected.has(key))`；
  - 勾选框切片里同时出现 `onClick: (event) => event.stopPropagation()` 与
    `onChange: (event) => toggle(key, event.target.checked)`（一次点击只切一次）；
  - 可勾条件钉住原文 `const pickable = imported === false && account !== null && busy === null`；
  - CSS 钉住 `.sshrm-gridRowPick{cursor:pointer}` 与
    `.sshrm-gridRowPick:hover{background:var(--dsw-alias-interactive-bg-hover)}`，并断言不与过渡/动画共存；
    另断言 `.sshrm-iconButton:hover:not(:disabled)` 用的是同一个 token（不另造语言）；
  - 反向断言：源码里不得出现 `role: 'checkbox'`，也不得出现 `tabIndex`（键盘可达性不退化）；
  - 布局不动：行高 `height:40px` 与资产表模板 `28px minmax(0, 1fr) 128px 64px 50px` 原文断言仍在。
- `node --check dsh-ssh-remote/lib/client.js` 通过。
- 既有 24 条断言一字未改、没有放宽（列宽模板、零 padding、行高、勾选居中、`space-between`、`width:100%` 等原样保留）。

#### 7. 未验

- **真机交互**：点行内任意非勾选框位置是否真的切换勾选、点勾选框是否只切一次（不双触发）、
  hover 底色与手型指针的观感、拖选地址文本是否真的误触勾选——本轮只有静态断言与源码切片，
  没有渲染或点击证据（B-42 要求这类交互由用户在自己环境里真机点一遍）。
- 极窄窗口与 125%/150% 缩放下，行内各格被压缩后行点击的命中范围（整行仍是整行，只是更窄）未实测。

### 十五、资产列表限高 320px 与吸顶表头（2026-11-16，用户真机反馈）

#### 1. 现象

用户原话：

> 获取的资产列表 可以给个最高高度

现象：一个接入点下资产多时，资产表把整张卡片顶得很长（每行 40px，几十行就有上千像素），
要看列表末尾或点下面的按钮，得先滚整个设置页；而列表本身没有自己的滚动边界。

#### 2. 判定

这是缺陷不是偏好：列表区应该自己滚，「卡片高度由内容决定」在长列表上等于「页面高度由资产条数决定」。
判定标准：资产列表容器有最大高度、超出部分在容器内部滚动；表头在滚动时仍然可见（否则滚到第 20 行
就不知道哪一列是什么）。

#### 3. 结论

```
.sshrm-assetTable{--sshrm-asset-cols:28px minmax(0, 1fr) 128px 64px 50px}     （不动）
.sshrm-assetTable{max-height:320px;overflow-y:auto;overflow-x:hidden}         （新增盒子规则）
.sshrm-assetTable .sshrm-gridHead{position:sticky;top:0;z-index:1;background:var(--dsw-alias-settings-card-fill)}   （新增）
```

三处与原计划口径不同的取舍，都有确定理由：

1. **限高单独一条 `.sshrm-assetTable` 规则**，没有并进列宽模板那条。并进去会把
   `.sshrm-assetTable{--sshrm-asset-cols:…}` 的原文改掉，既有断言（第 25 条「资产表列宽模板一字未动」）
   就得跟着改；两条同选择器规则在 CSS 里合法，属性不冲突，列宽模板仍然「只定义一处」。
2. **底色用 `--dsw-alias-settings-card-fill`，不是 `--dsw-alias-bg-layer-1`**。
   查 `dsh-client-ui-theme` 的 `src/styles/base.css`：`--dsw-alias-settings-card-fill:
   var(--dsw-alias-bg-layer-2)`；`design-platform.css` 里浅色 `bg-layer-1 = bg-layer-2 =
   rgb(255,255,255)`（两者相同，用哪个都行），但**深色下 `bg-layer-1 = rgb(35,35,36)`、
   `bg-layer-2 = rgb(44,44,46)`**——卡片底色取的是 `bg-layer-2`，用 `bg-layer-1` 会在深色主题下
   比卡片暗一层，滚动时表头正是那条最显眼的色带。两个 token 都是不透明 `rgb()`，不是 rgba 叠加。
3. **sticky 带 `.sshrm-assetTable` 前缀，没有挂在无前缀的 `.sshrm-gridHead` 上**。
   主机表（`sshrm-hostsTable`）不是滚动容器，无前缀的 sticky 会相对**设置页的滚动容器**
   `.VOzbGW_options{overflow-y:auto}`（`dsh-client-ui-settings-general` 外壳）生效：
   整页滚动时主机表表头会浮在自己那几行上面，属于对主机表的意外改动（要求是不动主机表）。
   带前缀后只有资产表（唯一滚动容器）里的表头吸顶。`z-index:1` 让表头压住行（行没有定位）。

#### 4. 数值依据

320px = 表头 34px + 7 行 × 40px = 314px，留 6px 余量：

- 表头 `.sshrm-gridHead{height:28px;padding-bottom:6px}` 是 content-box，实际占 34px；
- 数据行 `.sshrm-gridRow{height:40px}`，7 行 280px；
- 合计 314px，给 6px 余量到 320px，让第 7 行下面那条 0.5px 界线与最后一点留白都完整，
  不会出现「第 7 行只露一半」的观感。

这是**默认值**：用户以后给出具体数字，只改 `.sshrm-assetTable{max-height:320px;…}` 里的这一个数
（测试 `max-height:320px` 只允许出现一处，就是为这件事钉的）。

横向不滚：列宽是像素模板（28 + 名称 + 128 + 64 + 50，内容区 532px 里名称列约 257px），
所以 `overflow-x:hidden`；滚动条交给浏览器原生行为——宿主主题 `scrollbar.css` 已全局给
`::-webkit-scrollbar` 5px 皮肤，自己在插件里再写一套就是第二份实现，且会随主题切换失真。
滚动条宽 5px 会从内容区拿走 5px，固定资产轨道不变、名称列少 5px（257 → 约 252），仍远大于内容。

#### 5. 被否方案

- **不限高**：用户明确要「给个最高高度」，这就是要解决的问题本身。
- **给整页加滚动 / 调设置页外壳**：设置页本来就是整页滚（`.VOzbGW_options{overflow-y:auto}`），
  再在列表外面套一层滚动等于双重滚动，滚轮落在哪一层全看命中的位置；且外壳是宿主代码，不在本插件边界内。
- **把 `max-height` 写成 `vh`/`%`**：卡片在设置面板里高度由内容决定，`%` 没有解析基准；
  `vh` 会随窗口变化，与「表头 + 7 行」这个具体口径脱钩。用户给的是行数口径，就写 px。
- **表头不做吸顶（只加限高）**：滚动区里不吸顶，滚到下面第 20 行时列名全部消失，
  用户还得滚回顶上看列——表头吸顶是「限高 + 内部滚动」的必要配套。
- **给滚动区加自定义滚动条样式 / 底部渐隐遮罩 / 翻页器**：都不是用户要的；
  滚动条有宿主统一皮肤，渐隐会盖住最后一行的可点区域，翻页器是 B-28 明令禁止的交互。
- **`position:sticky` 直接写在 `.sshrm-gridHead` 上**：见结论第 3 条，会把主机表一起变成「跟着整页滚吸顶」。
- **表头底色用 `rgba(...)` 半透明或 `--dsw-alias-interactive-bg-hover`**：hover token 是
  `rgba(38, 49, 72, 0.06)`（深色 `rgba(255,255,255,0.08)`），半透明等于没压住，滚过去的行会透出来。

#### 6. 复验

- `node --test --test-isolation=none "dsh-ssh-remote/tests/client.test.mjs"`：**27 项全过**
  （基线 26，本次新增第 26 条「资产列表限高与吸顶表头」，19 条断言）：
  - 容器：`.sshrm-assetTable` 的盒子规则含 `max-height:320px` / `overflow-y:auto` / `overflow-x:hidden`；
    并断言 `max-height:320px` 全文件只出现一处（「改一个数即可调整」）；
  - 表头：`.sshrm-assetTable .sshrm-gridHead` 含 `position:sticky` / `top:0` /
    `background:var(--dsw-alias-settings-card-fill)` / `z-index:1`，且底色不得是 `transparent`/`none`；
  - **反向断言**：主机表容器规则不含 `max-height`（短列表不限高）；无前缀的 `.sshrm-gridHead`
    规则不含 `position:sticky`（主机表表头不吸顶）；
  - **反向断言**：源码里不含 `::-webkit-scrollbar`、不含 `scrollbar-width|color|track|thumb`、
    不含 `linear-gradient`（渐隐遮罩）、不含 `pagination`/`Paginator`；
  - 既有口径原样保留：`.sshrm-gridHead{…height:28px;padding-bottom:6px…}`、`.sshrm-gridRow{…height:40px}`、
    `.sshrm-assetTable{--sshrm-asset-cols:…}` 三条原文断言仍在。
- 既有 26 条一字未改、没有放宽（列宽模板、零 padding、行高、勾选居中、`space-between`、`width:100%`、
  整行可点那条全部原样保留）。
- `node --check dsh-ssh-remote/lib/client.js` 通过。
- 顺带跑仓库根 `tests/preferences.ps1`：**52 / 52 通过**（B-46 四条 grid 检查仍成立）。
- 中途踩到一次自己的坑：第一版注释里写了 `--sshrm-asset-cols:` 原文，把第 17 条
  「资产表列宽只定义一处」的字面计数顶成 2，测试立刻报错；改注释措辞（写「列宽模板那一条」）
  而不是改断言——断言查的是源码字面量，注释里的示例同样算命中，这条口径本来就该保持。

#### 7. 未验

- **真机观感**：吸顶表头的底色是否与卡片背景完全一致（浅色/深色两个主题都要看）、
  滚动时行 hover 底色在表头下方是否仍清晰、5px 原生滚动条在 532px 内容区里的观感、
  320px 处是否刚好切在第 7 行下方——本轮只有静态断言与 token 取值的源码证据，没有渲染证据
  （B-42 要求这类交互与颜色由用户在自己环境里真机点一遍）。
- 表头 `border-bottom` 0.5px 与粘住后的行上界线是否会叠出一条更粗的线（浏览器亚像素舍入），没量过真图。

## D-47 一个账号一行：资产清单按「资产 × 账号」展开，导入改成 `items`（用户 2026-11-12「这个机器应该是两个用户 现在只显示了一个」「没有 root 用户」）

### 一、现象与判定

真机接入点里那台 `192.168.1.18` 实际有两个受管账号（`example` 与 `root`），可设置页的资产表只显示一行、
账号列只有 `example`；从卡片导入也只有一台主机，`root` 从此没有入口。

判定：
- 资产表里**每个受管账号一行**（一台两个账号就是两行），账号列写用户名，状态按该账号判；
- 卡片里**每个账号一行**，勾哪行导哪个账号；
- 同一台资产的两个账号导入后是**两台主机**，各自带自己的账号别名，备注能分清谁是谁。

### 二、根因

三处都只取「第一个账号」：

| 位置 | 原写法 | 后果 |
| :-- | :-- | :-- |
| `lib/api/gateway.mjs` 资产清单 | `accountsOfAsset[0]?.username` | 一台只出一行，第二个账号在界面上根本不存在 |
| `lib/api/gateway.mjs` 导入 | `items.push({ asset, account: accountsOfAsset[0] })` | 只导第一个账号 |
| `lib/jms/tool.mjs` 卡片 | `items.push({ asset, account: accounts[0] })` | 同上，卡片也是「一台一行」 |

而且「已导入」原来按 `via.assetId + via.gatewayId` 判——一台资产的任意账号导入后，整台都显示「已导入」，
剩下的账号就算列出来也会被误标成导过了。

### 三、结论与改法

**一个账号一行。** 连接凭据按**账号别名**签发（`createConnectionToken(assetId, alias)`，服务端拒绝用用户名），
所以「可导入的单位」本来就是「资产 + 账号」，不是资产。一台机器多个账号是常态（普通用户 + `root`），
把它们塞进同一行既表达不了，也没法分别授权。

1. **`gateway/assets`** 返回行 `{ assetId, name, address, account: { alias, username } | null, imported }`：
   - `imported` 按 **(assetId + accountAlias)** 判（`importedAccountKeys` / `accountKey`，键是 `资产id|别名`）；
   - 一行账号都没有的资产**仍出一行**、`account: null`、`imported: false`：界面要能说「这台看得见但导不了」，
     而不是让它凭空消失（那会变成「为什么这台没出现」的第二个 bug）。
2. **`gateway/import`** 入参改成 `{ gatewayId, items: [{ assetId, account }] }`，`account` 是**别名**（签凭据要用）。
   - 按 (assetId + alias) 去重，同一项点两次只导一次；
   - 逐项校验：资产不在这次清单里 / 账号已被撤销 / 这台没有可用账号 → 进 `skipped`（带 `assetId` + `account` + 原因），
     **不因为一项失败就整批不导**；
   - 返回 `imported: [{ id, address, user, account, created }]`（`account` 是别名，`created` 区分新增/更新）。
3. **主机身份不变**：还是 `地址|端口|用户名`。同资产两个账号（用户名不同）自然各自一台；
   `id` 仍由 `suggestHostId` 生成，撞了加序号（`192.168.1.11` / `192.168.1.11-22`）。
4. **默认备注**：只有一个账号的资产＝资产名（与普通主机同形）；**多账号**资产＝`资产名 · 用户名`
   （否则两台主机同名，列表里分不清）。
5. **卡片**（`ssh_jms`）把「资产 × 账号」摊平成行：`jmsSelectRows({ entries })`，一行的标题是
   `地址:22 · 名称 · 用户名`（单账号不拼用户名），已导入的那行标「已导入」；
   问句改成「勾选要导入的账号（共 N 个，来自 M 台资产）」，没有可用账号的资产在问句里提一句、不占行。
6. **界面**：资产表列 `勾选 | 名称 | 地址 | 账号 | 状态`，一行一个账号；勾选状态按 `资产id|别名` 记
   （`accountRowKey`），重新拉取后已导入 / 无账号的行自动掉勾且不可勾。

### 四、被否方案

- **一台主机挂多个账号、连接时切换**：`hosts.json` 的身份就是 `地址|端口|用户名`，一个条目一个用户；
  再加一层「账号列表 + 运行时选择」等于给主机模型加第二种形状，审批卡、`ssh_run` 的目标解析、
  密码库绑定都要跟着改，收益只是列表短一点。否。
- **只导第一个账号，其余在文档里说明**：这正是 bug 本身——`root` 是运维最常用的那个，丢掉它等于工具不可用。
- **用用户名当 `account` 参数（省一次查询）**：服务端签发凭据只认别名，用户名会直接被拒；
  而且同一台资产的别名与用户名不一定相同（别名可以是 `root-prod` → 用户 `root`），两者不能互相代替。
- **保留 `assets: [id]` 入参做兼容层**：本项目不做兼容（AGENTS.md §0「正确性优先于兼容性」），
  旧形状只会让「导入了哪个账号」变得含糊。直接改，客户端与卡片同一次提交里一起改。

### 五、复验

- `tests/api.test.mjs`
  - 第 17 条：三个资产（一个两账号、一个单账号、一个无账号）→ 4 行；只导了 `example` 时 `root` 仍 `imported: false`；
    另一个接入点里全 `false`；账号请求按资产各一次。
  - 第 18 条：一次导入 `example` / `root` / 已撤销的 `gone` / 无账号资产 / 不可见资产 →
    两台主机（`192.168.1.11` / `192.168.1.11-22`）、`via.accountAlias` 各自正确、备注 `Web 1 · example` / `Web 1 · root`、
    三项进 `skipped`；单账号资产备注就是资产名；同一项再导＝`created: false` 且不多一条。
  - 第 19 条：不接管同身份的直连条目与别的接入点的条目。
  - 第 20 条：`items` 缺 `account`、旧 `assets: [...]` 形状都是 400。
- `tests/client.test.mjs` 第 18 条：列顺序 `名称 → 地址 → 账号 → 状态`、`noAccount` 文案、
  行键 `7|example` ≠ `7|root` ≠ `8|root`、无账号行键稳定、同一行两次渲染键相同。
- `tests/jms.ps1`：新增 4 项（多账号导两台 + 备注带用户名、另一账号不覆盖已有那条、账号键判定、卡片行数＝账号数）。
- 未验：真机 JumpServer 现在返回 502，多账号资产的真实返回形状（`perms/users/self/assets` →
  `asset_accounts`）只在假客户端上验过；接入点恢复后要真机拉一次，确认「两个账号两行」。

## D-48 卡片抬头那行是**会话工作区**，不是宿主进程的 cwd（R-25）

**现象**（2026-11-12 用户原话）：「欧对了 这个路径也不对 不是工作目录的路径」——
SSH 执行确认卡抬头下面那行显示 `%USERPROFILE%`。

**判定标准**：这行的用途写在代码注释里——「卡片在桌面上冒出来时没有会话上下文，只能靠这一行认出是哪个项目」。
所以它必须是**用户打开的那个工作区**（例如 `C:\work\Example\example-ai-baojia-system`），
不是宿主进程从哪儿启动的。

**根因**：`lib/approval.mjs` 的 `cardApprovalChannel` 直接把 `process.cwd()` 塞进卡片的 `workDir`
（原来 `approval.mjs:217`）。`process.cwd()` 是 **DSH 宿主进程**的工作目录，本机从
`%USERPROFILE%` 起，与用户的项目毫无关系；而且它在一个进程里只有一个值，
多开几个会话时每张卡都会显示同一个错路径。

**证据（取值来源，不是猜）**：

- `@deepseek-ai/dsh-tools` 的 `ToolExecutionInput`（`lib/types/index.d.ts:216`）带
  `agent?: Agent`，注释写明「set by the agent loop」——工具执行时拿得到会话；
- `@deepseek-ai/dsh-agent` 的 `Agent`（`lib/types/runtime-types.d.ts:139-143`）有 `readonly session: Session`；
- `@deepseek-ai/dsh-session` 的 `Session`（`lib/types/index.d.ts:135-147`）有
  `readonly header: SessionHeader`，而 `SessionHeader.cwd`（同文件 `:70`）的定义是
  「Absolute working directory the session was created in (if any)」；
- 本机实测：会话日志第一行就是这条头部——`{"type":"session",...,"cwd":"C:\\work\\dsh-plugins"}`，
  而同进程的 `process.cwd()` 是 `%USERPROFILE%`。两者不是一回事，这就是缺陷本身。

**做法**：`lib/approval.mjs` 新增 `resolveWorkDir(exec)`——取 `exec.agent.session.header.cwd`，
裁掉两侧空白，**只有**拿不到会话（或字段不是非空字符串）时才退回 `process.cwd()`
（headless / SDK 直接调工具没有会话，也就没有工作区可显示：这是能力缺失，不是兜底）。
`run.mjs`、`copy.mjs`、`jms/tool.mjs` 三个建卡处统一传 `resolveWorkDir(exec)`，
`cardApprovalChannel(dialog, workDir)` 只负责把值送进 `selectRows`。
PowerShell 那半边不用改：`dialog.ps1` 的 `-WorkDir` → `Invoke-SshCardSelect -ProjectDir` →
`New-SshCardPayload` 已经把路径写进标题行（`dsh-ssh-remote/tests/card-select.ps1:188-189` 早就守着），
错的只是 JS 给的**值**。

**为什么不是「干脆不显示这一行」**：用户要的就是「一眼认出是哪个项目」（D-16 / B-16 那行的来历）；
删掉之后卡片在桌面上就没有任何项目线索，多开会话时更容易点错。

**被否的方案**：

- **取会话的「当前目录」而不是项目目录**（`workingDirectory.get(session)`，`@deepseek-ai/dsh-working-directory`
  的 `WorkingDirectoryService`，见其 `lib/types/index.d.ts:64`）：它能跟着 `cd` 变，但
  ① 要在插件里再挂一个可选服务、并从 `index.js` 一路传进三个工具工厂，链路更长；
  ② 拿到的可能是项目里的某个子目录，反而认不出是哪个项目；
  ③ 没有服务时还是要退回 `process.cwd()`。这一行的语义是「哪个项目」，项目根更贴题。
  真需要「当前目录」时，改的是这一行的语义（另开一条 R），不是换个取法。
- **在 PowerShell 侧猜**（例如从 `-RowsFile` 路径反推）：同一次调用里根本没有任何会话信息，
  猜出来的路径比 `process.cwd()` 更不可信。
- **改卡片视觉不显示路径**：见上。

**怎么复验**：

1. `node --test --test-isolation=none "tests/run.test.mjs"`：
   「R-25：卡片抬头下面那行取会话工作区」直接断言 `dialog.selectRows` 收到的 `workDir`
   等于 `exec.agent.session.header.cwd`，并断言**不等于** `process.cwd()`；
   「R-25：没有会话时退回宿主进程的工作目录」断言退回；
   「R-25：resolveWorkDir 只认非空字符串」覆盖缺字段 / 空串 / 非字符串。
2. `tests/copy.test.mjs` 里同名一条：搬运卡走同一口径（run / copy / jms 三处不许分叉）。
3. 真机：随便发一条远端命令，卡片抬头下面那行应当是本会话的工作区（而不是 `%USERPROFILE%`）。

## D-49 会话侧删除主机维护入口：弹窗只剩「执行 / 复制的勾选卡」（R-21）

**现象**（2026-11-15 用户原话，R-21）：「可行的话实现后移除会话新增/编辑的入口 让他只能连接操作 不能新增/编辑主机」。
当时的会话侧能通过 `ssh_admin` 的 `add_host`（表单卡）、`set_label`、`remove_host`（确认卡）与
`ssh_jms`（接入卡 + 导入多选卡）新增、改密码、改备注、删除主机和批量导入——即**会话能给自己加目标**。

**判定标准**：会话侧只该有「连接 / 执行 / 搬运 / 只读查询」四件事，弹窗只该剩**执行与复制的勾选卡**
（这两张勾选卡本身就是审批）；新增主机、改密码、改备注、删除主机、接入点导入这类维护动作只留在
**插件设置页「SSH 主机」**（`lib/api/routes.mjs` + `lib/client.js` 的浏览器页面）。判定通过的标志：
`lib/`、`scripts/`、`index.js` 里搜不到 `add_host` / `set_label` / `remove_host` / `askForm` /
`createJmsTool` / `ssh_jms` / `jms/tool.mjs`，且 `ssh_admin` 的动作只剩 `list`。

**根因**：维护能力当初跟着工具一起长出来（D-36 / D-38 / D-40）——同一批纯函数既给工具用，也给
设置页的 `store.updateHosts()` 用。工具那边为了「模型能自助配主机」多出了表单卡、确认卡和
整条 `ssh_jms` 接入链路；后来维护搬进设置页（D-41 / D-42），会话侧那套就成了第二套入口。

**结论**：删除范围逐条如下（只动会话侧，设置页那条路一行不改）。

| 文件 | 删除/保留 |
| :--- | :--- |
| `index.js` | 删 `createJmsTool` 的 import 与 `tools` 数组里的那一项（工具从 5 个降到 4 个）；`renderHostsSection()` 删规则 5（`add_host` / `set_label`）与规则 8（`ssh_jms`），其余重新连续编号 1–6 并补一句「维护只在设置页」；空主机提示与「无密码」提示改成指向插件设置页「SSH 主机」 |
| `lib/jms/tool.mjs` | 整文件删除（`ssh_jms` 工具、接入卡、导入闭环） |
| `lib/admin.mjs` | `createAdminTool()`：`action` 的 enum 只剩 `list`，参数只剩 `action`（`id`/`address`/`port`/`user`/`label`/`tags` 一并删），描述改成「只读列出；维护在设置页」，未知动作的报错写明只剩 `list` 且维护在设置页；`createAdmin()` 只剩 `list()`（`paths` / `dialog` / `pool` 参数不再需要，签名收成 `{ store }`）；`createDialogRunner()` 删 `run()` / `confirm()` / `askForm()`，只剩 `selectRows()`（`run.mjs` / `copy.mjs` 用它）与它需要的 `awaitDialogDone` / `readCollected` / `DIALOG_DRAIN_GRACE_MS`；删只被删掉分支用的 `hostLabel()` 与纯逻辑 `removeHost()`，删 `writeJsonAtomic` import |
| `lib/admin.mjs`（保留） | `upsertHost()` / `setHostLabel()` / `serializeHostsDocument()` **保留**：前两个被 `lib/api/handlers.mjs`（设置页）直接复用，第三个被 `lib/store.mjs` 用于写 `hosts.json` |
| `scripts/dialog.ps1` | `-Mode` 的 `ValidateSet` 只剩 `'select'`；删 `confirm` / `form` 两个分支、`-FieldsFile` / `-Title` / `-Prompt` / `-HostLabel` / `-ConfirmText` / `-CancelText` 参数与它们的 STA 转发；退出码语义不变（0 有答案 / 2 取消 / 1 起不来） |
| `scripts/ui/card.ps1` | 删 `Invoke-SshCardConfirm()` 与 `Invoke-SshCardForm()`；`Invoke-SshCardSelect()` / `New-SshCardShotScript()` 一字不动 |
| `scripts/ui/shared.ps1` | 删 `New-SshConfirmPayload()` / `New-SshFormPayload()` / `ConvertTo-SshFormDecision()` / `ConvertTo-SshConfirmDecision()` 与只给它们用的 `$script:SshConfirmAction`；`New-SshCardPayload()` / `ConvertTo-SshDecision()` / `Get-SshRowLabels()` / `Split-SshRowMeta()` / `Test-SshCardField()` / `Assert-SshCardShell()` 不动 |
| 其它 lib 文件 | 只改注释与报错文案里指向已删工具的引用（`status.mjs` / `pool/connect.mjs` / `hosts.mjs` / `vault.mjs` / `jms/{api,config,hosts}.mjs` / `api/gateway.mjs`），行为零改动 |

**为什么删纯函数 `hostLabel` / `removeHost`**：`hostLabel` 只服务 add_host 与 remove_host 两张卡的文字
（卡片删了就没有第二个调用点）；纯逻辑 `removeHost` 只被 `ssh_admin` 的 remove_host 分支用，
设置页的删除在 `lib/api/handlers.mjs` 里自己 `delete hosts[id]`。设置页**没有**依赖这两个，
所以按 AGENTS §0「正确性优先于兼容性」直接删，不留没人调的导出。

**被否的方案**：

- **保留 `add_host` / `set_label` 做兼容层**（工具还在，只是不写进提示词）：模型照样能翻出工具 schema
  给自己加目标、删主机——「维护只在设置页」这条约束等于没落实，而且是两套写盘路径并存（工具走
  `writeJsonAtomic`，设置页走 `store.updateHosts()`），迟早分叉。
- **只隐藏工具、不删代码**（`index.js` 不注册，但 `lib/jms/tool.mjs`、`askForm`、confirm 卡都留着）：
  代码还在就有人（包括下一个会话的模型）重新接回去；`dialog.ps1` 的模式、载荷构造函数、卡片适配层
  会继续躺在运行时路径旁边，改卡片时还得为它维护。
- **把维护动作搬进「设置页 + 一个只读工具」之间的中间形态**（例如会话侧留一个 `ssh_admin add_host`
  但强制弹设置页链接）：多一条永远只在一个地方用的路径，还不如删干净。

**代价与已知缺口**（不藏）：会话侧现在**无法**新增主机、重填密码、改备注、删除主机，也不能在会话里
批量接入——这些都必须开插件设置页。接入卡那份字段表 `jmsFormFields()` 与 `jmsSelectRows()`
（都在 `lib/jms/hosts.mjs`）已无会话侧调用点，但按本轮的边界（`lib/jms/*` 行为不动）暂留。

**怎么复验**：

1. `grep -RInE 'add_host|set_label|remove_host|askForm|createJmsTool|ssh_jms|jms/tool' dsh-ssh-remote/{lib,scripts,index.js}` → 零命中；
2. `node --check` 逐个过改动过的 `.mjs` / `.js`；三个 `.ps1` 用
   `[System.Management.Automation.Language.Parser]::ParseFile()` 过一遍（无错误输出）；
3. 工具清单：`index.js` 的 `tools` 只剩 `ssh_status` / `ssh_admin` / `ssh_run` / `ssh_copy`
   （`tests/api.test.mjs` 那条工具列表断言要同步删掉 `ssh_jms`——断言归协调会话）；
4. 真机：问模型「加一台主机」，它应当只说去插件设置页，`ssh_admin` 的 schema 里只有 `list`；
   发一条 `ssh_run`，卡片照旧是勾选卡（没有确认卡 / 表单卡）；
5. 设置页：新增 / 编辑 / 改备注 / 删除 / 接入点导入全部照旧可用（这条路本轮零改动）。