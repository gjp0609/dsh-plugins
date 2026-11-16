# 共享卡片外壳（`shared/ui-card/`）

> **谁维护**：改这块代码的人（当前是协调会话 + 常驻文档子会话），改完代码顺手改本文件。
> **什么时候读**：要给插件加/改弹窗之前、要改卡片外观或尺寸之前、新插件接入之前。
> **事实来源是代码**：`shared/ui-card/*.ps1` 与 `app/src/`。本节与代码冲突时，以代码为准，并回来把这里改对。

## 0. 术语表（先对词，再谈事）

> 用户 2026-11-10：「我建议你先确定一下 术语 不然沟通总是有问题」。
> 左列是**用户的口语**（以他为准，我们不另起名字），右列是代码里的对应物。改这块代码前先看这张表。

| 用户叫它 | 屏幕上指哪块 | 代码里的名字 |
| :--- | :--- | :--- |
| 卡片 | 整个弹窗窗口（任务栏有条目） | 卡片窗口 / `Form` |
| **标题** | 最上面那行小字，如 `SSH · 执行确认` / `pwsh · 提权审批` | `eyebrow`（`New-CardPayload -Eyebrow`）。**唯一的拖动区** |
| 工作目录 | 标题下面那行路径 / 主机标签，如 `C:\work\…` | `titleHtml`（`New-CardTitlePath`）。纯展示，**不能拖** |
| 行 / 条目 | 勾选卡里一台主机那一整块 | row |
| 主机行 | 勾选框 + `192.168.1.11:22 · 主机A` | 行首 |
| **灰框 / 代码框** | 浅灰底、装代码的容器 | 代码容器（底色 `colorFillTertiary`，B-12） |
| 说明行 | 灰框里第一行灰字，如 `# 看一下根分区还剩多少` | `why`（带 `# `，交 shiki 上色，D-42） |
| 命令 / 命令区 | 灰框里着色那几行 | `command`；复制只拿它（B-32） |
| 框底附注 | 灰框最底下 `工作目录 /root · 超时 30s` | cwd / timeout 条（更深一档底色，B-18） |
| 按钮区 | 右下 `跳过` / `提交 0 项` / 右上 `✕` | 页脚按钮 |
| 折叠 / 展开 | 灰框只露 6 行 / 点按钮显示更多 | `canFold` / `expanded`（只作用于代码框） |
| 灰框高度 | 灰框的可见高度 | `FOLD_BODY_MAX`＝6 行 × 20px + 10px＝**130px** |
| **白块（留白）** | **灰框底边与按钮之间那块白色空隙** | 无对应物：出现即缺陷（D-44） |


## 1. 现在是什么

卡片**只有一个渲染源**：`app/src` 用 Vite 打成的 React + antd 5 单文件产物 `dist/index.html`
（约 690 KB / 705,961 字节，入库、不许手改；**产物不可字节复现**，大小每次构建都变，见 §9）。**PowerShell 只产出 payload JSON**，DOM、样式、交互全在产物里。

外壳只提供**两种卡**：**勾选卡**（`rows`：一行一个勾选项 + 代码框）与**审批卡**（`body` 只读正文 + `buttons`
两个按钮）。表单卡（`form.fields`）与确认卡已随 B-47 从渲染与协议里删除，没有输入区、也没有 `Fields` 回传。

- 宿主是 `webview2.ps1`（起窗、量高、收消息）+ `webview2-runtime.ps1`（DLL 与 WebView2 环境）；
- 拼装是 `card-html.ps1`：`New-CardPayload` 造载荷，`New-CardDocument` 把载荷塞进产物；
- 插件里**只留业务适配层**（载荷 ↔ 外壳输入、消息 ↔ 业务结果），不许出现外壳副本
  （`tests/shared-ui-guard.ps1` 断言）。

三条不能破的约束（来源：`AGENTS.md` §0 / §4）：一张卡只有一个渲染源；改 UI = 改源码 + 构建 + 提交产物；
通用能力引库（antd 5），自己写的只留业务。

## 2. 目录与分层

