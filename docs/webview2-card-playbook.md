# 桌面弹窗 playbook：WebView2 + React/antd 单文件产物

> **谁维护**：改外壳或改插件弹窗的人（协调会话 + 常驻文档子会话）。
> **什么时候读**：要做/改任何插件弹窗之前；新插件要接卡片之前；卡片「起不来」「高度不对」时先看 §6。
> 结构与接口细节在 [`shared-ui-card.md`](./shared-ui-card.md)；**两份冲突以代码为准**。

## 1. 现在只有一条渲染路径

所有插件弹窗都是同一张卡：`shared/ui-card/dist/index.html`（Vite 打的 React 18 + antd 5 单文件产物）
由 `webview2.ps1` 装进 WebView2 窗口。**PowerShell 只产出 payload JSON，不拼 DOM、不写样式。**

- 不需要再判断「用哪条路径」：没有第二套界面，**也没有退化卡**；
- 起不来就如实报错（stderr / error 结果 + 非零退出），由调用方决定怎么收场：
  审批插件退回浏览器审批（宿主既有能力），ssh 让命令失败、人重试；
- 三条铁律来自 `AGENTS.md` §0/§4：**一张卡一个渲染源**、**改 UI = 改源码 + 构建 + 提交产物**、
  **通用能力引库**（antd 的组件与 token，自己写的只留业务）。

依赖（都在 `app/package.json` 里，`app/node_modules` 已就位）：`antd ^5.21`、`react ^18.3`、
`vite ^5.4`、`vite-plugin-singlefile ^2.0`、`typescript ^5.6`、`shiki ^4.5`（代码高亮，见 §9）。
**除 Shiki 外别再加强依赖**（UI / 样式 / 高亮都一样），`tests/card-shell.ps1` 有白名单断言。

## 2. 分层

| 层 | 在哪 | 只干这些 |
| :--- | :--- | :--- |
| 业务数据 + 业务映射 | 插件 `scripts/ui/shared.ps1` | 载荷 → `New-CardPayload`；页面消息 → 业务结果 |
| 弹一次卡 | 插件 `scripts/ui/card.ps1` | 调 `Show-CardWindow`，把返回值换成调用方要的形状 |
| 入口 | 插件 `scripts/*.ps1`（`prompt.ps1` / `dialog.ps1`） | 参数、文件协议、STA 重拉、退出码 |
| 载荷与文档拼装 | 外壳 `card-html.ps1` | `New-CardPayload`、`New-CardDocument` |
| 窗口与协议 | 外壳 `webview2.ps1` + `webview2-runtime.ps1` | 建窗、两阶段量高、收消息、DLL/环境 |
| 渲染 | 外壳 `app/src` | 结构、样式、交互、消息（**唯一一处写视觉的地方**） |

只允许上层调下层；跨语言只走协议（`postMessage` / JSON 文件 / 退出码 / `-OutFile`）。
单个 `.ps1` 别过 400 行，过了就是混了职责（外壳自己也在拆：`webview2-runtime.ps1` 就是这么拆出去的）。

## 3. 新插件接入清单

1. 外壳只有一份，在仓库根 `shared/ui-card/`。**不要拷进插件**（`tests/shared-ui-guard.ps1` 会判失败）；
2. 写 `scripts/ui/shared.ps1`：从 `$PSScriptRoot` 上溯最多 6 层找 `shared\ui-card`
   （签名是两个文件同时在：`card-html.ps1` + `webview2.ps1`）；找到就 dot-source 这两个，
   找不到就返回空串、抛一条能照着修的错误；
3. 业务只写 `New-*Payload`（数据 → `New-CardPayload`）与 `ConvertTo-*Decision`（消息 → 结果）；
4. 写 `scripts/ui/card.ps1`：调 `Show-CardWindow -Html (New-CardDocument -Payload $p) …`，
   把返回值翻成调用方要的形状；`failed` 时把 `Error` 抛出去，**不要伪造答案**；
5. **卡片里没有输入区**：外壳只有两种卡——勾选卡（`rows`）与审批卡（`body` + 两个按钮），表单卡与确认卡
   已随 B-47 删除。需要用户填表（加主机、改密码这类）就放进插件的**网页设置页**，别往卡片里加控件
   （ssh 就是这么做的：维护全部走设置页「SSH 主机」）；
