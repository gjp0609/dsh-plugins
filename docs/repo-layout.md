# 仓库目录结构规范

> **谁维护**：协调会话（结构是判断，不是执行）。子会话按本文摆文件，不自行新增顶层目录。
> **什么时候读**：新建/移动/删除任何文件之前；发版之前；发现「根上多了一个目录」时。
> **事实来源是仓库本身**：本文与 `tests\layout.ps1` 冲突时以断言为准，并回来把这里改对。
> **由 `tests\layout.ps1` 守**：结构跑偏会让它红，红就是不许合并。

用户原话（2026-11-02）：

> 「整体目录结构 需要 整理一下 现在 目录结构 不清晰（做完功能有些 临时的删除 旧的更新 等等）」
> 「里面不少文档 应该也是过期的了 应该统一规定好 整体目录结构 不然过几天又乱了」

这份文件回答三件事：**什么能放在哪**、**什么永远不许出现在仓库里**、**谁在守**。
「先放这儿、回头收拾」一律视为违规——没有任何回头。

---

## 1. 仓库根：只允许 15 个条目

```text
dsh-plugins\
├── .gitignore                 ← 忽略规则
├── README.md                  ← 仓库总览（插件清单、装法、数据落点）
├── AGENTS.md                  ← 跨插件行为规范
├── PREFERENCES.md             ← 用户偏好硬约束（只有协调会话能写）
├── BACKLOG.md                 ← 待办唯一清单
├── THIRD-PARTY-NOTICES.md     ← 第三方组件与许可声明（WebView2 的 BSD-3 全文在这里）
├── docs\                      ← 跨插件文档（见 §4）
├── dsh-approval-allow\        ← 插件
├── dsh-approval-notifier\     ← 插件
├── dsh-rail-pins\             ← 插件（纯客户端：折叠栏里的 pin 会话）
├── dsh-ssh-remote\            ← 插件
├── shared\                    ← 跨插件共用的外壳（见 §3）
├── tools\                     ← 跨插件工具（见 §5）
├── tests\                     ← 跨插件断言（见 §5）
└── vendor\                    ← 第三方二进制：webview2 的三个 DLL（见 §5 末）
```

**只允许上面这些**。根上多一个条目就算跑偏，`tests\layout.ps1` 第 1 条会把它点名。

本机运行必需、但**永不入库**的三个条目（`layout.ps1` 放行其存在，`.gitignore` 保证不入库）：