| 文件 | 行数 | 层 | 职责 |
| :--- | ---: | :--- | :--- |
| `app/index.html` | 16 | 入口模板 | `data-phase="measure"` + `<script id="dsh-payload">__DSH_PAYLOAD__</script>` |
| `app/vite.config.ts` | 18 | 构建 | `vite-plugin-singlefile`，产物落 `../dist`，`target: chrome110` |
| `app/src/main.tsx` | 45 | 渲染 | 挂载、`ConfigProvider`（antd token：**字体**、字号 14、圆角 6、控件高 32）、崩溃兜底文案 |
| `app/src/App.tsx` | 779 | 渲染/布局 | 抬头、首行（路径/主机标签）、正文块、勾选行、页脚按钮、✕；两阶段、防误点、倒计时、键盘 |
| `app/src/styles.css` | 110 | 渲染 | 只留几件：两阶段高度契约、细滚动条、代码框工具条、去焦点环、读屏专用 label |
| `app/src/payload.ts` / `types.ts` | 38 / 69 | 数据 | 读 `#dsh-payload`；载荷类型（`CardRow.lang`；键名与 `card-html.ps1` 对得上） |
| `app/src/bridge.ts` | 77 | 协议 | 页面 ↔ 宿主消息（见 §7） |
| `app/src/fixtures/*.ts` | 2 份 | 开发态样例 | `npm run dev` 时用 `?fixture=approval\|select` 切 |
| `dist/index.html` | — | **产物** | 705,961 字节（2026-11-16），入库；`npm run build` 生成，禁手改 |
| `card-html.ps1` | 389 | 布局 | 定位外壳、造载荷/块/行/按钮、`New-CardDocument` |
| `webview2.ps1` | 591 | 入口（宿主） | `Show-CardWindow`：建窗、两阶段量高、落位、收消息、返回结果 |
| `webview2-runtime.ps1` | 139 | 运行环境 | 找 `vendor\webview2` 三个 DLL、查运行时、复用 WebView2 环境对象 |
| `environment.ps1` | 732 | 环境 | DPI、`Invoke-CardForceShow`、任务栏闪烁、`Get-CardPlacement`、`New-CardRegion` |
| `demo/demo.ps1` | 165 | 示例 | 最小宿主：喂一份 JSON 载荷出一张卡（**新接入先照它写**） |
| `debug/render.ps1` | 517 | 验收（非正式路径） | 出 PNG + `*.measure.json`；正式调用方从不 dot-source 它 |

DLL 在仓库根 `vendor\webview2\`（Core / WinForms / Loader，约 0.9 MB），**插件目录里没有副本**。

## 3. 一次弹卡的链路

```text
业务数据
  → New-CardPayload（body/rows/buttons/armMs/closeMs/keyboard）
  → New-CardDocument（读 dist/index.html，只替换 #dsh-payload 标签内部）
  → Show-CardWindow（建窗 → 等 ready{height} → 钳高 → SetWindowPos → ShowWindow → 发 shown → 等终态）
  → 返回 { Action, Message, … }（`Message` 是页面终态消息的原文 JSON）
  → 业务适配层把 Message 翻成业务结果