6. 窗口参数只用几个默认值：宽度 680（默认值，别自己写数字）、`-CornerRadius 0`（方形）、
   `-Position corner`；限高用 `Get-CardMaxHeight` 算一次，别自己写数字；
7. 退出码沿用既有契约：`0` = 有答案、`2` = 取消/关窗/到点、其它非零 = 起不来或输入文件有问题；
8. 抄一份插件侧 `tests/card-select.ps1`，把「载荷结构 + 结果映射 + 假窗口端到端」的断言换成自己那份
   （不建窗口，秒级，可离线跑）；
9. 要发 npm 包时，`files` 需要带上 `shared/` 与仓库根 `vendor/`；本机 junction 安装不受影响。

## 4. 协议与高度（要点）

- 页面 → 宿主：`ready{height}`（measure 阶段一次）、`resize{height}`（只 measure 阶段）、
  `decision{value,checked?}` / `cancel` / `expired`（终态只发一次）；
- 宿主 → 页面：`shown`；
- 高度两阶段：页面按真实宽度布局完后报 `ready` → 宿主钳到 `[160, min(760, 62% 工作区)]` →
  `SetWindowPos` → `ShowWindow` → `shown` → 页面切 `fill`（主体滚动、页脚钉住）；
- `ready` 超时 2 秒按 360 高显示，不阻塞；宿主侧的 `-TimeoutMs` 只是兜底。
- **高度由页面报给宿主，宿主不再自己量 DOM**（不再有 `ExecuteScriptAsync` / CDP 量高）。

完整字段与参数表见 [`shared-ui-card.md`](./shared-ui-card.md) §4–§7。

## 5. 尺寸与滚动

- 上限 `min(760, 62% 工作区高)`、下限 `160`：短卡贴内容，长卡才内部滚动（1080p 上约 669）；
- 三段式：头（抬头 + 首行路径/主机标签）固定、中间内容滚动、页脚（状态行 + 按钮）固定；
- 滚动条是 WebView2 原生细滚动条（`styles.css` 里 8px、半透明墨色，hover 加深），**不引悬浮滚动条库**；
- 不要翻页器；整卡也**没有「收起」**——只有代码框自己可折叠（B-28，见 §11），一次仍然只问一件事，
  窗口跟着内容变高。
- 只被钳矮时才滚动：窗口高度小于内容高度时，主体区滚动，`✕` 与页脚始终可达。

## 6. 坑（都踩过，按疼的程度排序）

1. **首次 `Show` 被 `SW_HIDE` 顶掉**：宿主 `spawn` 子进程带 `STARTUPINFO{ dwFlags: 257, wShowWindow: 0 }`，
   Windows 会拿它顶替本进程**第一次** `ShowWindow` 的参数（WinForms 的 `Show()` 正是那一次）。
   修法在外壳里且只有一份：`Invoke-CardForceShow` 显式 `ShowWindow` + `SetWindowPos(SWP_SHOWWINDOW)`，
   然后用 `IsWindowVisible` 量出来，不靠肉眼。
2. **payload 占位符只能按标签替换**：`<script id="dsh-payload">` 内部才是载荷；
   打包后的 JS 里也可能出现同一个字符串，整串 `Replace` 会把 JS 改坏（症状：白页）。
   `New-CardDocument` 用正则定位并要求恰好命中一个。
3. **`Set-StrictMode` 会把「读不到属性」变成「再弹一次框」**：`Show-CardWindow` 的返回对象**字段恒定**；
   调用方「答案落盘 + 退出码」放在 `try` 外面——用户答过就绝不能再问第二次。
4. **不要在 UI 线程同步等异步调用**（`ExecuteScriptAsync(...).GetAwaiter().GetResult()` 会互锁）：
   一律 `DoEvents()` 轮询 + 超时收口，否则窗口能画出来却点不动、关不掉。
5. **不能用 `documentElement.scrollHeight` 量高度**：它最小等于视口高度，先按大窗建就会量满。
   现在是页面报 `#root` 的 `getBoundingClientRect().height`，宿主只钳不量。
6. **载荷里不留输入值**：表单卡与确认卡已随 B-47 从外壳删除（没有输入区、没有 `Fields` 回传），这条只作历史
   ——**别再把输入控件加回卡片**：要填表就放插件的网页设置页。