| 条目 | 是什么 | 为什么不能删 |
| :--- | :--- | :--- |
| `.git\` | 版本库本体 | 删了仓库就没了 |
| `.agents\` | `create_worktree` 的落点（`worktrees\<名字>\`） | 并行开发靠它隔离，见 §7 |
| `.session-files\` | 工作区临时区（见 §6） | 构建副本、调试日志都在里面 |

**忽略 ≠ 允许**：`.gitignore` 只保证「不入库」，不保证「可以出现」。`.agents\` 与 `.session-files\`
各有明确的内容约束（`.agents\` 见 §7、`.session-files\` 见 §6），除此以外的目录不许借这两个名字生存。

### 禁止在仓库根出现

- `out\`：旧出图落点，2026-11-02 起正式图统一进 `docs\images\`，临时图进 `.session-files\tmp\`；
- `.dev\`：旧的测试工作树落点，已改到 `.agents\worktrees\`；
- `_*.log` / `_*.ps1` / `_*.txt`：调试残留（重定向输出时别用根目录当靶子）；
- 构建副本目录（`dist\`、`app\`、`build\`、`temp\` 之类）与任何「最后一次」的备份目录。

判据（可执行）：

```powershell
Get-ChildItem -Force | Select-Object Mode, Name      # 对照 §1 的清单
pwsh -NoProfile -File tests\layout.ps1               # 第 1、2 条
```

---

## 2. 插件目录：七个标准件 + 两个 bundle 必备件

每个 `dsh-*\` 的结构固定，**只允许这些**：

| 条目 | 必需 | 是什么 |
| :--- | :---: | :--- |
| `README.md` | 是 | 插件自己的约定、用法、坑（插件特有内容只写这里，不写进 `AGENTS.md`） |
| `DECISIONS.md` | 是 | 这个目录的「为什么」：现象/判定/根因/结论/被否方案 |
| `index.js` | 是 | 宿主入口（Cordis bundle 的源码入口，仓库里保留） |
| `index.bundle.js` | 仅打包型 | **入库产物**：依赖已内联的单文件（`dsh-ssh-remote` 用），不许进 `dist\` |
| `lib\` 或 `scripts\` | 是 | 实现层；再往下按职责拆子目录（如 `lib\pool\`、`scripts\ui\`），不为一个文件单开一级。两样都有时：`lib\` 放运行逻辑（`.mjs`），`scripts\` 放 PowerShell 入口与卡片适配层 |
| `tests\` | 是 | 本插件的断言（`.mjs` 单测、`*.ps1` 纯逻辑断言、`fixtures\` 样例数据） |
| `vendor\` | 仅需要时 | 真需要第三方的、无法用仓库根 `vendor\` 共享的二进制；**目前三个插件都没有** |
| `package.json` | 是 | bundle 清单；开发形态（`main` 指源码、带 `dependencies`），生产形态由部署脚本改写 |
| `cordis.patch.yml` | 是 | 插件在 profile 里的装配行 |

插件目录里出现的**自有附加目录**也算结构的一部分，先登记再放：

| 插件 | 允许的附加条目 | 为什么 |
| :--- | :--- | :--- |
| `dsh-approval-allow` | `scripts\project-id.mjs` | 给人算项目标识；与运行时同源，不能挪进 `tools\` |
| `dsh-approval-notifier` | `locale\`、`icon.svg` | 宿主界面的本地化与图标，运行时直接读 |
| `dsh-ssh-remote` | `pnpm-lock.yaml`、`scripts\lib\`、`scripts\ui\` | 依赖锁文件入库（可复现构建）；`.ps1` 按层拆 |

### 插件目录里禁止出现

- `node_modules\`：不入库。**唯一例外**是 `dsh-ssh-remote` 为打单文件 bundle 临时装的依赖
  （`pnpm install` 后 `pnpm build`，产物入库、目录可随时删）；
- `dist\`、`app\`、`.tmp\`：构建期目录，产物必须按上面的规则落位（`index.bundle.js` 在插件根、
  卡片产物在 `shared\ui-card\dist\`）；
- **外壳副本**：`card-html.ps1` / `webview2.ps1` / `environment.ps1` 等共享外壳文件的逐字节副本
  （`tests\layout.ps1` 第 5 条按 SHA256 比对；自己写的同名不同内容文件不算副本，但名字要先说清用途）；
- 任何 `.md` 之外的临时笔记、截图、日志、备份（`*.bak`、`*.old`、`*.orig`）。

---

## 3. `shared\ui-card\`：卡片外壳（唯一渲染源）

```text
shared\ui-card\
├── app\                  ← 源码（这里才改界面）
│   ├── src\              ← React + antd 5：结构/交互、payload、协议、高亮、fixtures
│   ├── index.html        ← 入口模板（data-phase="measure" + #dsh-payload 占位）
│   ├── vite.config.ts / tsconfig.json / package.json / package-lock.json
│   └── node_modules\     ← 构建依赖，不入库
├── dist\index.html       ← **入库产物**（单文件，禁手改；`npm run build` 生成）
├── card-html.ps1         ← 载荷与文档拼装（`New-CardPayload` / `New-CardDocument`）
├── webview2.ps1          ← 窗口层（起窗、两阶段量高、收消息）
├── webview2-runtime.ps1  ← 运行环境层（DLL 定位、WebView2 环境复用）
├── environment.ps1       ← DPI、强制显示、落位、任务栏闪烁
├── assets\               ← 窗口图标（`card.ico` / `card-256.png`）与生成脚本
├── debug\                ← 调试与出图（`render.ps1`、`probe.js`、`samples\`）；正式路径 dot-source 不到它
├── demo\                 ← 最小演示宿主（`demo.ps1`，新接入先照它写）
└── DECISIONS.md          ← 外壳自己的决策记录
```

- **只有这一处渲染源**：插件目录里不许有副本（`tests\shared-ui-guard.ps1` 守），也不许 junction；
- 改 UI 的唯一流程：改 `app\src` → `cd shared\ui-card\app; npm run build` → **提交 `dist\index.html`**；
- `debug\` 与 `demo\` 只给验收/示例，部署不搬（见 `docs\deploy.md`）。

---

## 4. `docs\`：跨插件文档

```text
docs\
├── repo-layout.md            ← 本文（结构规范）
├── shared-ui-card.md         ← 外壳的结构与接口（载荷字段、两阶段高度、消息协议）
├── deploy.md                 ← 部署与生产树（上线、回滚、打包规则）
├── webview2-card-playbook.md ← 做弹窗的接入清单与坑清单
├── plugin-dsh-contract.md    ← 我们碰了 dsh 哪些面（从插件代码倒推的触点表）
├── upgrade-acceptance.md     ← 升级验收：分工、动作顺序、什么时候跑 tests\upgrade-accept.ps1
└── images\
    ├── card-approval.png     ← 审批卡（dsh-approval-notifier）
    └── card-select.png       ← 勾选卡（dsh-ssh-remote；勾选即审批）