```

调用方只认这三步，不需要知道窗口怎么建、高度怎么算。

## 4. 载荷契约（`New-CardPayload`）

| 参数 | 载荷键 | 说明 |
| :--- | :--- | :--- |
| `-Eyebrow` | `eyebrow` | 抬头小字，格式统一成「域 · 动作」两段（如「`pwsh` · 提权审批」「SSH · 执行确认」）；业务给整串，外壳不认识业务（B-13）。**用户口中的「标题」就是这一行**，也是唯一的拖动区（`-TitleHtml` 那行是「工作目录」，不能拖——2026-11-10 真机纠正过一次） |
| `-TitleHtml` | `titleHtml` | **首行**里的片段，**唯一允许带 HTML 的字段**；用 `New-CardTitlePath` 生成（路径/主机标签；主机标签与勾选行同形，`地址:端口 · 别名`，B-22）。没有就不渲染首行（B-16：首行不用固定句子） |
| `-Status` | `status` | 页脚状态行；有 `closeMs` 时页面自己在后面接「剩余 m:ss」 |
| `-Body` | `body` | 正文块数组：`note`（正文）/ `code`（只读代码块） |
| `-Rows` | `rows` | 可选行数组：`label`（必填）/ `why` / `text` / `meta` / `warn` / `lang`。外壳把 `why` 排成代码框首行（注释色、不拼 `#`）、`text` 排成主体、`meta` 排成框底附注条、`warn` 排到主机那一行右侧。`lang` **只决定 `text` 的高亮**：缺省/缺键 = 按 `sh`（行的主体通常是命令）；给 `text` = 逐字纯文本、不按 shell 涂色（搬运卡的 `Source: …` / `Target: …` 说明文字用它，D-37）。空/缺键时不写该键（页面靠「键在不在」区分） |
| `-Buttons` | `buttons` | 页脚按钮：`label` / `action` / `kind`(primary\|default) / `requiresChecked` / `labelCount` |
| `-ArmMs` | `armMs` | 窗口显示后多久按钮才可点（防误点；0 = 立刻可点） |
| `-CloseMs` | `closeMs` | 页面倒计时到点自己关（发 `expired`；0 = 不自动关） |
| `-Keyboard` | `keyboard` | `none` = 整页拦键盘（只认鼠标）；默认 `Esc` 取消、`Enter` 主按钮 |

块与行由这些函数造：`New-CardNoteBlock`、`New-CardCodeBlock`（`-Command` 命令一字不改、`-Lang`、
`-Comment` 可选一行说明；说明由外壳渲染成代码框**第一行**（注释色、**不拼 `#`**，D-40）、复制时排除，B-31 / B-32）、
`New-CardRow`、`New-CardButton`、`New-CardTitlePath`、`ConvertTo-CardHtmlText`。
`ConvertTo-CardBlockList` 透传 `comment`：**给了才写这个键，没给就不写**（页面靠「键在不在」判断有没有说明；
说明是独立字段，不许拼进 `command`——拼进去就等于改了命令原文，C-08）。

**代码高亮由 Shiki 提供**（`app/src/highlight.ts`，K-012 / B-10）：只带 `shellscript` 与 `powershell`
两种语法（按子路径引，不引 `shiki` 根入口），跑 **JS 正则引擎**（不装 oniguruma、没有 wasm 外链），
高亮在 render 期同步完成（`createHighlighterCoreSync` + `useMemo`），所以 measure 量高时已经定格；
只改颜色、不改字体字重，所以高亮后不会再折行或变高。

配色是 **IDEA Light 调色板**（B-30），**不是「跟随界面色」**：主题仍由 `createCssVariablesTheme`
生成，但 `--shiki-*` 变量指向 `App.tsx` 里的 `IDEA_LIGHT` 固定色表——注释 `#8C8C8C`、
字符串 `#067D17`、关键字/命令名 `#0033B3`、数字/常量与命令/函数同色 `#1750EB`、变量 `#248F8F`、
类型 `#7A7A43`、操作符 `#871094`、正文与参数/标点 `#080808`（D-34）；`inserted` / `deleted` / `changed` 三档仍走 antd token（它们表达
「增删改」，没有编辑器主题语义）；`--shiki-background` 不给，底色归代码框（B-12）。

**坑：`createCssVariablesTheme` 的桶是粗粒度前缀匹配。** 它的规则是 `scope: ["string", …]` 这种前缀匹配，
而 `shellscript` 语法把**裸参数**归进 `string.unquoted.*`——`echo xxxx` 的 `xxxx`、`for i in 1 2 3`
的字面量、`wc -c` 的 `-c`（祖先也是 `string.unquoted.argument.shell`）全被涂成字符串绿，
表现为「命令 + 参数」整行发绿。修法：在桶表**之后**追加更具体的
`string.unquoted` / `constant.other.option` → `var(--shiki-foreground)`（更具体的作用域优先）。
**别拿取色器验收颜色**：ClearType 子像素混色会让你量到 `#2C8365` 这种不存在的值；要验就看
`getComputedStyle`，或断言源码里的映射表（`tests/card-shell.ps1`；真跑高亮的行为断言在
`tests/card-tokens.ps1`）。