7. **进程/环境**：WebView2 控制器在受限令牌下必然失败（`0x8000FFFF`），出图与真机验证要提权，
   攒成一批一次跑完；调试脚本另起进程必须 `-WindowStyle Hidden`（本机终端是 Windows Terminal，会闪窗）。
8. **UDF 共享**：WebView2 用户目录默认 `%LOCALAPPDATA%\dsh-ui-card\webview2`，两个插件的弹窗同时在场
   共用一个；要隔离就传 `-DataDir`。

## 7. 验证（不用盯屏幕）

```powershell
# 1) 纯逻辑：外壳 + 守卫 + 偏好载体（秒级，不开窗口、不提权）
pwsh -NoProfile -File tests\card-shell.ps1
pwsh -NoProfile -File tests\shared-ui-guard.ps1
pwsh -NoProfile -File tests\preferences.ps1
# 高亮配色行为：真跑 highlight.ts（借 node 直接 import .ts，需 node ≥ 22.18 与 app/node_modules）
& tests\card-tokens.ps1

# 2) 插件适配层（不弹窗：载荷结构、结果映射、假窗口端到端）
pwsh -NoProfile -File dsh-approval-notifier\tests\card-select.ps1
pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1

# 3) 出图 + 几何（要提权：受限令牌下 WebView2 起不来）；临时图落 .session-files\tmp\
pwsh -NoProfile -STA -File shared\ui-card\debug\render.ps1 `
  -Payload tests\fixtures\approval.json -OutFile .session-files\tmp\approval.png -Mode screen -ScreenMargin 20
pwsh -NoProfile -File tests\card-geometry.ps1 -Measure .session-files\tmp\approval.measure.json
pwsh -NoProfile -File tests\card-border.ps1 -Png .session-files\tmp\approval.png -WindowRect '20,20,680,267'
# 正式图只进 docs\images\（每次发版重出，tests\layout.ps1 第 7 条守）

# 4) 落笔字体（问渲染引擎，不看 CSS）
& dsh-approval-notifier\tests\card-font.ps1
```

成品验收必须由**人**真弹一次并点一遍（勾选、提交、跳过/✕、滚到底）。
能用断言量的（可见性、宽度、颜色、几何、字体）就别用眼睛看；截图只用来给人看长相。
**禁止脚本注入鼠标点击**。

## 8. 设计原则：统一语言，不追求像素一致

网页端那张卡是**设计基准**，不是像素模板：

- 抬头放**工作目录 / 主机标签**（一眼看出哪个项目、哪台机器在问），不是一句通用说明；
- 命令块**默认换行**：审批要看全命令，不能一开始就藏掉半行；
- 卡片层级＝**露脸 + 让位**两段（D-41 / D-43）：① 建窗时 `CreateParams.ExStyle |= WS_EX_TOPMOST`（`New-CardForm`）——事后 `SetWindowPos(HWND_TOPMOST)` 在非前台进程里返回 True 但**不落位**（`exstyle` 停在 `0x50000`）；② 装 `WH_MOUSE_LL` 钩子，**用户首次按在卡片窗口之外**时卡片自己 `SetWindowPos(HWND_NOTOPMOST, …, 0x0013)` 降层并卸钩。**不要**用定时降层（用户还没看完就被盖住），也不要监听前台窗口变化（卡片从不获得前台，事件不会触发）。`SHOWNOACTIVATE` 保持不变，全程不抢焦点。
- 窗口先在屏幕外量好再显示，不会先露一条矮缝再蹦高；
- 没有翻页器、没有整卡「收起」（可折叠的只有代码框，见 §11）；
- 图标、间距、配色与网页端同源（antd），**不逐像素对齐**。

## 9. 字体与样式来源

- **整卡字体是用户定的「等距更纱黑体 SC」**（英文名 Sarasa Mono SC），正文与代码都用它，
  **中文族名排第一**（GDI 只认中文名，写英文名会静默回退）；
- 只有一个地方设字体：`app/src/main.tsx` 里 antd 的 `fontFamily` / `fontFamilyCode`，
  加 `app/src/styles.css` 的 `body` 栈（antd token 只作用到组件，body 这一层要自己声明）；
  **不要逐个元素写 `font-family`**，也不要想当然去改「令牌文件」——现在没有那层东西；
- 证明「真的用了这款字体」不能看 CSS 栈：`getComputedStyle` 只回你写的栈，`document.fonts.check`
  只证明字体可用。要问渲染引擎：CDP `DOM.getDocument` → `DOM.querySelector` →
  `CSS.getPlatformFontsForNode`，返回的 `familyName` + `glyphCount` 才是实际画字的字体
  （Chromium 报英文名 `Sarasa Mono SC`，断言要认两个名字）。
- 字重按「字面」核对：`font-weight: 500` 在这款字上会落到 SemiBold，中文看着发粗；要「不粗」就给 400；
- 样式只写在 `app/src`：布局用 antd 的 `Flex` / `Typography` 与 token，`styles.css` 只留四件事
  （两阶段高度契约、细滚动条、去焦点环、代码框右上按钮的 hover 显隐）——它越长越说明没在用库；
- 代码高亮由 **Shiki** 提供（`app/src/highlight.ts`，K-012 / B-10）：跑 **JS 正则引擎**
  （`createJavaScriptRegexEngine`，不装 oniguruma、产物里没有 wasm），只带 `shellscript` + `powershell`
  两种语法（按子路径引；引 `shiki` 根入口会把全部语法与主题带进单文件）；主题走 `css-variables`，
  卡片根节点上给 13 个 `--shiki-*` 语义变量赋值（`foreground` + 12 个 `token-*`），其中注释/字符串/
  关键字/常量/函数/正文指 **IDEA Light 调色板**（B-30：`#8C8C8C` / `#067D17` / `#0033B3` /
  `#1750EB` / `#00627A` / `#000000`），不再「跟随界面色」；`inserted`/`deleted`/`changed` 仍走 antd token，
  `--shiki-background` 不给（底色归代码框）。认不出 `lang` 或高亮失败一律退纯文本（命令原文不改）。
  高亮同步完成、只改颜色，所以 measure 量高时已经定格、后面不会再折行或变高。
  **桶是粗粒度前缀匹配**（`string` 会把 `string.unquoted.*` 的裸参数涂绿）的坑与修法见
  [`shared-ui-card.md`](./shared-ui-card.md) §4。