```

- **`docs\` 只放跨插件结论**：插件特有的用法进插件 `README.md`，决策进对应 `DECISIONS.md`；
- `docs\images\` 里**只有两张卡片截图**：`card-approval.png`（审批卡）与 `card-select.png`（勾选卡）。
  **每次发版必须重出**（旧图即缺陷，用户 2026-11-02「里面都是旧的」）；两张已于 2026-11-16 按中性载荷重出。
  表单卡与确认卡已随 B-47 从外壳删除，`card-form.png` / `card-confirm.png` 不再存在、也不许再引用；
  出图载荷还剩两张卡的夹具：`tests\fixtures\approval.json` / `select.json`（`ssh-run.json` 只给
  `shared\ui-card\debug\height-stability.ps1` 做高度稳定性调试；`app\src\fixtures\` 同样只剩 `approval.ts` / `select.ts`）。
  同名 `card-*.measure.json` 是同一次出图的量测记录（`tests\card-geometry.ps1` 读它），随图一起重出；
- **出图载荷必须是中性数据**：地址用 `192.168.1.x` 这类示例值（RFC 1918 私有网段——它不是「无效地址」，只是与我的实际主机无关），主机备注用「主机A/B/C」，不许出现
  真实内网地址、本机用户名、公司/项目名与主机角色（主机B、WAF 入口之类）。截图是脱敏的盲区——文本能替换、
  像素不能，只能在载荷上避开（用户 2026-11-16：「还是特征明显，直接用 192.168.1.1 这种即可，备注也模糊一点」）；
- **`docs\samples\` 不存在**：样例载荷在 `tests\fixtures\` 与 `app\src\fixtures\`，不要再开第三个落点；
- 文档与代码不一致时：**代码为准**，回来改文档（本文档体系见 `AGENTS.md` §6）。

---

## 5. `tools\` 与 `tests\`：只放跨插件的东西

| 目录 | 允许的条目 | 判据 |
| :--- | :--- | :--- |
| `tools\` | `deploy.ps1` + `deploy-lib\{paths,assert,items,backup,output,actions}.ps1`、`preview-card.ps1`（真窗口验收）、`approvals-report.ps1`（审批流水统计）、`gen-fixtures.ps1`（样例载荷生成）、`DECISIONS.md` | 会被**两个以上**插件/脚本用；只服务一个插件的东西放回那个插件的 `scripts\` |
| `tests\` | 跨插件断言 `.ps1`（每张卡/每条规范一个文件，如 `layout.ps1`、`card-shell.ps1`、`preferences.ps1`、`shared-ui-guard.ps1`）、`fixtures\*.json`（共享样例载荷）、`probe-partial.mjs` | 断言脚本不随部署上线、不进生产树；插件自己的断言留在插件 `tests\` |

- 断言脚本**不受 400 行上限约束**（`AGENTS.md` §2 的例外），拆开只会重建基线；
- 新增一条规范 = 新增一条断言，**不许只写文档不写断言**（见 §8）。

### `vendor\` 只有一份 WebView2

`vendor\webview2\` 入库的只有三个 DLL：`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、
`WebView2Loader.dll`（合计约 0.9 MB）。`extracted\` 与 `*.nupkg` 是解包中间物与下载缓存，**已忽略、可整删**，
不许入库；插件目录里也不许放 DLL 副本（各插件的 `tests\card-select.ps1` 与 `tests\shared-ui-guard.ps1` 守）。

---

## 6. `.session-files\`：工作区临时区（不入库）

顶层**只允许**这六类条目，其它一律视为垃圾：

```text
.session-files\
├── INDEX.md            ← 会话索引
├── PROJECT_CONTEXT.md  ← 本机项目上下文（启动方式、环境、账号等）
├── TASK_STATE.md       ← 当前任务状态
├── tmp\                ← 调试日志与草稿：可随时整删
├── build\              ← 构建副本（`npm install` / `npm run build` 在这里做）：可随时整删
└── <日期>-<任务名>\     ← 会话目录，名字必须匹配 ^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$
```

- **临时物只许出现在 `tmp\` 与 `build\`**：根上直接落 `_*.log`、`card-preview.json` 这类文件
  是旧习惯，已被禁止；
- `build\` 里的副本用完就删（它是「仓库外构建」的替身，不是归档）；
- 会话目录只在任务跨会话时建（见 `session-state` skill），做完把结论写进 `TASK_STATE.md` / `INDEX.md`，
  目录不无限增长。

---

## 7. 生命周期：临时物、worktree、发版

| 场景 | 规则 |
| :--- | :--- |
| 调试输出 / 草稿 | 只写 `.session-files\tmp\`；不写仓库根，不写 `docs\` |
| 构建（`npm install` / `npm run build`） | 在 `.session-files\build\<名字>\` 的副本里做（`AGENTS.md` §1） |
| 开发隔离 | `git worktree add .agents\worktrees\<名字> -b <分支>`；**不并行两件事**，一个 worktree 一件事 |
| 功能合并后 | **24 小时内** `git worktree remove .agents\worktrees\<名字>` + 删分支；残留会被 `layout.ps1` 第 9 条点名 |
| 出图 | 正式图进 `docs\images\`（入库）；临时图进 `.session-files\tmp\`，验收完即删 |
| 发版三件套 | ① 重出 `docs\images\` 两张卡片截图（`card-approval.png` / `card-select.png`）；② 核 `BACKLOG.md`（做完的删行）；③ 把 `docs\` 里与代码不一致的陈述同步掉 |

「发版三件套」不做的后果是可验证的：`layout.ps1` 第 7 条（图不比产物旧）会红，用户也会看到旧图——
2026-11-02 就是这么被发现 `docs\images` 还是 10-30 的图的。

---

## 8. 防复发：结构由 `tests\layout.ps1` 守

**没有断言的规范等于建议。** `tests\layout.ps1` 把上面的条款变成 9 条可跑检查（任一失败即退出码 1）：

| # | 断言 | 对应条款 |
| :--- | :--- | :--- |
| 1 | 仓库根只有白名单条目 | §1 |
| 2 | 根上没有 `_*.log` / `_*.ps1` / `_*.txt` 调试残留与 `out\` | §1「禁止在仓库根出现」 |
| 3 | `.session-files\` 顶层只有白名单（含日期目录正则） | §6 |
| 4 | 每个插件目录都有 `README.md` 与 `DECISIONS.md` | §2 |
| 5 | 插件目录里没有 `dist\` / `app\` / `.tmp\`，也没有外壳文件的逐字节副本 | §2、§3 |
| 6 | 本文在位，且自己声明了由 `tests\layout.ps1` 守 | 本文头部 |
| 7 | `docs\images\*.png` 不比 `shared\ui-card\dist\index.html` 旧 | §4、§7 发版三件套 |
| 8 | 文档里引用的本地图片都真的存在 | §4 |
| 9 | 没有未登记的残留 worktree（`.agents\worktrees\` 与 `.git\worktrees\` 一一对应） | §7 |

改结构的正确顺序：**先改本文与 `layout.ps1` 的白名单/断言，再动文件**。
两边必须同一次提交——只改一边，下一个人就会按旧规则把东西放回去。

---

## 9. 新增一个文件时怎么判断放哪

```text
只被一个插件用？           → 那个插件的 scripts\ 或 lib\
被两个以上插件/脚本用？     → tools\（可执行）或 shared\（运行时代码）
是跨插件结论/做法？         → docs\
是某块代码的「为什么」？     → 该目录的 DECISIONS.md
是用法/坑/兼容性？          → 该插件的 README.md（仓库级才进根 README.md）
是临时物？                 → .session-files\tmp\ 或 build\
是待办？                   → BACKLOG.md（不许另开清单）
是用户偏好？               → PREFERENCES.md（只有协调会话能写）
```

拿不准时**不要先放根上**：问协调会话，或在 `BACKLOG.md` 记一条。

---

## 10. 迁移记录（2026-11-02）

这次整理的一次性动作，留档避免重复讨论：

- 仓库根的 `out\`（旧出图）与 `.dev\`（旧测试工作树）已删除，职责分别归 `docs\images\` 与 `.agents\worktrees\`；
- `.session-files\` 根上的调试残留清空（只留 `tmp\`、状态文件与会话目录；`build\` 用到了才出现）；
- `tools\gen-fixtures.ps1` 归入 `tools\`（跨插件样例生成），不再放仓库根；
- 空目录 `docs\samples\` 删除（样例载荷只有 `tests\fixtures\` 与 `app\src\fixtures\` 两处）；
- 新增本文与 `tests\layout.ps1`；此后结构变更必须同时改这两处。