`lang` 认不出、初始化失败、拼回的原文与输入不一致——任一情况都退回**纯文本**（命令原文一字不改，C-08）；
认不出的语言不猜，涂错比不涂更难读。构建后仍是**单文件、无 wasm 外链**。
代码框的折叠 / 复制 / 悬停按钮见 [`webview2-card-playbook.md`](./webview2-card-playbook.md) §11。

**勾选行的排版**（`rows`，实现见 `app/src/App.tsx`；B-15 / B-17 / B-18 / B-22 / B-23）：

- **一行 = 一个执行单位**：左列 `Checkbox`，右列第一行「主机 `label` + 警告」（`warn` 靠右、橙色 `⚠`、小一号字）；
- **`label` 是业务层给的目标，外壳原样显示**：外壳不认识主机，也不往选项行里拼命令或文件名（拼了会被截断，
  且挤掉真正要看的主机名）。ssh 的远程主机写成 `地址:端口 · 别名`（**B-22**，22 也写端口：同地址两台 sshd
  省了就完全重名），WSL 写 `WSL(Debian)`；只要有一对 `label` 撞车，业务层就给**所有** `label` 前加 `①②③`
  （**B-23**，正文块标题同步带同一个编号——编号的职责只是让勾选映射回 `label` 下标）；
- 主机行下面一个代码框（`token.colorFillTertiary`、圆角、`overflow: hidden`）：框内第一行 `why`（注释色、等宽、不拼 `#`），
  第二行 `text`（命令，等宽、默认换行）；`meta` 排在**框底附注条**（`token.colorFillQuaternary`，落像素 ≈`#F0F0F0`，
  与命令靠底色区分，框内**没有 1px 分隔线**）；
- **行间没有分隔线**：行容器 `gap 8`、行 `padding: 6px 10px`，靠留白把行分成一组（B-17）；
- `warn` 只有存在时才渲染，`⚠` 由外壳统一画一次（载荷里只放「覆盖」这类词）；`meta` 同样只在存在时渲染。

载荷规则（都写在代码里、由 `tests/card-shell.ps1` 守着）：

- **空字段不进载荷**：空串/空数组直接不写键——页面靠「键在不在」区分「没有这个区域」和「区域是空的」；
- **主按钮唯一**：两个 `kind = primary` 直接抛错；`none` / `outline` 一律归一成 `default`；
- **没有 `label` 的行被丢掉**（回传的 `checked` 是按下标对齐的，少一行就错位）；
- `code` 块的命令**一字不改**（不改前缀、不去空格、不换行处理）；
- `titleHtml` 之外的字段都由 React 转义，业务层不要再手工拼 HTML。

## 5. 文档拼装（`New-CardDocument`）

- 只替换 `<script id="dsh-payload" …>…</script>` **标签内部**；标签外一个字节都不动
  （占位符字符串在打包后的 JS 里也可能出现，整串 Replace 会把 JS 改坏）；
- 标签必须**恰好 1 个**，否则抛错并写明路径；
- JSON 里的 `<` `>` `&` 与 U+2028/U+2029 转成 `\u` 转义，命令里的 `</script>` 不会提前闭合标签；
- 产物缺失时抛「卡片产物缺失：…（在 shared/ui-card/app 里执行 npm run build；产物要入库）」。

## 6. 窗口契约（`Show-CardWindow`）