## 10. 参考实现

- `dsh-approval-notifier/`：审批卡。多出来的两件事——**防误点与自动关闭的计时必须从「窗口真的可见」
  开始**（`shown` 之后），以及「起不来就退回浏览器审批」的收尾；
- `dsh-ssh-remote/`：**勾选卡**（`-Mode select`：`ssh_run` / `ssh_copy` 的勾选就是审批，B-47；确认卡与表单卡
  已随 B-47 删除，维护改在设置页）。可参考的是**行即单位**
  （勾选框 + 主机一行，下面代码框里原因作首行注释、然后是命令、框底附注条放 cwd/超时；
  行间靠留白分块、没有分隔线，下标即回传顺序）与「一行不勾就不许提交」；搬运卡演示了 `row.lang`（`Source:` / `Target:`
  说明文字给 `lang: 'text'`，不按 shell 高亮）。

改完记得回填：[`shared-ui-card.md`](./shared-ui-card.md)（结构/接口变了时）、
`shared/ui-card/DECISIONS.md`（做了非显然选择或否掉了方案时）、插件 `README.md`（用法变了时）。

## 11. 代码框的三件小事（折叠 / 复制 / 悬停按钮）

正文的 `code` 块与勾选行的行内命令框是**同一份实现**（`App.tsx` + `CodeTools.tsx`），两张卡共用：

- **折叠（B-28）**：默认**折行**，按 **6 行**限高裁掉多余部分（`FOLD_LINES = 6`；行高钉成 20px 整数，
  否则第 7 行会露半行）。**不许用 `line-clamp` / `text-overflow`**——那会画省略号。展开后**不折行**，
  纵向 + 横向都能滚（`overflow: auto`），上限是正文可视区高度；**卡片高度不变**，展开只在框内滚动。
  「复制 / 展开」两个按钮**恒显**（用户 2026-11-10：「默认都显示 简单处理 又不影响功能」）；溢出与否只决定第一次点「展开」要不要定高——没溢出的短框展开后仍按内容自适应，绝不撑成空框（T-09）。
- **复制（B-32）**：剪贴板里只放**命令本体**。框内第一行的说明（`CodeBlock.comment`、行内 `row.why`；注释色、不拼 `#`，D-40）
  与命令自带的整行注释都由 `commandOnly()` 去掉（行首 `#`，含缩进）；行内注释（`cmd --x  # 备注`）
  **不动**——那是 shell 语义的一部分，删了会改命令。走 `navigator.clipboard`，成功只给 1.2s 对勾，
  失败静默（C-07 不为可重试的小事加 UI）。