| 参数 | 默认 | 说明 |
| :--- | :--- | :--- |
| `-Html` | 必填 | `New-CardDocument` 的产物 |
| `-Width` | `680` | CSS 逻辑像素；内部按 DPI 换物理像素建窗 |
| `-MaxHeight` | `0` | 0 = 按屏幕算（`Get-CardMaxHeight`：屏高 62%，夹 160–760） |
| `-TimeoutMs` | `0` | 0 = 一直等（页面自己倒计时关窗）。只有审批卡传 `closeMs + 15s` 作兜底；ssh 侧 2026-11-10 起没有自超时（见 `dsh-ssh-remote/DECISIONS.md` D-39） |
| `-DataDir` | `''` | WebView2 用户数据目录；空 = `%LOCALAPPDATA%\dsh-ui-card\webview2` |
| `-Position` | `corner` | `corner` = 主屏右下角（16px 边距，多窗按 slot 往上错开）；`center` = 鼠标所在屏居中 |
| `-SlotIndex` / `-SlotCount` | `0` / `1` | 同时在场第几个 / 一共几个（错开步长按可用高度自适应） |
| `-CornerRadius` | `0` | 0 = 方形（不设 Region）；>0 才裁 Region，半径只有这一个来源 |
| `-WindowTitle` | `DSH` | 任务栏标题（不是卡片首行） |
| `-Activate` | 关 | 用 `SW_RESTORE` 并切前台；不传则 `SW_SHOWNOACTIVATE`。**层级不在这个参数里**：置顶来自建窗时 `New-CardForm` 的 `CreateParams`（`WS_EX_TOPMOST`，D-41）；让位（点卡片外面即降层）来自 `Start-CardTopMostYield` 的 `WH_MOUSE_LL` 钩子（D-43）；`Invoke-CardForceShow` 只负责显示（`SWP_SHOWWINDOW` 兜住 `SW_HIDE`） |
| `-OnShown` | — | `param($ShowInfo, $Form, $Ctrl)`：提示音、任务栏闪烁、自检截图 |
| `-OnRendered` | — | `param($Form, $Ctrl)`：`shown` 之后、页面已切 fill 时调用，**只给验收脚本** |

返回对象**七个字段恒定**（StrictMode 下直接读不抛）：
`Action`（`message` / `closed` / `timeout` / `failed`）、`Message`、`ContentWidth`、`ContentHeight`、
`WindowBounds`、`ShowInfo`、`Error`。`failed` 时 `Error` 非空、其余字段照旧。
`Message` 只在 `Action = message` 时是页面终态消息的原文（`decision` / `cancel` / `expired` 的 JSON）；
业务适配层自己解析这段 JSON（ssh 侧是 `ConvertTo-SshDecision`），外壳内部用 `ConvertFrom-CardMessage` 做路由。

**高度协议（两阶段）**：

1. 窗口先按目标宽度建在屏幕外、隐藏；页面在 `data-phase="measure"` 下不限高，布局完成后发 `ready{height}`；
2. 宿主把高度钳到 `[160, min(760, 62% 工作区)]`，`SetWindowPos` → `ShowWindow`（带 `SW_HIDE` 修法），再发 `shown`；
3. 页面收到 `shown` 切 `fill`：卡片 100% 高、主体区滚动、页脚钉住；防误点与倒计时都从这一刻开始；
4. `ready` 有 **2 秒**超时，超时按 **360** 高显示（不阻塞、不写兜底 UI，重试即可）。

### 6.1 「到点自动关」只有一个输入口

调用方只给一个数，其余全从它推：

| 输入 | 页面侧 | 宿主侧 |
| :--- | :--- | :--- |
| 审批卡的 `closeAfterMs` | 载荷 `closeMs` → 页脚「剩余 m:ss」+ 到点发 `expired` 自己关窗 | `-TimeoutMs = closeMs + 15s` |
| ~~ssh `dialog.ps1` 的 `-AutoCloseMs`~~ | 已删（2026-11-10，见 ssh D-39）：ssh 的勾选卡不传 `closeMs`、`TimeoutMs = 0`，永不自动关 | 无 |

- **不传 / `0` = 一直等**：`closeMs` 键不下发、`TimeoutMs = 0`，页面不显示倒计时；
- 兜底永远比页面宽 15s，只防「页面脚本挂了、倒计时没跑」；正常路径是页面先关，**页脚写什么就发生什么**；
- 现在只剩审批卡一个入口（ssh 的自超时已删），改 `closeMs` 只需动审批插件。

## 7. 消息协议

页面 → 宿主（`chrome.webview.postMessage`）：

```text
{ "type": "ready",    "height": <int> }              # measure 阶段首次布局完成，只发一次
{ "type": "resize",   "height": <int> }              # 只在 measure 阶段报（窗口还没定高）
{ "type": "decision", "value": "<action>", "checked": [bool…] }
{ "type": "cancel" }                                 # ✕ / Esc：关窗，不做决定
{ "type": "expired" }                                # 页面倒计时到点
{ "type": "copy", "text": "<原文>" }                  # 代码框「复制」：text 是命令原文（命令本体，不含说明行）
{ "type": "drag" }                                   # 标题按下：宿主进系统移动循环（R-15）
```

宿主 → 页面：`{ "type": "shown" }`（`PostWebMessageAsJson`，不注入脚本）、`{ "type": "copied", "ok": bool }`（复制回执，页面 800ms 无回执按失败）。

- 终态消息**只发一次**（`decided` ref 防重入）；
- `checked` 只在有 `rows` 时出现——**没有这个能力就别读这个键**；
- `ConvertFrom-CardMessage` 对坏消息/空串返回全空字段，不抛异常；它只解析
  `Type` / `Value` / `Checked` / `Height` / `Text`，`Checked` 是按下标对齐的勾选结果。

## 8. 插件怎么接

插件**先定位外壳、再 dot-source**，第一步不能调用外壳函数（那时还没加载）：

1. 插件适配层（`scripts/ui/shared.ps1`）里保留一段上溯搜索：从 `$PSScriptRoot` 往上最多 6 层找
   `shared\ui-card`（以 `card-html.ps1` + `webview2.ps1` 同时存在为签名），找不到返回空串；
2. 找到就 dot-source `card-html.ps1` 与 `webview2.ps1`（dot-source 本身不建窗口）；
3. 找不到就抛一条**能照着修**的错误，入口据此写 stderr / error 结果并非零退出——
   不要静默生成「一张空卡」，也不要有第二套界面兜底；
4. 业务只写两三个函数：`New-*Payload`（数据 → `New-CardPayload`）、`ConvertTo-*Decision`
   （消息 → 业务结果），外加一个「弹一次」的 `Invoke-*Card*`；
5. **不要** junction、不要复制外壳：前者进了版本库会指回主 checkout，后者两份必然漂移。
   代价是插件**不再自包含**：单独把插件目录拷出去会找不到外壳（弹窗失败、命令报错）。

函数名要带插件前缀：外壳的 `card-html.ps1` / `webview2.ps1` / `environment.ps1` 与插件代码
dot-source 进**同一个作用域**，同名函数会静默互相覆盖（`Get-DpiScale`、`Invoke-TaskbarFlash` 这类都撞过）。

## 9. 改 UI 的唯一流程

1. 改 `shared/ui-card/app/src`：结构/交互 → `App.tsx`；载荷字段 → `types.ts`（同步 `card-html.ps1`）；
   字体与 antd token → `main.tsx`；antd 表达不了的 CSS → `styles.css`；协议 → `bridge.ts` 与 `webview2.ps1` 一起改；
2. `cd shared/ui-card/app && npm run build`（依赖已在 `app/node_modules`，产物落 `../dist`）；
3. **提交 `dist/index.html`**：不许手改产物，也不许产物与源码不同步（`tests/card-shell.ps1` 会查内联与占位符）；
4. 跑纯逻辑测试（见 §10），出图对比再交给真机验收。

改了 `.ps1` 或产物**都不需要重启 DSH**：卡片每次弹窗现读。只有插件自己的 `index.js` / `lib/*.mjs`
要重启（ESM 缓存）。

**产物不可字节复现（2026-11-02 实测）**：同一份源码在两处重建，得到 725,788 / 727,204 / 741,359 三种
字节数与内容——差异是压缩后的标识符分配不同（同一段代码 `z=fu(ae)` 与 `V=eu(se)`），不是代码增减。
推论：**不能用「重建后比对字节」验证产物与源码同步**，只能靠 `tests/card-shell.ps1` 的源码/载荷断言 + 真机看一眼；
重建后 `git status` 里出现 15KB 级别的大小变化属正常，别当事故查。构建时若在沙箱里跑要提权，并且把
`TEMP`/`TMP` 指到工作区内（Vite 的 esbuild 插件要删 `%TEMP%` 临时文件，沙箱会拒）。

改样式的推进顺序（`AGENTS.md` §4 / `DECISIONS.md` D-08）：基础布局 → 少量样式 → 字体 → 最后抠细节。
跳步必返工。

## 10. 守卫与测试