- **按钮（B-29）**：每个代码框各自一套「复制 / 展开·收起」，`position: absolute` 钉在右上角
  （`top: 2px; right: 4px`），默认 `opacity: 0` + `pointer-events: none`，鼠标进到框内才显形，
  120ms 淡入；**不占布局**，所以卡片高度与 measure 结果一个像素都不变，藏起来时也点不到。
  按钮上的点击 `stopPropagation()`，不许在多选卡里冒泡成一次勾选。

复验：`tests/card-shell.ps1` 查源码/结构（折叠常量、没有 line-clamp、`commandOnly` 只用在复制文本上、
CSS 的 absolute/opacity/pointer-events/hover 规则）；`tests/card-tokens.ps1` 真跑高亮、查配色归属。

## 12. 产物零外链（构建后自检）

`NavigateToString` 没有 base URL：产物里任何指向外部的引用都会**静默失效**（白页、缺样式、缺字体），
所以构建完必须自己查一遍，下面每一项都应为 **0**：

| 查什么 | 表达式（`$html` = `shared/ui-card/dist/index.html` 全文） |
| :--- | :--- |
| `<script src>` | `([regex]::Matches($html, '(?i)<script[^>]+src=')).Count` |
| `<link href>` | `([regex]::Matches($html, '(?i)<link[^>]+href=')).Count` |
| `<a href>` | `([regex]::Matches($html, '(?i)<a[^>]+href=')).Count` |
| `<img src>` | `([regex]::Matches($html, '(?i)<img[^>]+src=')).Count` |
| `WebAssembly` | `([regex]::Matches($html, 'WebAssembly')).Count` |
| `onig.wasm`（wasm 加载器） | `([regex]::Matches($html, '(?i)onig\.wasm')).Count` |
| `.wasm` 扩展名 | `([regex]::Matches($html, '(?i)\.wasm\b')).Count` |
| 动态 `import(`（外部分包） | `([regex]::Matches($html, 'import\(')).Count` |

```powershell
$html = Get-Content -Raw shared\ui-card\dist\index.html
([regex]::Matches($html, '(?i)<link')).Count     # 0：没有任何 <link>
([regex]::Matches($html, 'src="/')).Count        # 0：没有根绝对路径的资源
```

**2026-11-16 重建（B-47 删掉表单卡与确认卡后）的实测**（`dist/index.html` **705,961 字节** ≈ 690 KB；
2026-11-02 那份还带表单卡的是 728,537 字节，2026-10-29 接完 Shiki 时是 722,712 字节）：

- 上表全部 **0**；产物里真实的标签只有三个——`<script type="module">`（全部 JS）、
  `<style rel="stylesheet">`（全部 CSS；单文件插件把 `rel` 写在 `<style>` 上，**不是** `<link>`）、
  `<script id="dsh-payload" type="application/json">`（载荷占位）；
- 打包 JS 的**字符串**里另有 `"<script"` 与 `"<style "` 各一处（React/antd 的 DOM 构造代码），
  它们不是标签——**别靠数 `<script` 出现次数下判断**，要判带属性的形式（`<script src=`）；
- 裸 `src=` 全篇只有 **1** 处，在打包进来的 React 源码里（`case "img": … n.src = l.src`），
  **不在**任何 HTML 标签属性上；
- 产物里有 **5 处 `Oniguruma`** 字样，来自 JS 正则引擎的**报错文案**（`oniguruma-to-es` 的
  「Quantifier value unsupported in Oniguruma」等），不是 oniguruma 引擎，也没有 wasm；
  同理按大小写不敏感搜 `.wasm` 会命中 React 的 `wasMultiple`——判外链要判 `onig.wasm` / `.wasm` 扩展名；
- Vite 的 modulepreload polyfill 里还有 3 处 `modulepreload` 字样与一处 `fetch(o.href, …)`，
  但产物里 `<link` 是 **0**，这段永远不会触发。

**注意字节数 vs 字符数**：`(Get-Content -Raw).Length` 是**字符数**（704,051），
`Get-Item`.Length 才是**字节数**（705,961，UTF-8 中文占多字节）。文档里统一写字节数。