| 脚本 | 查什么 | 要提权 |
| :--- | :--- | :--- |
| `tests/card-shell.ps1` | 产物内联与占位符、`New-CardDocument` 只换标签、载荷归一、`comment` 透传、单主按钮、协议形状、尺寸钳制、代码框折叠/展开/复制/按钮、代码高亮（Shiki 两种语法、JS 正则引擎、IDEA Light 调色板、失败退纯文本）、防回退（旧模板/`.qc-`/旧函数/已删的表单卡与确认卡） | 否（100 项） |
| `tests/card-tokens.ps1` | **真跑** `highlight.ts`（node 直接 import .ts）：裸参数不绿、引号字符串绿、关键字/注释/命令各归各位、字符串色只给引号开头的内容 | 否（1 项，需 node ≥ 22.18 + `app/node_modules`） |
| `tests/shared-ui-guard.ps1` | 插件里零外壳副本、外壳源码里没有插件专有词、载荷键名与 `types.ts` 一致、正式路径无调试符号 | 否（10 项） |
| `tests/preferences.ps1` | `PREFERENCES.md` 里能机器查的偏好是否还有载体（字体、方形、160/760/62%、无自动注入、逐行字段模板、B-47 会话侧只读……） | 否（51 项） |
| `tests/layout.ps1` | 仓库目录结构（根白名单、无调试残留、`.session-files` 顶层白名单、插件目录标准件、`docs\images` 不比产物旧、worktree 不残留） | 否（9 项） |
| `tests/card-geometry.ps1` | 读 `*.measure.json`：无非客户区、卡片贴左上、宽度铺满、返回尺寸与实测一致、Region 与半径对得上、落位边距 | 否 |
| `tests/card-border.ps1` | 读 PNG 数边缘线：每条边只允许一条（双边框是历史事故）+ 最外 1px 必须是 **B-26 的橙色描边**（`-EdgeColor`，默认 `#FAAD14`，容差 24）；白边/其它色都算不合格 | 否 |
| `tests/card-border.selftest.ps1` | 检查器本身能抓到双边框（合成反例） | 否 |
| `dsh-approval-notifier/tests/card-font.ps1` | 问渲染引擎（CDP `CSS.getPlatformFontsForNode`）落笔字体是不是等距更纱黑体 SC | **是** |

## 11. 出图与量测（要提权）

WebView2 在受限令牌下起不来（`0x8000FFFF`），所以出图批量跑、一次审批：

```powershell
# 临时出图落 .session-files\tmp\（可整删）；正式图只进 docs\images\（见 docs\repo-layout.md §4）
# 真屏抓图 + 外扩 20px（窗口外多余渲染只有扩出去才看得见）
pwsh -NoProfile -STA -File shared\ui-card\debug\render.ps1 `
     -Payload tests\fixtures\approval.json -OutFile .session-files\tmp\approval.png `
     -Mode screen -Screen 0 -ScreenMargin 20

# 洋红背板：卡片没盖住的地方会显形
... -Backdrop magenta

# 断言（只读 PNG / JSON，不需要提权）
pwsh -NoProfile -File tests\card-geometry.ps1 -Measure .session-files\tmp\approval.measure.json
pwsh -NoProfile -File tests\card-border.ps1   -Png .session-files\tmp\approval.png -WindowRect '20,20,680,267'

# 最小演示（不写业务代码，直接看一份载荷长什么样）
pwsh -NoProfile -STA -File shared\ui-card\demo\demo.ps1 -Payload tests\fixtures\select.json
```

`-WindowRect` 用**图内坐标**（`x = window.left - capture.left`，宽高取窗口），可从 `*.measure.json` 读。
白底会掩盖问题：验收要纯色壁纸或 `-Backdrop`。
**禁止脚本注入鼠标点击**；真机点一次只能由人来。离屏 PNG 只证明长相。

**交互类改动的验收入口**（B-42，用户 2026-10-30 定：截图看不出细节，样式/颜色/交互由人自己点）：

```powershell
# 起一张真卡片窗口（不截图、不跑探针、不注入点击），关窗后打印验收清单 + 剪贴板核对
pwsh -NoProfile -File tools\preview-card.ps1
pwsh -NoProfile -File tools\preview-card.ps1 -PayloadFile tests\fixtures\select.json -Width 680
```

- 默认载荷是 `shared\ui-card\debug\samples\review.json`（长 shell 折叠/滚动 + PowerShell 类型/变量 + shell 数字/管道 + 一条行内命令）；
- 它不是截图工具：只起窗、等人点、关窗后 `Get-Clipboard` 判定「复制是否等于命令本体」；
- 想验复制是否真的写进剪贴板，最容易判的办法是**先放一个哨兵串**：
  `Set-Clipboard 'SENTINEL'` → 点复制 → 关窗 → 看输出里剪贴板是不是变成了命令本体。

## 12. 已知坑

- **不要在 UI 线程同步等 WebView2 的异步调用**（`.GetAwaiter().GetResult()` 会互锁：脚本执行需要 UI 线程泵消息）。
  一律 `while (-not $task.IsCompleted) { DoEvents(); Start-Sleep -Milliseconds 10 }`，并且**要有超时收口**
  （环境/控制器 20s、ready 2s），否则表现是「窗口永远出不来」。
- **首次 `Show` 会被宿主的 `SW_HIDE` 顶掉**：`STARTUPINFO{ dwFlags: 257, wShowWindow: 0 }` 会顶替本进程
  第一次 `ShowWindow`（WinForms 的 `Show()` 正是那次）。修法固定：`Invoke-CardForceShow` 里显式
  `ShowWindow` + `SetWindowPos(SWP_SHOWWINDOW)`，并用 `IsWindowVisible` 量，不靠肉眼。
- **`$PSScriptRoot` 在函数里不可靠**（函数被调用时它可能是调用方的目录）：外壳在每个文件执行时就把它算成
  `$script:CardShellDir`，函数里只用常量。
- **`Set-StrictMode` 会传染**：调用方少了字段就抛异常，异常又常被当成「卡片起不来」。
  协议就用 `PSObject.Properties` 取值、返回对象字段恒定。
- **外壳的通用函数带 `Card` 前缀**（`Initialize-CardNative`、`Invoke-CardForceShow`、`Get-CardPlacement`）：
  曾经叫裸名，dot-source 后静默盖掉插件同名函数，语义还相反。
- **WebView2 用户数据目录默认全局共享**（`%LOCALAPPDATA%\dsh-ui-card\webview2`）：两个插件的弹窗同时在场
  会共用一个 UDF。需要隔离时给 `-DataDir` 各自子目录；默认共享是有意的（同一版本、一份缓存）。
- **出图不归外壳管**：`Show-CardWindow` 没有 `-ShotPath`，验收方自己用 `-OnRendered` 截图
  （`debug/render.ps1` 是范例）。不要为了出图在正式路径里加截图参数。
- **`OnRendered` 里的异常会被吞掉**：调试回调必须自己 `try/catch/finally` 并**无条件关窗**，
  否则窗口会挂到超时（人不在电脑前就是永远挂着）。
- **`NavigateToString` 没有 base URL**：卡片不能引外链资源，产物必须内联（`vite-plugin-singlefile` 保证）。

## 13. 还没做的

- **白底观感与交互仍等人真看**（B-42）：两张图已于 2026-11-16 按当前产物重出
  （`docs/images/card-approval.png` / `card-select.png`），`tests/layout.ps1` 第 7 条与 `BACKLOG.md` R-08
  因此转绿/销账；但截图只证明长相，**样式 / 颜色 / 交互（复制、展开/折叠、按钮位置、滚动）以用户真机点一遍为准**，
  入口是 `tools/preview-card.ps1`（起真窗口、不截图）。
- 卡片描边已定：1px、橙色 `token.colorWarning`（B-26，不再用灰色 `colorBorderSecondary`）；
  剩下的是**白底观感等人真看**。

> 表单卡与确认卡已随 B-47 从外壳里删掉（`-FormFields` / `payload.form` / `CardField` / `Fields` 回传 /
> `?fixture=form` 都不在了，夹具只剩 `approval` 与 `select`），`tests/card-shell.ps1` 里有对应的
> 「不许回退」断言。历史取舍见 `DECISIONS.md` 与 git 历史。
