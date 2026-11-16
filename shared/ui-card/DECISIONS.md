# 卡片外壳的决议记录

这里只写**为什么这么做**，不写怎么改代码。规则：非平凡改动先走
「现象 → 算不算问题 → 根因 → 候选方案与代价 → 结论 → 复验」，结论落到本文件。

> 历史证据路径：本文里的 `out/*.png`、`out/*.measure.json`、`out/refs/*`、`out/palettes.html` 是 2026-11-02 之前的
> 临时出图落点，该目录已删除。临时产物改落 `.session-files\tmp\`，正式截图统一进 `docs\images\`（`docs/repo-layout.md` §4）。

下次要改这部分之前先读一遍，尤其看「被否掉的方案」——那些是已经付过代价的。

---

## D-01 渲染源：React + antd 产物是唯一渲染源

- **现象**：PowerShell 用字符串拼 HTML 生成卡片，样式要手抄一遍网页端，代码 600+ 行且改一处崩一处。
- **判定**：是问题。维护成本落在自己身上，且拼 HTML 无法复用成熟组件。
- **根因**：渲染与业务逻辑混在 PS 里，PS 同时当模板引擎和宿主。
- **候选**：① 继续拼字符串 + 引 Tailwind/daisyUI 类名（PS 仍要拼 DOM）；② 引 React + 组件库，PS 只出 payload。
- **结论**：②。**一张卡只能有一个渲染来源**（AGENTS.md §0），PS 拼一半、JS 渲染一半是不一致的根源。
- **被否**：① 的问题不是库不好，而是「PS 还在生成 DOM」，库只用到贴类名这一步，逻辑仍散在 PS。
- **复验**：`tests/card-shell.ps1` 断言产物内联、无外链；插件目录零副本（`tests/shared-ui-guard.ps1`）。

## D-02 构建：Vite 打成单文件 HTML，产物入库

- **现象**：React 需要构建，而运行路径是 WebView2 直接加载 HTML，没有 node。
- **判定**：不是问题，前提是产物入库。
- **根因**：运行时零构建 + 开发时可构建，两者能并存，只要产物是仓库文件。
- **候选**：① 运行时起 dev server；② 产物入库，PS 直接读 `dist/index.html`；③ CDN 外链。
- **结论**：②（`vite-plugin-singlefile`，约 485 KB）。③ 离线不可用；① 运行时要多一个进程。
- **复验**：`npm run build` 输出单文件；`card-shell.ps1` 断言含内联 module、无 `src="/`、无 `<link rel="stylesheet"`。
- **坑**：占位符 `__DSH_PAYLOAD__` 在打包后的 JS 里也会出现，**必须按标签定位替换**，整串 Replace 会把 JSON 塞进 JS（症状：白页）。

## D-03 高度：卡片贴着内容，两阶段 measure → fill

- **现象**：短卡（密码、确认）留一大片空白；长卡出现原生滚动条还裁掉最后一行。
- **判定**：是问题。空白来自旧固定尺寸时代的 420 地板；裁行来自「`max-height: 62vh` 与内容量高互相打架」。
- **根因**：一阶段协议——宿主一边量高、页面一边按视口收口，两边都以为自己是裁判。
- **候选**：① 保留 420 地板、页脚钉底；② 宿主量到内容高后严格贴合，只有超过屏高 62% 才内部滚动。
- **结论**：②，两阶段：页面 `data-phase=measure` 报 `ready{height}` → 宿主钳到 `[160,760]` ∧ 屏高 62% → `shown` → 页面切 `fill`（`height:100%` + 主体区滚动 + 页脚钉住）。
- **被否**：① 的空白不是设计，是约束没跟内容走。
- **复验**：`out/*.measure.json` 的 `contentHeight` 与 `windowBounds` 高度一致；`card-geometry.ps1` 8 项。

## D-04 行结构：一行 = 标签 + 原因 + 命令 + 元信息

- **现象**：某版把命令提到正文的代码块里、勾选框只剩主机名，读起来是「三条命令 + 三个勾选框」，看不出哪条命令属于哪台机器。
- **判定**：是问题，属信息结构错误，不是样式问题。
- **根因**：我给子智能体的指令写错了（「原因进代码块抬头」），测试又跟着断言「命令块与行一一对应」，等于把错误固化。
- **候选**：① 命令放正文 code 块，行只留标签（错误方案）；② 命令留在行里，行即单位。
- **结论**：②。`New-CardRow -Label -Why -Text -Meta`，正文只在「没有 Rows」时放一个 Detail 代码块。
- **被否**：① 会导致下标回传与视觉对应错位。
- **复验**：`dsh-ssh-remote/tests/card-select.ps1` 断言正文无代码块、每行同时有 why 与 text。

## D-05 焦点与键盘：全程鼠标，不要焦点环

- **现象**：✕ 按钮上出现黑框，我先改成蓝色描边、再改成柔光。
- **判定**：**不是「焦点环难看」的问题**，是「这张卡根本不该有焦点」。
- **根因**：窗口激活时浏览器把焦点落到第一个可聚焦元素；而卡片的使用方式是纯鼠标。
- **候选**：① 美化焦点环（被否）；② `tabIndex={-1}` + 全局 `outline:none` + 挂载后 `blur()`。
- **结论**：②。审批卡另加 `keyboard:'none'`（整页拦键盘），ssh 卡保留 Esc=取消、Enter=主按钮。
- **被否**：① 只在「用户会用键盘」时才有意义，为不存在的场景调样式是净负债。
- **复验**：离屏图 ✕ 无描边；`card-shell.ps1` 断言 `tabIndex={-1}` 与 `:focus` 规则。

## D-06 样式来源：antd 组件 + token，CSS 只留三件事

- **现象**：说好「用库的默认样式」，`styles.css` 却写到 242 行自定义规则。
- **判定**：是问题，而且自相矛盾——文件越长，越说明没在用库。
- **根因**：把「布局」当成需要手写 CSS 的事；实际 antd 的 `Flex`/`Space`/`Typography` + token 已能表达。
- **候选**：① 继续在 CSS 里补规则（被否）；② 布局改用 antd 组件与内联 token 样式，CSS 只留 antd 表达不了的部分。
- **结论**：②。CSS 只剩：两阶段高度契约、细滚动条、去焦点环（约 55 行）。
- **被否**：① 会回到「自己写样式库」的老路。
- **复验**：`styles.css` 行数与规则清单；离屏图与 antd 默认视觉一致。

---

## D-07 守卫只扫代码，不扫文档

- **现象**：新增 `DECISIONS.md` 后，`shared-ui-guard.ps1` 报「外壳源码里出现插件专有词（ssh / 审批 / 勾选）」。
- **判定**：不是问题，是**守卫范围过宽**。它要防的是「外壳代码认识某个插件」，不是「文档解释决策」。
- **根因**：扫描清单里带了 `.md`；此前 `shared/ui-card/` 没有任何 markdown，所以这条从没触发过。
- **候选**：① 文档里用代称避开 ssh/审批/勾选（被否：讲不清「为什么」）；② 扫描清单去掉 `.md`。
- **结论**：②。守卫继续覆盖 `.ps1/.ts/.tsx/.css/.html/.json`，文档豁免。
- **复验**：`tests/shared-ui-guard.ps1` 10/10。

---

## D-08 改样式的顺序：布局 → 粗样式 → 字体 → 细节

- **现象**：这一轮我在焦点环、1px 描边、命令换行之间来回改，每改一处都引出新问题（焦点环美化 → 又被否 → 改柔光 → 又改 tabIndex）。
- **判定**：是问题，而且是我这个改法造成的——**细节在整体没定时都是伪问题**。
- **根因**：没有固定的推进顺序，看到哪不对就改哪；每次返工都没留下「当时为什么」。
- **结论**（用户定）：① 基础布局（结构、分区、页脚位置）→ ② 少量样式（粗细、间距、边界）→
  ③ 字体（正文无衬线、代码等宽、落笔字体实测）→ 有「大概」→ ④ 才细化细节。
- **落地**：`AGENTS.md` §4 写入同一条；字体这一关用 `dsh-approval-notifier/tests/card-font.ps1` 实测落笔字体（当前是等距更纱黑体 SC，见 `PREFERENCES.md` B-02），不靠眼睛看。
- **复验**：任何一次 UI 改动，先说明当前处在第几步、这一步的判断标准是什么。

---

## D-10 实现选择（不是用户偏好，别混进 PREFERENCES.md）

用户要的是「高度合适、不过高、三段式（头固定 / 中间滚动 / 尾固定）」；下面这些数字是我选的实现：

- 上限 = `min(760, 62% 工作区高)`，下限 = `160`。用户没有指定数值；62% 与 760 是为了不让卡占满屏，
  160 是为了不让单行卡看起来像条缝。
- 审批卡 `keyboard:'none'`、ssh 卡不绑快捷键：用户的偏好只有「审批卡别被键盘误批」，ssh 卡的行为
  没有表态，保留默认（不绑）是我选的。
- 「测试是合并门槛」写在 `AGENTS.md` §0/§3，是我的工程要求，不是用户原话。

**规则**：`PREFERENCES.md` 只收用户说过的话。我的选择写这里，改了要说明改的原因。

---

## D-11 偏好表的结构：用户原话 vs 我的推断

- **现象**：第一版 `PREFERENCES.md` 里混进了我自己加的条目（高度数值、ssh 键盘、测试门槛、锯齿），
  用户逐条指出「没说过 / 这是我自己的要求 / 没头没尾」。
- **判定**：是问题，而且是结构性的——表一旦失真，以后按表做事就会做错方向。
- **根因**：我把「实现里做了什么」当成「用户要求了什么」记录，且没有区分标注。
- **结论**：表里只写用户要什么；每条必须能指到用户原话（K-xxx 或日期 + 引号内的原话片段）。
  推断出来的、我优化过的写法要标「按经验细化」，并保留用户原话作依据。
- **复验**：新增条目时先问「这句是用户说的，还是我想的」；想的一律进 DECISIONS。

---

## D-12 文档跟代码走：docs 改成「React 产物 + payload」这一套

- **现象**：`docs/shared-ui-card.md`、`docs/webview2-card-playbook.md` 与两个插件 README 还在讲
  `card.html` + `dsh-card.css` + `dsh-tokens.css`（外加 OverlayScrollbars、highlight.js、420–760 的旧钳制），
  与合并后的实现对不上。
- **判定**：是债，不是文风问题——文档是「怎么改」的入口，写错会把人指向已经不存在的文件。
- **根因**：ui-react 合并只改了代码，文档没跟；旧文档描述的是「PS 拼 HTML」时代的分层。
- **候选**：① 旧描述留着 + 补一段「现在不一样了」（被否：两套互相矛盾的说法，下次还得靠人判断哪段算数）；
  ② 按当前代码重写，历史留给本文件与 git。
- **结论**：②。依据只有四条：**渲染源只有** `shared/ui-card/dist/index.html`；**PowerShell 只产 payload JSON**；
  整卡字体是**等距更纱黑体 SC**（antd token + `body` 栈）；高度是**两阶段 + 三段式**（160–760 / 屏高 62%，见 D-03/D-10）。
- **被否**：继续维护 `card.html` + 两套 CSS 的描述——那些文件已经删了，写下去等于把不存在的东西当规范。
- **复验**：`tests/preferences.ps1` 30/30、`tests/shared-ui-guard.ps1` 10/10；两份 docs 与两个 README 里搜不到
  `card.html` / `dsh-card.css` / `dsh-tokens.css` / `OverlayScrollbars` / `highlight.js` / `daisyUI`；
  `AntdUI` 只允许出现在「它已被删除」这类说明里（见 D-13）。

---

## D-13 「没有 AntdUI 引用」只扫产品代码，不扫 README

- **现象**：两个插件的 `tests/card-select.ps1` 把 `README.md` 也放进扫描集，且 `Select-String -SimpleMatch`
  大小写不敏感——README 里写一句「AntdUI 那套自绘卡已删除」就会 FAIL，于是文档只能说「旧的自绘卡连同它的控件库」。
- **判定**：是断言写宽了，不是文档写错。偏好 B-01 的原话是**产品代码**里没有 AntdUI 引用；
  文档的责任恰恰是写清「删了什么、为什么删」，否则后来的人不知道被替换的是什么。
- **根因**：断言从「不许再引用旧库」滑成「不许提旧库的名字」，两个插件的扫描集都带上了 `README.md`。
- **候选**：① 保持断言，文档用绕弯说法（被否：等于用测试约束表达力，下次还会踩）；
  ② 扫描集去掉 `README.md`，只在 `scripts/`、`index.js`、`package.json`、`lib/*.mjs` 上守（采纳）。
- **结论**：②。`tests/` 与 `README.md` 都不在扫描集内——前者是断言本身，后者是文档。
- **复验**：`dsh-approval-notifier/tests/card-select.ps1`、`dsh-ssh-remote/tests/card-select.ps1` 全绿；
  `tests/preferences.ps1` 的 B-01 本来就只扫产品代码，口径由此统一。
- **遗留**：README 现在可以、也应该点名「AntdUI」，由文档子会话改回明确表述。

---

## D-14 行距用分隔线代替，行内命令自带底色（B-11 / B-12）

- **现象**：① 选项行之间实测约 33px，而行内几行文字只隔 7–8px，读起来是「几块独立卡片」而不是「一组选项」；
  ② 行里的命令与正文同为白底等宽字，看不出「这是一条要执行的命令」。
- **判定**：两条都是问题。判据就是用户那两句话——B-11「行距要明显小于行内几行文字的间距」、
  B-12「整块命令（含选项行里的那一行）都要有区别于正文的底色」。
- **根因**：
  - ① 内容容器 `gap={10}` 逐行累加，行自己又带 `padding: 8px`，上下合计 18px，再叠上行内行距；
    每行被当成一张独立卡片来排，自然「散」。
  - ② 行里的命令走的是普通 `<Text>`，只换了等宽字体、没有任何背景；而正文的 `code` 块早就有
    `colorFillTertiary`。同一条命令在两处长得不一样，正是「代码区域没有背景区分」的来源。
- **候选**：① 保留 `gap`、只压行内 `padding`（被否）；② 行容器 `gap` 归零 + 除第一行外描上分隔线（采纳）；
  ③ 行之间用 `margin` 造 1px 间隔（被否，与 ② 等价却多一处手写值）。
- **结论**：②。
  - 行容器：`gap` **10 → 0**；行 `padding` 保持 `'8px 10px'`（有分隔线后 8px 上下正好，不改成 4px）。
  - 分隔线：`borderTop: '1px solid ' + token.colorSplit`，**只在 index > 0 时加**；颜色走 token，不写死色值。
  - 行内命令：`display: 'block'`、`background: token.colorFillTertiary`、`padding: '4px 8px'`、
    `borderRadius: token.borderRadius`；字体仍是 `token.fontFamilyCode`，换行仍是 `pre-wrap` + `overflowWrap: 'anywhere'`。
  - 「选中」底色：`token.colorFillTertiary` → **`token.colorPrimaryBg`**。
    理由：命令块已经是灰底（`colorFillTertiary`），选中用同一个灰就分不出「选中了」与「这是命令」；
    同灰阶更深的 `colorFillSecondary` 只差一档明度，仍然糊。`colorPrimaryBg` 是主色浅调（默认 #E6F4FF，
    与灰底的 #F5F5F5 色相不同），两件事一眼分得开，同时仍是浅底，不抢正文。
  - 行的交互一字未动：整条 `Flex` 仍然 `onClick`、`cursor: 'pointer'`、`borderRadius: token.borderRadius`。
- **被否的方案**：
  - 「保留 `gap` 10，只把行 `padding` 压到 4px」：① B-11 要的是「行距 < 行内间距」，压 padding 会先撞上行内间距，
    改到头还是分不开；② 用户说的「太散」主要来自行与行之间那一整段空白，不是行内留白；
    ③ 还会让 label / why / 命令 / meta 贴在一起，把可读性换成分隔感。
  - 「用 `margin-bottom` 或 `Space size` 表达间隔」：只是同一个间距换个写法，没有解决「一行是一个单位」。
  - 「选中底继续用灰，改去给命令块换色」：命令是内容、选中是状态；状态该用主色系、内容块该用中性灰。
    反过来会让普通命令长得像高亮，故选中的一侧换色。
- **实现补充（为什么多包一层 `Flex`）**：正文块（note / code）与行原本是同一个 `gap={10}` 容器的兄弟节点。
  若直接把这个容器归零，「正文块之间」「正文与行之间」的间距会一起被吃掉，而分隔线只加在行上，
  正文与第一行之间就彻底没有区隔。所以行单独包一层 `<Flex vertical gap={0}>`，外层容器继续用 `gap={10}` 管正文块。
- **复验**：
  - 源码：`App.tsx` 里行容器 `gap={0}`、`borderTop` 用 `token.colorSplit`、行内命令 `background: token.colorFillTertiary`、
    选中 `token.colorPrimaryBg`；字体、字号、圆角默认值均未改动；
  - 守卫：`tests/preferences.ps1` 30/30、`tests/shared-ui-guard.ps1` 10/10、`tests/card-shell.ps1` 39/39；
  - 视觉：离屏出图的 select 卡应有——行距接近行内行距、行间一条 1px 分隔线、命令块底色 ≠ 白、
    选中行底色偏蓝灰而非灰；改前/改后各一张。

---

## D-15 抬头统一成「域 · 动作」两段（B-13，含断言变更说明）

- **现象**：四张卡的小标题风格不一致——审批卡是「工具名 · 提权审批」（两段、中间一个中点），
  而 ssh 的三张是「SSH 执行确认」「SSH 操作确认」「连接凭据」，前两张中点都没有，
  密码卡连「发起方」都没有（只有动作的旧叫法）。用户原话：「抬头风格 可以统一一下吗 xxx · xxxx」。
- **判定**：是问题，且是**用户已经拍板的偏好**（`PREFERENCES.md` B-13），不是我自己想改的文案。
- **根因**：抬头是各业务自己拼好的一整串字符串交给外壳的（外壳不认识业务，这本身是对的），
  但从来没人定义过这串字的格式，于是每个调用点各写各的。
- **候选**：
  - ① 只改文案、不定义格式：这次对上了，下次新增卡片还会歪。
  - ② 统一成「域 · 动作」两段：左段是发起方（工具名或 `SSH`），右段是这张卡要你做什么（采纳）。
  - ③ 在外壳里做抬头拼装（外壳收 `domain` + `action` 两个字段）：被否，见下。
- **结论**：②。四张卡最终值——审批 `<工具名> · 提权审批`（本来就对，未动）、
  选项卡 `SSH · 执行确认`、确认卡 `SSH · 操作确认`、密码卡 `SSH · 输入密码`。
  分隔符沿用审批卡那个字符（U+00B7 中点，前后各一个半角空格），不新造第三种写法。
  **格式仍然是「业务给整串、外壳只负责显示」**：外壳依旧不认识 ssh / 审批，
  `tests/shared-ui-guard.ps1` 第 3 条继续守这条边界。
- **被否的方案**：
  - ③ 外壳拼装：外壳必须知道「域」是什么，等于把业务概念塞进通用层，直接违反 shared-ui-guard 第 3 条；
    而且一条格式规则不值得新增两个载荷字段。
  - ① 只改文案不定义格式：这次改完，下一个新卡还是会写成第四种风格。
- **断言变更（按 B-13 改，不是迁就实现）**：`dsh-ssh-remote/tests/card-select.ps1` 三条 eyebrow 断言，
  旧值 → 新值分别是
  - 第 147 行 `'SSH 执行确认'` → `'SSH · 执行确认'`（选项卡）
  - 第 208 行 `'SSH 操作确认'` → `'SSH · 操作确认'`（确认卡）
  - 第 234 行 `'连接凭据'` → `'SSH · 输入密码'`（密码卡）

  理由：这三条断言守的就是「抬头写什么」，而抬头文案正是用户这次要改的东西；
  改了实现不改断言，守卫第二天就会报错并把人引回旧文案。按 `AGENTS.md` §3，有意变更断言要先写清
  改哪条、为什么，所以记在这里。**没有放宽任何一条断言的强度**，仍然逐张卡比对完整字符串。
- **同步改动**：`dsh-ssh-remote/scripts/ui/shared.ps1`（3 个 `-Eyebrow` 默认值 + 3 处注释）、
  `dsh-ssh-remote/scripts/ui/card.ps1`（3 个 `-Eyebrow` 默认值）、同插件 `README.md` 的三处描述。
  这些是纯文本，**不需要重新构建** `dist/`。
- **遗留：已补齐**（前一轮如实记下的三处，本轮全部按同一规则改完，共 5 个字符串）：
  - `dsh-ssh-remote/lib/run.mjs` 第 208 行 `header: 'SSH 执行确认'` → `'SSH · 执行确认'`（网页/宿主审批通道的抬头）；
  - `dsh-ssh-remote/lib/copy.mjs` 第 755 行 `header: 'SSH 搬运确认'` → `'SSH · 搬运确认'`（搬运卡虽不在 B-13 的四张卡里，
    但它是同一张勾选卡的网页通道抬头，按同一格式统一，不新留第二种写法）；
  - `shared/ui-card/app/src/fixtures/select.ts` 第 5 行 `'SSH 执行确认'` → `'SSH · 执行确认'`；
  - `shared/ui-card/app/src/fixtures/confirm.ts` 第 5 行 `'SSH 操作确认'` → `'SSH · 操作确认'`；
  - `shared/ui-card/app/src/fixtures/password.ts` 第 5 行 `'连接凭据'` → `'SSH · 输入密码'`。
  `shared/ui-card/app/src/fixtures/approval.ts` 已核对，本来就是 `Write · 提权审批`，
  正是「`<工具名> · 提权审批`」的形状，未动。
- **仍未处理的、抬头仍是旧写法的地方（不属于本轮范围，交协调会话）**：
  - `tests/fixtures/*.json`：`select.json` 的 `eyebrow` 还是 `SSH 执行确认`，由生成脚本重出，**不手改**；
  - `docs/shared-ui-card.md` 第 36 行的举例还是「SSH 执行确认」；
  - `shared/ui-card/dist/index.html` 里 fixtures 的文案仍是旧值：本会话无构建能力（受限沙箱拦 esbuild 的命名管道），
    源码改完后必须由协调会话 `npm run build` 重出产物再提交，**不许手改产物**。
- **复验**：`dsh-ssh-remote/tests/card-select.ps1` 49/49、`tests/preferences.ps1` 30/30、
  `tests/shared-ui-guard.ps1` 10/10、`tests/card-shell.ps1` 39/39，四项 exit=0；
  另可用 `git diff` 确认只改了上述 12 处字符串，没有动格式以外的逻辑。
- **复验（遗留补齐这一轮）**：`shared/ui-card/app` 下 `npx tsc --noEmit` exit=0（无输出）、
  `tests/preferences.ps1` 30/30、`tests/shared-ui-guard.ps1` 10/10，全 exit=0；
  ssh 插件的 node 单测需子进程管道，本会话跑不了，交协调会话。

---

## D-16 勾选卡行内重排、去掉行间分隔线、删掉 title 死字段与模板说明句（B-14 / B-15 / B-16 / B-17）

- **现象**（用户一次给的四个点，对应四条偏好）：
  - ① 载荷里的 `title` 从没渲染过：`App.tsx` 是 `titleHtml ? … : title ? …` 的三元，而四个构造函数都同时给了
    `titleHtml`，所以 `title` 永远被盖住——它承载的又全是「DSH 需要你批准一步操作」「勾选要执行的行」
    「删除主机」「设置主机密码」这类**每个请求都一样的固定句**（B-16）。
  - ② 勾选行是「主机 + 文字原因 + 代码框 + 文字 meta」四段纵排，一条命令占四行；用户要的是一行一个单位：
    `checkbox + 主机` 一行，下面一个代码框（原因作首行注释、命令是主体、cwd/超时在框底）（B-15）。
  - ③ 行间还留着上一轮（D-14）的 1px `borderTop`。行内已经有代码框之后，框本身就是分隔（B-17）。
  - ④ 卡片里散着模板说明句：「命令原文 · 判断以此为准」（代码块 caption）、「密码只写进本机密码库，
    不进模型上下文」（密码卡 note）——用户「我肯定知道的东西不用再写，不然稀释了注意力」（B-14）。
- **判定**：四条都是问题，且都是用户拍板的偏好，不是样式洁癖。判据：① 字段渲染不出来就是死字段；
  ②③ 一条命令占四行、行间还要靠线分块，读起来不是「一行一个执行单位」；④ 固定句不携带任何本次信息。
- **根因**：
  - ① `title` 是旧「小标题 + 标题」两行结构的遗留。B-13 把抬头统一成「域 · 动作」之后，标题那句就只剩重复；
    没人删，于是它变成「传了但不生效」的参数，还沿着 `-Title` / `-Question` 一路传到命令行。
  - ② 原因与 meta 当初是「先有文本、后有代码框」的排法（D-04 定的是「行即单位」，没定行内怎么排）。
  - ③ D-14 用分隔线代替行距，是「行距太散」的权宜解；代码框进来后分隔线是第二层边界，重复了。
  - ④ caption / note 是「照网页端抄一遍」时带过来的解释性文案，网页端有上下文、桌面卡片没有。
- **候选**：
  - ① 保留 `title` 作为兜底（被否：兜底永远不触发，等于留一个死字段与一条死参数链）；
    只删 `App.tsx` 的三元、保留字段（被否：参数还在，下一个人会以为它有用）。
  - ② 原因单独一行文字、代码框只管命令（被否：还是四段纵排）；原因放代码框**首行注释**（采纳）。
  - ③ 行距回到 D-14 之前的大 gap（被否：那正是 B-11 嫌「太散」的版本）；行距用 8px 留白（采纳）。
  - ④ 给 caption 换成动态文案（被否：每张卡都一样的 caption 换成动态的也是噪音，直接不要）。
- **结论**：
  - **① `title` 整个删掉**：`types.ts` 的 `CardPayload.title`、`New-CardPayload -Title`、
    notifier 的 `-Data.title`（`prompt.ps1` / `index.js` 也不再产这个键）、ssh 的
    `New-SshCardPayload -Title/-Question`（`-Question` 原来就是灌进 `title` 的）、三张 ssh 卡与
    `ui/card.ps1` / `dialog.ps1` / `lib/admin.mjs` 命令行里的 `-Title`。抬头已经是「域 · 动作」，
    动作再由按钮文字说清（「删除」「保存」「提交」）。**`App.tsx` 主行只渲染 `titleHtml`，
    没有就什么都不渲染**——不退回 `eyebrow`（那会变成同一句话出现两次）。
  - **② 行内重排**：行 = 左列 checkbox + 右列（`Flex vertical`）。右列第一行是「主机 + 警告」，
    警告靠右、`token.colorWarning`、`token.fontSizeSM`、前缀 `⚠`；右列下面是代码框
    （`token.colorFillTertiary`、`padding: '4px 8px'`、`token.borderRadius`），框内依次是
    `# 原因`（等宽、`token.colorTextTertiary`）、命令（等宽、`pre-wrap` + `overflowWrap: 'anywhere'`）、
    框底一条（上方 1px `token.colorSplit`，小一号字、`token.colorTextSecondary`）放 `meta`。
    代码框铺满右列（左侧让出 checkbox 那列），整行仍可点、`cursor: 'pointer'` 未动。
  - **② 警告从 meta 里拆出来**：载荷新增 `rows[].warn`（可选字符串）。ssh 适配层新增
    `Split-SshRowMeta`：把 `meta` 按 ` · ` 切开，含「覆盖」的那段去掉 `⚠` 后进 `warn`，其余拼回 `meta`。
    **放在 PowerShell 适配层而不是 `lib/*.mjs`**：`meta` 是上游 node 侧给网页卡的同一份文本，
    桌面卡需要的是拆过的版本；在适配层拆，网页卡一个字都不用改，也不用为此改 node 单测。
    `⚠` 由外壳统一画一次（载荷只放「覆盖」这个词），避免两层各画一次。
  - **③ 行间分隔线删掉**：行容器 `gap: 0 → 8`，行 `padding: '8px 10px' → '6px 10px'`。
    **这两个数是起点不是定稿**：协调会话会出图量像素，别自行往更紧/更松调（B-11 仍成立：
    行距要明显小于行内行距，8px 只是当下的估计）。
  - **④ 模板说明句**：代码块的 `caption` 字段整个删掉（`types.ts`、`New-CardCodeBlock -Caption`、
    `ConvertTo-CardBlockList` 的透传；ssh 的 Detail 兜底块原本写 `-Caption 'sh'`，一并去掉——
    「code 块不带 caption」才是可守的规则）。密码卡的 note 整段删掉（`admin.mjs` 不再传那句说明，
    卡片只剩抬头 / 主机 / 输入框 / 按钮）。确认卡保留警告但压成一句：`删除后不能撤销。`
  - **没动的东西**：审批卡里模型给的理由、勾选卡的 cwd/超时、按钮文案（跳过 / 提交 / 取消 / 保存 /
    删除 / 拒绝 / 允许一次）、`status` 行。
- **被否的方案**：
  - 让 `App.tsx` 在 `titleHtml` 缺失时退回 `eyebrow` 当主行：抬头与主行是两种字号/职责，
    合并之后「SSH · 执行确认」会被读成这张卡的标题，和 B-13 的抬头定义打架。
  - 在 node 侧（`nativeSelector` / `itemsToRows`）就拆 `warn`：网页卡同样吃这份 `rows`，
    拆了就得同步改 Markdown 卡片的排版与四条 node 断言，收益是零（适配层拆一次就够）。
  - 保留 `caption` 字段、只是不传：死字段会像 `title` 一样再活一年。
- **断言变更（按 B-14/B-15/B-16/B-17 改，不是迁就实现）**：

  | 文件 | 旧断言 | 新断言 | 为什么 |
  | :--- | :--- | :--- | :--- |
  | `tests/card-shell.ps1`「只替换 payload 标签」 | `New-CardPayload -Title '只换标签'`，`$parsed.title -ne '只换标签'` | `-Eyebrow '只换标签'`，`$parsed.eyebrow -ne '只换标签'` | 字段已删；换 eyebrow 后仍是**逐字比对完整字符串** |
  | `tests/card-shell.ps1`「字段齐全」 | 键表含 `title`；rows 只查 `label`/`meta` | 键表去掉 `title`，并断言 `$payload.Contains('title')` 为假；rows 增加 `warn -ne '覆盖'` | B-16；B-15 |
  | `tests/card-shell.ps1`「空字段不进载荷」 | `-Title 't'`，末尾断言 `-not $payload.Contains('title')`（「标题也没了」） | 无参构造；禁止键表里加入 `title`；再断言 `$payload.Count -eq 0` | 比原来更严：空载荷一个键都不许有 |
  | `tests/card-shell.ps1`「New-CardCodeBlock」 | `-Caption 'sh · 只读'` + `$block.caption -eq 'sh · 只读'` | 不再传 caption；断言 `$block.Contains('caption')` 为假，`command`/`lang` 仍逐字 | B-14 |
  | `tests/card-shell.ps1` **新增** | — | `New-CardPayload` / `New-CardCodeBlock` 的参数表里没有 `Title` / `Caption` | 新增断言①：字段/参数真的删干净，不留「传了但不生效」 |
  | `tests/card-shell.ps1`「样例载荷」 | `$parsed.title` 必须非空 | 断言 `$parsed` **没有** `title` 属性 | B-16；样例 JSON 里的旧 `title` 由载荷构造丢掉，正好证明字段不生效 |
  | `tests/shared-ui-guard.ps1`「dot-source 之后…」 | `New-CardPayload -Title '守卫自检'`，产物须含该串 | `-Eyebrow '守卫自检'`，产物仍须含该串 | 参数已删；断言目的（载荷进得了文档）未变 |
  | `dsh-ssh-remote/tests/card-select.ps1`「可选行」 | `rows[2].meta` 含 `⚠ 覆盖` | `rows[2].warn -eq '覆盖'`，且 `meta` **不含**「覆盖」、仍含 `工作目录 /etc/nginx` | 新增断言② + B-15 |
  | `dsh-ssh-remote/tests/card-select.ps1`「抬头」 | `$payload.title -eq '勾选要执行的行'` | 断言 `$payload` 没有 `title` | B-16 |
  | `dsh-ssh-remote/tests/card-select.ps1` 确认卡 / 密码卡 | `-Title '删除主机'` / `-Title '设置主机密码'` + `title` 等值 | 去掉 `-Title`；断言没有 `title`；确认卡正文仍 `-ne '这个操作不可撤销。'` 逐字比对 | B-16 |
  | `dsh-ssh-remote/tests/card-select.ps1`「密码卡空标签」 | `$bare.title -eq '设置主机密码'`（无标签时退回调用方标题） | 断言没有 `title`、也没有 `titleHtml`（没有主机标签就不出标题行） | 「退回标题」这个行为本身随字段一起删掉了 |
  | `dsh-ssh-remote/tests/card-select.ps1` 端到端确认 | `Invoke-SshCardConfirm -Title '删除主机' …` | 去掉 `-Title` | 参数已删 |
  | `dsh-approval-notifier/tests/card-select.ps1`「结构」 | `$payload.title -eq 'DSH 需要你批准一步操作'` | 断言 `$payload` 没有 `title` | B-16 |
  | `dsh-approval-notifier/tests/card-select.ps1`「理由」 | `$payload.body[1].caption` 含「判断以此为准」 | 断言 code 块没有 `caption`；`command` / `lang` 仍逐字 | B-14 |
  | `dsh-approval-notifier/tests/card-select.ps1`「没有工作目录」 | `$fallback.title -eq 'DSH 需要你批准一步操作'` | 断言没有 `title`（`titleHtml` 不占位的断言保留） | B-16 |
  | `dsh-ssh-remote/tests/run.test.mjs`、`copy.test.mjs` | `assert.match(opened[0].title, /SSH 审批/)` | `assert.equal(opened[0].title, undefined, …)` | `nativeSelector` 不再传固定句标题；**node 单测本会话跑不了**（要子进程管道），交协调会话 |

  **没有放宽任何一条**：原来逐字比对完整字符串的，改完还是逐字比对（连「空载荷一个键都没有」
  这一条都是收紧的）；新加的两条断言各自都是「必须不出现 / 必须等于某个值」的硬判断。
- **同步改动**：`dsh-ssh-remote/README.md`（三张卡的形状、密码卡说明）、
  `dsh-approval-notifier/README.md`（三处 caption 描述）、`docs/shared-ui-card.md`
  （载荷表的 `-Title` 行、rows 的 `warn`、`New-CardCodeBlock` 的 caption、输入模式示例）、
  `shared/ui-card/demo/demo.ps1`（示例 JSON 与 `-Title` 透传）、
  `shared/ui-card/app/src/payload.ts`（开发态错误载荷改用 `eyebrow` + note，不再造 `title`）。
- **复验**：
  - `shared/ui-card/app` 下 `npx tsc --noEmit` exit=0（无输出）；
  - `tests/card-shell.ps1` **40/40**、`tests/shared-ui-guard.ps1` **10/10**、
    `dsh-ssh-remote/tests/card-select.ps1` **49/49（全部通过）**、
    `dsh-approval-notifier/tests/card-select.ps1` **全部通过（28 条）**；
  - `tests/preferences.ps1` **29/30**：唯一失败是 `E-04 PREFERENCES.md 在项目根（不跟着分支跑）`——
    这条偏好的载体是「PREFERENCES.md 不在 `.agents/worktrees/` 下」，而 `PREFERENCES.md` 本身已随分支入库
    （`git ls-files` 可见），任何 worktree 里都必然命中。**与本轮改动无关，`preferences.ps1` 一个字没改**；
    在仓库根跑仍是 30/30（脚本头部的跑法写的就是 `<repo>`）。本轮涉及的偏好 B-14…B-17 在
    `preferences.ps1` 里本来就没有断言（校验方式写的是截图），这里只补了上面那两个间接载体。
- **遗留（不属于本轮，交协调会话）**：
  - `shared/ui-card/dist/index.html` 是旧源码的产物（`title`/`caption`/旧行布局都在里面）：
    本会话无构建能力（受限沙箱拦 esbuild 的命名管道），必须 `npm run build` 重出并提交；
  - `tests/fixtures/*.json` 里仍有 `title` / `caption` / 旧密码 note，由生成脚本重出，**不手改**；
    其中 `caption` 已被 `ConvertTo-CardBlockList` 忽略，`title` 已被 `New-CardDemoPayload` 丢掉，
    但密码卡的旧 note 会照原样显示，重出后才彻底消失；
  - `docs/images/*.png` 里的卡片图还是旧布局，出图后要替换。

---

## D-17 勾选卡框底附注行改用深一档底色区分，去掉框内 1px 分隔线（B-18，取代 D-16 里那半条）

- **现象**：勾选卡代码框里，框底那行（`工作目录 /root · 超时 30s`）与上面的命令之间靠一条
  1px `token.colorSplit` 分隔线区分——那是 D-16 定的写法。用户看到实际弹窗后说「现在分割线感觉不太好」，
  要的是「额外的背景色把它区分开 还不会抢命令的视线」（`PREFERENCES.md` B-18）。
- **判定**：是问题，且是用户拍板的偏好，不是样式洁癖。判据两条：
  ① 代码框内部再画一条 1px 线，等于在框里再造一层边界，与 D-16 ③「代码框本身就是分隔」的理由重复；
  ② 1px 硬边在这个字号下发虚发脏，看起来像一条没对齐的表格线。
- **根因**：D-16 把「原因 / 命令 / meta」三段塞进同一个底色块（`colorFillTertiary`），三段只有字色与字号的区别，
  而 meta 又比命令更浅（`colorTextSecondary` + `fontSizeSM`）——不带底色的话本来就更难看出「这是附注」。
  当时用一条线兜底，而不是给附注条自己的底色。
- **候选**：
  - ① 线加粗 / 变淡（被否：加粗更抢视线；淡到看不见又回到「没有区分」，1px 硬边在这个字号下无论深浅都发脏）；
  - ② **底色分层**：命令区仍是 `colorFillTertiary`，附注条深一档 `colorFillSecondary`（采纳）；
  - ③ 附注条缩进（被否：缩进表达的是树形的「从属关系」，而 meta 不是命令的一部分；
    缩进还会让附注条与框边之间留白，更像「另一个块」，与「铺满框宽」直接冲突）。
- **结论**：
  - 代码框外层：`background: token.colorFillTertiary`、`borderRadius: token.borderRadius` 不变，
    **新增 `overflow: 'hidden'`**；**外层内边距下放到两段各自**（原 `padding: '4px 8px'` 删掉），
    否则附注条与框边之间会留一圈缝；
  - 上段（`# 原因` + 命令）：包一层 `<Flex vertical gap={4} style={{ padding: '4px 8px' }}>`，行内 `gap` 仍是 4；
  - 附注条：`background: token.colorFillQuaternary`（最终取值，经过见下「最终取值」）、
    `padding: '4px 8px'`、**内层不加圆角**——
    圆角由外层管，`overflow: 'hidden'` 裁出两个下角，底色因此**铺满代码框宽度（含圆角处）**；
  - 附注文字仍是 `<Text type="secondary" style={{ fontSize: token.fontSizeSM }}>`
    （= `token.colorTextSecondary` + 小一号），字号与颜色都没动；
  - `borderTop: 1px solid token.colorSplit` **整条删掉**，框里不再有任何 1px 分隔线；
  - 附注条只在 `row.meta` 存在时渲染；上段只在 `row.why || row.text` 存在时渲染
    （否则只有 meta 的行会在附注条上方多出 8px 空内边距）；
  - **没动**：行容器 `gap 8`、行 `padding: '6px 10px'`、主机行与 `⚠ warn`、其他三张卡。
- **最初为什么是 `colorFillSecondary`，不用 `colorFill` / `colorFillQuaternary`**
  （此判断已被下面「最终取值」取代，留在这里是因为它记录了当时的取舍）
  （antd 5 默认值；`main.tsx` 的 `ConfigProvider` 只覆盖字体、`fontSize`、`borderRadius`、`controlHeight`，
  这几个填充 token 没被改）：
  - `colorFillSecondary` = `rgba(0,0,0,0.06)`，比命令底的 `colorFillTertiary`（`rgba(0,0,0,0.04)`）
    深一档，落在**同一灰阶的相邻两档**，读起来是「同一块里的附注」；
  - `colorFill`（`rgba(0,0,0,0.15)`）太重：比命令底深三档，附注条会变成框里最重的一块，
    直接违反 B-18 的「不抢命令的视线」；它的深度还接近选中行的 `colorPrimaryBg`，选中态会被它压掉一半；
  - `colorFillQuaternary`（`rgba(0,0,0,0.02)`）太浅：与 `colorFillTertiary` 只差 0.02 透明度，屏幕上几乎看不出，
    等于换个写法继续「没有区分」（此判断 2026-10-28 被用户改判：叠出来的 `≈#F0F0F0` 他接受，见下「最终取值」）；
  - 不换色相（不用主色 / 警告色）：附注是中性信息，不是状态。
- **最终取值（2026-10-28，用户拍板，`PREFERENCES.md` B-19）**：
  1. 先按上面的理由用 `token.colorFillSecondary`，真机实测 `#E7E7E7`——**偏深**，附注条压过了命令区；
  2. 用户自己把它调到 `#EEEEEE`，认可这个深浅；
  3. 随后用户补了一句「**如果组件库有合适的内置 那就用他**」——不为一个观感值放弃 token 体系；
  4. 定稿 **`token.colorFillQuaternary`**：`rgba(0,0,0,0.02)` 叠在命令区 `colorFillTertiary`
     （`rgba(0,0,0,0.04)`，白底约 `#F5F5F5`）之上，落像素 **`≈#F0F0F0`**——`#F0F0F0` 用户明说过「也行」。
  - **结论口径：内置 token 优先，档位够用就不写死色值。** `#F0F0F0` 与 `#EEEEEE` 两档用户都接受，
    可接受区间是 `#F0F0F0`～`#EEEEEE`；不要比 `#E7E7E7` 更深（压过命令区），也不必再往浅走
    （浅到命令区那一档就没有区分了）。
  - 注意别把它当先例：antd token 覆盖得到的地方一律用 token，这次连用户自己都要求退回内置档；
    「用户偏好 > token 一致性」的例外**没有**在这处成立。
- **被否的方案（补记）**：
  - 只调 meta 的字色（更浅或更深）：浅灰底上色差不够，且会削弱「小一号」这条已有区分；
  - 把 meta 移到代码框外面的下一行文字：等于退回 D-16 之前的「四段纵排」，违反 B-15。
- **复验**：
  - 源码：`App.tsx` 里 `borderTop` 消失（`rg -n 'borderTop' shared/ui-card/app/src/App.tsx` 无输出）、
    外层有 `overflow: 'hidden'`、附注条 `background: token.colorFillQuaternary`；
  - `shared/ui-card/app` 下 `npx tsc --noEmit` exit=0（无输出）；
  - 五套测试全绿：`tests/card-shell.ps1` 40/40、`tests/shared-ui-guard.ps1` 10/10、
    `tests/preferences.ps1` 30/30、`dsh-ssh-remote/tests/card-select.ps1` 全部通过、
    `dsh-approval-notifier/tests/card-select.ps1` 全部通过；
  - **不新增断言**（底色是观感，断言只认字符串）：由协调会话出 select 卡改前/改后对比图，
    并像素量三条——框内没有 1px 线、附注条比命令区深一档、附注条左右贴到框边（圆角处也被裁齐）；
  - 产物：`shared/ui-card/dist/index.html` 仍是旧产物（本会话无构建能力，受限沙箱拦 esbuild 命名管道），
    必须由协调会话 `npm run build` 重出并提交，这条改动才在真机可见。

---

## D-18 文档侧：卡片文档与截图跟上 D-15 / D-16 / D-17 的实现

> 只记文档与截图的处理，不改前面任何结论；布局与字段的取舍见 D-15～D-17。

- **现象**：代码侧改完了抬头、行内布局、`title` / `caption` 字段与框底附注条，但文档与图还停在旧版式：
  `docs/images/` 是三张旧图（旧行距、行间分隔线、固定句标题），三个 README 与 `docs/shared-ui-card.md`
  里仍写着「标题行」「命令原文 · 判断以此为准」「密码只写进本机密码库」这类已经不存在的描述。
- **判定**：是债。文档是下次改卡片的入口，写错会把人指向已删除的字段与不存在的版式。
- **依据（以当前代码为准）**：`App.tsx` 首行只渲染 `titleHtml`（没有 `title`）、行容器 `gap: 8`、
  行 `padding: '6px 10px'`、无 `borderTop`、代码框 `colorFillTertiary` + 附注条 `colorFillQuaternary`；
  `types.ts` 没有 `title` / `caption`，`rows[].warn` 在列；四个抬头值见 D-15。
- **做法**：
  - `docs/images/` 只留本轮出的四张图，命名 `card-approval.png`（680×213）、`card-select.png`（680×506）、
    `card-confirm.png`（680×160）、`card-password.png`（680×169）；旧的三张（`webview2-card*.png`，
    旧布局 + 旧真屏抓图 + 旧长内容图）删除，不留旧版式的图；
  - 引用点：根 `README.md` 一段「卡片长什么样」（总体，放勾选卡）、`dsh-approval-notifier/README.md`
    （审批卡）、`dsh-ssh-remote/README.md`（勾选 / 确认 / 密码三张）；
  - 每张图的图注写清四件事：**哪张卡、抬头是什么、结构是什么**（一行 = 一个执行单位、原因在框内当注释、
    cwd/超时在框底）、**示例载荷**（构造载荷离屏渲染，不是真机弹窗）；审批卡图另注「剩余 10:00」是
    10 分钟无人应答自动关闭的倒计时；
  - `docs/shared-ui-card.md`：§2 的行数/描述、§4 字段表（`-TitleHtml` 改「首行」、`rows` 说明、
    新增「勾选行的排版」）、§6 的 `-WindowTitle`，以及 `docs/webview2-card-playbook.md` 的「行即单位」
    与「三段式」描述按现状重写；
  - 三个 README 里描述「标题」「命令原文 · 判断以此为准」「行间分隔线」「密码只写进本机密码库」的段落
    按现状改写；旧真屏图、旧长内容图的两处引用随图片删除。
- **被否**：① 留旧图并标注「示意」——旧布局正是这次要淘汰的东西，留着会让人以为两种版式都在用；
  ② 在文档里保留对已删字段的历史说明——字段已不存在，说明只会误导。
- **BACKLOG 同步**：已完成条目按「做完就删行」删掉（已勾选的清理整理记录、已合并工作树清理；
  依据是 `git worktree list` 只剩 `ui-react`、`git branch -a` 只剩 `master` / `ui-react`，`docs/ui-spike/`
  与 `docs/ui-stack-research.md` 已不存在）。卡片相关的 `title` 死字段条目此前已删；仍需人或需改代码的条目
  （真机四类卡点击、`-AutoCloseMs` 语义、1px 描边、可访问性、`nativeSelector` 改名、`armDelayMs` 死字段【已删：
  从未生效，防误点统一走 `payload.armMs`，见 `### BACKLOG #21（2026-11-01）：删掉死字段 buttons[].armDelayMs`】、
  拆超长文件、Shiki、DPI/副屏、ssh 真机端到端、prepack）原样保留。
- **复验**：`tests/preferences.ps1` 30/30、`tests/shared-ui-guard.ps1` 10/10；`docs/images/` 每张图至少被
  一处 README 引用；根 README、两个插件 README 与 `docs/*.md` 里搜不到 `命令原文 · 判断以此为准`、
  `密码只写进`、`SSH 执行确认`（无中点写法）、`连接凭据` 这些串（`titleHtml` 与 `-WindowTitle` 是现存字段，
  不在此列）。

---

## D-19 提交按钮的计数改成「提交 N 项」，不再用中文全角括号（B-21）

- **现象**：勾选卡右下的主按钮显示「提交（0）」，勾了 3 行就是「提交（3）」。用户 2026-10-28 看到真机弹窗后说
  「这个提交（0）用的是中文括号吧 后面占得空间太多了 改为 提交 x 项」（`PREFERENCES.md` B-21）。
- **判定**：是问题，且是**用户给的文案偏好**，不是样式洁癖。判据：按钮宽度由文字撑开，全角括号左右各占一个汉字宽，
  括号里的数字又被中文字形往里推，整体读起来像「提交」后面挂了个注脚；「提交 3 项」把计数还原成一个正常的量词短语，
  同样字数占宽更小。
- **根因**：`ConfirmCountLabel` 的**默认值**里带着标点——模板的职责本该只有「把数字放进句子」，
  却把括号也写死进模板。`App.tsx` 的 `labelCount.replace('{n}', String(count))` 与模板内容无关，所以只换默认值就能生效。
- **候选**：
  - ① 保留全角括号、只压窄括号（被否：全角括号宽度由字体决定，用 CSS 压只会得到比例失调的括号，等于换个地方继续别扭）；
  - ② **`提交 {n} 项`**（采纳）；
  - ③ 半角括号 `提交({n})`（被否：中英混排在同一行里仍显零碎；「项」才是量词，去掉它读起来像直译）。
- **结论**：
  - `dsh-ssh-remote/scripts/ui/shared.ps1` 第 148 行 `$ConfirmCountLabel` 默认值：`'提交（{n}）'` → `'提交 {n} 项'`；
  - `shared/ui-card/app/src/App.tsx` 第 12 行注释里的模板示例同步改成 `` `提交 {n} 项` ``；第 14–15 行的替换逻辑**没动**
    （它本来就与模板内容无关，任何模板都能替换）；
  - 顺带清掉三处同样写死全角括号计数的地方：`app/src/fixtures/select.ts` 第 26 行、`tests/fixtures/select.json` 第 38 行
    （样例载荷会照原样弹出来给人看）、`demo/demo.ps1` 第 24 行的载荷结构示例（`确定（{n}）` → `确定 {n} 项`）。
    不改它们等于把旧文案继续当范例示范出去。
- **改了哪三条断言（仍是逐字比对，强度没变）**：
  1. `dsh-ssh-remote/tests/card-select.ps1` 第 164 行：`$submit.labelCount -ne '提交（{n}）'` → `'提交 {n} 项'`；
  2. `tests/card-shell.ps1` 第 237 行：`-RequiresChecked -LabelCount '提交（{n}）'` → `-LabelCount '提交 {n} 项'`（构造按钮的入参）；
  3. `tests/card-shell.ps1` 第 240 行：`$full.labelCount -ne '提交（{n}）'` → `'提交 {n} 项'`（回读后的比较）。
- **为什么这不算「改测试迁就实现」**：这三条断言钉的是「默认模板长什么样」，而模板长什么样**正是用户刚定的偏好**——
  B-21 的载体栏点名 `ConfirmCountLabel` 默认 `提交 {n} 项`、`card-select.ps1` 断言模板等于新值。所以分歧不在实现与断言之间，
  而在**旧断言与用户新文案**之间；实现（模板默认值）已经按用户要求改过，断言随后跟上的是**同一件事**，
  属于「有意改文案 → 同步偏好载体」。比较方式仍是逐字 `-ne`，没有放宽成 `-match`、没有只比前缀、也没有删掉断言。
  真正会被这条判据拦住的情形（实现写错、靠放宽断言混过去）在这里不存在：按钮文字与模板全部来自用户原话。
- **复验**：
  - 源码里搜不到 `提交（`（`shared.ps1`、`card-select.ps1`、`card-shell.ps1`、`select.ts`、`select.json`、`demo.ps1` 均为零命中）；
  - `shared/ui-card/app` 下 `npx tsc --noEmit` exit=0（无输出）；
  - 五套测试全绿：`tests/card-shell.ps1`、`tests/shared-ui-guard.ps1`、`tests/preferences.ps1`、
    `dsh-ssh-remote/tests/card-select.ps1`、`dsh-approval-notifier/tests/card-select.ps1`；
  - **产物**：`shared/ui-card/dist/index.html` 里还嵌着旧样例字符串（`app/src/fixtures/select.ts` 会被打进包），
    本会话没有构建能力，必须由协调会话 `npm run build` 重出并提交，样例页才会跟着变；
    正式路径（PS 产 payload、按钮文字由 `labelCount` 替换）不经样例，真机上改 `shared.ps1` 即生效；
  - 真机看：一张勾选卡不勾时按钮读「提交 0 项」，勾一行读「提交 1 项」。

---

## D-20 主机标签带「地址:端口 · 别名」，WSL 例外（B-22）

- **现象**：`ssh_run` 的勾选卡、执行结果、错误信息里，远程主机只显示别名（`project-a 主机D`），
  拿不到完整 IP。用户 2026-10-29 的原话：「服务器显示了别名但没有显示完整IP，我觉得除了wsl其他的都要显示ip再加别名」。
- **判定**：是问题，且是用户拍板的偏好（`PREFERENCES.md` B-22）。判据：别名是我自己起的，几台同型号测试机的名字
  只差一个数字；卡片要做的事是「勾哪台」，唯一能定位到机器的是地址，别名只是辅助。
- **根因**：`targetLabel()` 当初是给「短标签」用的（`target.label ?? target.id`），后来被所有出口复用——
  卡片选项、正文标题、执行结果、审计、错误信息全走它，于是「短」这个初始假设把地址一起省掉了。
- **结论**：`dsh-ssh-remote/lib/hosts.mjs:147` `targetLabel()` 改成
  - 非 WSL：`` `${target.address}:${target.port} · ${target.label ?? target.id}` ``（**22 也写端口**：
    同一地址上跑两个 sshd 的两台主机，省了端口就完全重名）；
  - WSL 保持 `` `WSL(${target.distro})` ``——用户明确点的例外，本机发行版没有 `地址:端口` 这回事。
  函数被 `run.mjs`、`copy.mjs`、`approval.mjs` 与审计一起用，改一处即全链路一致（不只在卡片那一路改）。
- **副作用（如实记）**：
  - 错误信息变长，例如 `预检 192.168.1.11:22 · 主机A:/path 失败`——`.mjs` 里的拼接是
    `${targetLabel(target)}:${path}`，看起来像「别名后面跟了个端口」，但地址只出现一次，不重复；
  - `copy.mjs` 的结果行是 `第 1 项 · <源> → <目标> · 文件`，标签自身含 ` · `，与行内分隔符同形，
    长行读起来更挤。**没有为此改拼接格式**：改它要动 `from`/`to` 的文本形状与对应断言，
    属于另一条偏好，留给协调会话判断；
  - `short(head, 56)` 的截断还在：一趟多台主机时选项仍可能被截成 `…`，但截的是主机标签、不再是命令。
- **被否的方案**：
  - ① 只在勾选卡里拼地址（被否：执行结果与错误信息仍然认不出是哪台，同一件事两套写法）；
  - ② 让别名里自带 IP（被否：别名是给人写的，用户要的是「显示地址」，不是改数据）；
  - ③ 22 端口省略（被否：两台主机只差端口时标签完全一样，勾错就是执行错机器）。
- **怎么复验**：`dsh-ssh-remote/tests/state.test.mjs:103` 新增一条——remote 得到
  `192.168.1.13:22 · project-a 主机D`、`:2222` 那台不同名、WSL 仍是 `WSL(Debian)`；
  `run.test.mjs:248`、`copy.test.mjs:511` 断言勾选行里带地址。

---

## D-21 勾选行只留主机，同主机多行用 ①②③ 区分（B-23）

- **现象**：用户看到勾选行是 `project-a 主机D · for u in https://download.dock…`，
  问「另外后面的省略是什么，命令吗？」——那半句是被 `short(…, 56)` 截断的命令首行。
- **判定**：是问题（`PREFERENCES.md` B-23）。判据：选项行的职责是「勾哪台/哪项」，命令在正文代码块里；
  把命令拼进来再截断，既看不懂又挤掉了主机名，还引入一个「省略号到底省了什么」的疑问。
- **根因**：`stepsToRows()` 的 `label` 是「`head` 撞车时才用的区分字段」，当初用命令首行做区分手段；
  可它同时被 `short(…, 56)` 截断，于是多行卡片上必然出现半句命令。`copy.mjs` 的 `itemsToRows()`
  同理，用的是「文件名 · 体积/覆盖标记」。
- **结论**：
  - `lib/run.mjs:57` `stepsToRows()` **不再产出 `label` 字段**（`target` 与 `head` 都是主机标签）；
  - `lib/copy.mjs:280` `itemsToRows()` 同样删掉 `label`（原值是 `文件名 · 标记`）；
  - `lib/approval.mjs:99` 选项一律 `heads.map(head => short(head, 56))`，**重名就加 ①②③**；
    `row.label` 这个 override 字段与「退回 `目标 · action/命令`」的回退表达式**一起删掉**，
    从结构上保证任何回退路径都拼不出命令（不是「保证 rows 恒带 label」那种约定）；
  - 正文块标题本来就随 `needMark` 带编号，未改；这一条这次有断言钉住。
- **被否的方案**：
  - ① 保留 `label` 字段、只把回退表达式改成 `row.target`（被否：字段留着就还能被塞进命令，
    「约定」挡不住下一个人）；
  - ② 加一句「…（命令见正文）」的提示文案（被否：用户明确不要多余说明句，B-14 同理）；
  - ③ 用「第 N 行」代替 ①②③（被否：卡片里已经有 ①②③ 这套语法，不新造第二种编号）。
- **怎么复验**：
  - `run.test.mjs:280` 钉住行字段集合恰为 `['code','head','meta','target','why']`、`:281` 钉住 `label` 不存在、
    `:285` 钉住选项里搜不到命令文本；
  - `run.test.mjs:300` 同主机两行得到 `['① 192.168.1.11:22 · Web 1', '② 192.168.1.11:22 · Web 1']`，
    `:310` 起钉住正文块标题也带编号；
  - `copy.test.mjs` 的覆盖用例仍断言选项里只有两台主机（`:511`）。

---

## D-22 ssh 弹窗只剩 WebView2 卡这一条路，删掉宿主 channel 与 approval 兜底（C-10）

- **现象**：`ssh_run` 的勾选弹到了**宿主内置的问题弹窗**（浏览器里那个），我们自己做的共享外壳 WebView2 卡
  反而没被用上。用户 2026-10-29 选「改成优先用我们自己的卡（推荐）」，随后加严为
  「后续 ssh 工具只有 WebView2 弹窗」。
- **判定**：是问题，且是用户两次拍板的偏好（`PREFERENCES.md` C-10 已是「只有一条路、不保留降级」）。
  判据：两套界面＝两套样式各改一遍，而且宿主弹窗与卡片的行结构、防误点、抬头都不一样；
  「优先」还会让人分不清自己刚点的是哪张卡。
- **根因**：`askApproval()` 当初的顺序是「有 `userQuestions` 就先问宿主，只有『调用者不是根会话』
  （`DELEGATED_CALLER`）才降级到桌面卡」。桌面卡一直只是**兜底**，根会话根本走不到它。
- **结论**：`dsh-ssh-remote/lib/approval.mjs` 的审批路径收敛成一条：
  - 删掉 `getApprovalChannel()`（取 `ctx.get('userQuestions')`）、`selectedIndices()`、
    `isDelegatedCallerError()` 与整段 `channel.ask` 分支，连同只服务于它的 `ctx` / `exec.agent` 判断；
  - 删掉 `approval.request` 那条逐条 allow-once 的降级（`:216` 之前整段）——它同样只用于
    「没有 questions 服务」这种「卡片之外还有别的通道」的场景；
  - `askApproval({ question, fallbackSelect })`：`fallbackSelect` 不是函数 → 直接抛
    `ApprovalUnavailableError`（文案里带「请重试」）；是函数 → 只 await 它，抛错原样上抛。
  - 调用点跟着收：`run.mjs`、`copy.mjs` 的 `createXTool({ ctx, … })` 去掉 `ctx`，`askApproval` 调用只传
    `{ question, fallbackSelect }`。`admin.mjs` 的确认 / 密码两张卡本来就是直接走 `dialog.confirm` /
    `dialog.askPassword`（同一张外壳），**不需要改**，只把那段「给子代理兜底」的过期注释改成了
    「这是唯一界面」。
- **为什么不留兜底（也是「为什么不降级到宿主弹窗」）**：
  1. `AGENTS.md` §4 的口径是「ssh 卡片起不来就让命令失败、重试即可」，兜底不是必需能力；
  2. 静默换通道会让人以为批准的是刚才那张卡——审批的全部价值是「看到什么就是执行什么」；
  3. `AGENTS.md` §0：不留旧路径、不写兼容层；留着 `approval.request` 就等于永远有两套审批语义
     （逐条 allow-once vs 一张多选卡），谁也说不清线上走的是哪套。
- **被否的方案**：
  - ① 保留 `channel` 作为「卡片不可用时的兜底」（被否：见上三条，且用户已明确「只有」）；
  - ② 保留 `approval.request` 兜底（同上）；
  - ③ 用配置项决定走哪条通道（被否：默认值优先于配置项，且这会变成永久双路径）。
- **删掉的东西有没有别的调用者**：`getApprovalChannel` / `selectedIndices` / `isDelegatedCallerError`
  全仓只有 `approval.mjs` 自己用；生产路径上 `dialog` 由 `index.js` 的 `createDialogRunner` 恒有
  `selectRows`，所以改前那条 `channel.ask` 分支**在生产里根本走不到**（只有测试里造过）。
- **怎么复验**：
  - `run.test.mjs:408` 新增——`askApproval` 没有卡片构建器时抛 `ApprovalUnavailableError`，
    文案含「请重试」，并且塞进去的宿主 channel spy **一次都没被调用**（就是「不去问宿主」那条断言）；
  - `run.test.mjs:425` 工具层同样报错且不执行；`copy.test.mjs:621` 同理（搬运拒绝执行）；
  - `run.test.mjs:355` 有宿主 `userQuestions` 时仍然走卡片；`:385` 卡片抛错就失败、不切通道。

---

## D-23 本轮断言改动表（旧值 → 新值 + 位置，均为「格式变化必然不等」）

> 由 B-22 / B-23 / C-10 直接推出，没有放宽任何一条：原来是逐字 `assert.equal` 的仍是逐字，
> 原来是 `assert.match` 正则的仍是正则（只是把地址写进期望值）。文件中行号为提交时实际行号。

| # | 断言 | 旧值 | 新值 | 位置 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 勾选行标签（多主机） | `'Web 1 + Web 2'` | `'192.168.1.11:22 · Web 1 + 192.168.1.12:22 · Web 2'` | `dsh-ssh-remote/tests/run.test.mjs:248` |
| 2 | 勾选行标签（单主机） | `'Web 1'` | `'192.168.1.11:22 · Web 1'` | `run.test.mjs:249` |
| 3 | 撞车行的选项 | `'Web 1 · uname -a'` / `'Web 1 · df -h'` | `'① 192.168.1.11:22 · Web 1'` / `'② 192.168.1.11:22 · Web 1'` | `run.test.mjs:300` |
| 4 | 审计 target | `'Web 1'` | `'192.168.1.11:22 · Web 1'` | `run.test.mjs:348` |
| 5 | 搬运选项标签 | `asks[0].options[0].label === 'Web 1 → WSL(Debian)'` | `asks[0].rows[0].label === '192.168.1.11:22 · Web 1 → WSL(Debian)'` | `copy.test.mjs:511` |
| 6 | 覆盖标记 | `asks[0].detail` 里含 `⚠ 覆盖` | `asks[0].rows[0].meta` 里含 `⚠ 覆盖` | `copy.test.mjs:512` |
| 7 | 源不存在错误 | `/源不存在：Web 1:\/srv\/app\.tar/` | `/源不存在：192\.168\.1\.11:22 · Web 1:\/srv\/app\.tar/` | `copy.test.mjs:580` |
| 8 | 无审批通道的报错 | `/审批通道/` | `/没有可用的审批卡片/` | `copy.test.mjs:621` |

**被删除/搬运的断言，逐条说明（不是放宽）**：

- `run.test.mjs` 原有的「子代理（被托管）→ 网页卡片被拒 → 改用桌面卡」整条用例删除：
  `DELEGATED_CALLER` 这条错误路径已经不存在（C-10），留着它就是在测一段不存在的逻辑；
  等价甚至更强的新用例是 `:355`（有 channel 也走卡片）与 `:385`（卡片报错就失败）。
- 原「没有 `userQuestions` 时降级成 `approval.request`（逐条 allow-once）」与「两条通道都没有：拒绝执行」
  两条用例删除，合并成 `:408` + `:421`（没有卡片构建器 → 抛错、不执行、不问宿主）。断言强度没降：
  旧用例断的是「逐条问、只执行被允许的那条」，新用例断的是「连问都不许问」。
- 「选项行不带 `description`」这条原来断言在 `channel.ask` 收到的 question 上；卡片路径拿不到 question，
  于是改成对 `buildApprovalQuestion` 的直接断言 `run.test.mjs:269`
  （`Object.keys(options[0])` 恰为 `['label']`）——比原来更严：不是「没有 description」，
  而是「选项里只允许出现 label 一个键」。
- 卡片正文（粗体定位行 / 围栏代码块 / 不出现列表、引用、表格、「共 N 行」）的断言从
  「宿主 question.detail」搬到 `run.test.mjs:256` 起的直接构造（`stepsToRows` + `buildApprovalQuestion`
  都是生产函数），断言文本一字未改。
- `run.test.mjs` 的 `pick(question)` 变成 `pick(rows)`、`events[].options/detail` 变成 `events[].rows`：
  这是**观测面**变化（卡片只拿得到 rows），不是断言变松；被测的仍是「勾第几行 → 只执行那一行」。
- 新增三条（本轮要求）：`state.test.mjs:103`（targetLabel 带地址 / WSL 例外）、
  `run.test.mjs:280`（行里没有命令拼接字段）、`run.test.mjs:408`（无卡片构建器时抛错而非问宿主）。

---

## D-24 收尾三件：密码卡标签统一到 B-22、`askApproval` 删掉 `mode`、`index.js` 清死参数

- **现象**：① 同一台机器在勾选卡上写 `地址:端口 · 别名`，到了密码卡与删主机卡还是
  `id · user@地址[:端口]`（22 还省掉端口）——用户刚在勾选卡上因为「只有别名没有 IP」踩过一次，
  密码卡再犯就是同一个坑挖两次；② `askApproval()` 返回 `{ mode: 'native', indices }`，
  但 C-10 之后只剩卡片一条路，`'native'` 没有对照物，读它的人只能读到一个常量；
  ③ `index.js` 还把 `ctx` 传给 `createRunTool` / `createCopyTool`（两者已经不看它），
  系统提示词第 7 条还在讲「网页审批卡只对根会话开放」。
- **根因**：三处都是上一轮删通道时留下的尾巴——意图改了，调用点与文案没跟上。
- **候选**：
  - ① 标签：a) 保留 `id · user@…`，只把端口补上（否：同一台机器两套长相，用户得自己在脑子里对齐）；
    b) 统一成 B-22 的 `地址:端口 · 别名`，需要 `id` 就放该行的 `meta`。**选 b。**
  - ② `mode`：a) 留着（否：没有第二条通道，字段恒为 `'native'`）；b) 删掉，返回 `{ indices }`。**选 b。**
  - ③ `index.js`：a) 保留 `ctx` 实参、只改提示词（否：正是「传了但没人用」）；b) 删实参 + 改注释与第 7 条。**选 b。**
- **结论 / 为什么**：
  - `hostLabel()` 与 `targetLabel()` 同形，且**端口一律不省**：只差端口的两台机器省了端口就重名，
    而删主机是不可撤销操作，这里按「不可挽回的错误按最严标准」办。
  - `id` 这一轮没有塞进任何 `meta`：用到 `hostLabel` 的两个调用点（密码卡、删主机确认卡）都是给人看的，
    人按地址认机器；需要 `id` 的是模型，而所有 admin 调用本来就带着 `id`，`ssh_admin list` 也照样列 id。
    真出现「卡片上必须告诉人下次用哪个 id」的场景再加，不预先造字段。
  - `mode` 删掉后返回值只剩 `indices`：`run.mjs` / `copy.mjs` 只读 `approval.indices`，
    全仓 grep `mode` 只剩 `admin.mjs` 的 dialog 模式名与 `pool.test.mjs` 假连接的行为开关，
    没有日志或审计把它当「走了哪条通道」记录——所以删字段不牵动任何读取点。
  - `index.js` 里 `userQuestions` 的例子一并删掉：连通道都没有了，注释里不该再留一个不存在的服务。
  - 两个 C-10 工具级用例改成「工具连宿主 channel 都拿不到」：`createXTool` 现在不接受 `ctx`，
    再传一个 channel spy 进去只是自欺——「不去问宿主」这条断言留在 `askApproval` 那一层
    （`run.test.mjs:408`，故意多塞一个 `ctx` 当回归探针）。
- **旧值 → 新值**（行号为本次提交时）：

  | # | 断言/实现 | 旧值 | 新值 | 位置 |
  | :--- | :--- | :--- | :--- | :--- |
  | 1 | `hostLabel()` 实现 | `id · user@地址[:端口]`（22 省略端口） | `地址:端口 · 别名`（22 也写） | `dsh-ssh-remote/lib/admin.mjs:22` |
  | 2 | 同上（默认端口用例） | `'web1 · deploy@192.168.1.11'` | `'192.168.1.11:22 · 生产 Web'` | `tests/admin.test.mjs:70` |
  | 3 | 同上（非默认端口用例） | `'db1 · root@192.168.1.12:2222'` | `'192.168.1.12:2222 · db1'` | `tests/admin.test.mjs:70` |
  | 4 | 密码卡标题断言 | `assert.match(…, /web1 · deploy@192\.168\.1\.11/)` | `assert.equal(…, '192.168.1.11:22 · 生产 Web')` | `tests/admin.test.mjs:167` |
  | 5 | `askApproval` 返回 | `{ mode: 'native', indices }` | `{ indices }` | `lib/approval.mjs:223` |
  | 6 | C-10 工具级用例名 | 「有宿主 userQuestions 时仍走桌面卡片，宿主弹窗一次都不问」 | 「审批只走桌面卡片（工具连宿主 channel 都拿不到）」 | `tests/run.test.mjs:354`、`tests/copy.test.mjs:390` |
  | 7 | 提示词第 7 条 | 「网页审批卡只对根会话开放，子代理的审批会自动落到桌面卡片…」 | 「审批一律走本机桌面卡片…不经过宿主的内置问题弹窗」 | `index.js:84` |

  第 4 条是**加强**不是放宽：`assert.match`（正则）换成 `assert.equal`（逐字），期望值写全。
  第 6 条只是改名 + 去掉一个已经传不进去的 spy，断言（卡片被调用一次、只执行被勾中的那行）一字未改。
- **怎么复验**：`node --test --test-isolation=none "tests/*.test.mjs"` → 110 通过 / 0 失败
  （admin 13、copy 33、pool 21、run 22、state 15、wsl 6）；`card-shell.ps1` 40/40、
  `shared-ui-guard.ps1` 10/10、`preferences.ps1` 30/30。
- **没做的**：`short(head, 56)` 的截断保留——新格式把地址放在最前，先掉的是别名尾部而不是 IP，
  正是 B-22 要的优先级；`copy` 结果行里 `<源> → <目标>` 两个标签都自带 ` · `，读着挤，
  但那是另一条偏好（未定），先记着不动；`README.md` 的过期描述归文档会话，这里不碰。

---

## D-25 落位跟「活动窗口所在屏」走（B-24）：屏幕解析与落位数学拆开

- **现象**：2026-10-29 双屏实测，人在副屏干活，卡片仍然弹在主屏（记成 `PREFERENCES.md` B-24）。
  **判定**：是问题——B-24 是用户硬约束，双屏是本机常态，不是环境特例。
- **根因**：整条落位链路没有一处读「当前活动窗口」——
  `Get-CardPlacement` 的 `center` 读光标所在屏（`Screen.FromPoint(Cursor.Position)`），
  `corner` 硬编码 `Screen.PrimaryScreen`；`Get-CardMaxHeight` 的 62% 也读 `PrimaryScreen.WorkingArea.Height`。
  所以只要光标不在副屏、或走 corner 分支，卡片必然落主屏；副屏更矮时 62% 还会超出那块屏的高度。
- **候选**：
  - **A. 前台窗口所在屏**：`user32!GetForegroundWindow` → `Screen.FromHandle(hwnd).WorkingArea`，
    拿不到再退光标、最后退主屏。**选它。**
  - **B. 只用光标**：否——用户报的正是「光标和正在操作的窗口不在一块屏」，按光标算等于把复现条件写进实现；
    卡片弹出后光标可能停在别处，「下一张卡去哪块屏」无法解释。
  - **C. 记住上次弹卡的屏**：否——「上次」不等于「现在」，用户切屏后下一张卡继续错；要维护状态与缓存，
    进程级缓存还会跨会话残留，重启即失效，并且把「人现在在哪」换成了「上次人在哪」。
- **结论 / 为什么**：
  - A 是系统里唯一直接回答「人现在在哪块屏干活」的现成信号，零延迟、无状态。B、C 都只是它的近似，
    近似在用户报告的那个场景里正好失效。
  - 「前台窗口 → 光标 → 主屏」是有序兜底，不是第二套实现：第 2、3 级只在 hwnd 为 0 / 已销毁 /
    API 抛异常时命中（受限令牌、会话无桌面等），目的只是「别弹不出卡」；全都拿不到时返回零矩形
    （窗口落到 0,0），也不抛异常。
  - **屏幕只解析一次**：`webview2.ps1` 在建窗之前取 `$screenArea = Get-CardScreenArea`，
    高度上限用 `$screenArea.Height`、落位传 `-Area $screenArea`。否则同一张卡可能按主屏限高、
    按副屏落位（副屏更矮 → 卡超出屏）。解析点放在建窗之前，因为窗口一旦创建前台窗口可能变成我们自己。
  - `Get-CardPlacement` 增加 `-Area`：落位变成纯函数，`center` 与 `corner` 都用这一块矩形，
    corner 不再硬编码主屏（通知卡也该落在用户所在屏，B-24 不含例外）。DPI 约定不变：
    矩形是**物理像素**，`$Scale` 仍只乘边距与间隔的 16 / 8。
  - P/Invoke 加进已有的 `DshUiCard.Native`（一个类型、一次编译），靠 `$script:NativeReady` 与
    类型存在守卫保证幂等，没有另起第二个 `Add-Type` 类型。
- **复验方式**：
  - 纯 PS 断言：`pwsh -NoProfile -File tests\card-placement.ps1` → 12 通过 / 0 失败。
    断的是**数学与退化路径**：副屏矩形（`Left = -1920`）下 center 居中且在界内、corner 在界内且
    SlotIndex 递增往上错开不越界、900 高的屏 62% = 558（且默认路径问 `Get-CardScreenArea` 而不是主屏）、
    不传 `-Area` 时返回非空矩形并连调两次不抛「类型已存在」、`webview2.ps1` 限高与落位共用 `$screenArea`。
  - **屏幕解析真值只有真机双屏能验**（纯 PS 断言覆盖数学，屏幕解析由真机验）：在副屏开一个窗口并
    保持前台 → 触发一张中心卡与一张 corner 卡 → 两张都落在副屏；副屏更矮时卡高 ≤ 该屏 62%。
    这一步仍需要人来做。
- **遗留（没做的）**：`tests/card-geometry.ps1` 的 corner 断言仍拿 `PrimaryScreen.WorkingArea` 当参照
  （它读的是离屏渲染产出的测量 JSON），单屏行为不变；将来在副屏出图时那条断言要改成「截图所在的那块屏」。
  `docs/shared-ui-card.md` 里 `environment.ps1` 的函数清单与行数、`tests/preferences.ps1` 里 B-24 的载体条目，
  归文档会话与协调会话，本次不碰。

---

## D-26 「停止」对卡片是死键：把取消信号接到卡片，并让卡片进程的任何结束都立刻结算

- **现象**：`ssh_run` / `ssh_copy` 的勾选卡一旦挂出来，点宿主的「停止」没有任何效果——命令不会执行，
  但那一次工具调用永远不结束，用户实测只能**重启宿主**才恢复。2026-10-29 15:27 的现场又补了一种：
  卡片宿主进程已经没了（窗口不在、没有 `pwsh`、`%TEMP%` 里没有 `dsh-ssh-*` 目录，只剩 3 个
  `msedgewebview2` 孤儿），会话日志里**只有 `tool/call`、没有 `tool/result`**，审计日志同一次调用
  完全没有执行记录 ⇒ 卡在「等卡片」，命令根本没开始跑，而且卡片已经不在了还在等。
- **判定**：是问题，而且是**不可挽回操作那一侧的问题**（C-07）：审批卡的任务是「看不到就不执行」，
  它一旦挂死，用户既没法批准也没法拒绝，只能重启——这不是「重试一次就好」的失败。
- **根因**（三层，缺一条都复现不了）：
  1. `askApproval` 只 `await fallbackSelect(question)`，**从不传 `signal`**；`nativeSelector` 也不传，
     于是 `dialog.selectRows` 起的那条 `pwsh` 拿不到宿主的取消信号，除非用户点卡片按钮，它永远不退出；
  2. 卡片的 `timeoutMs` 是 `0`（永不自关，这是有意的：审批不替用户猜时间）。所以卡片侧也没有任何
     「到点结算」的出口；
  3. 宿主语义是**「工具 body 不 settle，取消就不生效」**（`dsh-tools` 的
     「Cancellation never abandons the body: a started promise reaches quiescence before its
     outcome becomes `ABORTED`」）：只要 `execute` 还在 await 那张卡，点「停止」只是给 body 递了个
     abort 信号，body 不理会就一直挂着。这三条叠起来，停止＝死键。
  4. 现场那一种更细一层：`admin.mjs` 等的是 `handle.done`，而宿主的
     `ctx.subprocess.spawn` 结算 `done` 的条件是「目标进程退出**且**已收集管道排空」——
     排空最多等 `graceMs`。卡片宿主会拉起 WebView2 子进程，**它们继承着 stdout/stderr 管道**，
     宿主进程死了写端还在，`close` 永远不来。我们原来给的 `graceMs = 20000`，于是「卡片已经没影了」
     还要再干等 20 秒；如果宿主那边连 target-exit 都送不出来（runner 也被拖住），就是永不 settle。
- **宿主 `subprocess` 语义（读包内实现确认，不是猜的）**：
  - `dsh-subprocess` 的 `SubprocessSpawnSpec.graceMs` 文档原话：用于「draining still-open collected
    pipes after the process exits (an inherited descriptor held by a survivor cannot hold the outcome
    open indefinitely)」——即**退出之后**的排空窗口，有上限，不是进程存活时间；
  - `done` 是「exit facts of one closed process」，`terminate()` 是「the seam's only termination verb」，
    幂等，作用于**managed range（整棵进程树，Windows 上走 Job / `taskkill /T /F`）**；
  - `waitForExit()` 等的是「same managed range is empty」——**不是**目标进程退出。现场那种孤儿占着
    range 的情况，`waitForExit` 正好也永远不返回，所以**不能拿它当「进程已退出」的信号**。
  - 结论：能用的只有两件事——把 `graceMs` 调到「几十毫秒到半秒」量级（退出即结算），
    以及结算后调 `terminate()` 把树带走（不留孤儿）。
- **候选**：
  - **A. 把取消信号一路接到卡片子进程**（`exec.signal` → `askApproval` → `fallbackSelect` →
    `dialog.selectRows` → `subprocess.spawn({signal})`），并让卡片进程退出即结算、结束时收树。
    **选它。**
  - **B. 工具层加总 deadline**（`Promise.race` 一个「最多等 N 分钟」）：被否——那等于给审批卡
    定了寿命，用户在读卡、思考「这条 rm 到底对不对」的时候被自动关掉，安全语义直接反了；
    而且它只让 body 结算，卡片窗口还留在屏幕上（谁来关？），取消信号一停就又会挂死。
  - **C. 卡片自带超时（`-AutoCloseMs`）**：被否——`-AutoCloseMs` 的下限是 5s，本质还是「审批卡
    会自己消失」，是 BACKLOG #6/#14 那件事（通知/展示类卡片的寿命），用户明确这次不做；
    审批卡的正确出口是「人处理」或「人停止」，不是「时间到」。
- **结论 / 为什么**：
  - `exec.signal` 是宿主唯一表达的「这次调用被取消了」的事实；不往下传，就只有「body settle 之后」
    才轮得到取消语义生效，而 body 恰恰卡在卡片上——传下去是唯一能同时做到「停」和「不留窗口」的路径。
  - 不在这里另起一条 abort 竞速（`Promise.race([card, aborted])`）作为兜底：那样 body 会先结算、
    卡片窗口留在屏幕上没人收，下一次卡片还可能撞上残留的旧窗口；「让子进程被杀、由它自己结算」
    才是唯一的一条收尾路径（AGENTS §0：能重试的失败不做兜底，也不做第二套实现）。
  - 停下来的语义要写死：**宿主强杀 → 非 0 退出 + stderr 空 → `admin.mjs` 按「没勾选」返回 →
    `askApproval` 得到空数组 → 一行都不执行**。所以「停 = 跳过 = 一行都不执行」，
    不会出现「停了一下却批准了 0 行以外的意外结果」。
  - `graceMs` 从 20000 改 **500ms**：它只用于把 pwsh 退出前写下的那点 stdout/stderr 收干净
    （密码卡要从 stdout 读密码，必须留一点余量），不再兼职「等 WebView2 孤儿把管道关掉」。
  - 结算之后统一 `handle.terminate()`（`run()` 与 `selectRows()` 都收进 `awaitDialogDone()`）：
    宿主的 terminate 是杀整棵树，卡片窗口的 WebView2 子进程跟着走；终止是幂等的，
    正常答完时是无害的 no-op。
  - 断链归因（顺手做的那件）：`pool.run()` 的 `close`/`exit` 拿不到退出码也拿不到退出信号时
    （`exitCode === null && signalName === null`）标 `dropped: true`，`exitCode` 仍是 `null`
    （**绝不编一个 1**），并顺手丢掉这条连接；`ssh_run` 的行里写
    `与 <地址:端口 · 别名> 的连接中断（命令可能未执行完）`、带 `dropped: true`、渲染抬头显示
    「连接中断」而不是「退出码 无」，审计里也记 `dropped`。远端进程被信号杀掉（`signalName` 有值）
    不算断链，走原来那条分支；WSL 侧与本地超时的文案一个字没动。
- **改动清单**：
  - `lib/approval.mjs`：`nativeSelector` 的返回函数改成 `(question, { signal })` 并把它放进
    `selectRows({ …, signal })`；`askApproval({ question, fallbackSelect, signal })` 透传。
  - `lib/run.mjs` / `lib/copy.mjs`：`askApproval({ …, signal: exec?.signal })`；
    `run.mjs` 加 `dropped` 归因、结果字段与渲染状态；`audit.mjs` 白名单加 `dropped`。
  - `lib/admin.mjs`：`DIALOG_DRAIN_GRACE_MS = 500`；新增 `awaitDialogDone()`（等 `done`，
    `finally` 里 `terminate()`）；`run()` 与 `selectRows()` 都用它。
  - `lib/pool.mjs`：`run()` 的 `finish()` 计算 `dropped`，断链时 `close(host.id)`。
- **断言改动表（旧值 → 新值）**：**本轮没有改任何既有断言的值**——`card-shell` / `shared-ui-guard` /
  `preferences` / `card-placement` 四个 .ps1 与 `tests/*.test.mjs` 的既有期望值全部原样通过。
  只新增了用例（没有放宽、也没有改观测面）：

  | # | 新增用例 | 位置 | 钉住什么 |
  | :--- | :--- | :--- | :--- |
  | 1 | askApproval：signal 原样交给卡片构建器 | `tests/run.test.mjs:403` | `fallbackSelect(question, { signal })` 拿到的是同一个 AbortSignal |
  | 2 | 取消（点停止）：signal 到 selectRows，卡片被杀后按「跳过」结算 | `tests/run.test.mjs:418` | 2s 内 settle（旧代码永远挂着）、`approved === 0`、一行都没执行 |
  | 3 | 断链归因：没有退出码的 close | `tests/run.test.mjs:456` | `dropped === true`、`exitCode === null`、文本含「连接中断 / 命令可能未执行完」、**不含**「退出码 1」「退出码 无」 |
  | 4 | 断链：close 没带退出码 → dropped 且丢掉连接 | `tests/pool.test.mjs:244` | `close(undefined, null)` ⇒ `dropped`，`entries` 清空；正常退出 `dropped === false` |
  | 5 | 远端进程被信号杀掉不算断链 | `tests/pool.test.mjs:261` | `close(undefined, 'KILL')` ⇒ `dropped === false`（这条边界不能被「拿不到 code 就算断链」吞掉） |
  | 6 | 卡片退出但 stdio 没关 → selectRows 立刻结算、按跳过处理 | `tests/dialog.test.mjs:92` | 假句柄「进程退出、管道永不 close」，1.5s 内 settle；`graceMs <= 1000`；`terminate()` 被调用；`waitForExit()` 一次都不调（它等的是「树空了」，孤儿在时永不返回） |
  | 7 | 答完（退出码 0）读回结果并收树 | `tests/dialog.test.mjs:106` | 正常路径也 `terminate()`；且**没有** `-AutoCloseMs`（这次不加卡片自超时） |
  | 8 | 取消：signal 到子进程、abort 后立即结算并收树 | `tests/dialog.test.mjs:119` | `spec.signal` 是同一个对象、1.5s 内 settle、`terminate()` 被调用 |
  | 9 | 密码卡与确认卡同样退出即结算 | `tests/dialog.test.mjs:131` | `askPassword` 仍能从 stdout 读回密码；两张卡都收树 |

- **怎么复验**：
  - `cd dsh-ssh-remote && node --test --test-isolation=none "tests/*.test.mjs"` →
    **119 项全通过 / 0 失败**（admin 13、copy 33、dialog 4、pool 23、run 25、state 15、wsl 6）；
  - `pwsh -NoProfile -File tests\card-shell.ps1` 40/40、`shared-ui-guard.ps1` 10/10、
    `preferences.ps1` 34/34、`card-placement.ps1` 12/12；
  - **真人验证（只能人做，需要重启宿主后才生效）**：
    ① 重启 DSH（新的 `lib/*.mjs` 才会被加载）；
    ② 让一次 `ssh_run` 弹出勾选卡，**什么都不点**，直接点会话里的「停止」→ 工具应在
       1 秒内结束（返回「没有执行…/一行都不执行」或直接被标成已取消），**卡片窗口同时消失**；
    ③ 任务管理器里不该再有这次卡片留下的 `msedgewebview2`（原来是 3 个孤儿）；
    ④ 再跑一次正常的「勾一行 → 提交」确认卡片还能正常用；
    ⑤ 顺手验断链文案：拔网线/重启目标机后跑一条命令，结果应是
       `❌ … · 连接中断 · …ms` + `错误：与 <地址:端口 · 别名> 的连接中断（命令可能未执行完）`，
       而不是「退出码 无」。
- **没做的（范围外）**：没有给卡片加 `-AutoCloseMs` / 自超时（BACKLOG #6/#14）；没有在工具层加总
  deadline（B 方案已被否）；`copy.mjs` 的搬运失败文案没有改成断链措辞（这一轮只要求 `ssh_run`
  的归因，搬运那侧的 `目标端写入失败（退出码 null）` 是另一个坑，等它自己进 BACKLOG）。

---

## D-27 任务栏里认不出、弹出来会漏看：只换窗口图标 + 闪任务栏 + 橙色描边（不置顶）

- **现象**：卡片的窗口图标是系统默认程序图标，任务栏和 alt-tab 里跟一堆终端窗口混在一起，
  扫一眼分不出哪个是 DSH 的卡片；卡片又是不抢焦点的通知式弹窗，弹在别的窗口后面时用户
  **根本没注意到它出现过**，于是「怎么没反应 / 我是不是没点」反复发生。
- **判定**：是问题。判定标准不是「好不好看」，而是**能不能一眼识别 + 能不能不漏看**：
  ① 任务栏 / alt-tab 里的图标要与终端窗口区分开；② 弹出来时必须有非视觉的提示（闪烁）；
  ③ 不可以用「压到最前面」来解决——那会打断用户正在做的事。
- **为什么换图标不能只换图标**：图标只在用户**看向任务栏时**起作用，它解决的是「这是谁」；
  「弹出时我根本没看见」是另一件事，得靠任务栏闪烁把人叫过来。反过来只闪不换图标也不够：
  任务栏里仍然分不出哪一个是卡片、和 ssh 终端窗口长得一样。所以**三件互不替代**：
  窗口图标（识别）、任务栏闪烁（叫注意）、描边颜色（窗口真正露出来时的边界）。
- **根因**：
  - `webview2.ps1` 建窗时只设了 `ShowInTaskbar` 与 `$form.Text`，**从没设 `$form.Icon`**，
    WinForms 就用默认程序图标；
  - `environment.ps1` 里其实已经有 `Invoke-TaskbarFlash`（`FlashWindowEx` + `FLASHWINFO`，
    声明也早就在 `DshUiCard.Native` 里），但**从来没有人调用**，等于死代码；
  - 窗口显示路径 `Invoke-CardForceShow` 用 `HWND_TOPMOST` 把窗口强制抬到最上层，
    而且 `SetWindowPos` 的 flags 里没有 `SWP_NOACTIVATE`——置顶 + 激活，等于**压住用户当前的窗口**。
- **结论 / 为什么**：
  - **窗口图标**：新增 `assets/make-icon.ps1` 生成 `assets/card.ico`（16/32/48/256 四档，入库），
    `webview2.ps1` 用 `Get-CardWindowIcon` 读它并设 `$form.Icon`；文件缺失或读坏只往 stderr
    写一次说明，然后照常用默认图标开窗——图标缺失不该拦住一次审批。
  - **图标造型与配色**（B-25）：**透明背景上直接画内容**——`>` 折线（圆头、圆转折）+ 一条短下划线
    `_`，也就是终端提示符「`>_`」；不铺任何实心色块托底。颜色是 **antd 调色板 orange-6 = `#FA8C16`**
    （第 6 档，标准色阶；`make-icon.ps1` 里有注释标明出处——图标在窗口层绘制、拿不到 antd token，
    这是 B-20 允许的「写死并说明」）。小尺寸不靠等比缩小：16 档单独给整数/半像素坐标与更细的线宽，
    否则两条臂会在拐点糊成一团（实测 2.2px 的版本 16×16 下就是一团橙色）；32/48 等比，256 保细节。
  - **ICO 只装 DIB**：四档都是 32bpp 的 DIB（XOR 图 + 全 0 的 AND 掩码，透明由 alpha 决定），
    不用 PNG 压缩条目——GDI+ 对 PNG-in-ICO 的支持一直不可靠，而 DIB 是所有 Windows 版本都认的老格式。
    一个已知限制：GDI+ 的 `Icon` 尺寸选择只到 48（`Icon(path, 256, 256)` 会退回 48），
    所以 256 那档是给 Windows 外壳 / 高 DPI 场景用的，断言按**目录项 + 独立预览图**验证，不靠 `Icon` 选它。
  - **任务栏闪烁**：`ShowWindow` 之后调一次 `Invoke-TaskbarFlash`，`FLASHW_TRAY(2) | FLASHW_TIMERNOFG(12)`
    = `dwFlags 14`，`uCount 5`（3–5 次之间）；只闪任务栏按钮、不闪标题栏，窗口已经是前台时不再闪。
    它只抬注意、不抬窗口，是**不置顶之后唯一「别漏看」的手段**。P/Invoke 仍加在已有的
    `DshUiCard.Native` 里（已有 `FlashWindowEx` 声明，没有开第二个 `Add-Type` 类型）。
  - **不置顶（本轮反转过一次）**：先按「别漏看」的直觉把 `-TopMost` 改成默认 true 并给审批卡传实参，
    **用户实测后明确说「不想置顶了，影响使用，全部取消置顶」**——理由是置顶会压住用户正在操作的窗口，
    审批卡本身又不是必须马上处理的东西。于是回到：`-TopMost` 默认 `$false`、删掉插件里唯一的
    `-TopMost` 实参（`dsh-approval-notifier/scripts/ui/card.ps1`，`Show-CardWindow` 那行），
    `Invoke-CardForceShow` 也不用 topmost 插入位置：改成 `HWND_TOP(0)` +
    `SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_SHOWWINDOW`（`0x0053`），**只显示、不抬层、不激活**。
    仍然不调用 `SetForegroundWindow` / `Activate`：不抢焦点这条一直没变（C-01）。
  - **描边橙色**（B-26）：`App.tsx` 的 `card-border` 从 `token.colorBorderSecondary`（灰）改成
    **`token.colorWarning`**（antd 的 warning 一档是橙色系）。为什么不是 `orange[6]`：
    `@ant-design/colors` **不在 `app/package.json` 的依赖里**（只是 antd 的传递依赖），
    而 `tests/card-shell.ps1` 有一条「只允许 antd/react/vite 这些依赖」的守卫——直接 import 一个
    未声明的包，等于让产物悄悄依赖 node_modules 里恰好存在的东西；把它提升成正式依赖又要改
    `package.json` + lockfile、装包、再重建，这轮只改颜色来源，不顺手改构建面。
    所以先用组件库自己的 token，颜色不手写、也不新增依赖；将来要精确到 `orange-6` 再把
    `@ant-design/colors` 提成正式依赖（那是一次独立的构建变更）。
    **粗细仍是 1px**，只换颜色：先看颜色够不够辨认，不够下一轮再调粗，不一次改两样。
  - **窗口标题不动**：用户明确「只改任务栏图标」，`$form.Text` 仍是调用方传的 `-WindowTitle`
    （ssh 是 `dsh-ssh-remote`），这一轮没有改成卡片抬头——留作以后单独决定。
  - **卡片内部视觉不动**：不加 logo、不加角标、不改布局、不改间距（用户原话「卡片不加图标」）。
- **被否的方案**：
  - **纯色方块里再放一个图形**（橙色圆角方块 + 白色 `>_`）：B-25 明确否掉（「不喜欢那种纯色背景再加内容，
    我喜欢直接绘制内容」），任务栏小尺寸下也会变成一块橙色方块，反而更难认。
  - **系统默认图标 / 用一个系统自带图标**：认不出是 DSH 卡片，也区分不了一次执行确认和密码卡；桌面图标
    语义也不对（C-09 那类「用错图标语义」的问题）。
  - **只换图标，不闪任务栏**：解决不了「弹在别的窗口后面根本没看见」——那是本次现象的主因。
  - **置顶（默认 true）**：实现并实测过，用户认为压住正在操作的窗口、影响使用，已整体撤销。
  - **只闪不换图标**：任务栏里仍与其他终端窗口混在一起，仍然分不出「这是卡片」。
  - **给卡片加角标 / 内部 logo**：用户明确不要（卡片设计不动）。
- **断言改动表（旧值 → 新值 + 位置）**：

  | # | 改动 | 位置 | 说明 |
  | :--- | :--- | :--- | :--- |
  | 1 | 新增 4 项 | `tests/card-shell.ps1`（40 → 44 项） | `$form.Icon` 从 `assets\card.ico` 加载且缺文件不崩；`Invoke-TaskbarFlash` 在 `Invoke-CardForceShow` 之后调用一次、`dwFlags 14`、`uCount 3–5`、P/Invoke 仍只有一个 `Add-Type`；`TopMost` 默认 false + 产品脚本里没有 `-TopMost` 实参 + 不出现 topmost 插入位置；`App.tsx` 不再用 `colorBorderSecondary`、描边用橙色 token |
  | 2 | 新增文件 8 项 | `tests/card-icon.ps1` | 资产存在、可加载、四档尺寸、每档 32bpp DIB 且头里的宽高对得上、透明底、橙色线条（16 档可见像素 ≥30）、256 预览、生成脚本还在并注明 orange-6 |
  | 3 | 观察面收窄 | `tests/shared-ui-guard.ps1` 第 5 条 | 「正式路径里没有调试符号」不再扫 `shared/ui-card/assets/`：`make-icon.ps1` 是**生成图标的构建期脚本**，`System.Drawing.Bitmap` 是画布，不是运行路径上的截图/出图代码；其余目录、其余符号一个没放宽 |
  | 4 | 断言值翻转 | `dsh-approval-notifier/tests/card-select.ps1` | 旧：`MockCall.TopMost -ne $true` → 报「没有置顶」；新：`-ne $false` → 报「仍在置顶」。**需求本身反了**（用户要求全部取消置顶），不是为了让实现通过而放宽 |
  | 5 | 其余 | — | `card-shell` 原有 40 项、`card-placement` 12 项、`shared-ui-guard` 其余 9 项、`preferences` 34 项全部原样通过；只新增用例，没有改观测面 |

- **怎么复验**：
  - 纯逻辑：`& tests\card-shell.ps1` → 44/44；`& tests\card-icon.ps1` → 8/8；
    `& tests\card-placement.ps1` → 12/12；`& tests\shared-ui-guard.ps1` → 10/10；
    `& tests\preferences.ps1` → 34/34；`& dsh-approval-notifier\tests\card-select.ps1`、
    `& dsh-ssh-remote\tests\card-select.ps1` → 全部通过。
  - **真人看（只能人做，C-09）**：真弹一次勾选卡与审批卡——① 任务栏里是橙色 `>_` 图标、与终端窗口区分得开；
    ② alt-tab 里同样认得出；③ 弹窗出现时**任务栏按钮闪几下**，且**没有被压到最前面**（用户正在操作的
    窗口仍在上面、输入焦点没被抢走）；④ 卡片内部长相与之前一致（没有多出图标/装饰）。
  - **离屏图采样描边**（协调会话提权出图）：`debug/render.ps1 -Backdrop` 出图后采样卡片最外圈 1px，
    颜色应是 `token.colorWarning`（橙色系），不再是灰色 `colorBorderSecondary`；粗细仍是 1px。
  - 图标长相的离屏证明：`assets/card-256.png`（256×256 预览，透明底）。
- **没做的（范围外）**：
  - 没有改窗口标题（`$form.Text` 仍是调用方传的 `-WindowTitle`），也没有把标题改成卡片抬头；
  - 没有给卡片内部加任何图标/装饰；
  - 没有改描边粗细（仍 1px）、圆角（仍 0）、布局与间距；
  - 没有把 `@ant-design/colors` 提成正式依赖（要改 `package.json` + lockfile 并重建，是独立变更）；
  - 没有跑离屏渲染与构建：`dist/index.html` 仍是旧产物，`App.tsx` 的描边改动要等协调会话
    重建产物后才生效（构建是提权操作）。

---

## D-28 任务栏闪烁：先从「完全没闪」改成「闪几秒」，真机又变成「一直闪不停」——埋点定性 + 显式 FLASHW_STOP 收尾

- **现象（两轮）**：
  - 第一轮：D-27 交付的三件「别漏看」手段里，图标、不置顶、停止即结算、断网归因都验过了，
    唯独**任务栏闪烁在真机上一次都没出现**（用户原话「可以确认没有闪烁」）。
  - 第二轮（按用户要求「应该是闪烁几秒 而不应该一直闪」把 flags 改成 `FLASHW_ALL` + `uCount 5` +
    `dwTimeout 500` 之后）：**一直闪不停，直到卡片关掉**（用户原话）。埋点日志只有一行 flash、
    没有 stop——也就是说 `uCount` / `dwTimeout` 到点了，**但没人去停，它就不停**。

- **判定**：是问题，而且不是「好不好看」。B-27 把「怕漏看」整个押在任务栏闪烁上
  （「不置顶，怕漏看就靠任务栏闪烁」），闪烁不发生 = 唯一防漏看手段为空；闪烁不停 = 反过来变成骚扰，
  用户会以为卡片卡住了。判定标准：**弹卡时必须有一个不依赖置顶、不依赖用户正好看向那块屏幕、
  而且会自己结束的可见提示**。
- **根因**（分三层，前两层是代码事实，第三层要靠日志确认）：

  1. **flags 的语义错了，而且错得很有针对性**。`dwFlags = 14` 是 `FLASHW_TRAY(2) | FLASHW_TIMERNOFG(12)`。
     `FLASHW_TIMERNOFG` 的语义是「**一直闪，直到窗口到前台为止**」。这带来两个后果：
     - 窗口**本来就在前台**时，它什么都不做——而 ssh 那三张卡（`dsh-ssh-remote/scripts/ui/card.ps1`
       的 94 / 157 / 202 行）全都传 `-Activate`，`Invoke-CardForceShow` 因此走 `ShowWindow(SW_RESTORE=9)`，
       这个命令**会激活窗口**。也就是说：卡片最想闪的那类调用，正好落在「按语义不闪」的分支里。
     - 就算窗口不在前台，它也是**一直闪到用户去点为止**——用户明确否了：
       2026-10-29「应该是闪烁几秒 而不应该一直闪」。
  2. **时机可疑，但还没证据**。`Invoke-CardForceShow` 的修法是「`ShowWindow` + `SWP_SHOWWINDOW`」：
     宿主用 `STARTUPINFO.SW_HIDE` 顶掉本进程第一次 `ShowWindow`，所以窗口真正变可见是 `SetWindowPos`
     那一下。而任务栏按钮由外壳（explorer）**异步**建，`FlashWindowEx` 紧跟其后在同一条语句序列里发出，
     可能落在「按钮还不存在」的时刻。这条只有日志里的 `shownToFlashMs` + 真机现象能定性。
  3. **不是 `cbSize` 的问题**：`cbSize` 与 `Marshal.SizeOf` 取的是同一个值（本机 x64 实测 **32** 字节，
     与 Win32 定义 `4 + 4pad + 8 + 4 + 4 + 4` 对齐到 8 一致），两边同源，不可能算错。

  之所以先写埋点再改：这三层里只有第 1 层是确定的，第 2 层靠读代码推不出来，第 3 层需要被排除。
  「猜一个改一个」正是这类问题最贵的做法（改完还是看不见，就不知道是没修对还是没修到）。

- **第二轮的埋点结论（这就是「先取证再修」换来的东西）**：真机那一行是
  `visible=true, isForeground=false, flags=3, uCount=5, dwTimeout=500, cbSize=sizeOf=32, flashReturn=0`
  —— **参数全对、调用也确实进去了，但闪没有在 5 次后停**。于是三层根因里：
  - 第 3 层（`cbSize`）**排除**：`cbSize == sizeOf == 32`；
  - 第 2 层（任务栏按钮还没建出来）**排除**：闪的时候 `visible=true`，说明按钮存在、闪起来了；
  - 第 1 层的真相**换了位置**：问题不在 flags 选错，而在**「谁来停」**。

- **真根因：非前台窗口的「请求注意」（flash）是持续状态，不是一次性动画。**
  窗口不在前台时，Windows 把这个窗口标记成「需要用户注意」，外壳就一直闪它的任务栏按钮，
  **直到那个窗口被激活为止**——`uCount` / `dwTimeout` 在这种情形下**压不住它**（它们只影响闪烁节奏，
  不影响「什么时候结束」）。所以只发一次 `FLASHW_ALL` 是**停不下来**的，真机「一直闪不停直到卡片
  关掉」正是这个语义：窗口一直没被激活 → 外壳就一直闪 → 卡片关掉、按钮消失才停。
  这跟 `FLASHW_TIMERNOFG(12)` 想表达的东西是同一件事的两面：`TIMERNOFG` 是**明确要求**「一直闪到
  前台」，而我们不带它时，非前台场景的默认行为**本来就是这个**。

  因此「闪几秒就停」**只能显式做**：约 2.5 秒后自己发一次 `FLASHW_STOP`。

- **结论 / 为什么**：
  - **埋点（先做，长期保留）**：新增 `Write-CardFlashLog`（`environment.ps1`），每次闪烁追加**一行
    JSON** 到 `%TEMP%\dsh-card-flash.log`（`[System.IO.Path]::GetTempPath()`），**只留最近 20 行**。
    记的字段：`ts / card（窗口标题，区分哪张卡）/ position / activate / showInTaskbar /
    showWindow·visibleBefore·visibleAfter（Invoke-CardForceShow 的返回值）/ shownToFlashMs（从 ShowWindow
    到 FlashWindowEx 之间过了多少毫秒）/ hwnd / cbSize / sizeOf / dwFlags / uCount / dwTimeout /
    visible（闪之前 IsWindowVisible）/ isForeground（GetForegroundWindow() == hwnd）/ foregroundHwnd /
    flashReturn / lastError`。
    约束：**任何失败都不抛**（写不出来就静默跳过，绝不允许埋点把一次审批弄坏）、一次调用只写一次、
    默认常开（自己用的机器，留几天日志没成本）。
    `FlashWindowEx` 的返回值是「调用前窗口是否画成活动态」，**不是**成功/失败（`0` 恰恰是「不活动」＝
    该闪的前提）；`lastError` 只在声明带 `SetLastError` 时才有意义，照样记下来用于发现「根本没调成功」。
  - **flags 改成 `FLASHW_ALL`（3）**：`FLASHW_CAPTION(1) | FLASHW_TRAY(2)`、`uCount = 5`、`dwTimeout = 500`
    —— **5 × 500ms ≈ 2.5 秒的节奏**（是节奏，不是时长，见上面真根因）。`dwTimeout` 特意不给 0
    （0 = 跟系统光标闪烁节奏走，节奏就不由我们定了）。**不用 `FLASHW_TIMERNOFG(12)`**：它的语义就是
    「一直闪到窗口到前台为止」，正是用户否掉的行为；而且在非前台场景，不带它也会得到同样的「一直闪」。
  - **停止靠显式 `FLASHW_STOP`（0）**：新增 `Stop-TaskbarFlash`，`dwFlags = 0`、`uCount = 0`、
    `dwTimeout = 0`、同一个句柄——这是唯一能保证「闪几秒就停」的手段（不要它停，它就一直闪）。
    停止前先 `IsWindow(handle)` 判活：用户可能在 2.5 秒内就把卡关掉了，那时句柄已经销毁，再发就是白发；
    异常一律吞掉，绝不允许影响关窗。
  - **谁来发这个 stop：`[System.Windows.Forms.Timer]`（2500ms，一次性）**。`Invoke-CardWebView` 里
    **没有 `Application.Run`**，卡片的事件循环是 `Application.DoEvents()` 泵（每 10ms 一次），而 WinForms
    Timer 正是靠消息泵跑 WM_TIMER 的——已单独验证：`Interval=500` 的 Timer 在纯 `DoEvents` 循环里
    **准点触发一次**（实测 514ms），`Stop()+Dispose()` 之后不再触发；拿隐藏窗口跑完整链路，stop 落在
    **2539ms**。Tick 里先 `Stop()`/`Dispose()` 再调 `Stop-TaskbarFlash`；窗口层在 `finally` 里第一件事
    就把它摘掉（`remove_Tick` + `Stop` + `Dispose`），所以卡片提前关掉时不会补射一行「句柄已销毁」的 stop。
  - **P/Invoke 顺手修了两处**：`FlashWindowEx` 补上 `SetLastError = true`（原来没有，日志里的
    `lastError: 203` 是无关残留、会误导人）；新增 `IsWindow` 声明，加在同一个 `DshUiCard.Native` 里
    （不开第二个 `Add-Type`）。
  - **日志补了 `kind` 与停止侧字段**：`kind: "flash"` / `kind: "stop"`；stop 那行记 `stoppedAtMs`
    （相对 flash 的毫秒，正常 ≈2500）、`isWindow`、`stopReturn`；flash 那行加 `retNote` / `errNote`
    两句话，把「返回值 = 调用前窗口是否已画成活动态，0 是正常」写在数据里，避免下次又被 `lastError` 带偏。
  - 一个必须写清的**事实**：卡片是 `FormBorderStyle.None` 的无边框窗口，**没有标题栏可闪**，所以
    `FLASHW_CAPTION` 这一半在卡上没有任何可见效果，真正起作用的是任务栏按钮那一下。保留 `ALL`
    是为了语义完整（真要看见标题栏闪，得先给它一个标题栏，那是另一件事）。
  - **本次真机的另一个收获**：日志是 `isForeground: false` —— 说明传 `-Activate` 的那张卡**并没有真的
    抢到前台**（Windows 的前台锁把 `SW_RESTORE` 的激活挡掉了），所以第一轮「按语义不该闪」这条猜测
    **不成立**，闪烁其实一直在发生，只是停不下来。若以后 `isForeground` 为真（前台窗口的任务栏按钮本来
    就处于活动态、又无标题栏可闪），那时的处置是**在下面两个方案里选**（都属产品决定，不自行实现）：
    ① 调用方不再传 `-Activate`（与 C-01「不抢焦点」、B-27「不置顶」一致），闪烁就有对象了；
    ② 接受「已经在前台＝这张卡本来就在你眼前」，把「别漏看」交给别的信号（任务栏进度态 /
       任务栏按钮叠加标记），闪烁只作为后台场景的手段。
    两条都不许反向做成「为了看见闪烁而让卡片抢前台/置顶」。
- **被否的方案**：
  - **继续用 `FLASHW_TIMERNOFG`（14）**：它的语义就是「一直闪到窗口到前台为止」——本轮要的正好是反的
    （闪几秒就停），而且前台时它什么都不做。
  - **指望 `uCount` / `dwTimeout` 到点自己停**：真机已经证伪（`5 × 500ms` 参数全对，仍一直闪到关窗）。
    非前台窗口的「请求注意」是**持续状态**，只有激活该窗口或 `FLASHW_STOP` 能清掉。
  - **`Start-Sleep` 2.5 秒后再停**：会卡住宿主线程（这 2.5 秒里卡片不响应、页面不刷新、用户点不动），
    而且是同步阻塞，等于用「卡住」换「停下」。
  - **另起一个进程 / 线程去 sleep 再停**：多一个进程只为等一个时间点，句柄还得跨进程传；本函数本来就有
    消息泵，没有必要。
  - **在 `FlashWindowEx` 之后 sleep 一段时间再看结果**：没有任何可观测输出，只会拖慢弹窗；
    要的是日志不是等待。
  - **纯 `FLASHW_TRAY(2)` 不带 CAPTION**：语义上没错（卡上本来只有任务栏按钮能闪），但 `ALL` 更完整，
    且省下的那一个位没有任何收益，反而要写一段「为什么只要 TRAY」的解释。
  - **靠置顶/抢前台保证「看得见」**：B-27 已实测否掉（压住正在操作的窗口），C-01 也不允许。
  - **只在失败时写日志**：失败的定义本身就是要查的东西（「没闪」不是错误码），只在失败时写等于什么都写不下来。
  - **给埋点加开关**：自己用的机器，常开最省事；能重试的东西不做配置项。
- **断言改动表（旧值 → 新值 + 位置）**：

  | # | 改动 | 位置 | 说明 |
  | :--- | :--- | :--- | :--- |
  | 1 | 拆分：原「闪烁：ShowWindow 之后调用一次任务栏闪烁（FLASHW_TRAY \| FLASHW_TIMERNOFG）」只剩调用点与 P/Invoke 唯一性；flags/次数/节奏移进新用例 | `tests/card-shell.ps1` | 旧断言要求 `dwFlags = 14`、`uCount = [3-5]`；新断言要求 `dwFlags = 3`、`uCount`/`dwTimeout` 为有限正整数、且 `uCount × dwTimeout` 落在 2000–3000ms。**需求本身变了**（用户要「闪几秒就停」），不是为了让实现通过而放宽 |
  | 2 | 新增 1 项（44 → 45 项） | `tests/card-shell.ps1` | 「闪烁：节奏有限（FLASHW_ALL、5 × 500ms = 2.5 秒），不再用 FLASHW_TIMERNOFG」：代码里（**剔除注释**，`<# #>` 与 `#` 行都不算）不许出现 `TIMERNOFG`、不许出现 `dwFlags = 14`，必须出现 `dwFlags = 3`，并按时长公式算总时长 |
  | 3 | 新增 1 项（45 → 46 项） | `tests/card-shell.ps1` | 「闪烁：约 2.5 秒时显式 FLASHW_STOP 停」：必须有 `Stop-TaskbarFlash`、停止侧 `dwFlags/uCount/dwTimeout` 全 0、`IsWindow($Handle)` 判活、窗口层用 `System.Windows.Forms.Timer` + `Interval` + `add_Tick` + 调 `Stop-TaskbarFlash`，且不许 `Start-Sleep -Milliseconds 2500`（旧实现里没有这条路径，属**新增观察面**，不是放宽） |
  | 4 | 其余 | — | `card-shell` 其余 43 项、`card-icon` 8 项、`card-placement` 12 项、`shared-ui-guard` 10 项、`preferences` 34 项全部原样通过 |

- **怎么复验**：
  - 纯逻辑：`& tests\card-shell.ps1` → 46/46；`& tests\card-icon.ps1` → 8/8；
    `& tests\card-placement.ps1` → 12/12；`& tests\shared-ui-guard.ps1` → 10/10；
    `& tests\preferences.ps1` → 34/34；`& dsh-approval-notifier\tests\card-select.ps1`、
    `& dsh-ssh-remote\tests\card-select.ps1` → 全部通过。
  - 埋点与停止链路自检（不建窗、不提权、不弹任何窗口）：dot-source `environment.ps1` →
    `[System.Runtime.InteropServices.Marshal]::SizeOf([type]'DshUiCard.Native+FLASHWINFO')` = **32**；
    连写 25 次后日志恰好 **20 行**；把 `$script:FlashLogPath` 指到不存在的目录，`Invoke-TaskbarFlash`
    仍然**不抛**；**隐藏窗口**（只 `$null = $form.Handle`、不 Show）跑一遍 flash + Timer + stop：
    `StopAfterMs = 2500`、stop 行 `stoppedAtMs ≈ 2539`、`isWindow = true`、`dwFlags/uCount/dwTimeout = 0/0/0`；
    先 `$form.Dispose()` 再 `Stop-TaskbarFlash` → `isWindow = false`、不调用、不抛。
  - **真人看（只能人做，C-09）**：真弹一张卡，看任务栏按钮**闪约 2.5 秒后停下、且不需要点它**；
    日志应出现成对的 `kind:"flash"` + `kind:"stop"`（`stoppedAtMs` ≈2500）。
- **日志判读表（下次真机看两行就够）**：

  | 看到什么 | 说明什么 | 下一步 |
  | :--- | :--- | :--- |
  | `kind:"flash"` 之后**没有** `kind:"stop"` | 定时器没跑起来（消息泵没泵到 / 卡片在 2.5 秒内就关了） | 前者查 Timer 与 DoEvents；后者属正常（窗口没了，闪也没了） |
  | `kind:"stop"` 的 `isWindow: false` | 停的时候卡片已经关了 | 正常，不必处理 |
  | `kind:"stop"` 的 `stoppedAtMs` 明显大于 3000 | 消息泵被什么堵住了（宿主线程忙） | 查是不是有同步阻塞（`Start-Sleep`、长 I/O） |
  | 有 stop 但人眼仍一直闪 | `FLASHW_STOP` 没清掉请求注意（极端情形） | 再退一步：激活窗口或改用任务栏进度态（要用户拍板） |

- **没做的（范围外）**：
  - 没有改 ssh 三处 `-Activate`、没有改 `Invoke-CardForceShow`（`SW_SHOWNOACTIVATE` / `SW_RESTORE` 的选择）——
    日志已证明「`-Activate` 也抢不到前台」，那是另一个话题；
  - 没有把闪烁挪到 `{type:'shown'}` 之后：第二轮的日志 `visible=true` 已经排除「按钮还没建出来」，
    不需要再挪时机；
  - 没有删日志（默认常开、只留 20 行，用户自己看几天）。

---

## D-29 代码高亮接 Shiki：JS 正则引擎 + 同步分词，高亮在 measure 之前就定格（K-012 / B-10）

- **现象**：`<pre data-part="code">` 里的命令一直是纯文本——`#` 注释、引号里的路径、`if/then/fi`、
  `Get-ChildItem` 全同色。`types.ts` 的 `CodeBlock.lang` 字段从引入那天就在传（`card-html.ps1` 默认 `'sh'`），
  但没人读它。B-10 早就定了「代码高亮用 Shiki」，只是一直排在「外壳稳定之后」。
- **判定**：是问题，且判据不是「好看」：卡片里最长的一段内容就是命令，审批卡的全部价值是
  「让人看清要执行什么」。全都同色时，注释与参数分不开，`--dry-run` 这种要命的后缀也淹没在字里行间。
- **根因**：三件事叠在一起，缺一条都不成——
  ① 高亮没接；
  ② 接了也不能用 oniguruma：它要 `onig.wasm` 外链，而产物必须是**一个** `dist/index.html`（D-02，
     `card-shell.ps1` 的「JS 与 CSS 全部内联」守着）；
  ③ 高亮若晚于 `ready` 完成，宿主量到的是纯文本高度，高亮后即使字体族不变、折行点也可能变，
     卡片会跳高或被截断。所以要定的其实是**「用哪种分词方式」+「什么时候算完」**，不是「换个渲染函数」。
- **候选**（引擎 / 时机 / 语言，三组）：
  - 引擎：a) oniguruma wasm；b) **Shiki 的 JS 正则引擎（采纳）**。
  - 时机：a) 异步 `createHighlighterCore` + 「await 高亮完再发 ready」；b) **同步 `createHighlighterCoreSync`
    + `codeToTokens`，首次 render 就算完（采纳）**。
  - 语言来源：a) 只信载荷里的 `lang`；b) **别名表 + pwsh 特征嗅探（采纳）**。
- **结论 / 为什么**：
  - **JS 正则引擎**：`createJavaScriptRegexEngine()`，只按子路径引 `shiki/core`、
    `shiki/engine/javascript`、`shiki/langs/{shellscript,powershell}.mjs`。不引 `shiki` 根入口
    （根入口带全部语法/主题的懒加载表，等于把几百种语法拖进单文件产物），也不引 `shiki/wasm`。
    产物仍是**一个 HTML**，`card-shell.ps1` 的内联断言一条没动。
  - **同步分词 = 高度定格（本次最大的风险点）**：`createHighlighterCoreSync({ themes, langs, engine })`
    在第一次用到时建一次（模块级缓存；失败也记住，之后一律纯文本）；`codeToTokens()` 是纯同步调用；
    `CodeText` 在 render 期用 `useMemo` 取结果。于是**宿主 measure 到的 DOM 里已经是最终文本**，
    `ready{height}` 报的就是高亮后的高度，之后不会再变宽变高。
    这比「await 完再发 ready」更强：后者把 ready 挂在一个 promise 上，等的那段时间正好会撞上
    `webview2.ps1` 的 `$readyTimeoutMs = 2000`——一旦超时，宿主按 360 的兜底高度显示，
    高亮回来时高度照样会变，等于把要防的事挪了个位置。同步方案里**根本不存在这个时间窗**。
  - **语言**：`SHELL_LANGS`（sh/shell/bash/zsh/shellscript/console/shellsession）与
    `PS_LANGS`（powershell/pwsh/ps1/ps/posh）。**声明的 shell 只当弱提示**：命令里出现 `$x =`、
    `Cmdlet-Noun`（如 `Set-Content`）、`param(` / `#requires` 就按 powershell 分词。
    原因是上游两个插件都把命令标成 `sh`（`New-CardCodeBlock` 的默认值），其中审批卡的命令其实是 pwsh；
    只信字段就永远涂错，而改上游要动两个插件目录（本轮禁改），也不如「按内容认」稳。
    行内命令没有 `lang` 字段，按 `sh` 传（一行只承载一条命令），pwsh 特征同样会被认回来。
  - **降级（三层，全部退纯文本，卡片照常弹）**：语言认不出（`sql`、空串、没有 `lang`）→ 纯文本；
    highlighter 初始化失败 → 记住失败、之后全部纯文本；`codeToTokens` 抛错 → `catch` 后纯文本。
    另外**分词结果拼回去必须与原文逐字相同**，否则也退纯文本——高亮只负责上色，不许改写命令原文（C-08）。
    退化的那条路径就是换高亮之前的那行 `{block.command}`，不是第二套渲染。
  - **主题走 css-variables**：`createCssVariablesTheme({ name: 'dsh-card', variablePrefix: '--shiki-',
    fontStyle: false })`；`--shiki-*` 变量在 `App.tsx` 的卡片根节点上一次性指到 antd token，子节点继承：
    `foreground → colorText`、`token-comment → colorTextTertiary`、`token-string` /
    `token-string-expression → colorSuccessText`、`token-keyword → colorPrimaryText`、
    `token-constant → colorWarningText`、`token-function / token-link → colorLink`、
    `token-parameter / token-punctuation → colorTextSecondary`、`token-inserted → colorSuccessText`、
    `token-deleted → colorErrorText`、`token-changed → colorWarningText`。**一个裸色值都没有**（B-20）。
  - **只改颜色**：`fontStyle:false` 让主题里不带斜体/加粗；`<span>` 只设 `color`，字体/字号/字重/行高
    一个字都没动，字体仍是 `token.fontFamilyCode`（等距更纱黑体 SC，B-02）。理由不只是洁癖：
    斜体是合成斜体、字宽可能差一点点，而高亮发生在 render 期——任何字宽变化都可能改折行点，进而改高度。
  - **缓存**：highlighter 模块级单例（一张卡里多段代码、多行命令共用）；每段代码的 token 结果按
    `lang + 源码` 缓存，同一段代码只分词一次（上限 64 条，防一张超长卡把缓存撑大）。
    本机实测：冷启首次分词 ~90ms、热调 ~0.4ms/段、5000 字符单行 ~130ms——都远在 ready 的 2 秒预算内。
- **被否的方案**：
  - **oniguruma wasm**：`onig.wasm` 必须外链，与「产物只有一个 HTML」直接冲突；把 wasm 内联成 base64
    也没选——体积翻倍、每次弹窗多一次 wasm 编译，换来的只是极少数正则语法兼容性，而目标两种语法的
    TextMate 语法在 JS 引擎上实测能完整编译、分词结果与原文逐字一致。
  - **异步 `createHighlighterCore` + await 后发 ready**：见上，会引入 2 秒就绪超时的窗口；
    而且 ready 一延后，`resize` 的 ResizeObserver 与 `shown` 的时序都得跟着改——
    为一个同步就能做到的事往协议里加分支。
  - **Prism**：要自己挑语言包、自己写主题映射，还得处理它按行切 `<span>` 的 DOM；比 Shiki 多一份
    「手写映射」的维护面，且用户 K-012/B-10 点名的是 Shiki。
  - **highlight.js**：同上，且 TextMate 语法对 shell / pwsh 的覆盖更细；用户同样点名 Shiki。
  - **纯 CSS / 自写正则伪高亮**（把 `#` 注释、引号串用正则包 span）：要自己维护两套词法，
    嵌套引号、续行、here-doc 立刻涂错，等于自己写一个劣化分词器（D-04 成熟库优先）。
  - **用 `codeToHtml` 整块注入**：Shiki 会吐一个带自己 `<pre class="shiki">`、自己背景与字体的 HTML 块，
    我们外面再套 `data-part="code"` 的 `<pre>` 就成了两层 pre：`pre-wrap` 折行与 padding 全要重算，
    「DOM 契约靠这个标记」这条也会被 Shiki 的 pre 抢走。所以只用 `codeToTokens`，DOM 仍是我们自己的。
  - **保留 fontStyle（斜体注释 / 加粗关键字）**：理由见上「只改颜色」——合成斜体的字宽差异会威胁高度定格。
  - **在 PowerShell 侧把 `-Lang` 改对**：两个插件目录本轮禁改；而且「命令真实语言」按内容判断比按调用方
    标注更准（同一张卡的正文与行可能来自不同来源），标注只留作弱提示。
- **断言变更（有意变更，不是迁就实现，按 AGENTS §3 写清改哪条/为什么）**：
  1. `tests/card-shell.ps1`「防回退：没有新的 npm 依赖」的允许清单加 `shiki`。
     `package.json` 里已经有它（用户点名、K-012，`b5f45eb` 已提交），这条断言守的是「别不小心多出依赖」，
     不是「不许用 Shiki」；改后仍然逐项比对，只多了一个**用户指定**的包名。
  2. 新增 **7 条**（46 → **53** 项），全部是「必须出现 / 必须不出现」的硬判断，没有放宽任何既有断言：
     - Shiki + 只装 `shellscript` / `powershell` 两种语法，且不许引 `shiki` 根入口；
     - 显式 `createJavaScriptRegexEngine`，代码里（**剔除注释后**）不许出现 oniguruma / wasm；
     - 纯文本退化：`try/catch`、`return null`、`CodeText` 原样输出 `{code}`、拼回原文校验；
     - DOM 契约：`data-part="code"`、`pre-wrap`、`overflowWrap`、正文与行内两处都走高亮；
     - 主题：`createCssVariablesTheme` + `--shiki-*` 变量映射到 token，高亮两文件里不许出现裸色值；
     - 只改颜色：`fontStyle:false`，`CodeText` 里不许出现 `fontFamily/fontWeight/fontSize/fontStyle`；
     - 同步 + 单例：`createHighlighterCoreSync`、不许 async/`await`、highlighter 只建一次、模块级缓存。
     第 2 条的「剔除注释再扫」沿用 D-28 的口径：注释里写「为什么不用 oniguruma/wasm」是结论，不是用法。
- **怎么复验**：
  - 类型：`shared/ui-card/app` 下 `node node_modules/typescript/bin/tsc --noEmit` → exit=0（本会话实测，无输出）；
  - 纯 PS：`& tests\card-shell.ps1` **53/53**、`& tests\shared-ui-guard.ps1` 10/10、
    `& tests\card-icon.ps1` 8/8、`& tests\card-placement.ps1` 12/12、`& tests\preferences.ps1` 34/34；
  - 高亮逻辑真跑过：把 `highlight.ts` 单独 `tsc` 成 JS 再在 node 里 import，跑 shell / pwsh / 「声明 sh 的
    pwsh」/ 认不出的语言 / 空串 / CRLF / 5000 字符单行 / 缓存命中，全部符合预期；高亮结果拼回去与原文逐字相同；
  - **构建与真机（协调会话做）**：`npm run build` 重出 `dist/index.html`。预计产物 **486 KB → 0.8 MB 量级**
    （+0.3～0.5 MB，一个数量级内：core 50 KB + primitive 29 KB + textmate 101 KB + oniguruma-to-es 61 KB
    (ESM) + 正则工具 23 KB + 两种语法 67 KB + hast 37 KB，打包压掉一部分）；仍然只有**一个** HTML、
    没有 `.wasm`、没有第二个 js/css。出审批卡与勾选卡各一张离屏图（改前/改后：注释、字符串、命令名上色；
    行高、折行、框底色、`data-part="code"` 几何不变），再真机各弹一次确认没有跳高（C-09）。
  - 构建时顺带确认两件事：产物里搜不到 `onig.wasm`；`<pre data-part="code">` 内的 `<span>` 只带 `color`。
- **遗留（范围外）**：`shared/ui-card/dist/index.html` 已由协调会话重建（704 KB，`c22609c`），
  本节不再保留「产物待构建」这类会过期的说明。`docs/` 与 `PREFERENCES.md` 的 B-10 行由文档会话维护，
  它的「校验」列早已不是待实施状态（B-10 的校验就是本节的六条高亮断言，已跑通），本文件不再转述。
  另外 `app/src` 里的注释刻意不写「ssh / 审批 / 勾选」这些词——`shared-ui-guard.ps1` 会扫外壳源码，
  这里用「远程命令 / 授权卡 / 行内命令」代替，结论写在本文件里。

---

## D-31 代码框折叠/展开 + 复制 + IDEA Light 主题 + 说明进框（B-28 / B-29 / B-30 / B-31 / B-32）

- **现象**：长命令在卡里「被省略」。用户原话是「有些很长的命令里面出现了省略，而不是内部滚动」。
  两种表现叠在一起：① 命令末尾出现 `…`；② 40 行的长命令下半截既看不到、也滚不到。
- **判定**：是问题。判据不是「好看」——这张卡的全部价值是让人看清要执行什么，
  **显示被截断 / 滚不到 = 让人在信息不全时点「允许」**。
- **根因（取证，不是猜）**：
  - `…` **不在卡片里**：`dsh-approval-notifier/index.js` 的 `SUMMARY_MAX_CHARS = 400`，
    第 289 行 `${summary.slice(0, 400)}…` 把载荷摘要截到 400 字再加省略号。
    渲染层是无辜的：`app/src/**` 里没有任何 `line-clamp` / `text-overflow` / `ellipsis`，
    产物里 `text-overflow`、`-webkit-line-clamp` 字面量各 0 处，`textOverflow:"ellipsis"`
    只出现在 antd 的 Input 占位符与 `Typography` 的 `*-ellipsis-*`（要 `ellipsis` 属性才生效，从没传过）。
  - 对照载荷五组（a1 8 行 841 字、a2 574 字单行、a3 40 行 4999 字、a4 436 字 8 行且第 400 字落在第 8 行、
    b1 行内 539 字）离屏渲染：a4 的**最后一整行完整、没有 `…`**（`contentHeight` 300，与内容相符）——
    证明 400 字以内怎么长都不会被省略号糊住；a1 379、a2 300、b1 536 也都完整。
  - a3 是另一回事：`contentHeight` **669 = 屏高 62% 的钳位值**，`bodyScrollHeight` 也是 669。
    也就是窗口自己被撑到上限，然后 `<pre>` 作为 flex 子项默认 `flex-shrink:1` 又没有 `overflow`，
    文字溢出后被 `html{overflow:hidden}` 裁掉——**框本身不能滚，下半截任何操作都到不了**。
- **结论（四条一起做）**：
  - **B-28 折叠/展开**（每框独立）：
    | 状态 | 换行 | 滚动 | 高度 |
    | :--- | :--- | :--- | :--- |
    | 折叠（默认） | 折行 `pre-wrap` + `overflowWrap: anywhere` | 不滚 | 最多 6 行（`FOLD_LINES × CODE_LINE_HEIGHT`），超出裁掉 |
    | 展开 | 不折行 `white-space: pre` | `overflow: auto` 双向 | `maxHeight: expandedCap` = 点开那一刻正文可视区的高度 |
    - **裁而不是画省略号**：折叠态是「`maxHeight` + `overflow: hidden`」。`-webkit-line-clamp` 与
      `text-overflow: ellipsis` 恰好会画那个 `…`，就是这次要修掉的观感，明确禁用（断言扫源码）。
    - **行高钉成 20px**：折叠高度要精确等于「6 行」，1 行就必须是整数像素，否则第 7 行露半行。
      代价是每行比 antd 的 1.5714 倍行高（≈19.64px）高 0.36px，整卡高 1～4px。
    - **展开不改卡片高度**：只改框内排版，`maxHeight` 取正文滚动容器的 `clientHeight`（点开时算一次）；
      内容比上限短就矮、超了就滚，所以是 `min(内容, 可用高度)`。窗口尺寸、`ready`/`resize` 一概不碰
      （`toggleCode` 里没有 `postToHost`）。
    - **折叠不切文本**：整段命令始终在 DOM 里（只是被裁），所以复制拿到的永远是全文，不存在
      「折叠后复制到半条命令」的风险（C-08）。
  - **B-29 按钮**（复制 + 展开/收起，每框一套：正文代码块与行内命令框各一套）：
    绝对定位在代码框右上角、`opacity: 0`、`pointer-events: none`，`.card-code:hover` 才显形。
    **不占布局**（absolute）、**不改高度**（measure 量到的 DOM 里它不参与排版）。
    `pointer-events: none` 是必须的：藏着的按钮若还能点，就会无声吃掉一次点击，而这张卡里
    每一次点击都算数（多选卡整行可点、审批卡只有两个按钮）。
    「展开」只在内容真的超出折叠高度时出现——判据是**真实溢出量** `scrollHeight - clientHeight > 1`，
    不是数换行符：a2 那种 574 字符的单行命令折成 8 行也必须能展开。
  - **B-30 主题 = IDEA Light 固定色**：`IDEA_LIGHT` 常量（注释 `#8C8C8C`、字符串 `#067D17`、
    关键字 `#0033B3`、常量 `#1750EB`、函数 `#00627A`、变量/参数/标点 `#000000`）在 `App.tsx` 里
    一次性指到 `--shiki-*`，两种语言共用一份。只有 inserted/deleted/changed 三档仍走 token——
    它们表达「增/删/改」，没有编辑器主题语义。
  - **B-31 说明进框**：`CodeBlock` 新增可选 `comment`，渲染成 `<pre data-part="code">` 里的**第一行**
    `# 说明`（灰注释色、同字号同字宽），和多选卡行内命令框的 `# 原因` 同一形态。`note` 块保留。
  - **B-32 复制只给命令本体**：`commandOnly()` 纯函数（`app/src/commandText.ts`）——只认「行首（可缩进）
    `#`」的整行注释，逐行删掉，再去掉首尾空行；**行尾行内注释不动**（`cmd --x  # 备注` 是 shell 语法的一部分）。
    正文块的 `comment` 本来就不在 `command` 里，行内命令的 `why` 也不在 `row.text` 里，两边都只传命令本体。
    失败静默（`navigator.clipboard` 不可用 / 拒绝都 `.catch` 掉，不弹任何东西），成功只让图标短暂变对勾
    1200ms——`C-07` 不做兜底，也不为它加第二套提示 UI。
- **被否的方案**：
  - **在 `dsh-approval-notifier` 里把 400 改大 / 去掉截断**：那才是 `…` 的源头，但本会话禁改插件目录；
    已由协调会话另派一路处理。本决定只管「卡片这一侧即使收到超长命令也不许变成省略号、也不许滚不到」。
  - **`-webkit-line-clamp: 6`**：一行 CSS 就能折 6 行，但它自带省略号，与本次目标直接冲突（见上）。
  - **折叠时把文本 `slice` 成 6 行**：DOM 里只剩 6 行，复制就会拿到半条命令（C-08 危险），
    而且展开时要么重新量高、要么另存全文；不如「限高裁切」——文本全在，只裁显示。
  - **展开时把窗口 / 卡片撑大**：会让卡片在用户点「展开」的瞬间跳高，且必须回到「量高 → SetWindowPos」
    的老路（D-21 已否掉「页内量高再改窗口」）。展开只改框内排版，窗口与卡片高度一个字不动。
  - **`text-overflow: ellipsis` + `white-space: nowrap`**：单行截断，命令中段全部丢掉，比现在更糟。
  - **每框一个 `<details>`/手风琴**：浏览器原生 `<details>` 的展开会改布局高度（相同的问题），
    而且它自带三角与默认样式，要覆盖的样式比现在写的这十几行多得多；antd 也没有「代码框折叠」这种控件。
  - **复制用 `document.execCommand('copy')` 兜底**：`navigator.clipboard` 在 WebView2（`file://` 是安全上下文）
    可用；再加一条旧路径就是「为不会失败的事做第二套实现」（C-07 / AGENTS §0）。
  - **`shiki/themes/*` 里的整包主题（`github-light` / `min-light`）**：用户点名 IDEA Light 的调色板，
    整包主题颜色不是这套，且会把整份主题表带进单文件产物。
- **与派活口径的一处偏差（必须知道）**：协调会话给的实现建议是「自己写一个 theme 对象给 Shiki
  （`{ name, type: 'light', settings: [...] }`）」。本实现**没有换掉 `createCssVariablesTheme`**，
  而是把 `--shiki-*` 指向 IDEA Light 的固定十六进制。原因：D-29 的四条既有断言锁着
  「用 `createCssVariablesTheme` + `fontStyle: false` + `highlight.ts` 里不许出现裸色值」
  （子会话不许改断言），换机制就要改这四条；而可观测结果完全相同（注释灰、字符串绿、两语言一致、
  字号字宽不变），且保留 `--shiki-*` 还能局部覆盖。代价是**配色定义在 `App.tsx` 而不是 `highlight.ts`**。
  若协调会话要求严格按 theme 对象：把 `IDEA_LIGHT` 搬进 `highlight.ts` 的 `themes: [obj]`，
  同时改 D-29 的四条断言（`card-shell.ps1` 的「主题走 css-variables…」「`fontStyle: false`」两条，
  以及 `App.tsx` 里 `--shiki-*` 的三条映射检查）。
- **断言变更（有意变更，按 AGENTS §3 写清）**：
  - `tests/card-shell.ps1` **53 → 67 项，只新增 14 条，没有改动任何既有断言**（含「没有新的 npm 依赖」
    「DOM 契约」「主题走 css-variables」——所以上面的偏差没有动摇既有约束）：
    折叠默认态与 6 行限高、源码里没有 line-clamp/text-overflow/ellipsis（**剔除注释后**扫）、
    展开不折行 + 双向滚 + 上限取正文可视区（且不许写成 `height`）、切换不上报 resize、不改卡片高度、
    两个代码框各一套按钮、按钮绝对定位 + 默认透明 + 悬停显 + 藏着点不到、IDEA Light 三色在且注释/字符串
    不再指 token、`comment` 字段与「渲染在 `<pre>` 里、位于命令之前」、`commandOnly` 是纯函数；
    **第三轮补的 4 条**：`New-CardCodeBlock -Comment`（独立字段、不拼进 command、不给就没有该键）、
    `ConvertTo-CardBlockList` 透传 comment、IDEA Light 六个色值逐个对值 + 七个 `--shiki-*` 逐个指向调色板
    常量、`string.unquoted` / `constant.other.option` 的覆盖规则在（见附录 B）。
  - 新增 `tests/command-only.ps1`：**行为断言**（真把 `commandText.ts` 跑一遍，六个用例）。
    单独一份的原因写在文件头：它要起 node，而 `card-shell.ps1` 一旦被管道/捕获运行，PowerShell
    就起不了原生程序（`StandardOutputEncoding…` / 受限沙箱下「拒绝访问」），塞进去会让门禁莫名失败。
    它必须直接运行：`& tests\command-only.ps1`。
  - 新增 `tests/card-tokens.ps1`：**着色行为断言**（真把 `highlight.ts` 跑一遍）。同样的 node 限制、
    同样的「必须直接运行」。它钉的是**结果**而不是源码：b1 那条命令里 700 个 x / `-c` / 循环字面量
    必须是正文色，`'%s\n'` / `"step $i"` 必须是字符串色，`printf` 是命令色，`for` 是关键字色；
    再加一条通项——**凡是字符串色的 token，内容必须以引号或反引号开头**（不闭合的字符串会把后面整段
    吞成绿色，这条能直接逮住）。
- **怎么复验**：
  - 类型：`shared/ui-card/app` 下 `node node_modules/typescript/bin/tsc --noEmit` → exit=0（无输出）；
  - 纯 PS：`& tests\card-shell.ps1` **67/67**、`& tests\shared-ui-guard.ps1` **10/10**、
    `& tests\preferences.ps1` **34/34**、`& tests\command-only.ps1` **PASS**、
    `& tests\card-tokens.ps1` **PASS**（本会话实测）；
  - **构建与真机（协调会话做）**：`npm run build` 重出 `dist/index.html` 后，出审批卡（8 行命令、
    40 行长命令两版）与多选卡各一张离屏图，看四处：① 折叠态是**折行**、第 6 行以后被整齐裁掉（没有 `…`）；
    ② 鼠标进代码框，右上角出现「复制 / 展开」且**卡片高度不变**；③ 点展开后长命令不折行、能上下左右滚，
    卡片仍是原来那个高度；④ 命令行首是灰的 `# 说明`、字符串是绿的，**而参数、路径、裸单词是黑的**
    （附录 B：这条第三轮才修对）。
  - 真机还要人点一次「复制」：`navigator.clipboard` 在 WebView2 的 `file://` 下应为安全上下文，
    但**只有真点一次才知道**（失败了是静默的，看不出来）。开发者工具里 `window.isSecureContext` 可先确认。
  - 查色值**不要用取色器**：这张图是子像素（ClearType）渲染的，字形边缘每个像素都是一个混色，
    取到的值必然偏；要证颜色就查 DOM（附录 B 有算式与像素统计）。
- **遗留（范围外 / 待定）**：
  - `dist/index.html` 已由协调会话重建（704 KB，`c22609c`），产物这一项不再是遗留。
  - 400 字截断在上游（`dsh-approval-notifier`），由另一路改；本决定只保证「不管多长都不许变成省略号」。
  - **折叠是否该是审批卡的默认**：默认折叠会让 40 行命令只露 6 行（信息不全的风险与「窗口别太高」之间的取舍）。
    本轮按用户口径做默认折叠；若真机上觉得不够，改成「审批卡默认展开 / 显示隐藏行数」是下一步的选项。
  - `AGENTS.md` §4 里「不要翻页器、不要「收起」」已与 B-28 冲突（用户改了口径），按分工归文档会话。
  - PowerShell 语法里参数的连字符（`-LiteralPath` 的 `-`）被语法标成 `keyword.operator.assignment.powershell`，
    于是呈关键字蓝。同一个 scope 名也用于 `$x = 1` 的 `=`，改它会让真正的运算符掉色，**本轮不动**；
    真要修得在主题里按「后面紧跟标识符」再分一层，属于新需求。

---

## 附录 A（属 D-31）：`comment` 从 PowerShell 到画面（B-31 的字段链路）

**为什么要写**：审批卡的说明进框内之后，适配层（`dsh-approval-notifier`）只能用临时函数
`Add-ApprovalCodeComment` 在 `New-CardPayload` **之后**把字段补上去——因为外壳的拼装层原本不认它。
补丁函数是「字段没有正式入口」的症状，不是设计。

- **链路（现在是一条直线，没有补丁）**：
  1. 调用方 `New-CardCodeBlock -Command 'df -h' -Comment '看磁盘'` → 块里多一个 `comment` 字段
     （`card-html.ps1`；**没给就不写这个键**，不写 `comment: $null` 也不写空串——页面靠「键在不在」
     判断有没有说明，空串会在框里多渲染一行光秃秃的 `#`）；
  2. `ConvertTo-CardBlockList` 用 `Get-CardItemValue $item 'comment'` 透传；
  3. `ConvertTo-CardPayloadJson` 照原样序列化（字段名与 `app/src/types.ts` 的
     `CodeBlock['comment']` 对齐）；
  4. `App.tsx` 在 `<pre data-part="code">` 里先渲染 `# ${block.comment}`，再渲染命令；
  5. 复制按钮传的是 `commandOnly(block.command)`——`comment` 根本不在这个入参里，
     **它进不了剪贴板是结构性的**，不靠字符串过滤（`#` 开头的整行仍会被 `commandOnly` 去掉，
     那是给「命令里本来就带注释」的情形，两件事分开）。
- **为什么复制必须排除它**：框内第一行的 `# 说明` 是**给人看的注解**，不是命令。粘到终端里会变成
  一条注释、或者让整段变成「先注释后命令」的两行文本；更糟的是有人只粘第一行以为那就是命令。
  `# 说明` 与「命令里真有的注释」在视觉上无法区分，所以只能在**来源上**分开：说明走 `comment` 字段。
- **断言**：`card-shell.ps1` 里 `New-CardCodeBlock -Comment`（含「空白说明也不算有」）与
  `ConvertTo-CardBlockList` 透传两条；渲染侧与复制侧的两条在正文的断言清单里。
- **适配层下一步（不在本会话范围）**：外壳参数到位后，`Add-ApprovalCodeComment` 可以退化成
  `New-CardCodeBlock -Comment`，`New-CardPayload` 之前直接把说明传进去。

---

## 附录 B（属 D-31）：着色取证——第三轮的三件事，只有一件是真的

**起因**：协调会话在真机离屏图上量到三个问题——① 字符串绿是 `#2C8365`（不是 `#067D17`）；
② `printf` 是 `#069BA7`（不是 `#00627A`，「idea 里好像没这个颜色」）；③ 第 3 行那 700 个 `x`
被当成字符串涂绿。要求逐 token 打 scope 与最终颜色、写进本附录。

**结论先说**：③ 是真的缺陷，已修；① ② 是**取色取在抗锯齿边缘**，画面上一直是 `#067D17` / `#00627A`。

### B.1 取证方法（三层，都是可复跑的）

1. **token 层**：`codeToTokens(code, { includeExplanation: true })` 打出每个 token 的完整 scope 栈
   与它最终拿到的颜色变量（`highlight.ts` 的 `highlight()` 返回的就是这些 `var(--shiki-*)`）；
2. **桶层**：把 13 条真实命令（shell + pwsh）全部切一遍，按「颜色变量 × 最内层 scope」聚合，
   看谁落进了哪个桶（这一步才发现问题不只在 b1，`df -h /`、`rm -rf`、`sed -i` 的裸参数全绿）；
3. **画面层**：直接统计离屏 PNG 的像素颜色分布，看定义的十六进制到底在不在画面上。

### B.2 桶层当时的样子（修前，13 条命令聚合）

| 颜色变量 | 最内层 scope | 举例 | 判定 |
| :--- | :--- | :--- | :--- |
| `--shiki-token-string` | `string.unquoted.argument.shell` | `restart`、`/`、`/tmp/build`、700 个 `x` | **错**：裸参数不是字符串 |
| `--shiki-token-string` | `string.unquoted.shell` | `for i in 1 2 3` 的字面量 | **错** |
| `--shiki-token-string` | `constant.other.option` | `-h`、`-c`、`-u`、`-n` | **错**：选项不是字符串 |
| `--shiki-token-string-expression` | `punctuation.definition.string.end.shell` | `'%s\n'`、`"step $i"`、`'s/a/b/g'` | 对 |
| `--shiki-token-function` | `entity.name.command.shell` / `support.function.builtin.shell` | `printf`、`echo`、`wc`、`df` | 对 |
| `--shiki-token-keyword` | `keyword.control.*.shell`、`keyword.operator.pipe.shell` | `for`、`in`、`do`、`\|` | 对 |
| `--shiki-token-comment` | `comment.line.number-sign.shell` | `# 看目录` | 对 |
| `--shiki-foreground` | `source.shell`、`meta.for.in.shell`、`meta.argument.shell` | `;`、循环变量 `i` | 对 |

**根因**：`createCssVariablesTheme` 生成的 `tokenColors` 是**粗粒度桶表**——字符串那条是
`scope: ["string", "markup.fenced_code", "markup.inline"]`，匹配只看 scope 前缀。
而 `shellscript` 语法把「裸参数」也归进字符串家族（`string.unquoted.shell` /
`string.unquoted.argument.shell`），于是**命令后面每一个参数都继承了字符串色**。
一条 `echo xxx… | wc -c` 就这样整行发绿——用户看到的是「满屏绿色」，不是「某个词颜色不对」。

### B.3 b1 第 2 行的逐 token 证据（修前 → 修后）

命令：`for i in 1 2 3 4 5 6 7 8 9 10; do` / `  printf '%s\n' "step $i";` / `done; echo xxx…(700) | wc -c`

| token | 最内层 scope（修前） | 修前颜色 | 修后颜色 |
| :--- | :--- | :--- | :--- |
| `for` | `keyword.control.for.shell` | `--shiki-token-keyword` | 不变 |
| ` i ` | `meta.for.in.shell` | `--shiki-foreground` | 不变 |
| `in` / `do` | `keyword.control.in/do.shell` | keyword | 不变 |
| `1` … `10`（含空格） | `string.unquoted.shell` | **string（绿）** | **foreground（黑）** |
| `printf` | `support.function.builtin.shell` | function | 不变 |
| `'%s\n'` | `punctuation.definition.string.end.shell`（栈内有 `string.quoted.single.shell`） | string-expression | 不变 |
| `"step $i"` | 同上（`string.quoted.double.shell`） | string-expression | 不变 |
| 700 个 `x` | `string.unquoted.argument.shell` | **string（绿）** | **foreground（黑）** |
| `wc` | `entity.name.command.shell` | function | 不变 |
| `-c` | `constant.other.option.dash.shell`（祖先 `string.unquoted.argument.shell`） | **string（绿）** | **foreground（黑）** |

**顺带排除一个猜想**：`'%s\n'` 的 scope 栈是**闭合**的（`string.quoted.single` 包到
`punctuation.definition.string.end`），没有「单引号没配对、把后面整段吞掉」这回事；
把同一段文本喂给 `powershell` 也只证明它会按自己的语法切词——**所以不需要换语法导入、
也不需要换引擎**，问题在主题的桶粒度。

### B.4 修法（为什么是主题规则，不是别的）

在 `createCssVariablesTheme` 的桶表后面追加**一条更具体的规则**（同一份 `tokenColors` 里，
更深/更准的 scope 优先）：

```
scope: ['string.unquoted', 'constant.other.option']
settings: { foreground: 'var(--shiki-foreground)' }
```

- 只动**两组** scope，其它桶仍是原来那张表 → 不需要重写整个主题，D-29 的四条断言
  （`createCssVariablesTheme`、`--shiki-` 前缀、变量映射、`fontStyle: false`）**一条都不用改**；
- 颜色仍写成 `var(--shiki-foreground)`，`highlight.ts` 里依旧没有裸色值（B-20 的断言不变）；
- 语义上也说得通：**只有带引号的才是字符串**，裸参数是命令的一部分，就该是正文色。

**被否的方案**：
- **换成「一次一个 scope 写全」的自建主题对象**：能修，但要把调色板搬进 `highlight.ts`
  （撞 B-20 的「不许裸色值」）或改 D-29 的四条断言；收益相同，代价是动门禁。
- **在 JS 里对 token 做后处理（`string.unquoted* → 替换颜色`）**：要遍历整份 token 表、
  按 scope 字符串做前缀匹配，等于把主题的事搬到代码里；坏了也只在运行时才看得见。
- **把 `string.unquoted.*` 从语法里删掉**：改的是第三方语法的语义，不是我们该改的地方。
- **认不出就退纯文本**：那是「宁可不涂」的兜底（本来就有），拿它掩盖「涂错了」等于把问题藏起来。

### B.5 「量到的色不是定义的色」——算式与像素统计

两条量化到的值都能**逐通道反解**成「我们的色 × 子像素覆盖率 + 底色 `#F5F5F5`（`colorFillTertiary`）」：

| 量到的值 | 反解出我们定义的值 | 三通道覆盖率 |
| :--- | :--- | :--- |
| `#2C8365` (44,131,101) | `#067D17` (6,125,23) | R 84% / G 95% / B 65% |
| `#069BA7` (6,155,167) | `#00627A` (0,98,122) | R 98% / G 61% / B 63% |

三个通道各自落在 `[0,1]`、且都不等于 1——这正是**子像素（ClearType）抗锯齿**的指纹：
一个像素的 R/G/B 三个子像素被字形覆盖的比例不同，于是同一个字色在不同位置混出不同的色相。
灰 `#8C8C8C` 量成 `#878787` 只差 5，是因为中性色三通道一起偏、色相看不出来；饱和色就露馅了。

像素统计（`select-long.png`，680×481，深色像素 11061 个）：

| 颜色 | 像素数 | 说明 |
| :--- | ---: | :--- |
| `#878787` | 446 | 注释的混色 |
| `#2C8365` | 276 | 字符串绿的混色（协调会话量到的值） |
| `#069BA7` | 211 | 命令青的混色（协调会话量到的值） |
| `#067D17` | 48 | **定义的字符串绿，确实在画面上** |
| `#00627A` | 30 | **定义的命令青，确实在画面上** |
| `#8C8C8C` | 52 | 定义的注释灰 |
| `#0033B3` / `#000000` | 15 / 155 | 定义的关键字蓝 / 正文黑 |
| `#2CB6D8`、`#4BC3E7`、`#B0A11E`、`#5A0000` … | 144、141、145、83 | 同一批字的其它子像素相位的混色 |

结论：**画面上从来没有 `#2C8365` 这个色值**，它只是 `#067D17` 在某个子像素相位下的混合结果。
再证一步：产物 `dist/index.html` 里搜 `#2C8365` / `#069BA7` **各 0 次**，
而 `#067D17`、`#00627A`、`#0033B3`、`#8C8C8C`、`#1750EB` 各在。

**所以要把颜色当门禁，只能用 DOM，不能用取色器**：`getComputedStyle` 读
`[data-part="code"] span` 的 `color`（或看 `style` 属性里的 `var(--shiki-*)`），那是定值。
本会话起不了 WebView2（受限沙箱），这一步留给协调会话或真人。

### B.6 本轮新增的着色断言

- `card-shell.ps1`（源码层）：
  - **IDEA Light 六个色值逐个对值**（`comment/string/keyword/constant/function/foreground`
    ↔ `#8C8C8C`/`#067D17`/`#0033B3`/`#1750EB`/`#00627A`/`#000000`），
    并且七个 `--shiki-*` 变量**逐个指向调色板常量**（防止「变量名指到另一个 token」这类错位）；
  - 覆盖规则在：`string.unquoted` / `constant.other.option` 存在且颜色是 `var(--shiki-foreground)`。
- `tests/card-tokens.ps1`（行为层，真跑 `highlight.ts`）：b1 那条命令的 700 个 `x`、`-c`、
  循环字面量必须是正文色；`'%s\n'` / `"step $i"` 必须是字符串色；`printf` 是命令色；`for` 是关键字色；
  外接 `printf '%s\n'` 与 `df -h / && rm -rf /tmp/build` 两条回归；
  **通项**：任何字符串色的 token 必须以引号/反引号开头。

---

## D-32 代码框按钮改图标 + 右上角 6px/6px + 折叠计数 + 探针（B-28 / B-29 / B-33）

- **现象**：① 折叠按钮是「展开 / 收起」两个汉字，复制按钮却是图标——同一组里两种形态，
  且汉字按钮把右上角撑宽；② 按钮组在 top 2 / right 4，间距 2，用的是 antd `size="small"`
  （24px 高），四个数都不是 B-29 想要的那套；③ 折叠态只有「被裁掉」这一个信号，看不出
  「8 行里只给你看了 6 行」；④ 配色/几何一直靠离屏图取色与肉眼比对，**取色器会把
  `#067D17` 混成 `#2C8365`**（D-31 附录 B.5 已经算清：那是子像素抗锯齿，画面上从来没有这个色）。
- **判定**：①②③ 是问题（②③ 是可量化的不一致：说了 6px/20×20/4px，实际不是）；
  ④ 是**测量方法**的问题，不是颜色的问题——用截图当门禁必然反复「读错色 → 改色表 → 又错」。
- **根因**：按钮组是照 antd 的档位拼的（small = 24），没有把 B-29 的四个数落成显式样式；
  折叠计数从来没实现过；而验收只有「出图」一条路，没有页面内的数值出口。
- **结论**：
  - **两个按钮都用图标**：复制 `CopyOutlined` → 成功后 `CheckOutlined`（1.2s 复原），
    折叠 `DownOutlined` / 展开 `UpOutlined`。图标 13px；无障碍名放 `aria-label`（不是可见文字）。
  - **几何**：组 `position: absolute; top: 6px; right: 6px; gap: 4px`；按钮 20×20、`padding: 0`、
    `fontSize: 13`、`lineHeight: 20px`、`borderRadius: token.borderRadiusSM`。**不占流**：
    绝对定位，隐藏工具栏前后 `offsetHeight` 相等（探针 `block.toolsDontAffectHeight`）。
  - **显隐**：沿用 `.card-code-tools` 的 `opacity: 0` + `pointer-events: none`，
    `.card-code:hover` 时 `1 / auto`，过渡 120ms（要求 ≤120ms）。
  - **底色**：组用 `token.colorFillTertiary`（与代码框同档），按钮 hover 底色交给 antd 的
    text 按钮（token），**一个裸色值都没写**（B-20）。
  - **右内边距 28px**（正文代码框与行内命令框同一个数）：6px 偏移 + 20px 宽 + 2px 余量。
    复制按钮因此永远不会压到字符。
  - **折叠计数** `6/8`（可见行/总行数）放在按钮组**左侧**、同一个 chip、同一套 hover 规则、
    同样不占流；**总行数 ≤6 时不渲染**（没有可说的数）。没有渐变遮罩（B-28 不引入新视觉）。
  - **行数必须按渲染行算**：`measure.ts` 的 `countCodeLines()` 用 `Range.getClientRects()`
    按 top 归并出行，再按内容盒（`clientHeight` 减上下内边距）数可见行。
    `split('\n')` 在折叠态是错的——一条 574 字符的单行命令会排成 8 行，数换行符只得到 1。
  - **行数判定是唯一算法，两份实现必须同步**（产品 `app/src/measure.ts` 的计数 chip 与
    `debug/probe.js` 的探针）：**改一处必须改另一处，并在 commit message 里写明**。
    两份实现本身就是这次「chip 与探针同时错」的根因——真机一量，一处 7/11、一处 6/9，
    各说一套比不测更糟。实测暴露的两个错：
    ① `getClientRects()` 是**文档顺序**、不是视觉顺序（外层 span 的分片排在内层 token 之后），
    只跟「上一行」比会凭空多出行（9 行报 11、3 行报 5）；
    ② 「可见」只比 top，会把**只露出 5px** 的那一行算成整行（6 行报 7）。
    修法（两份同步）：先按 top 排序再归并、每行记 `{top, bottom}`、整行落在内容盒内才算可见
    （±0.5px 防抖）、无溢出（`scrollHeight - clientHeight <= 1`）时全部算可见。
  - **探针**：`debug/render.ps1 -Probe` 在 `onRendered`（页面已 ready、已切 fill）之后执行
    `debug/probe.js`，把 `getBoundingClientRect()` + `getComputedStyle()` 的结果写进
    `<名字>.measure.json` 的 **`probe`** 字段（与现有字段并列）。探针异常只写 `probe.error`，
    出图与其余字段照常；**不带 `-Probe` 时 measure.json 与以前逐字节一致**。
- **被否的方案**：
  - **继续用文字按钮**：B-33 明确要图标；且文字长度会随语言变，右上角几何就不固定了。
  - **把按钮改成 `position: fixed` 或用 grid 占位**：占流，卡片高度会变，直接撞 B-29 与 D-03。
  - **用 CSS `text-overflow: ellipsis` / `line-clamp` 表示折叠**：会画省略号、还会改折行点，
    `card-shell.ps1` 已钉死不许出现（D-31）。
  - **计数用 `scrollHeight / 20` 算**：padding、行高、非 20px 的场景都会算错；渲染行才作数。
  - **截图取色当门禁**：D-31 B.5 已证伪（`#2C8365` 是混色），所以探针只读计算样式。
- **如实记的偏差（本轮没解决，留给协调会话判断）**：
  - **28px 只够让复制按钮不压字**：折叠按钮与计数在它左侧（组宽 20 / 44 / ~64），
    第一行末尾的字符会落在组底下。组有与代码框同档的底色，鼠标悬停显形时**遮住**而不是
    「半个字露出来」；不显形时（默认态）文字完好。要彻底「不压任何字符」有两条路：
    ① 把 `paddingRight` 提到 ~76（正文可视宽度变窄，折行点会变）；② 两个按钮改成竖排
    （组宽回到 20，能塞进 28px），但计数在左侧仍会压字。**本轮按派活口径保留 28px**，
    并把「组宽/按钮数/是否压字」原样交给探针读数，不靠猜。
  - **`visibleLines` 的口径**：**整行都在内容盒内**才算可见（半行＝看不见）。原先写的是
    「折叠高度是整数行 × 20px，不会出现半行」——**实测证伪**：折叠态第 7 行只露出 5px
    （PNG 文本带 208..212，块底 213），按 top 判会算成整行，所以改成按 bottom 判。
  - **探针已在真机跑过一轮**（2026-10-30，协调会话，`-Probe`）：approval 3 行不裁、
    probe-lines 9 行露 6 行；页面计算色与调色板逐一对上：`#8C8C8C`→`rgb(140,140,140)`、
    `#067D17`→`rgb(6,125,23)`、`#000000`→`rgb(0,0,0)`、`#0033B3`→`rgb(0,51,179)`、
    `#00627A`→`rgb(0,98,122)`、`#1750EB`→`rgb(23,80,235)`；裸参数 `-h` / `/` / `1 2 3` 是正文黑。
    这一轮同时暴露了上面两个行数 bug（探针与 chip 各错一次）。
- **复验**：
  - `tests/card-shell.ps1` 67/67（按钮绝对定位/默认透明/悬停显形/产物内联等原有断言全过）；
  - `tests/shared-ui-guard.ps1` 10/10；`tests/preferences.ps1` 34/34；`tests/command-only.ps1` PASS；
  - `tests/card-tokens.ps1` PASS：`-h`、`/`、`1 2 3` 的 token 色是 `var(--shiki-foreground)`
    → `IDEA_LIGHT.foreground = #000000`，页面计算色实测 `rgb(0, 0, 0)`（见上）；
  - 几何（6/6、20×20、4px、28px、不占流）由 `-Probe` 的 `gap` / `buttons` / `block` 数字验收。

---

## D-33 计数 chip 常显 + 折叠态不露半行：按钮不占布局、内边距移出裁剪盒（B-28 / B-29）

- **现象**（2026-10-30 真机探针 + 出图，三件同一处）：
  ① 计数 chip（`6/9`）跟复制/折叠按钮同属 `.card-code-tools`，整组默认 `opacity: 0`，
  只有 `.card-code:hover` 才显形——「折叠了、下面还有 3 行」只有把鼠标放进代码框才知道，**提示等于不存在**；
  ② 折叠态底部露出第 7 行的 5px，像一行字被切掉上半截（`build: clientHeight=136 paddingTop=8
  paddingBottom=8 scrollHeight=196`，`state: collapsed=true visibleLines=6 totalLines=9`，探针按「整行可见」
  数对了 6 行，但**画面上仍露半行**）；
  ③ 按钮即使 `opacity: 0` 也**占布局**：实测 `buttons.width=63.75`（chip 15.75 + gap 4 + 两个 20×20 + gap 4），
  组右沿在 6px 处 → chip 左沿 = 盒右 - 69.75，而正文只留 `paddingRight=28`：chip 一旦常显就会压住第一行文字 41.75px。
- **判定**：三条都是问题。判据不是「好不好看」，而是 ①「提示只在 hover 时存在」＝没有提示（B-28 要的是
  一眼看出还有几行）；②「半行」是渲染坏掉的观感，任何折叠态都不该出现；③「常显的 chip 压住正文」直接
  违反「按钮/控件不占布局、不顶开内容」（B-29），而且压住的是正文第一行，不是装饰。
- **根因**：
  - 显隐规则作用在**整组**上：计数与按钮同一层，`opacity` 一关就一起没了；
  - `overflow: hidden` 按 **padding box** 裁，而 8px 上下内边距一直留在被裁的 `<pre>` 上：
    折叠高度 136 = 8 + 6×20 + 8，内容盒只到 128，第 7 行从 128 起的样子就从底部内边距里露出来；
  - 绝对定位只让**组**不参与排版，组里的按钮仍是 flow 子项：组宽 = 按钮宽 + chip 宽，
    chip 常显时必然把正文往里挤。
- **结论**：
  - **计数与按钮分两层**（`CodeTools.tsx` + `styles.css`）：
    `.card-code-controls` 是定位容器（`top:6 right:6`、`gap:4`），**常显**，里面只放 chip；
    `.card-code-tools` 是按钮组，绝对定位到 chip 左侧（`right: calc(100% + 4px)`，宽度跟着 chip 变），
    保持 `opacity: 0` + `pointer-events: none` + `.card-code:hover` 显形（B-29 的「默认透明」说的是按钮）。
    静止态容器宽度就是 chip 宽（约 15.75px），落在 28px 右内边距里，chip 左沿 = 盒右 - 21.75 > 正文右沿。
  - **按钮组底色改成不透明**：`token.colorBgLayout`（`#f5f5f5`，与 `colorFillTertiary` 叠在白底上的观感一致）。
    `colorFillTertiary` 是半透明，悬停时按钮盖在字上会透出文字（B-20：用内置 token，不写裸色值）。
  - **内边距移出裁剪盒**（`App.tsx`）：`padding: 8px 28px 8px 10px` 放到 `.card-code` 外层，
    里面的 `<pre class="card-code-body" data-part="code">` 只承担 `maxHeight` + `overflow`；
    `FOLD_BODY_MAX = FOLD_LINES * CODE_LINE_HEIGHT = 120`（不再 +16）。`n    **2026-11-10 修正**：现值是 `FOLD_LINES * CODE_LINE_HEIGHT + FOLD_PEEK_Y`（10）= **130**，`n    「露半行」那 10px 又回来了（T-09 之后为了能看到第 7 行露头），这条的 120 与 136 都过期。展开态仍是不折行 + 双向滚动，
    上限改成「正文可视高 - 上下内边距」，卡片总高不变（8 + 120 + 8 = 136）。
  - **行内命令框不动**：它的裁剪盒本来就没有上下内边距（`FOLD_ROW_MAX = 120`），不存在半行问题；
    只跟着换成新的控件层结构，`paddingRight: 28` 仍在框上。
- **被否的方案**：
  - **让整个 `.card-code-tools` 常显、只把按钮包一层 opacity**（被否）：chip 与按钮仍在同一 flow 里，
    组宽还是 63.75，chip 左沿照样压住正文 41.75px——只是把提示从「看不见」换成「盖在字上」。
  - **把 padding 留在 `<pre>` 上、用 `clip-path: inset(0 0 8px 0)` 遮住那 5px**（被否）：
    `clientHeight`/内容盒几何不变，探针的 `partialLines` 仍是 1，「修好了」只能靠眼睛，
    而这次的验收要求是数字（B-28 那 5px 就是靠数字量出来的）。也不是「把 padding 从裁剪盒移出去」。
  - **改 `card-shell.ps1` 的断言**（未改，也不需要）：`.card-code-tools` 仍然只装两个按钮，
    「绝对定位 / 默认透明 / 藏着点不到 / hover 才显」四条原样成立；chip 是另一个元素，断言里从来没提过它。
  - **缩小 chip 字号 / 隐藏计数**（被否）：字号是 D-32 定的 10.5px，隐藏计数正是这次要修的问题。
- **探针新增字段（验收用数字，不靠看图）**：
  - `state.partialLines`：与裁剪盒有正面积相交、但没有整行落在内容盒内的行数（半行）。修前 1、修后必须 0；
    算法是纯函数（`#region line-geometry`），桩测试 `tests/probe-partial.mjs` 直接取这段跑。
  - `buttons.countLeft`（chip 左沿）与 `buttons.contentRight`（正文内容盒右沿），要求
    `countLeft >= contentRight - 0.5`；修前 `buttons.width=63.75` → 差 -41.75px，修后 chip 宽 15.75 →
    countLeft = 盒右 - 21.75、contentRight = 盒右 - 28，差 +6.25px。
  - `block` 与 `body` 分开量：`block` 是可视代码框（`.card-code`：高 136、paddingRight 28、gap 6/6），
    `body` 是裁剪层（高 120、无内边距、scrollHeight 180）；`block.offsetHeight` 在隐藏整个控件层后不变。
  - `buttons.countOpacity` 记录 chip 自己的透明度（常显 = 1，不再跟按钮组一起变 0）。
- **复验**：
  - 纯逻辑：`shared/ui-card/app` 下 `npx tsc --noEmit` exit=0；`node --check shared/ui-card/debug/probe.js` exit=0；
    `tests/card-shell.ps1` **67/67**；
  - 桩：`node tests/probe-partial.mjs` → 修前 `visible=6 total=9 partial=1`、修后 `visible=6 total=9 partial=0`，
    外加「同一行的分片乱序仍归并成一行」；
  - **真机待协调会话跑**：`render.ps1 -Probe` 的 `state.partialLines=0`、`buttons.countLeft >= contentRight - 0.5`、
    `gap.top/right=6`、`items` 全 20×20、`paddingRight=28`、`buttons.countOpacity=1`；
  - 产物：`dist/index.html` 仍是旧源码的产物，本会话无构建能力，**必须由协调会话 `npm run build` 重出**。
- **已知边界（没解决，留给协调会话判断）**：chip 宽度超过约 22px（4 个字符以上，例如 `100/123`）时，
  左沿会越过 `contentRight` 开始压字；`paddingRight` 按派活口径保持 28，这一轮不动。
  真要解决有两条路：放宽右侧留白（折行点会变），或把 chip 改成「只显示折叠掉的行数」这类更短的文案。

---

## D-34 用户真机五条反馈：删计数、按钮钉死、折叠可滚+露 10px、复制走宿主、按 IDEA 实测色值（B-28 / B-29 / B-30）

- **现象**（2026-10-30 用户真机看完上一版，五条原话）：
  ① 「为什么右上角多了 行数，我没说要这个」；
  ② 「展开折叠 按钮位置会变化」；
  ③ 「折叠无法上下滚动，超出可用范围时一般是 下一行稍微露出一点 能看出来还有 而不是对齐 6 行右上角增加额外的统计」；
  ④ 「点击复制没有反馈，一般短暂变为对号代表复制成功. 而且确实没复制成功」；
  ⑤ 「idea 的两种语言的高亮，特地放大了给你看」（两张 IDEA 参照图 `out/refs/idea-powershell.png`、`out/refs/idea-shellscript.png`）。
- **判定**：五条全成立，都是行为问题、不是调样式；其中 ① 是上一轮（D-32 / D-33）我自己加的计数 chip，用户没要求，
  直接删掉，不留「更短的文案」这种折中。
- **根因**：
  1. 计数 chip 是**我加的**（D-32 为了「折叠了还有几行」做的提示），用户不需要；它还把按钮挤到左边。
  2. 按钮组用 `right: calc(100% + 4px)` 挂在 chip 左边，chip 宽度随内容（`6/9` → `10/12`）变，按钮整组平移。
  3. 折叠态 `overflow: hidden` + 高度精确 6 行：既滚不动，也没有「下面还有」的视觉提示。
  4. 卡片走 `NavigateToString`，origin 是 `about:blank`，**不是 secure context**，页面里 `navigator.clipboard`
     是 `undefined`，旧代码 `if (!clipboard) return` 静默退出——点了没反应、也确实没复制（不是写失败，是根本没写）。
  5. 配色此前按「IDEA Light 默认色」写死，命令色用了 `#00627A`；用户实测的命令色是 **`#1750EB`**
     （与数字同色，用户口径「数字算命令」；上一轮传话误给成 `#174AD4`，2026-10-30 已改正），
     普通文本是 `#080808`（不是 `#000000`），且关键词要**加粗**。
- **结论**：
  1. **删计数 chip 的全部产物**：`CodeTools.tsx` 的 `.card-code-controls` / `data-count` / `.card-code-count`、
     `styles.css` 对应规则、`App.tsx` 的 `lineCounts` 状态与测量，`app/src/measure.ts` 整个删除（只为 chip 服务）。
     探针的 `buttons.count / countLeft / contentRight / countOpacity` 一并删掉。
  2. **按钮位置钉死**：`.card-code-tools` 绝对定位 `top: 6px; right: 6px`（相对 `.card-code`），折叠态与展开态
     同一个位置，与内容、与其它控件无关。探针加 `buttons.top` / `buttons.right`（相对代码框上沿/右沿），
     两态都必须 **6/6**。
  3. **折叠 = 6 行 + 露 10px + 能滚**：`FOLD_BODY_MAX = FOLD_LINES * CODE_LINE_HEIGHT + FOLD_PEEK_Y = 130`
     （行内命令框同值），折叠态 `overflowY: 'auto'` / `overflowX: 'hidden'`；展开态不变（`pre` + 双向滚动，B-28）。
     滚动条细（代码框 6px）、折叠态 thumb 静止透明、鼠标进代码框才显形（`data-expanded='false'` 区分，
     展开态保持常显——B-28 要一眼看出能滚）。
     探针加 `state.overflowY`（折叠态 `auto`）与 `state.peekPx`（第一行不可见的行露出来多少像素，折叠态 ≈10、> 0；
     展开态探针**固定记 0**——那是折叠态的提示，展开态是正常滚动）；
     `state.partialLines` 因此在折叠态是 **1**（不再是 D-33 的 0），展开态 0。
     正文代码块（`.card-code`）高度随之从 8+120+8=136 变成 **8+130+8=146**（行内命令框同理 +10），
     探针 `block.height` 会看到这个数。
  4. **复制走宿主**（唯一实现，不做第二套兜底）：删掉 `navigator.clipboard` 分支；点击 → `postToHost({type:'copy', text})`
     → 宿主 `webview2.ps1` 在 STA 线程上 `Set-Clipboard -Value $text` → 回 `{type:'copied', ok}`。
     页面收到 `ok=true` → `CheckOutlined` 停留 1.2s；`ok=false` → 红色 `CloseOutlined` 停留 1.2s（失败不许静默）；
     **800ms 没回执也按失败显示**（不许永远停在「没反应」）。`bridge.ts` 只加 `copy` / `copied` 两种消息，
     `webview2.ps1` 只加这一种通用消息（不塞业务概念）。
  5. **配色以用户实测为准**（2026-10-30，用户在 IDEA 里取的值，**禁止从截图取色**：ClearType 子像素会混出假色，
     之前取到过 `#2C8365` / `#069BA7`，把命令色读偏成 `#0073BF` 也是这么来的）：

     | 类别 | 色值 |
     | :--- | :--- |
     | 普通文本 | `#080808` |
     | 命令（cmdlet 与外部命令**同一色**，**与数字同色**） | `#1750EB` |
     | 关键词（`for` / `in` / `do` / `if` / `param`） | `#0033B3` + **加粗** |
     | 字符串 | `#067D17` |
     | 注释 | `#8C8C8C` |
     | 数字 | `#1750EB` |

     **命令色最终是 `#1750EB`，与数字合并成一类**：用户口径「命令 `#1750EB`，数字算命令」。
     上一轮传话把命令色给成 `#174AD4`（`rgb(23,74,212)`），是传话错误、不是用户口径；这里以本表为准，
     代码里 `IDEA_LIGHT.function` 与 `IDEA_LIGHT.constant` 同值。

     加粗只加在 keyword token 上：`highlight.ts` 追加 `{ scope: ['keyword.control'], settings: { fontStyle: 'bold' } }`，
     `CodeText.tsx` 把 `token.fontStyle` 的 Bold 位渲染成 `font-weight: bold`（其余 token 仍是 400）。
     裸参数（`-a` / `-type` / `/var/` …）仍是普通文本色 `rgb(8,8,8)`（B-30），不许绿、也不许蓝。
     探针 `colors` 每条带 `fontWeight`；期望：keyword ≥ 700，其余 = 400。

     落到实现上另有三处细调（都是拿实际 token scope 验出来的，不是猜的）：
     - **数字**：`echo 1 2 3` 的数字带 `constant.numeric`，但也被 `string.unquoted.argument` 的前缀规则
       拉回正文色，所以补一条更靠后的 `constant.numeric → 常量色`；`for i in 1 2 3` 的数字**只有**
       `string.unquoted.shell`（语法本身没给 numeric scope），只能按 token 文本兜底（整段纯数字 / 空格分隔的
       数字列表 → 常量色；带引号的字符串 token 含引号，不会被误判）。
     - **操作符与类型名**：`=` `,` `-` `-not` `/` 在语法里属于 `keyword.operator`，`[string]` / `[int]`
       属于 `storage.type`；IDEA 里它们都是**正文黑、不加粗**，所以各补一条 `→ var(--shiki-foreground)`；
       加粗也只挂 `keyword.control`（for/in/do/done/if/param …）。
     - 探针的分类标签随之改名：`function` → **`command`**（两种语言统一一色）；裸参数采样从 `1 2 3`
       换成 `-type`（数字现在归 `number` 类别单独量）。

     **2026-10-30 追加：用户看完双栏对比选定「方案 B（社区扩展版）」，再上三个色位**
     （`out/palettes.html` 两栏 mock 就是验收基准，B 栏逐 span 对得上）：
     | 语义 | 色值 | scope 规则 |
     | :--- | :--- | :--- |
     | 变量 | `#248F8F` | `variable.other` |
     | 类型 | `#7A7A43` | `storage.type`（`[string]` / `[int]`） |
     | 操作符 | `#871094` | `keyword.operator.other` / `.string-format` / `.redirect` / `.pipe` |

     - 实现手法与 `BARE_ARGUMENT_SCOPES` 一致：`highlight.ts` 追加三条**覆盖规则**，`foreground` 只写
       `var(--shiki-token-variable|type|operator)`；这三档不在 `createCssVariablesTheme` 的白名单里，
       所以 `App.tsx` 的 `codeColors` 里自己加三行映射到 `IDEA_LIGHT.variable/.type/.operator`
       （颜色只写变量名，不落裸色值，B-20）。
     - **三处照 mock 明确不动**：① `keyword.operator.assignment`（`=`，以及 PowerShell 参数前的 `-`，
       如 `-LiteralPath`）仍是正文色——染紫会让参数前缀变色；② `keyword.operator.logical`（`-not`，
       shell 里 `[ -f … ]` 的 `-f` 也是它）仍算关键词：蓝 + 加粗；③ 裸参数 / 选项 / 数字口径不变
       （`string.unquoted` / `constant.other.option` → 正文色，数字 → 命令色 `#1750EB`）。
     - 实测口径（`includeExplanation` 反查，和 mock 一致）：PowerShell 参数列表里的 `,` 是
       `keyword.operator.other` → **紫色**（mock B 里就是紫的）；`$_.CPU` 的 `$_` 是
       `support.variable.automatic`，不在 `variable.other` 里，仍是常量蓝（mock 未涉及，未动）；
       双引号里的 `$i` / `$f` 由语法拆成 `"` + `variable.other` + `"`，渲染成「绿引号 + 青变量」，
       与 mock B 一致。
- **被否的方案**：
  - **保留 chip、只把文案缩短**（被否）：用户原话是「我没说要这个」，不是「太长」；留着就是再一次自作主张。
  - **按钮用 `right: 6px` 但宽度跟着 chip 走**（被否）：位置仍会随 chip/内容变化，正是这次要修的 ②。
  - **折叠用 `overflow-y: scroll` 常显粗滚动条**（被否）：用户要「细、hover 才明显」，常显灰条会抢掉「露一点下一行」的提示。
  - **页面里再留一条 `navigator.clipboard` 兜底**（被否）：本机只有 WebView2 一条路径，且 about:blank 下它恒为
    undefined——留着只会让「到底走没走宿主」永远说不清；两份实现就是两份要维护的失败路径。
  - **用 `document.execCommand('copy')` 兜底**（被否）：同属非安全上下文里的老 API，行为不可预期，且又是一套实现。
  - **复制失败弹提示/用 antd message**（被否）：C-07 不做兜底 UI；图标变红叉 1.2s 已经是「看得见的失败」。
  - **从截图取色**（被否）：已踩过假色；色值只有用户在 IDEA 实测给的这一份。
- **断言影响（测试断言本会话不许改，交协调会话处理；均已确认是「行为有意变化」而不是实现写错）**：
  - `高亮：只改颜色，不改字体/字号/字重（高亮后不会再折行、量高不再变）`：`CodeText.tsx` 现在必须渲染
    `fontWeight`——用户要求关键词加粗；
  - `主题（B-30）：IDEA Light 调色板逐色对值，变量再逐个指向它`：`function` 由 `#00627A` 改为 `#1750EB`、
    `foreground` 由 `#000000` 改为 `#080808`；
  - `复制（B-29）：走 navigator.clipboard，失败静默、只给一个对勾反馈`：不再有 `navigator.clipboard`，改为
    宿主回执 + 失败红叉 + 800ms 超时；
  - `折叠（B-28）：默认态折行，只按 6 行限高裁，不画省略号`：**语义已过时但当前仍会 PASS**——折叠态不再用
    `overflow: 'hidden'`（改成 `overflowY: 'auto'`），这条能过是因为行内命令框的附注条（`row.why` 容器）里
    还写着 `overflow: 'hidden'`；断言已不能证明它声称的事，建议协调会话改成查折叠对象的 `overflowY`。
  - 另外 `高亮：主题走 css-variables，色值取自 IDEA Light 调色板常量（highlight.ts 里不写裸色值）`
    一开始因注释里带了十六进制而失败，已把注释改成「见 App.tsx 的 IDEA_LIGHT」，**这条不改断言**。
  - `tests/card-tokens.ps1`（不在 card-shell 里，但也是行为测试）：协调会话已把「循环字面量 `1` 是正文色」
    改成「数字/命令色」（现在过了）；**剩下的失败是 `"step $i"` 丢了字符串色**——方案 B 给 `variable.other`
    上色后，语法把双引号里的 `$i` 拆成单独 token，渲染成「绿引号 + 青变量 + 绿引号」（mock B 第 38 行就是
    这么画的），该断言按「整段 `"step $i"` 是一个字符串 token」找，自然找不到。这是有意行为，改断言即可。
- **探针字段（验收用数字，不靠看图）**：
  - `buttons.top` / `buttons.right`：折叠态 6/6、展开态 6/6（同一位置）。探针一次只量当前状态；
    这两个数由 `styles.css` 的 `absolute top:6 right:6` 钉在 `.card-code` 上，与内容/状态无关，
    所以展开态不必另跑一次也能守住「位置不变」——真要量展开态，得先有人点开（脚本不许注入点击）。
  - `state.overflowY = 'auto'`（折叠态）；`state.peekPx = 10`（**行盒口径**：内容盒 130 − 6 个完整行 ×
    行距 20 = 10；展开态固定 0）。**不要按字形带读**：`getClientRects()` 返回的行内盒比行高矮，实测只到
    138，字形带量出来是 8——那是字体内容区，不是排版行框；字段注释与 `measureLines` 里都写明了取行盒。
  - `gap.top` / `gap.right` 与 `buttons.top` / `buttons.right` 同源同值，都是 6/6（T-01 按 `gap.*` 这个名字核）；
  - `buttons.count` = `items.length`（真实按钮数 2；不能再留 chip 时代那个自相矛盾的数字）；
  - `state.visibleLines = 6` / `state.totalLines = 9`（示例载荷）、`state.partialLines = 1`（露出的那一截）；
  - `colors[].fontWeight`：keyword ≥ 700，plain / command / string / comment / number / variable / type /
    operator / bare-arg 都是 400；
  - `colors` 的期望值：`plain=rgb(8,8,8)`、`command=rgb(23,80,235)`（与 `number` 同值）、`keyword=rgb(0,51,179)`、
    `string=rgb(6,125,23)`、`comment=rgb(140,140,140)`、`number=rgb(23,80,235)`、裸参数 `rgb(8,8,8)`；
    方案 B 三类：`variable=rgb(36,143,143)`、`type=rgb(122,122,67)`、`operator=rgb(135,16,148)`。
    **样本必须真命中**：`variable` 用双引号里的 `$i`（`variable.other.normal`）、`operator` 用 `|`；
    **不要用 `$_`**（`support.variable.automatic`，根本不在 `variable.other` 里，会误报缺色）。
    `probe-lines.json` 是 shell 载荷，**没有 `storage.type`**，所以那一跑 `type` 会进 `colorsMissing`；
    要 DOM 级的 `type` 数字，得跑一次带类型标注的 PowerShell 载荷（如 `param([string]$Test)`）——
    色值本身已用真实 `highlight.ts` 的 token 输出逐条核过。
- **复验**（本 worktree 内已跑）：`npx tsc --noEmit` exit=0；`node --check debug/probe.js` exit=0；
  `tests/probe-partial.mjs` 仍全 PASS（`measureLines` 只多返回 `peek`，不影响 partial 口径）；
  `tests/shared-ui-guard.ps1` 10/10；`tests/card-shell.ps1` 64/67（3 条失败见上）；
  `tests/card-tokens.ps1` 只第一条失败（数字口径，见上）；`webview2.ps1` 用 PowerShell Parser 解析无错；
  `ConvertFrom-CardMessage -Json '{"type":"copy","text":"echo 你好"}'` 得到 `Type=copy`、`Text` 原样（含中文），
  缺 `text` 时给空串不抛；本机 STA 下 `Set-Clipboard` 写入 + `Get-Clipboard` 读回一致（测完已还原原剪贴板）。
  纯函数复算折叠几何：`measureLines(9 行, 130)` → `visible=6 total=9 partial=1 peek=10`，
  `120` → `partial=0 peek=0`（证明「露 10px」是唯一来源，不是别处算错）。
  真机待协调会话：先 `npm run build` 重建 `dist/index.html`（本会话按派活口径**不构建**，产物是旧的），
  再 `render.ps1 -Probe` 核对上面的数字，并真点一次复制（成功对勾 + 剪贴板内容 = 命令本体）、
  点一次折叠按钮看位置是否不动、滚轮能否滚到底。
- **已知边界**：折叠态露出的 10px 在「第 7 行正好是空行」时看不到内容，但空行也占 10px 高度，仍能看出还有；
  按钮悬停盖住正文的偏差不变（B-29 已接受）。

### T-09（2026-10-30 真机后追加）：溢出过的框固定框高，不改卡片高

**现象**（用户原话）：「默认折叠 高度正常 / 展开成一行后 高度变矮 卡片高度不变 代码框变矮 导致内容空了」。
根因：折叠态 `white-space: pre-wrap` 把长命令折成 9 行、框高 146；展开后 `white-space: pre` 让整条命令
变回 1 行，而展开态只给了 `maxHeight`（上限不是定高），`<pre>` 于是缩到 20px，代码框跟着变矮，
卡片下方留出一块空白。

**结论**（用户已定，照此实现）：**框高恒定在折叠高度**（正文 146 = 8+130+8，行内块同理），
展开态多出来的空白**留在框里**——用户原话「代码框空着 比下面空白色 好一点」。三条配套约束：

1. **只有「溢出过」的框才固定高**（判据仍是 `overflowingKeys[key] === true`，即折叠宽度下
   `scrollHeight - clientHeight > 1`）。没溢出的短框没有折叠按钮，也没必要撑成 130。
   （2026-11-10 修正：按钮已改为**恒显**，短框也有按钮；但短框的展开态仍**不定高**、只关掉折行
   ——展开态走 `expandedShortBox`，只有溢出过的框才用 `expandedBox` 的定高。）
2. **绝不动态改卡片高度**：用户明确「动态改变卡片高度会导致点击后位置变化，所以不做」。
   所以 `toggleCode` 里只剩一个布尔翻转，不重新量高、不报 resize（断言会查）。
3. 展开态的语气不变：不折行 + 双向滚动（B-28），只是高度由 `maxHeight` 换成 `height`
   （只对溢出过的框；短框仍只有 `maxHeight`）。

**因此删掉 `expandedCap`**：它原来是「展开后最多能占正文可视区多高」，现在展开态高度恒等于折叠高度
（130），这套按正文可视区算上限的机制**用不上了**，留着就是死代码。
**副作用**：`tests/card-shell.ps1` 的「展开（B-28）：不折行 + 双向滚动，高度上限取正文可视区」
断言的是 `maxHeight: expandedCap` + `bodyRef.current?.clientHeight`，这条**必然失败**，
该断言要改成「展开态高度 = 折叠高度（`height: <fold max>`），且 `toggleCode` 里没有量高」——
按口径由协调会话改，本轮**没有动断言**。

**溢出结论要跨状态延续**：展开态整条命令只剩一行、高度又定死 130，`scrollHeight - clientHeight` 必然是负的；
若照常重算，「可折叠」这个结论会在点开的一瞬间把自己清掉，框立刻缩回去。所以测量 effect 在
`expandedKeys[key] === true` 时沿用上一次的值，折回去再按真实内容量。

**被否方案**：① 展开后让卡片跟着变高——用户否，理由是点击后位置会跳；② 展开态继续用 `maxHeight`
（内容一行就 20px 高）——正是这次的现象；③ 用 `minHeight: 130` 而不是 `height`——内容很长时
（展开态不折行也不该超高）框会被内容顶高，等同于改卡片高。

**复验**：`npx tsc --noEmit` exit=0；`tests/card-shell.ps1` 66/67（唯一失败就是上面那条要改的断言）；
真机上点一次展开，看代码框高度是否**一点没变**、卡片下方是否不再多出空白。

### T-10（2026-10-30 真机后追加）：行内框的工具栏提升到「整框」层级，两套框统一

**现象**（用户原话）：「但是下面的选项的 为何复制按钮在代码行而不是最上面 且鼠标放注释行没显示复制按钮，
这两种实现还不一致？」

根因：两套框的 `.card-code` 挂在了不同层级——
- 正文框：`className="card-code"` 在**整个框**上（`<pre>` 里含 `# 说明` 行），`CodeTools` 挂在
  `.card-code` 这一层，所以按钮相对整框定位、hover 整框都显形；
- 行内框：`.card-code` 只挂在**命令那一层**，而 `# 原因` 注释行在它上面另起一层，于是
  `top:6` 相对的是命令行（按钮看起来「在代码行」），`.card-code:hover` 也只覆盖命令行
  （鼠标放注释行不显形）。

**结论**：把行内框的灰底外层（`background: colorFillTertiary` / `borderRadius` / `overflow: hidden`
的那个 `Flex`，含注释行与 meta 条）提升为 `.card-code`，命令层只留 `card-code-body` + `data-part="row-code"`，
`CodeTools` 作为整框最后一个子节点。于是两套框**共用同一条定位父级规则**：

> `.card-code`（内联 `position: relative`）+ `.card-code-tools`（CSS `position: absolute; top: 6px; right: 6px`）。
> 绝对定位的包含块是祖先的 **padding box**，外层 `padding: 4px 8px` 不影响 6px 的基准
> （padding box 从灰底边界算起），所以行内框按钮与正文框按钮视觉上同一位置（6/6）。

配套：`stopPropagation` 仍由 `CodeTools` 自带（多选卡整行可点，点按钮不许变成一次勾选）；
`minWidth: 0` 同时给外层与裁剪盒，长命令不会把行撑宽。

**副作用**：`tests/card-shell.ps1` 的「按钮（B-29）：绝对定位 + 默认透明 + 悬停才显」用
`position: 'relative', minWidth: 0`（同一行相邻）来判断「外层是定位父级」——原来行内框是一行内联写法，
现在两个属性分行写在两套框上，这条字面匹配失败。断言按口径由协调会话改（例如改成数
`className="card-code"` 出现 2 次且两处都有 `position: 'relative'`），本轮**没有动断言**。

**被否方案**：① 保持只在命令行挂 `.card-code`，把按钮 `top` 改成负值去够注释行——注释行高度随文案
换行变化，负偏移只能猜；② 注释行也套一层 `.card-code`（两个定位父级）——hover 与定位基准会分叉，
仍然不一致。

**复验**：`npx tsc --noEmit` exit=0；`tests/card-shell.ps1` 66/67（唯一失败是上面那条字面匹配）；
真机上看行内框按钮是否在灰底框右上角、鼠标移到 `# 原因` 那一行是否也显形、折叠/展开按钮是否不动。

### BACKLOG #21（2026-11-01）：删掉死字段 `buttons[].armDelayMs`

**现象**：`New-CardButton -ArmDelayMs` 能写进载荷，但页面只读 `payload.armMs`（`App.tsx` 里没有
按钮级的读取），所以按钮级防误点**从来没生效**——参数存在、文档也提，行为却是零。

**结论**：删干净，不做「按按钮解锁」那条路。防误点统一走 `payload.armMs`（一个数管所有按钮），
理由：真机上需要的就是「整张卡都别被误点」，按按钮区分只会多一个没人会调的参数。

删除点：`card-html.ps1` 的 `New-CardButton` 参数与赋值、`ConvertTo-CardButtonList` 的取值、
`app/src/types.ts` 的 `CardButton.armDelayMs`；调用方（`dsh-ssh-remote/scripts/ui/shared.ps1`
三处建按钮）同步去掉 `-ArmDelayMs`，`-ArmMs` 仍留在载荷级。

**没动的同名东西**：`dsh-approval-notifier` 自己的业务配置字段也叫 `armDelayMs`
（`scripts/ui/shared.ps1:133`、`prompt.ps1:179`），那是**它的 JSON 入参**、映射到载荷级 `armMs`，
是真在生效的字段，不是这次删的按钮级字段；改名要连它的配置文档与测试夹具一起动，另开一条。

**被否方案**：① 让 `App.tsx` 读按钮级值——等于给一个从未被验证过的行为加实现，收益是零；
② 保留参数但标注「不生效」——那正是这次要清的账。

**复验**：`grep -r armDelayMs` 只剩 DECISIONS 历史说明、审批插件的业务字段名与
`tests/card-shell.ps1` 里那条待改的断言；`tests/card-shell.ps1` 的
「New-CardButton：防误点与计数模板只在给了值时出现」**会失败**（它仍在传 `-ArmDelayMs 800`），
按口径报协调会话改断言，本轮未动。

### BACKLOG #6 / #14（2026-11-01）：自动关闭只留一个输入口 `-AutoCloseMs`

**现象**：ssh 的 `-AutoCloseMs` 只被当成宿主窗口超时（`Show-CardWindow -TimeoutMs`），载荷里
`closeMs` 恒 0 → 页面不算倒计时、页脚不写「剩余 m:ss」，可到点窗口还是关了；
反过来页面若自己写 `closeMs`，窗口又不认。两个入口语义重叠，还互相打架。

**结论**：`-AutoCloseMs` 是**唯一入口**，一个数同时决定两件事：

| 去处 | 值 | 含义 |
| :--- | :--- | :--- |
| `payload.closeMs` | `AutoCloseMs` | 页面倒计时 + 页脚「剩余 m:ss」，到点页面自己发 `expired` 关窗 |
| `Show-CardWindow -TimeoutMs` | `AutoCloseMs + 15000`（`Get-SshWindowTimeoutMs`） | 宿主兜底，只防「页面脚本挂了、倒计时没跑」 |

正常路径永远是页面先关，所以**页脚写什么就发生什么**；`AutoCloseMs = 0` 时两边都是 0
（载荷里 `closeMs` 字段干脆不出），行为与改动前一致。15s 与审批卡的
`closeAfterMs + 15s` 同一个口径，不另立数值。改动点：`scripts/dialog.ps1` 三处调用改传
`-AutoCloseMs`；`scripts/ui/card.ps1` 三个 `Invoke-SshCard*` 的参数由 `-TimeoutMs` 改名
`-AutoCloseMs`，并把它同时写进载荷与窗口；`scripts/ui/shared.ps1` 新增 `Get-SshWindowTimeoutMs`。

**被否方案**：① 让 `Show-CardWindow -TimeoutMs` 反推页面倒计时——审批卡传的是
`closeMs + 15s`，倒计时会变成 10:15，页脚与真实关闭时刻又错开；② 保留两个入口、只在文档里
写清「别同时用」——正是这次要收的账；③ 把 `closeMs` 当唯一入口、由插件自己拼窗口超时——
那 `-AutoCloseMs` 这个名字就没了，`lib/admin.mjs` 与 README 全要跟着改，收益只是换个名字。

**复验**：`New-SshConfirmPayload -CloseMs 600000` 的 `closeMs = 600000`、
`Get-SshWindowTimeoutMs 600000 = 615000`、`Get-SshWindowTimeoutMs 0 = 0`；
不给 `-AutoCloseMs` 时载荷里没有 `closeMs` 键（实测）；真机看一眼带 `-AutoCloseMs` 的卡，
页脚有「剩余 m:ss」且到点自己关。

### BACKLOG #8（2026-11-01）：密码框补 `<label for>`，标题不再被顶掉

**现象**：密码框只有 `placeholder`，读屏软件拿不到名字；`placeholder` 是提示、不是标签，
而且一输入就消失。

**结论**：`App.tsx` 的输入区改成「视觉隐藏的 `<label htmlFor="card-password-input">` +
`<Input.Password id="card-password-input">`」：标签文字取 `payload.input.placeholder`
（宿主给的就是「输入密码」这类说法），为空退回「密码」；`.card-visually-hidden`
（`styles.css`）用 `clip` + 1px 盒子把标签移出视觉，**不占布局、不改卡片高度**，量高不受影响。
没用 `aria-label`：标签元素能同时给读屏名字和「点标签聚焦输入框」，`aria-label` 只给前者。

**标题那条的结论（没改代码）**：现在的载荷**没有** `title` 字段（B-16 已删，`dsh-ssh-remote`
的 `card-select.ps1` 还专门断言「载荷里还有 title 死字段」），抬头是 `eyebrow`（「SSH · 输入密码」），
标题行是 `titleHtml`（主机标签），问题原文 `askPassword` 把「问什么问题」放在 `Prompt` 里、
渲染成正文首段。所以「title 被主机标签顶掉」不是被覆盖，而是**标题行本来就只有一个位置**；
要把问句提到标题行属于载荷结构调整（要新的字段与视觉方案），本轮没做，报协调会话定。

**被否方案**：① 用 `aria-label` 代替 `<label>`——满足读屏但不满足「有 label 关联」这条判定；
② 画一个可见的「密码」小标题——多一行文字，密码卡本来就窄，视觉上纯增噪。

**复验**：`npx tsc --noEmit` exit=0；`tests/card-shell.ps1` 除 #21 那条外全绿；
真机上点一下「密码」标签的隐藏区域（读屏或 DevTools 里 `document.querySelector('label[for]')`
能查到、`input#card-password-input` 存在），卡片外观与高度不变。

### R-12（2026-11-02）：单字段输入能力整条删除（`payload.input` / `-InputSpec` / `CardInput`）

**现象**：ssh 的「单独改密码」卡随 R-10 并进表单卡（`form.fields`）之后，外壳里那条单字段输入区
（载荷 `input` → 页面归一成 `{ id: 'input' }` → 回传 `decision.input` → 宿主 `Input`/`InputLength`）
**没有任何插件在用**：`New-CardPayload -InputSpec` 在插件里零调用，只剩 demo 与断言还在构造它。

**判定**：算死代码（用户 2026-11-02 拍板「那俩 input」，BACKLOG R-12）。判定标准：`payload.input`、
`CardInput`、`-InputSpec`、`ConvertTo-CardInputObject`、`decision.input` 在源码、断言、文档、样本里
一处都不剩。

**根因**：D-36 让 `form` 成为通用输入形态之后，`input` 只剩「兼容老密码卡」这一个理由，而老密码卡
已在 R-10 删除。兼容层正是 AGENTS §0 明令不许留的东西——不是功能不够，是没人用的第二条路。

**结论**：整条删。`App.tsx` 的归一化分支与 `legacyInput`、`types.ts` 的 `CardInput` 与 `input` 键、
`bridge.ts` 的 `input?`、`card-html.ps1` 的 `-InputSpec` 与 `ConvertTo-CardInputObject`、
`webview2.ps1` 的 `Input`/`InputLength`、`demo.ps1` 的搬运与 `-Input` 参数，以及样本
（`tests/fixtures/password.json`、`input.json`、`app/src/fixtures/password.ts`）和
`docs/images/card-password.png` + `.measure.json` 一起删。`payload.form` / `-FormFields` /
`form.fields` 的行为**一个字不动**（ssh 的表单卡在用）。

**被否方案**：① 保留 `-InputSpec` 只删渲染（「参数还在、没人用」）——参数是能力的一部分，留着就还会
有人照着文档用它；② 只删 `CardInput` 类型、保留运行时分支——类型删了协议还在，等于把契约藏起来；
③ 顺手把 `normalizeForm` 也删掉、在 JSX 里直接取 `form?.fields`——单字段表单（`fields.length === 1`）
仍是合法的 form，一处归一化判断比在 JSX 里散三处取值好读。

**断言改动（旧 → 新）**：9 条只与单字段输入有关的 Check 从「这条能力还在」改成「这条路已经不存在」
的正面断言（详见 `tests/card-shell.ps1`：返回字段恒定 9→8、消息对象无 `Input`/`InputLength`、
`New-CardPayload` 无 `-InputSpec`、`types.ts` 无 `CardInput`、`App.tsx` 不读 `payload.input`、
dev 样例表无 password 等）。断言总数不变（83 项）。

**复验**：`rg -n 'payload\.input|CardInput|InputSpec|ConvertTo-CardInputObject|decision\.input'` 在非
`dist`/`node_modules` 范围内只命中本文件（历史记录）与断言里的反向断言；
`pwsh -NoProfile -File tests\card-shell.ps1` 83/83；`dist/index.html` 仍是旧产物，
要等协调会话 `npm run build` 后产物才同步（产物入库、不许手改）。

**未验**：渲染层删除没有跑 `npm run build` / `tsc --noEmit`（本轮禁止安装与构建），
产物与新源码的一致性由协调会话重建后确认；真机没点（B-42，这次没有可见的交互变化）。


---

## D-38 空 lang 被 `??` 漏成纯文本：SSH 确认卡命令块整块纯黑

**现象**：SSH 执行确认卡里，命令块整块纯黑——`set -eu` 不分两色，heredoc 正文也不绿。

**判定**：缺陷，不是偏好。判定标准：`lang=''` 的行必须与 `lang='sh'` 渲染完全一致。

**根因**：
- `app/src/App.tsx` 的行内调用点写的是 `lang={row.lang ?? 'sh'}`，`??` 只拦 `null`/`undefined`，**不拦空字符串**；
- 上游 `dsh-ssh-remote/lib/approval.mjs:205` 传的是 `String(plain?.lang ?? '')`，也就是 `''`；
- 两边都以为对方兜默认值，`''` 一路进 `detectLanguage`，不在 `SHELL_LANGS` 里，返回 `null`，整块退成纯文本。
- 实测三条：`highlight(code, '')` → `null`（线上现状）；`highlight(code, 'sh')` → 有 token（`set` 函数色、`-eu` 正文色、`import os…` 字符串绿）；`highlight(code, 'text')` → `null`（搬运卡说明文字，正确）。

**结论**：新增 `app/src/codeLang.ts` 的 `codeLang(raw)` 做单点归一化：去空白后为空（含 `undefined`）返回 `'sh'`，否则返回去空白后的原值。`App.tsx` 的两处调用（正文块 `block.lang`、行内 `row.lang`）都改用它，删掉 `?? 'sh'`；`highlight()` 本身不改——`''` 在它那里退纯文本是对的，语义分歧归消费侧。

**被否**：
- ① 改 `highlight()` 把 `''` 当 `'sh'`：会让「语言未知」与「缺省 sh」无法区分，且把 `lang` 的缺省语义埋进底层；
- ② 改 ssh 侧给 `lang: 'sh'`：`approval.mjs:204` 的注释已经声明「空 = 按 sh」，约定在消费侧，改上游等于两处都要维护；
- ③ 用 `||` 就地替换 `??`：`row.lang` 若是 `'  '` 仍会漏，且散落两处。

---

## D-39 弹出即置顶、不抢焦点（取代 D-27 的「不置顶」）

> **层级来源已被 D-41 修正（2026-11-10）**：本节「层级由那一次 `SetWindowPos(HWND_TOPMOST, …|SWP_NOACTIVATE)`
> 决定」不成立——非前台进程事后改 Z 序会被系统静默忽略（实测 exstyle 停在 0x50000）。现行做法是
> **建窗时**在 `CreateParams` 里补 `WS_EX_TOPMOST`（实测 0x50008），见 D-41。本节其余结论
> （不抢焦点、不用轮询/定时降层、不设 WinForms `TopMost`、闪烁独立于置顶）继续有效；
> `SetWindowPos(…, 0x0053)` 降级为「显示兜底」（`SW_HIDE` 会吞掉第一次 `ShowWindow`）。

**现象**：最大化浏览器（或任何最大化窗口）在前台时弹出审批 / 勾选卡，卡片被它整个盖住——用户看不见卡，
以为「没弹 / 卡住了」，于是反复触发、或者干脆放弃这次操作。D-27 的补救只有任务栏闪烁，而它解决不了
「我根本没看向任务栏」这件事。

**判定**：算问题。判定标准**从 D-27 的「不打断」改成「不被漏看」**：

1. 卡片弹出来必须在用户当前这块屏、当前窗口**之上**，用户看着自己正在做的事也能注意到它出现了；
2. 输入焦点、键盘输入**不许**被抢走（C-01 不变）；
3. 不许靠轮询 / 定时器 / 前台窗口检测去「猜」什么时候该抬、什么时候该降——层级只由一次调用决定。

**根因**：D-27 当年把两件事混在一次改动里。`Invoke-CardForceShow` 用 `HWND_TOPMOST` 把窗口抬到最上层，
但 `SetWindowPos` 的 flags 里**没有 `SWP_NOACTIVATE`**（D-27 自己的根因段落写的就是「置顶 + 激活」），
于是「压到最前面」和「把焦点抢过来」同时发生，用户感受到的是「正在打的字被打断」，整条置顶能力被否掉
（「不想置顶了，影响使用，全部取消置顶」→ B-27）。被否掉的是「置顶 + 抢焦点」这个**组合**，不是置顶本身；
这一轮的前提正是补上当年缺的那一位——**topmost + `SWP_NOACTIVATE`**。

**结论**：

- `shared/ui-card/environment.ps1` 的 `Invoke-CardForceShow`：`SetWindowPos(hwnd, HWND_TOPMOST(-1), 0,0,0,0, 0x0053)`，
  `0x0053 = SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_SHOWWINDOW`——抬到 topmost 层、**不激活自己**。
  **只做这一次 `SetWindowPos`**：没有轮询、没有定时降层、没有前台窗口检测、没有隐藏/降层分支。
- `shared/ui-card/webview2.ps1`：**删掉 `-TopMost` 开关与 `$form.TopMost = ...` 那一行**。WinForms 的
  `TopMost` 属性会在窗口被激活时把窗口重新插回 topmost 层，等于第二条层级来源，让「什么时候在最上面」
  不可推理；层级只由上面那一次 `SetWindowPos` 决定。
- `dsh-ssh-remote/scripts/ui/card.ps1`：**删掉三处 `-Activate`**（`SW_RESTORE` 会抢前台，与「不打断用户」
  矛盾；置顶已经解决可见性）。`-Activate` 这个开关本身**保留**，`Invoke-CardForceShow -Activate` 的
  `SW_RESTORE` 分支也保留——`tools/preview-card.ps1:183` 还在用，它不属于产品路径。
  同轮删掉的被否思路是「ssh 的一次性确认要抢前台才能操作」：`SWP_NOACTIVATE` 只影响**显示那一刻**，
  用户自己去点卡片时窗口照样被激活，不需要在弹出时抢。
- **明确取代 D-27 第三条**：「③ 不可以用『压到最前面』来解决——那会打断用户正在做的事」作废。
  它仍然成立的只有**理由**（打断来自激活），结论改为「压到最前面、但不激活」。D-27 的窗口图标、
  任务栏闪烁、橙色描边三条继续有效：置顶保证「在最上面」，闪烁负责「把视线叫过来」，两者互不替代。

**已知代价（有意取舍，不是疏漏）**：

- 置顶会**持续到关窗**：卡片还在时，用户切到别的应用，它仍压在上面，直到处理或关掉。
  没有「N 秒后自动降层」——那要一个定时器加第二次 `SetWindowPos`，而「降到什么层」取决于用户此刻在
  哪，代价大于收益（见被否方案）。
- 用户当年抱怨「影响使用」可能有一部分是「盖住窗口」本身，而不只是抢焦点。这次接受这个代价：
  卡片是**等人的**（不处理就不继续），漏看的成本（以为没弹 → 反复触发 / 放弃操作）比被挡一会儿更高。
  卡片无边框，挡住的区域最多一张卡（宽 680/480、高 ≤ 屏高 62%），不是全屏遮罩。
- 切到别的应用时仍在最上层，这是本方案的定义性质，不打算修。

**被否方案**：

- **轮询前台窗口、切走就隐藏 / 切回就显示**：定时器 + 状态机；隐藏之后用户更找不到它，而且 3 条判定里
  的「只由一次调用决定」直接不成立（C-01 也不允许脚本去操作窗口）。
- **N 秒后自动降层**：多一个定时器与一次额外 `SetWindowPos`；用户在这 N 秒里没看屏幕就永远错过——
  正好是要解决的场景；「自己降下去」还会被读成卡片自己消失了。
- **`WS_EX_NOACTIVATE` 整窗**：窗口从此不参与激活，卡片上的按钮、勾选框、表单（还要能 Tab、密码框回车
  提交）都会变形。本轮只需要「显示时别抢」，不需要「永远不激活」。
- **WinForms `TopMost` 属性**：见结论第 2 条，会在激活时重新插回 topmost，层级不可推理；而且它是属性，
  不是一次带 flags 的调用，没法显式保留 `SWP_NOACTIVATE`。
- **只靠任务栏闪烁（D-27 现状）**：用户不看任务栏就等于没提示，正是这次要解决的。

**断言改动（有意反转，不是迁就实现）**：

| # | 位置 | 改前 | 改后 | 理由 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `tests/card-shell.ps1:824`（改前一条 → 改后两条） | 「不置顶：TopMost 默认关，产品代码里没有 -TopMost 实参、也没有 topmost 插入位置」：要求 `[switch]$TopMost` 在、`$form.TopMost = $TopMost.IsPresent` 在、`HWND_TOPMOST` **不在**、`IntPtr]::new(-1)` **不在** | 「置顶（D-39…）」：插入位置必须是 `[System.IntPtr]::new(-1)`、flags 解析后 `= 0x0053` 且 `band 0x0010` 非 0、`-TopMost`/`$form.TopMost` 都不在、`-Activate` 开关与分支仍在；「不抢焦点（C-01）」：产品代码无 `SetForegroundWindow`、无 `-TopMost` 实参、无 `-Activate` 实参 | 需求本身反了：判定标准从「不打断」改成「不被漏看」。反向检查强度不低于原检查（多了 flags 位运算与产品脚本实参扫描） |
| 2 | `dsh-ssh-remote/tests/card-select.ps1`（53 → 55 条） | 没有「不自超时 / 不抢前台」的断言（`-TimeoutMs`、`-Activate` 的传值无人守） | 新增「不自超时」：三张卡 `MockCall.TimeoutMs = 0`、勾选卡载荷无 `closeMs`、产品代码里没有 `AutoCloseMs`/`Get-SshWindowTimeoutMs`；新增「不抢前台」：三张卡 `Activate = $false`、源码里没有 `-Activate` 实参 | 这两项正是本轮删掉/反转的东西，没有断言下次就会悄悄加回来 |
| 3 | `dsh-approval-notifier/tests/card-select.ps1:407` | `仍在置顶（用户要求全部取消置顶，见 DECISIONS D-27）` | `又在设 WinForms 的 TopMost（层级只由外壳 SetWindowPos 决定，见 DECISIONS D-39）`，并新增 `Activate -ne $false` 检查 | 断言对象没变（审批卡不许自带层级来源、不许抢前台），只是依据从 D-27 换成 D-39 |

**怎么复验**：

- `pwsh -NoProfile -File tests\card-shell.ps1` → **84/84**（基线 83：`不置顶` 一条拆成两条）；
- `pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1` → **55/55**（基线 53）；
- `pwsh -NoProfile -File dsh-approval-notifier\tests\card-select.ps1` → 34/34；
- `pwsh -NoProfile -File tests\preferences.ps1` → 45/45、`tests\shared-ui-guard.ps1` → 10/10、
  `tests\layout.ps1` → 9/9；
- **真人验（只能人做；要部署 + 重启宿主才生效）**：
  ① 最大化浏览器在前台，触发一次审批卡 → 卡片**在浏览器之上**，**键盘焦点仍在浏览器**（接着打字不丢字）；
  ② 只有点卡片里的控件才把焦点拿过去；③ 卡片关掉后，下面那个窗口回到前台；
  ④ 任务栏按钮照旧闪几下（D-27 的闪烁没被撤掉）。

**没做的（范围外）**：

- **没有改 `PREFERENCES.md` 的 B-27**（只能协调会话改）：它现在与本轮行为相反，需要同步成
  「弹出即置顶、不抢焦点，怕漏看靠置顶 + 任务栏闪烁」，并更新「落地 / 校验」两列
  （`tests/preferences.ps1` 没有针对 B-27 的断言，所以测试不会红）。
  ——**已在 `4d15512` 完成**（B-27 已改成「卡片弹出即置顶，但不抢焦点」）。
- **没有改文档**：`docs/shared-ui-card.md` 第 136 / 142 / 163–166 行仍写着 `-TopMost` 与 `-AutoCloseMs`
  口径；`docs/webview2-card-playbook.md` 第 133 行仍写「ssh 的一次性确认才 `-Activate`」——文档归协调会话。
  ——**已在 `4d15512` 完成**（`webview2-card-playbook.md:133` 改成「产品路径不传 `-Activate`」；
  `shared-ui-card.md` 的 `-TopMost` / `-AutoCloseMs` 口径同轮一并更新）。
- **没有改 `dsh-approval-notifier/scripts/ui/card.ps1:116` 的注释**（仍写「不置顶（D-27）」）：该目录不在
  本轮可改范围，协调会话顺手改一句即可（代码本身没传 `-TopMost`，行为已正确）。
  ——**已在 `7c0e9a9` 完成**（注释改成「弹出即置顶、但不抢焦点（D-39，取代 D-27 的『不置顶』）」）。

---

## D-40 注释行并入高亮流 + 抬头（eyebrow）拖动

> **已被 D-42 部分推翻（2026-11-10）**：D-40 的「说明行**不拼 `#`**、靠注释色表达」整条作废——
> 用户当天纠正「肯定要#号啊， 再说没有#你怎么让shiki渲染为注释的啊？你还有特殊处理？」。
> 受影响的是本节第 1 条判据②、结论 1 / 4 / 5 / 6 与「为什么不拼 `#`」一节；**说明并入行流、
> 缓存键带 comment、折叠同步、以及第 8 条的抬头拖动结论全部继续有效**。现行做法见 **D-42**。
> 下文保留原样，作为「被否方案」的存档。

**现象与判定**（两条都是用户 2026-11-10 真机看完 D-34 那一版提的）：

1. **说明不是代码的一部分，而且被拼了一个 `#`。** 改前 `App.tsx` 有两套写法：
   - 正文代码块：`<pre data-part="code">` 里手写一个
     `<span style={{ color: IDEA_LIGHT.comment }}>{`# ${block.comment}\n`}</span>`——
     **手动上色 + 拼 `#`**，与命令的高亮各走一套；
   - 行内命令（`rows`）：说明在 `<pre>` **外面**，是一个独立的 `<Text>{`# ${row.why}`}</Text>`，
     不跟命令一起滚、也不跟命令一起折叠。
   用户原话三条：「有了 shiki 的颜色 不用拼 # 了 因为灰色天生就是注释」；
   「我不是说把它当代码的一部分吗」；「直接让 shiki 渲染不就行了」。
   **判定：是缺陷，不是样式偏好。** 判据两条：① 说明与命令必须是**同一条行流**（一起折行、
   一起滚动、一起折叠、一起被裁剪盒裁）；② 说明文本里**不许出现 `#`**。
   折叠态下的症状是判据①的直接后果：说明在框外时折叠只裁命令，说明留在原地不动。
2. **卡片不能拖。** 抬头 `eyebrow` 只是一个 `<Text>`，按住它既不挪窗口、也看不出能拖。
   用户原话：「只做拖动」「拖动区在标题」。**判定：是缺口。** 判据只有两条——
   按住抬头（`pwsh · 提权审批` / `SSH · 执行确认`）能把窗口挪走、**不做改大小**。
   （用户口中的「标题」= 抬头 `eyebrow`，**不是**首行路径 `titleHtml`；错绑经过见结论 8。）

**根因**：

- 说明和命令是两条渲染路径：说明由 `App.tsx` 手写上色并拼 `#`，命令由 `highlight()` 分词。
  只要「一部分归 A、一部分归 B」，位置、滚动、折叠、裁剪、行高就会各自对不上；D-29 已经定过
  「高亮是命令的唯一上色来源」，说明却绕过了它。
- `#` 是**往原文里加内容**：说明本来是载荷里的独立字段（`CodeBlock.comment` / `CardRow.why`），
  不是命令的一部分。拼出来的那一行既不在 `command` 里，也会被 `commandOnly()` 当成注释行删掉，
  于是「屏幕上看到的」与「原文 / 复制出去的」不一致（C-08 要的就是原样）。
- 拖动缺的是协议：页面没有任何「我开始拖了」的消息，宿主也没有进系统移动循环的入口
  （`DshUiCard.Native` 里连 `ReleaseCapture` / `SendMessage` 都没声明）。

**结论**：

1. **说明由 `highlight()` 产出，并入同一个 `lines` 数组**：签名变成
   `highlight(code, declared?, comment?)`。`comment` 非空时在返回的行数组**前面**加上注释行 token——
   一行一条 token，`content` 就是那一行的原文（**不加 `#`、不加任何前缀**），`color` 是
   `var(--shiki-token-comment)`（与主题里注释同一个变量，highlight.ts 里不写裸色值，B-20）。
   多行说明就产出多行。于是说明与命令在 `CodeText` 里是同一种东西（token 行流），
   位置、滚动、折叠、按钮定位父级全都自动一致。
2. **命令部分仍走语法解析，`rebuilt === source` 这条校验一个字节都没放松**：注释行不进
   `codeToTokens` 的输入、也不参与拼回校验（那条只约束命令原文，C-08）。
3. **缓存键带上说明**：`${lang}\0${source}\0${comment ?? ''}`。漏了它，同一段命令配不同说明
   会串内容（先渲染的那份被命中）。
4. **认不出语言时说明照样返回**：命令退纯文本（逐行一条 token、`var(--shiki-foreground)`、
   与原文逐字相同），注释行照旧在最前面。不能因为 `detectLanguage` 返回 null 就把说明弄丢。
5. **`CodeText` 的兜底分支也渲染说明**：`highlight()` 返回 null（highlighter 起不来 / 分词抛错）时，
   `if (!comment) return <>{code}</>`，否则说明按注释色渲染在命令前面。高亮失败不许变成「说明消失」。
6. **只有说明、没有命令的行**（`CardRow.why` 有、`text` 没有，`App.tsx` 的条件本来就允许）
   保留一个纯文本分支：这种行没有代码框（没有裁剪盒、没有复制/折叠按钮可挂），`CodeText` 那条路
   走不到；仍按注释色、**不加 `#`** 渲染。这是**唯一**还在 `App.tsx` 里直接写注释色的地方。
7. **折叠按钮改为常显**（两处 `canFold` 恒为 true）：用户 2026-11-10「溢出判定会变，那就默认都显示，
   简单处理 又不影响功能」。溢出判定**保留**——它只服务「折叠/展开是不是定高」（T-09），
   不再决定按钮出不出现。
8. **拖动**：拖动区 = 抬头 `eyebrow`（用户口中的「标题」：`pwsh · 提权审批`），**不是** `titleHtml`
   （用户口中的「工作目录」：`C:\…`）。抬头 `<Text>` 的 `onPointerDown` → `preventDefault()`
   （拖动不能变成选字）→ `postToHost({ type: 'drag' })`；宿主消息泵加一支 `drag`：
   `ReleaseCapture()` + `SendMessage($form.Handle, 0xA1 /* WM_NCLBUTTONDOWN */,
   [IntPtr]::new(2) /* HTCAPTION */, [IntPtr]::Zero)`。**按下即进入系统移动循环**——
   移动由 Windows 自己跑，**不改窗口过程、不做 hit-test**。抬头补 `data-part="eyebrow"`、
   `cursor: 'grab'` 与 `userSelect: 'none'`。
   - **错绑经过（2026-11-10 真机反馈）**：上一版照「拖动区在标题」把三件套挂在了 `titleHtml` 那个
     `<span>` 上，用户真机上撞到的是「我发现怎么是 工作路径那一行能拖动。。。」「我要的是 标题拖动」
     ——他拖到的是工作目录那一行。载荷字段名与他的叫法**错位**：`eyebrow` 才是他说的「标题」。
     同日已改绑到 `eyebrow`；`titleHtml` 恢复纯展示（`tests/card-shell.ps1` 反向守着：那一行
     不许再有 `onPointerDown`、不许再有 `cursor: grab`）。
   - **没有 `eyebrow` 的卡没有拖动区**：抬头是唯一的拖动区，这种卡不渲染那个 `<Text>`；**不退回
     `titleHtml`**（用户明确不要路径行能拖）。SSH 的四张卡都带抬头，不受影响。
   - `SendMessage(WM_NCLBUTTONDOWN)` 会**阻塞到拖动结束**，这段时间消息泵不转
     （ready/resize/copy 不处理、任务栏闪烁的定时器也不推）。拖动是用户主动的一次操作，接受。
   - **改大小明确不做**（用户原话「只做拖动」）：不加边框命中区、不加 `WM_NCHITTEST`、不加尺寸手柄。
   - 拖动**不新增任何层级/焦点操作**：层级仍只有建窗时 `CreateParams` 的 `WS_EX_TOPMOST` 一个来源
     （D-41，原 D-39 的「那一次 `SetWindowPos`」已降级为显示兜底），拖动不掺和，也没有新增任何轮询。
     边界要说清：断言只守住「没有新增层级/焦点 API 调用」（`tests/card-shell.ps1` 数 `SetWindowPos`
     调用点 + 新增的「置顶回归」反向检查）；NC 按下本身会由系统做一次 mouse-activate——焦点到底动没动
     **待真机确认**，不由断言代表。

**为什么不拼 `#`**：用户 2026-11-10「有了 shiki 的颜色 不用拼 # 了 因为灰色天生就是注释」。
灰色 + 等宽字体已经把「这是注释」说清楚了；而 `#` 是**内容**——它会出现在屏幕上的命令里、
在复制/抠字时被带走、还会让「命令原文」比载荷里多一行（C-08）。说明是独立字段，
屏幕上只该多出「说明这段文字」，不该多出一个 shell 注释符。

**被否方案**：

- **把说明渲染成独立 `<Text>`（本轮之前的现状）**：已否。说明在代码框外面/上面，折叠只裁命令、
  滚动只滚命令，位置与命令不同步；还多出一条「谁负责上色」的分叉。
- **拼 `# ` 前缀**：已否，见上（往原文里加内容，且与复制语义打架）。
- **`-webkit-app-region: drag`**：Electron 专有，WebView2 根本没有这个属性；它还会把整块区域
  从页面事件里摘走（按钮、勾选行被卷进去）。
- **子类化窗口过程、让 `WM_NCHITTEST` 返回 `HTCAPTION`**：本轮不做。它要改窗口过程（多一份窗口
  生命周期的责任与卸载顺序），收益只是「整条标题栏都能拖」——而卡片只有一行标题，
  `ReleaseCapture + WM_NCLBUTTONDOWN` 已经够，且不碰窗口过程。
- **页面自己算位移、发坐标让宿主挪窗口**：多一套坐标系（DPI、多屏），还要处理指针捕获丢失；
  系统移动循环把这些都免费给了。
- **拖动顺便把窗口抬到最前 / 抢焦点**：否。层级只有建窗时的 `WS_EX_TOPMOST` 一个来源（D-41），拖动不掺和。

**断言改动（有意改，不是迁就实现）**：

| # | 位置 | 改前 | 改后 | 理由 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `tests/card-shell.ps1:285` | 协议类型清单只列 `ready/resize/decision/cancel/expired/shown` | 加 `copy`（本来就漏了）与 `drag`，并检查 `HostMessage` 里有 `\| { type: 'drag' }` | 需求新增了 `drag`；`copy` 是上一轮加的通用消息但从没被这条守住 |
| 2 | `tests/card-shell.ps1:355`（原「认四种消息」） | 只解析 ready / decision / cancel / expired + 坏消息 | 加 `{"type":"drag"}` 一条 | `drag` 没有字段，靠的正是「未知 type 原样带出」这条通道；Type 丢成空串就拖不动 |
| 3 | `tests/card-shell.ps1:395` | 无 | 新增：抬头 `data-part="eyebrow"` 有 `onPointerDown` / `preventDefault` / `postToHost({type:'drag'})` / `cursor: grab` / `userSelect: none`，且仍以 `eyebrow` 为条件 | 页面侧整条链路（含「不许变成选字」「无抬头不能拖」）之前无人守；**2026-11-10 真机反馈后，目标从 `titleHtml` 改到 `eyebrow`** |
| 4 | `tests/card-shell.ps1:422` | 无 | 新增：`environment.ps1` 有 `ReleaseCapture` / `SendMessage` 声明；消息泵有 `drag` 分支且发 `0xA1` + `HTCAPTION(2)`；泵里没有 `SetWindowLong`/`WndProc`/`WM_NCHITTEST`/改大小常量；`environment.ps1` 的 `SetWindowPos` 调用点仍只有 1 处 | 宿主侧不做任何一件事都能「看起来能用」，三条边界（不改窗口过程 / 不做 hit-test / 不动层级）必须落成断言 |
| 5 | `tests/card-shell.ps1:525` | 兜底只查 `return <>{code}</>` | **追加**两条：兜底必须是 `if (!comment) return <>{code}</>`、且必须按 `COMMENT_COLOR` 渲染 `{comment}` | 高亮整体失败时说明不许丢（需求 5）；原检查一条没删 |
| 6 | `tests/card-shell.ps1:754`（原「说明进框内（B-31）」） | 要求 App.tsx 里**有** `# ${block.comment}`、它在 `<pre>` 里且在命令之前 | 反过来：App.tsx 里**不许**出现 `# ${`；`<pre>` 里必须有 `comment={block.comment}`、行内必须有 `comment={row.why}`；「只剩说明」的行要有兜底；highlight.ts 的注释 token 必须是 `textToken(line, COMMENT_COLOR)`；缓存键必须含 `comment ?? ''` | 需求本身反了（`#` 从「必须有」→「必须没有」）；链路覆盖更长：源码 → 参数透传 → token 生成 → 缓存键 |
| 7 | `tests/card-shell.ps1:779` | 无 | 新增：`canFold` 不许写成表达式、必须是 2 处裸 `canFold`；`overflowingKeys` 与真实溢出测量仍在 | 用户新口径「默认都显示」；同时防止顺手把 T-09 的定高依据删掉 |
| 8 | `tests/card-tokens.ps1:165`（新增 7 组探针） | 只测裸参数 / 字符串 / 命令 / 空 lang | 新增：单行说明首行是注释色 token 且内容等于原文、不带 `#`；多行说明逐行；说明后命令逐字不变；认不出语言时说明仍在且命令为正文色；换说明不串缓存、命中不串内容；空内容 + 有说明仍有输出；空白说明等于没有说明 | 这轮最有力的证据：它用 node 真跑 `highlight.ts`，不是拿正则看源码 |
| 9 | `tests/card-shell.ps1:408`（新增，2026-11-10 真机 bug 的回归防线） | 无 | 新增反向：`data-part="title"` 的 span **不许**有 `onPointerDown`、**不许**有 `cursor: grab`；`titleHtml` 仍是这一行的出图条件。失败文案按「窗口截图式」写（光标在 `C:\…` 变抓手 / 按住路径窗口跟着走） | 上一版把拖动错绑在 `titleHtml` 上，用户真机拖到的是工作目录那一行；没有这条反向检查，将来改回去也不会有人叫 |

**怎么复验**：

- `npm run build`（在 `shared\ui-card\app`，产物 `dist/index.html` 入库）——**由协调会话在本 worktree 完成**
  （子会话的受限令牌起不了 esbuild，报 `spawn EPERM`）：产物里能搜到 `drag` / `shiki-token-comment` /
  `userSelect`，即说明进流与抬头拖动都已进产物。
  **本轮改过 `App.tsx`，产物必须重建**（拖动改绑 `eyebrow`）；重建前 `dist/index.html` 里还是旧的
  `titleHtml` 绑定——源码已对、产物未对，真机验之前先构建。
- `pwsh -NoProfile -File tests\card-shell.ps1` → **89/89**（本轮 88 → 89：拖动区那条改盯 `eyebrow`，
  另加 1 条反向检查；本节早先写的 87 是旧数，已过时）；
- `pwsh -NoProfile -File tests\card-tokens.ps1` → PASS（探针从 5 组扩到 12 组）；
- `pwsh -NoProfile -File tests\command-only.ps1` → PASS；`tests\shared-ui-guard.ps1` → 10/10；
  `tests\preferences.ps1` → 45/45；`tests\layout.ps1` → **9/9**（`docs\images\*.png` 已按 B-42 于 10:34 重出，
  晚于 10:32 的产物）。
- **真人验（只能人做；要部署 + 重启宿主才生效）**：
  ① 打开一张带说明的卡：说明与命令**同色系**（灰）、**没有 `#` 前缀**，鼠标在说明行上也能看到
  右上角的复制/折叠按钮；② 折叠后说明随行流一起被裁（第 6 行之后的说明看不见，滚轮能滚到）；
  ③ 点复制：剪贴板里只有命令本体，不含说明；④ 按住**抬头**（`SSH · 执行确认` 那一行）拖动 →
  窗口跟着鼠标走，**松手处就是新位置**，抬头文字不会被选中，卡片高度/层级/焦点无变化；
  ⑤ 窗口边缘/角上按下 → **不该有改大小的行为**；⑥ 按住**首行路径**（`C:\…`）→ **窗口不动**、
  也不该出现抓手光标（2026-11-10 用户撞到的就是这个）；⑦ 没有抬头的卡：没有拖动区，按哪儿都不会误触发。

**已知代价**：

- 说明进流以后，说明行也算进「6 行」的折叠预算——说明越长，折叠态能看到的命令越少。
  这是「说明是代码的一部分」的必然结果（用户要的正是这个），不做「说明不计数」的例外。
- 拖动时消息泵停摆（见结论 8 第二条），拖动过程中不会处理任何宿主消息；关窗仍由 WinForms 自己走。

---

## D-41 置顶只在建窗那一刻成立：`CreateParams` 补 `WS_EX_TOPMOST`（修正 D-39 的层级来源）

> **让位语义见 D-43**（弹出即置顶，点卡片外面一下就让位）；本节只讲「怎么置顶」，置顶本身不变。

**现象**：D-39 之后，最大化浏览器（或任何最大化窗口）在前台时，卡片**仍然在它后面**——用户看到的还是
「没弹 / 卡住了」。用户原话：「不对啊， 我看很多软件都有 显示出新的窗口但不打断输入的 窗口。
这应该不是技术限制吧？」**判定：是缺陷，不是技术限制**；判据只有两条——① 卡片弹在用户当前窗口**之上**；
② 键盘焦点与输入**仍在**用户原来那个窗口（接着打字不丢字）。

**根因**：非前台进程改不了 Z 序。`SetWindowPos` / `SetWindowLong` 对**已建好**的窗口只能改「显示」与样式位，
Z 序那半被系统静默忽略：返回值是 True，扩展风格却一个位没变。本机 12 组对照（同一张卡，逐组看
`GetWindowLong(GWL_EXSTYLE)` 与 `GetForegroundWindow()`）：

| 做法 | 结果 |
| :--- | :--- |
| 建窗后 `SetWindowPos(hwnd, HWND_TOPMOST, …, 0x13 / 0x53)`（D-39 的线上实现） | `exstyle=0x50000`，**没有置顶位**；返回 True 但无效 |
| 建窗后 `SetWindowLong(GWL_EXSTYLE, ex \| 0x8)` | `0x50000`，无效 |
| `AttachThreadInput` 到前台线程再 `SetWindowPos` | 无效 |
| 跨进程 `SetWindowPos` 置顶 | 无效 |
| 先 `HWND_TOP` 再 `HWND_TOPMOST` 两次调用 | 无效 |
| **`Form.CreateParams` 里 `ExStyle \|= 0x00000008`（建窗时交给 `CreateWindowEx`）** | **`0x50008`，置顶成立、`IsWindowVisible=True`、`GetForegroundWindow() != hwnd`（前台没被抢）** |

Z 序属于「前台进程才准动」的那一类；而建窗时的扩展风格**不属 Z 序操作**（它随 `CreateWindowEx`
一起交给系统），所以成立。「置顶」与「不抢焦点」可以同时满足，我们之前只是走错了路。

**结论**：

- `shared/ui-card/environment.ps1` 新增 `New-CardForm`（放在 `Initialize-CardNative` 同层）：
  `Add-Type -AssemblyName System.Windows.Forms` → `if (-not ('DshUiCard.Card.TopMostForm' -as [type]))`
  → `Add-Type -ReferencedAssemblies $refs -TypeDefinition $src`，类型是：

  ```csharp
  namespace DshUiCard.Card {
    public class TopMostForm : System.Windows.Forms.Form {
      protected override System.Windows.Forms.CreateParams CreateParams {
        get { System.Windows.Forms.CreateParams cp = base.CreateParams; cp.ExStyle |= 0x00000008; return cp; }
      }
    }
  }
  ```

  - **必须幂等**：`environment.ps1` 被多个入口 dot-source（webview2.ps1、各测试脚本），类型在就不再编译；
  - **引用集取当前进程已加载的全部程序集**：只写 `-ReferencedAssemblies System.Windows.Forms` 会缺
    `System.ComponentModel.Primitives`（`CreateParams` 那一支的基类型在里面）而编译失败；
  - 建窗那一步的 `Add-Type` 仍是 `-TypeDefinition`，`tests/card-shell.ps1` 那条「`DshUiCard.Native`
    只有一处 `Add-Type`」的检查不受影响。
- `shared/ui-card/webview2.ps1`：`$form = New-CardForm`（替换 `New-Object System.Windows.Forms.Form`），其它一行不动。
- `Invoke-CardForceShow`：`ShowWindow` 与那次 `SetWindowPos(…, 0x0053)` **保留**，但只当**显示兜底**——
  `STARTUPINFO` 的 `SW_HIDE` 会吞掉进程第一次 `ShowWindow`，`0x0053` 里的 `SWP_SHOWWINDOW` 负责显出来、
  `SWP_NOACTIVATE` 负责不抢焦点；它的 Z 序部分无效，注释里写明实测数字 `0x50000` vs `0x50008`。
- **不许**新增 `SetForegroundWindow` / `.Activate()` / `.Show()` / `TopMost = $true`：抢前台是另一件事（C-01），
  置顶已经由建窗解决，不需要也不允许用「把用户打断」来凑可见性。

**被否方案**：上表前五行（事后抬层的五种写法）全部实测无效，不是「没试过」；`WS_EX_NOACTIVATE` 整窗会让
按钮/勾选/表单（还要能 Tab、密码框回车提交）变形（D-39 已否）；WinForms 的 `TopMost` 属性会在窗口被激活时
重新插回 topmost 层，等于第二条层级来源（D-39 已否）；`SetForegroundWindow`/`Activate` 就是 D-27 被用户
否掉的「打断输入」。

**断言改动（有意改，不是迁就实现）**：

| # | 位置 | 改前 | 改后 | 理由 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `tests/card-shell.ps1`「置顶（D-39…）」 | 只查对 `$Handle` 的 `SetWindowPos`：插入位置 `IntPtr::new(-1)`、flags 解析后 `= 0x0053` 且 `band 0x0010`；`-TopMost` / `$form.TopMost =` 不在 | 改名为「置顶（D-41，取代 D-39）」并**追加**：`function New-CardForm`、派生类是 `: System.Windows.Forms.Form`、`override System.Windows.Forms.CreateParams CreateParams`、`ExStyle |= 0x00000008`、`Add-Type` 幂等（`'DshUiCard.Card.TopMostForm' -as [type]`）、`$form = New-CardForm`、**没有**裸 `New-Object System.Windows.Forms.Form`；`SetWindowPos` 那组**一条没删**，只是语义改成「显示兜底」并多查 `SWP_SHOWWINDOW(0x0040)` | 层级来源从「事后 SetWindowPos」换成「建窗 CreateParams」；新增项全是这次 bug 的直接判据（少一个 `|=` 就退回 0x50000） |
| 2 | `tests/card-shell.ps1`「置顶回归（D-41）」（新增） | 无 | 新增反向：`environment.ps1` / `webview2.ps1` 里**不许**出现 `.Activate(`、`.Show()`、`TopMost = $true`；`SetForegroundWindow` 不在这里重复扫（「不抢焦点（C-01）」那条已按产品脚本全量扫） | 这次 bug 的回归防线：上一版就是靠「再抬一次」凑的，将来有人写回去要立刻红 |

**怎么复验**：

- `pwsh -NoProfile -File tests\card-shell.ps1` → **90/90**（基线 89：置顶一条拆成两条，其余一条没删）；
- `pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1` → 全部通过；
- `pwsh -NoProfile -File dsh-approval-notifier\tests\card-select.ps1` → 全部通过；
- **真人验（只能人做；要部署 + 重启宿主才生效）**：
  ① 最大化浏览器在前台时触发一张卡 → 卡片盖在浏览器**之上**；
  ② 键盘焦点仍在浏览器——不点卡片、直接接着打字，**一个字都不丢**；
  ③ `%TEMP%\dsh-card-flash.log` 里那一行仍是 `isForeground=false`（前台没被抢的旁证）；
  ④ 点卡片里的控件才把焦点拿过去；关窗后下面那个窗口回到前台。

**没做的 / 未验**：

- 真机上「置顶成立」与「焦点没被抢」**只有人手点一遍才算数**（12 组对照跑的是本机脚本窗口，不是产品卡）；
- `WS_EX_TOPMOST` 是窗口级：卡片会在所有普通顶层窗口之上，切到别的应用也仍在上层——D-39 记的
  「置顶持续到关窗」这个代价不变，不打算修。

---

## D-42 `# 说明` 是标准代码内容：拼进 source 交给 shiki（推翻 D-40 的「不拼 `#`」）

**现象**：D-40 之后的卡上，说明行是灰字但**没有 `#`**，用户 2026-11-10 原话：
「肯定要#号啊， 再说没有#你怎么让shiki渲染为注释的啊？你还有特殊处理？
我不是说了他就作为标准内容放进去shiki自己会处理吗？你还特殊处理了？」
**判定：是缺陷**（不是口味）。判据两条——① 说明行必须以 `# ` 开头，与命令里本来就有的注释长得一样；
② 它的颜色必须由 shiki 按**注释 scope** 给，不许自己造 token 上色。

**根因**：上一版把说明当成「不是代码」，用 `textToken()` / `commentLines()` 手造一条
`var(--shiki-token-comment)` 色的 token 直接拼在分词结果**前面**，并且不拼 `#`。这等于绕开 shiki：
屏幕上少一个 `#`，说明也没进 `codeToTokens`，「说明是代码的一部分」只在行流位置上成立。

**结论**：

1. `highlight.ts` 只留**一个** `#` 生成点 `commentSource(comment)`：逐行拼 `'# '`（`COMMENT_PREFIX + line`），
   空 / 纯空白说明返回空串；`source = head + '\n' + body`（只有说明时就是 head），**整段**交给
   `codeToTokens`。颜色自然来自注释 scope。
2. 删掉 `textToken()` / `commentLines()` / `plainLines()` / `COMMENT_COLOR` / `PLAIN_COLOR`：
   高亮路径上不再有任何手造 token。
3. `rebuilt === source` 这条校验现在对**整段**成立（含 `#` 行）——说明行每个字符也来自 shiki，C-08 更严。
4. 认不出语言时 `highlight()` 返回 null，`CodeText` 的 null 分支用 `commentSource()` 渲染
   「`# 说明` + 换行 + 命令」（纯文本、不着色，但 `#` 在；没命令时不补尾换行）。
   「只剩说明、没有命令」的行同理从 `commentSource(row.why)` 取前缀。
5. 缓存键 `${lang}\0${source}\0${comment ?? ''}` 照旧带 comment（说明已进 source，显式带上防将来分叉）。
6. 复制路径不变：调用方传 `commandOnly(block.command)` / `commandOnly(row.text)`，说明字段根本不在里面；
   `commandOnly` 仍按「行首 `#`」剥离，作为第二道保证（B-32 的断言一条没删）。

**被否方案**（就是上一版）：**手造注释色 token + 不拼 `#`**。它把说明与命令分成两条上色来源，
与 D-29 定过的「高亮是命令的唯一上色来源」直接冲突；而且用户一眼就看出少了 `#`——灰字只是「像注释」，
不是注释。

**断言改动（有意反转，不是迁就实现）**：

| # | 位置 | 改前 | 改后 | 理由 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `tests/card-shell.ps1`「高亮：任何失败都退回纯文本」 | 要求 `if (!comment) return <>{code}</>` 与 `<span style={{ color: COMMENT_COLOR }}>{comment}</span>` | 要求 `if (head === '') return <>{code}</>`、`const head = commentSource(comment)`，且**不许**再出现 `COMMENT_COLOR` | 回退分支现在也走 `#`、不着色（D-42 第 4 条）；「说明不许丢」的强度只增不减（多了「不许自己上色」） |
| 2 | `tests/card-shell.ps1`「说明并入高亮流」（改名 B-31/R-17/D-42） | 要求 `textToken(line, COMMENT_COLOR)`（手造注释 token）、App.tsx 不许 `# ${` / `'# '` / `"# "` | App.tsx 那三条**全部保留**；新增：`highlight.ts` 必须有 `'# '` 与 `COMMENT_PREFIX + line`、**不许**出现 `textToken` / `commentLines` 与 `[...head`、必须 `codeToTokens(source`、必须 `lines = tokens`；「只剩说明」那条改盯 `commentSource(row.why)` | 拼 `#` 只许一处、说明必须整段进分词；原检查一条没删，只把「需要手造 token」反转成「不许手造 token」 |
| 3 | `tests/card-tokens.ps1` §7（12 组探针） | 说明行**不带 `#`**、`content` 等于原文、且断言 `startsWith('#')` 必须为 false；未知语言退回「注释行 + 纯文本行」3 行 | 说明行**必须** `'# ' + 原文`、整行**一条** `var(--shiki-token-comment)` token；多行说明每行一个 `# `；整段（含 `#` 行）拼回逐字等于 source；未知语言 `highlight()` 返回 null、`commentSource()` 必须带 `#`（多行每行一个）；缓存/空内容/空白说明三组按新口径 | 期望随需求反转；这一条真跑 `highlight.ts`，是「`#` 真的进了 shiki」最有力的证据 |

**怎么复验**：

- `pwsh -NoProfile -File tests\card-shell.ps1` → **90/90**；
- `pwsh -NoProfile -File tests\card-tokens.ps1` → 需**协调会话在仓库根**跑（worktree 没有 `node_modules`，
  会 `ERR_MODULE_NOT_FOUND: shiki`）。本轮把同一份探针逻辑在临时副本里真跑过（node 24.9 + 根目录
  `node_modules` 只读复用）：说明行 1 条 token、内容 `# 看磁盘占用`、色 `var(--shiki-token-comment)`、
  多行每行 `#`、整段拼回相等、未知语言 `null` —— 全部符合；
- `pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1` / `dsh-approval-notifier\tests\card-select.ps1` → 全部通过；
- **真人验**：① 带说明的卡：第一行是灰的 `# 说明`（与命令里自带的注释同色）；
  ② 折叠时说明跟着一起被裁、滚轮能滚到；③ 复制只得到命令本体；④ 搬运卡（`lang=text`，走纯文本回退）
  第一行也带 `#`。

**没做的 / 未验**：

- `dist/index.html` 落后于源码（`highlight.ts` / `CodeText.tsx` / `App.tsx` 都改了）：必须由协调会话
  `npm run build` 重建后，真机才看得到 `#`；**未重建前真机看到的仍是旧行为**；
- 说明行在真机上的注释色与折行位置未验（离屏图只证明长相，不证明交互）。

---

## D-43 让位：弹出即置顶，用户第一次按在卡片外面就退回普通层（修 D-41 的「一直压在上面」）

**现象**：D-41 之后卡片确实盖在浏览器之上了，但它**不让开**——切到别的程序、点浏览器，卡片仍压在最上面。
用户 2026-11-10 原话：「又回到之前的问题了： 置顶了窗口 我其他程序即使激活 卡片还是在上面 影响使用」。

**判定标准**（三条，都是「窗口截图/真机一点就能看出」的）：① 用户点**卡片以外的任何地方**
（浏览器、别的程序、任务栏）后，卡片必须**立刻**退回普通层；② 在卡片上点（按钮、勾选、密码框、抬头拖动）
**不降层**，否则正在作答的卡会被自己的一次点击盖到后面；③ 全程**不抢焦点、不轮询**（不打断输入，也不空转）。

**根因**：`WS_EX_TOPMOST` 是**持久**的扩展风格，不会自动衰减——窗口一出生就在 topmost 层，除非窗口**自己**
调 `SetWindowPos(HWND_NOTOPMOST)` 或被销毁。而「让卡片露脸」又只能靠 topmost：非前台进程不能靠 Z 序抬高
（D-41 的 12 组对照，事后 `SetWindowPos` / `SetWindowLong` / `AttachThreadInput` 全部无效）。于是
「露脸」与「让位」必须由两条相反的机制各管一半：**建窗置顶** + **首次点外面时自己降层**。

三条想当然的替代路都不通，且都实测过（见「被否方案」）：非前台进程替**别人的**窗口降层无效；「前台窗口变化」
当不了触发（卡片从不获得前台，事件永不触发）；定时降层会盖掉还没看完的内容。

**结论**：

1. **建窗置顶不变**（D-41：`New-CardForm` 的 `CreateParams` 补 `WS_EX_TOPMOST(0x8)`）。让位不改变置顶的
   来源，只补上「什么时候退出 topmost」。
2. `shared/ui-card/environment.ps1`：给 `Initialize-CardNative` 的 P/Invoke 集合补
   `SetWindowsHookEx` / `UnhookWindowsHookEx` / `CallNextHookEx` / `WindowFromPoint` / `GetAncestor`
   （外加只读的 `GetWindowLong`，只为埋点记 `exstyle`）与 `POINT` / `MSLLHOOKSTRUCT` 两个结构体、
   `CardHookProc` 委托——**仍然只有一个** `Add-Type -Namespace DshUiCard -Name Native`，幂等照旧。
3. 新增 `Start-CardTopMostYield`（原生层，只认窗口与钩子，不认识业务）：
   - 装 `WH_MOUSE_LL(14)` 之前先记一行 `kind='yield-armed'`（含 `hwnd`、`exstyle`、`topmost`）；
   - 回调：`nCode -ge 0` 且消息是 `WM_LBUTTONDOWN(0x0201)` / `WM_RBUTTONDOWN(0x0204)` / `WM_MBUTTONDOWN(0x0207)`
     时，`WindowFromPoint(pt)` → `GetAncestor(…, GA_ROOT=2)` 算根窗口；**等于卡片 hwnd 就不动**，
     不等于就 `SetWindowPos($h, HWND_NOTOPMOST(-2), 0,0,0,0, 0x0013)` 降层、记 `kind='yield'`
     （`ret`、降层后 `exstyle`、`topmost`），然后卸钩、之后不再处理；
   - **委托必须留强引用**（`$script:YieldProc`）：放进局部变量出了函数就被 GC 回收，钩子随后**静默失效**
     ——现象是「点了外面毫无反应，也不报错」，demo 里踩过这个点；`hhook` 同放 `$script:YieldHook`；
   - 装钩失败**不许打断弹窗**：吞掉异常、记 `kind='yield-hook'`（`lastError` / `armed=false`），
     卡片继续置顶（让位是体验优化，不是功能前提）；全程**无定时器、无 `Start-Sleep`、无轮询、不看前台窗口**。
4. 新增 `Stop-CardTopMostYield`：`$script:YieldHook -ne 0` 才卸（幂等），卸完清强引用；
   只在**真的卸了**的时候记一行 `kind='yield-disarm'`。
5. `shared/ui-card/webview2.ps1`：`Invoke-CardForceShow` 之后、进消息泵之前
   `Start-CardTopMostYield -Handle $form.Handle`；`finally` 里第一件事 `Stop-CardTopMostYield`。
   量高、`OnShown` / `OnRendered`、拖动、复制回传一行没动。
6. **禁止**新增 `SetForegroundWindow` / `.Activate(` / `.Show()` / `TopMost = $true`：让位靠「自己降层」，
   不是靠「抢过来再还回去」（C-01 / D-41 的老账）。

**实测证据**：

| 观测 | 数字 |
| :--- | :--- |
| demo（`.session-files/tmp/demo-drop.ps1`，用户真机点过并说「这种是可以的」） | 建窗 `exstyle=0x50008`、`isForeground=false`（不抢前台）；第一次点窗口外 → `ret=True`、`exstyle=0x50000`（topmost 位掉了）；点窗口内 → 不动 |
| 非前台进程事后 `SetWindowPos(HWND_TOPMOST)` / `SetWindowLong` / `AttachThreadInput` | `0x50000` 不变（D-41 的 12 组对照） |
| 跨进程替**别人的**窗口降层 | 无效（`0x50000` 原地不动） |
| 本轮 `Start-CardTopMostYield` 的进程内冒烟（隐藏窗体，不弹卡） | `SetWindowsHookEx(14)` 返回 hhook 非零、`lastError=0`；伪造一次左键按下 → `0x50108 → 0x50100`（topmost 位清掉）、`ret=True`；`Stop` 后 hhook=0、再 `Stop` 无副作用；「命中的根窗口 == 卡片句柄」时**不降层**（无 `yield` 行） |
| 钩子的每条事件成本（PS 回调进出的实测） | **16.7 µs / 次**（1000 次移动消息的均值）：低层钩子在卡片打开期间会收到所有鼠标事件，按 500 次/秒算约 0.8% 一个核，所以「事件驱动」不需要额外的原生预过滤 |
| 埋点 | `%TEMP%\dsh-card-flash.log`：`yield-armed` → `yield-hook`（`armed`）→ `yield`（`ret`/`exstyle`/`topmost`）→ `yield-disarm`，只留最近 20 行 |

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| ① 定时降层（弹出 N 秒后自己退） | 时序猜不准：用户可能还在看，卡片就被别的窗口盖住；而「看完再退」没有任何可观测信号 |
| ② 抢焦点弹出（`SetForegroundWindow` / `Activate` / `SW_RESTORE`） | 打断输入（C-01，D-27 就是被用户这么否掉的）；而且抢前台只是把窗口「弄到最前面」，用户切走之后照样压着 |
| ③ 监听前台窗口变化（`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`） | 触发条件永远不成立：卡片**从不获得前台**（`isForeground=false`），浏览器始终是前台，始终「没有变化」→ 永不降层。实测推不出降层，不是「没试过」 |
| ④ 跨进程替卡片降层（宿主/别的进程调 `SetWindowPos(HWND_NOTOPMOST)`） | 前台限制：非本源进程改不了这张卡的 Z 序，`exstyle` 停在 `0x50000` |
| ⑤ `WS_EX_NOACTIVATE` 整窗 / WinForms `TopMost` 属性 | D-39 / D-41 已否：前者会让按钮/勾选/表单变形（还要能 Tab、密码框回车提交），后者会在窗口被激活时重新插回 topmost，等于第二条层级来源 |

**断言改动（有意改，不是迁就实现）**：

| # | 位置 | 改前 | 改后 | 理由 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `tests/card-shell.ps1`「拖动（R-15）：宿主 ReleaseCapture…」里那条层级计数 | `environment.ps1` 的 `::SetWindowPos(` 调用点**恰好 1 处** | 恰好 **2 处**（多出第三处即红），两处语义分别由「置顶（D-41）」与「让位（D-43）」各自钉住 | 让位按设计要加**一处**降层调用（`HWND_NOTOPMOST`）；计数从 1 改成 2 而不是删掉，第三处未登记的层级操作仍然立刻红 |
| 2 | `tests/card-shell.ps1`「让位（D-43）…」（新增 6 条） | 无 | 见下 | 这次缺陷的直接判据，少一条就会退回「一直压在上面」或「点卡自己也降层」 |

新增/改动的断言逐条（全部在 `tests/card-shell.ps1`）：

| 断言 | 钉的是什么 | 失败会看到什么 |
| :--- | :--- | :--- |
| `让位（D-43）：低层鼠标钩子的原生声明齐全…` | `SetWindowsHookEx(14`、`UnhookWindowsHookEx`、`CallNextHookEx`、`WindowFromPoint`、`GetAncestor`、`MSLLHOOKSTRUCT`/`POINT`、`yield-armed`/`yield` 埋点 | 切到浏览器后卡片还压在上面——让位没生效 |
| `让位（D-43）：只有「按在卡片之外」才降层——根窗口比对…` | `WindowFromPoint($info.pt)` + `GetAncestor($under, 2)` + `$root -ne $script:YieldHandle`，且降层在比对之后；只认 0x0201/0x0204/0x0207 | 点卡片里面的按钮，卡片反而被自己的点击盖到后面 |
| `让位（D-43）：降层是 HWND_NOTOPMOST(-2) + 0x0013…` | `[System.IntPtr]::new(-2)` + flags 解析后 `= 0x0013`（且不带 `SWP_SHOWWINDOW`） | 点了外面卡片纹丝不动（插入位置/flags 写错，Z 序不会变） |
| `让位（D-43）：回调委托的强引用留在 $script:…` | `$script:YieldProc = [DshUiCard.Native+CardHookProc]{`、`SetWindowsHookEx(14, $script:YieldProc, …`、`CardHookProc` 全文件只建一处 | 点了外面毫无反应也不报错——委托被 GC 回收，钩子静默失效 |
| `让位（D-43）：webview2.ps1 显示之后装钩、收尾 finally 卸钩…` | 调用点唯一、在 `Invoke-CardForceShow` 之后、`Stop` 在 `finally` 里 | 卡片关掉后钩子还活着（进程仍在处理鼠标），或者根本没装钩 |
| `让位（D-43）：事件驱动——没有 Start-Sleep / Timer / while / for` | 函数体内无轮询与定时（注释不算） | 用户还没看完卡片就被盖住，或者 CPU 白烧 |

**怎么复验**：

- `pwsh -NoProfile -File tests\card-shell.ps1` → **96/96**（基线 90，本轮 +6 条，见上表第 2 行）；
- `pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1` / `dsh-approval-notifier\tests\card-select.ps1` → 全部通过；
- 语法自检（改的是运行时真代码）：`[System.Management.Automation.Language.Parser]::ParseFile` 对
  `environment.ps1` / `webview2.ps1` 各 0 错误；再 dot-source 一次确认
  `Initialize-CardNative` / `Start-CardTopMostYield` / `Stop-CardTopMostYield` 都定义成功；
- **真人验（只能人做；`.ps1` 部署后即生效，不涉及重建 `dist`）**：
  ① 弹出卡片 → 卡片在浏览器之上；② **点一下浏览器** → 卡片立刻退到浏览器后面（不再压着）；
  ③ 再弹一张卡，**先点卡片里面的按钮/勾选框** → 卡片不降层；④ 让卡片让位后点任务栏上它的按钮 → 卡片回到前面；
  ⑤ 不点卡片、直接接着在浏览器打字 → **一个字都不丢**（全程没抢焦点）；
  ⑥ `%TEMP%\dsh-card-flash.log` 里依次出现 `yield-armed` / `yield-hook`(armed=true) / `yield`(`ret=true`,`topmost=false`)，
  关窗后 `yield-disarm`。

**没做的 / 未验**：

- **钩子在 WebView2 窗体里的行为未在真机验**：子窗口上 `WindowFromPoint` 返回的是 WebView2 的宿主/子窗口，
  `GetAncestor(GA_ROOT=2)` 逻辑上应归到我们的窗体（所以点卡片内容不会降层），但只有人点才算数；
- **装钩失败时的降级路径未真机验**：代码路径是「记 `armed=false`、卡片继续置顶、不抛异常」，
  本机冒烟里没有构造失败场景（`SetWindowsHookEx` 在该会话里总是成功）；
- **副屏**：判定用**窗口句柄**（`WindowFromPoint` 返回 hwnd、`GetAncestor` 归根）而不是比较坐标，
  所以多屏/负坐标（副屏在左）不影响判断；这一条是推理，未在副屏真机复验；
- `dsh-ssh-remote/README.md` 已 grep：里面没有「卡片会一直置顶」这类表述，**本轮不改文档**（不硬加）。

---

## D-44 短框展开后灰框不许变矮：折叠时记高，展开态用 `minHeight` 兜住（B-28 / T-09）

**现象**（用户 2026-11-10 真机，短命令卡：代码框只有一行、没有溢出）：

> 第三个 展开后怎么下面有了空白
> 我之前不说这么要求的吧
> 我不是说保持代码框高度
> 不然露出白色空白区域更不好看吗

> 展开后怎么代码框（灰色的）下面有了空白（白色的）
> 导致 代码框（灰色的） 与 按钮 中间有空白 （白色的）
> 能理解吗？
> 既然你给了默认高度（灰色的），那就不要收起来

**判定标准**（窗口截图就能看出）：点「展开」前后，灰框（`.card-code` 的灰底区）的**下边界不许上移**；
灰框底边与页脚按钮之间不许出现白色带。用户选定的处置是「展开时灰框不许变矮」，不是
「展开时窗口跟着缩」，也不是「干脆不关折行」。

**根因**：`App.tsx` 的展开态按「有没有溢出过」分两条路——

1. **溢出过**（`overflows` 为真）：折叠 `fixedBox` / 展开 `expandedBox`，两边都是**定高** `FOLD_BODY_MAX`
   （正文）/ `FOLD_ROW_MAX`（行内）= 6 行 + 露 10px，点开前后同高 → 没问题；
2. **没溢出过**（短框）：展开走 `expandedShortBox(max)`，它只把折行关掉（`whiteSpace: 'pre'`），
   **高度仍按内容自适应**。关掉折行后行数变少 → 灰框自然高度变小；而卡片窗口高度是宿主在 measure
   阶段量一次、fill 阶段钉成 100%，**不会跟着缩**（改窗口高度不在本次处置里，且点击后位置会跳，T-09 已否）。
   两者相减，就是灰框底边与按钮之间那条白。

**结论**：

1. 折叠态用 `useLayoutEffect` + `offsetHeight` 把**每个框**的实测高度记进 `foldedHeights`（`useRef`）：
   键与 `expandedKeys` / `overflowingKeys` / `codeRefs` **同一套**（`body-<下标>` / `row-<下标>`），
   正文块与行内框各一份；**只在折叠态记**（展开态量到的是被兜过的高度，回写会让折叠态也变高）。
2. `expandedShortBox(max)` 的返回体加 `minHeight: <该框折叠时的记录>`（没记录到就不加这项，退回原行为）。
   `maxHeight` 仍由 `foldedBox(max)` 带过来，所以「短框不许被撑成 130 的空框」（T-09 的另一半）不变。
3. `expandedShortBox` 保持**单参数**、仍然是唯一一份实现：每个框在拼样式前把渲染期游标
   `layoutKey` 指向自己的键，函数里按它取高度。**不动**溢出路径（`fixedBox` / `expandedBox`）、
   不动 `FOLD_BODY_MAX` / `FOLD_ROW_MAX`、不动折叠按钮的显隐（D-40 的「恒显」）、不改 `canFold`。

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| ① 短行不显示展开按钮 | 用户没选这条：D-40（2026-11-10）他明确要「按钮默认都显示，简单处理 又不影响功能」，收回去等于再翻一次 |
| ② 展开时让卡片窗口跟着缩（重新量高 / 调窗口高度） | 高度会跳、点击后卡片位置变化，T-09 已按用户当时的决定否掉；而且宿主只在需要时量高，链路上也不止一处 |
| ③ 干脆不关折行（展开=折行照旧） | 那「展开」这个按钮就没有任何效果，B-28 的「展开 = 不折行」被废掉 |

**断言位置**（`tests/card-shell.ps1`，只增不删，基线 96 → **98**）：

| 断言 | 钉的是什么 | 失败文案 |
| :--- | :--- | :--- |
| `展开（D-44）：短框展开后灰框不许变矮——折叠态的高度记下来当 minHeight` | `useLayoutEffect` + `offsetHeight/clientHeight`、`foldedHeights = useRef<Record<string, number>>`、折叠态回写 `foldedHeights.current[key] = height`、只记折叠（`expandedKeys[key] === true) continue`）、`expandedShortBox` 返回体里有 `minHeight: folded` 且按 `boxKey` 取、正文块与行内框各交 `layoutKey = key` / `layoutKey = rowKey` | 短命令点展开后，灰框底边和按钮之间又空出一条白 |
| `展开（D-44）反向：minHeight 不等于定高，短框仍按内容自适应（不退回空框）` | `expandedShortBox` 区域里不许出现行首 `height:`、不许 `height: FOLD_*_MAX`，且仍保留 `foldedBox(max)` | 短命令点展开后，灰框底边和按钮之间又空出一条白（短框被写成定高，会多出一块空框） |

**怎么复验**：

- `pwsh -NoProfile -File tests\card-shell.ps1` → **98/98**（基线 96，本轮 +2 条，见上表）；
- `pwsh -NoProfile -File dsh-ssh-remote\tests\card-select.ps1` / `dsh-approval-notifier\tests\card-select.ps1` → 全部通过；
- 新断言的**灵敏度**用内存里的变异源码验过：删掉 `minHeight` 行 → 第一条红；插入 `height: max` → 第二条红；
- **真人验**（要协调会话先重建 `dist`）：短命令卡点「展开」→ 灰框高度**不变**，灰框与按钮之间没有白带；
  展开后框内可能多出几点空白，这是本次接受的（用户原话：露出白色空白区域更不好看）。

**没做的 / 未验**：

- `dist/index.html` **没重建**（子会话没有 `node_modules`、`vite build` 起不来）：必须由协调会话
  `npm run build` 后真机才看得到；未重建前真机仍是旧行为；
- 真机上「短命令展开后灰框真不缩」未点过；**滚动条会不会出现**（记录值 = 折叠高度，理论上不会多出滚动）未看；
- 行内框（`data-part="row-code"`）与正文框（`data-part="code"`）两类都做了，但真机两类都未分别点过；
- 卡片宽度变化时记录值不会重算（窗口尺寸固定，宿主也不做 resize）；同一条命令在**折行宽度变化**后
  记录值可能偏大 → 展开态框内留白多几像素，不会出白带，暂不处理。

---

## 当前仍未定的

- 描边：颜色已按 B-26 改成橙色（`token.colorWarning`，D-27），**粗细仍是 1px，待真人看够不够辨认**；
  真机上如果还偏淡，下一轮只调粗细。
- 图标在真机任务栏 / alt-tab 里的实际观感（尤其 16×16 与高 DPI 缩放）待真人看；离屏预览只能证明长相。
- 闪烁：已改成「闪约 2.5 秒后显式 `FLASHW_STOP` 停」，带 `kind:flash/stop` 埋点（D-28）；
  **真机上是否真的停下来了，等下一张卡 + `%TEMP%\dsh-card-flash.log` 里那对 flash/stop 定案**。
- 代码高亮已接 Shiki（D-29 / D-31 附录 B）：产物已重建，**裸参数发绿已修，真机待看**（跳高与否只有真机才算数）。
- `buttons[].armDelayMs` 已删（BACKLOG #21）：`App.tsx` 只读 `payload.armMs`，按钮级防误点从未生效，
  防误点统一走 `payload.armMs`；`New-CardButton` 不再有这个参数，载荷里也不会再出现这个键。
- **D-32 的产物等重跑构建**：`measure.ts` 的行数判定已改（排序归并 + 整行可见才计），
  `dist/index.html` 必须重建后才与源码同步；探针已有一轮真机数字，但 **`6/9` 这一版还要按新口径
  重跑一次确认**：
  `pwsh -NoProfile -STA -File shared\ui-card\debug\render.ps1 -Payload out\probe-lines.json -OutFile out\probe-lines.png -Probe`。
- **D-43 让位（点卡片外面即退层）真机未点**：钩子装得上、降层数字对（`0x50108 → 0x50100`、`ret=True`）
  都只是进程内冒烟；「点 WebView2 卡片内容不降层」「点浏览器立刻让位」「全程不抢焦点」要真人点一遍。
  它只改 `.ps1`（`environment.ps1` / `webview2.ps1`），**不涉及 `dist` 重建**。
- **D-40 / D-41 / D-42 的产物都要重建**：`dist/index.html` 最后一次重建是 2026-11-10 10:32（727,239 字节，
  协调会话跑 `npm run build`；子会话的受限令牌起不了 esbuild，报 `spawn EPERM`），之后 `App.tsx`（拖动改绑
  `eyebrow`、`commentSource` 前缀）、`highlight.ts`（`#` 拼进 source）、`CodeText.tsx`（回退分支）都改过，
  所以**产物仍落后于源码**。要协调会话再跑一次 `npm run build`、重出 4 张卡片图。
  `webview2.ps1` / `environment.ps1` 不进产物（`.ps1` 部署时直接拷），不涉及重建。
  **真机还没点**（置顶是否成立、焦点是否没被抢、说明行的 `#` 与颜色、折叠同步、抬头拖动、
  路径行拖不动，都只有真人点一遍才算数，见 D-41 / D-42 / D-40 的复验）。
## D-45 高度不许赌时钟：先等页面加载完（NavigationCompleted），再给报高度的固定宽限

**现象**（2026-11-12 17:32 真机，用户原话「偶尔会出现这么高的」，截图 `SnowShot_20261112_173259.png`）：
SSH 执行确认卡弹出后比内容高一截——抬头 / 路径 / 一行命令 / 按钮之外，灰框与按钮之间还有一条约 80px 的白。

**判定标准**：同一份载荷的高度必须每次都一样（±2px），且必须等于页面量出来的那个值；
出现「窗口比内容高」就是缺陷，不许当成「反正能看」。

**证据（像素级，不是印象）**：

- 截图 680×360，四边都是 1px `#faad14` 描边 → 这张图**就是窗口本身**，不是屏幕裁切。
- 纵坐标分带：抬头文字 21–34、路径 48–64、行（勾选 + 灰框）77–230、**纯白 231–310（80px）**、按钮 311–344。
  按外壳的 16px 内边距 + 10px 段间距反推，内容自然高度约 290 → 窗口高了约 70px。
- 360 不是任何测量值：载荷里没有高度字段（`card-html.ps1` 的 `New-CardPayload` 不产出高度），
  页面的两个代码框被 `FOLD_BODY_MAX / FOLD_ROW_MAX = 130`（`App.tsx:19-56`）钉死，
  `#root` 在 measure 阶段是 `height:auto`（`styles.css` 里 `#root` 只有三条规则，dist 里已核），
  所以「量到 360」在结构上不可能。
- 360 **恰好**是 `$fallbackHeight`（`webview2.ps1:249`），而它同时是建窗初值（`webview2.ps1:295-297`）：
  窗口停在初值上说明 `SetWindowPos` 那一步用的就是兜底值，也就是**页面没在预算内报高度**。
- 「偶尔」不是测量误差：通知插件 246 张卡的埋点里 `contentHeight` 在 193–476 之间、**没有一张是 360**，
  说明页面侧的 `documentElement` 量高（`bridge.ts` 的 `contentHeight()`）平时是准的。
- 不是「ready 丢了」：页面进到了 fill 阶段（页脚钉住、body 滚动），而 fill 是收到宿主 `shown` 之后才切的；
  订阅 `shown` 与发 `ready` 是**同一个 effect** 里的相邻两行（`App.tsx:290-301`，先订阅后 post），
  所以那条 effect 一定跑过，`ready` 也确实发出去了——只是晚于预算。

**根因**：旧代码只有一个 2 秒时钟，起算点是 `NavigateToString`（原来 `webview2.ps1:345`）。
这 2 秒里同时装着 WebView2 冷启（浏览器/渲染进程）、728KB 产物解析执行、React + antd 首渲染、
Shiki 首次分词（同步，见下）——整段页面冷启。机器一忙（多个会话在跑、杀软扫新进程、字体缓存冷）
这段就会跨过 2 秒，于是 `$readyTimedOut = true` → `$logicalHeight = $fallbackHeight`；
而 `body` 是 `flex:1`（`App.tsx:547`），多出来的高度只能落在灰框与页脚之间，就是那条白。
超时之后宿主再也不会改高度（阶段 4 只更新 `$cardState.Height`，窗口已经定了），所以这张卡一辈子是 360。

**结论（改法）**：把「等多久」拆成两段，各量一件事（`webview2.ps1:246-249`、`128-166`、`390-405`）：

1. **页面加载**：等 `NavigationCompleted`（`$script:cardFlags.NavDone` 早就接好了，旧代码从来没读过它），
   收口 20s，与控制器初始化同一档（`webview2.ps1:352`）——这一段是冷启，不能拿常数赌；
2. **页面报高度**：加载完才起算 `$readyTimeoutMs = 2000`。这时布局已在眼前，React 的 ready 只比
   load 晚几十毫秒；2 秒还没报**才是页面自己的 bug**，这时落 360 才有意义。

判定抽成纯函数 `Test-CardHeightWait`（`webview2.ps1:128`），好处是能不建窗、不需要 WebView2 就把
「什么时刻算认输」直接测出来（见 `tests/card-shell.ps1` 的 D-45 四条）。落到兜底时往
`%TEMP%\dsh-card-flash.log` 记一条 `kind=height-fallback`（`webview2.ps1:406-417`），带
`segment=navigation|ready` 与 `elapsedMs`：下次真机上万一再现，一眼看出卡在导航还是卡在量高。

**这个改法的代价**（写下来，别装作没有）：页面彻底不加载时（导航永远不完成），窗口会先在屏幕外等满
20 秒才落到 360 显示——旧写法是 2 秒。也就是说，这一种坏情况从「2 秒无声失败」变成「20 秒无声等待」。
接受它的理由：`NavigateToString` 是内存里的字符串，正常导航 1–3 秒；真到了导航不完成这一步，
页面本身就是坏的，20 秒后至少还能看到一张能读的 360 卡。想再收紧就把 `$navigationTimeoutMs` 调小，
但那是照机器负载猜常数——D-45 要的正好相反。
**为什么这是根因、不是巧合**：

- 360 只能来自 `$fallbackHeight`（唯一写死的 360）；内容约 290 与 360 的差正好是 `flex:1` 吸走的余量；
- 页面侧的量高路径已被逐条排除：Shiki 是同步的（`createHighlighterCoreSync` + `useMemo`，
  `CodeText.tsx` / `highlight.ts`，`tests/card-shell.ps1` 守着「没有 await」）、字体不产生 70px、
  代码框定高 130 所以折行也长不高、`#root` 只有三条 CSS 规则；
- 同一次「偶发」里页面确实收到了 `shown`（进了 fill），证明页面是**慢**而不是**死**。

**怎么复验**：

1. `pwsh -NoProfile -File tests\card-shell.ps1` → D-45 四条（其中一条是 7 个时刻的时序表：
   3.2s 才加载完、12s 才加载完都必须拿到页面报的高度；加载完 2.5s 才报才允许兜底；导航一直不完成 → 20s 收口）；
2. `pwsh -NoProfile -File shared\ui-card\debug\height-stability.ps1`（**需要提权**，受限令牌里 WebView2 一律
   `0x8000FFFF`）→ 同一份载荷连出 10 次，逐次记 `contentHeight`，跨度必须 ≤ 2px，且 `height-fallback`
   命中数必须是 0；载荷用 `tests/fixtures/ssh-run.json`（就是真机那张卡的命令原文）。
   注意两个环境坑（2026-11-12 各踩过一次，脚本已改）：① 缺省的 WebView2 数据目录
   （`%LOCALAPPDATA%\dsh-ui-card\webview2`）被正在跑的卡片占着时 `CreateAsync` 报
   `0x800700AA`（ERROR_BUSY），所以脚本默认在 `<OutDir>\webview2` 建专用目录；
   ② `Start-Process -Wait` 会等整棵进程树，WebView2 的子孙不退出就永远不返回（实测卡满 30 分钟、
   零产物），所以改成 `.NET Process` + `WaitForExit(180s)`，超时连子孙一起杀、记一条失败。
3. 真机：正常用几天，`%TEMP%\dsh-card-flash.log` 里不该再出现 `height-fallback`；
   出现了就看 `segment`：`navigation` = 页面根本没起来，`ready` = 页面起来了但不量高。

**被否的方案**：

- **把 2000 调大**（比如 10s）：还是拿一个常数赌冷启时间，只是把概率压小；而且真卡死时要多等 10 秒。
  拆时钟之后 2 秒这个数才第一次量在「该量的那段」上。
- **把 360 调小 / 按行数估一个高度**：写死的值永远不是内容，估出来的高度迟早和真实排版对不上
  （用户 2026-10-30 否过「估算高度」那条路）。
- **超时后接受迟到的 resize 再改窗口**：窗口会当场跳一下、按钮位置变，T-09 / B-28 明确不许
  （「点击后位置变化」是用户点过的坑）。
- **页面先报一个粗高度、布局完成再报一次**：两次量高＝两次改窗口，同一个坑。
- **干脆去掉兜底，超时就 failed**：卡片偶尔弹不出来比偶尔高一点更糟（这张卡是审批，弹不出来就等于命令失败）；
  页面真坏时 360 至少还能读内容。兜底保留，但只在「加载完还不量高」这条路上。

## D-46 偶发矮 20px：屏区只解析一次 + 上限/报高/落位三者可对账

**现象（2026-11-12，用户原话「偶尔会出现这么高的」）**：同一份 `ssh_run` 载荷、同一台机器，
`debug\height-stability.ps1 -Runs 30` 的高度落在两个值上：**291**（多数）与 **271**（少数），
跨度 20px。271 的那几次不是「量小一点」，是**内容真被裁**——附注条（`超时 20s`）只剩上半截，
`probe.layout.fill` 里 `ant-flex` 的 `scrollHeight 154 > clientHeight 135`（裁 19px），
用户看到的就是「这张卡怎么这么矮」。

**逐次数字（`<run>.measure.json`，好/坏各两次，30 次里的样本）**：

| run | 窗口（`window`） | 第一条消息的高度（由钳高式反推） | 页面最终自然高（`layout.natural`） | `underReportedPx` |
| --- | --- | --- | --- | --- |
| 26 | 680×**291** | 291 | 291 | 0 |
| 27 | `3082,769` 680×**291** | 291 | 291 | 0 |
| 28 | `3082,789` 680×**271** | **271** | **291** | **20** |
| 29 | 680×**271** | **271** | **291** | **20** |

本机事实（这一轮实测，非上表记录）：两块屏 1920×1080，`WorkingArea` = `{0,0,1858,1080}`（主屏）与
`{1920,-4,1858,1080}`；`Get-DpiScale` 走 `GetDeviceCaps(LOGPIXELSX)=96` → **1.0**；
`Get-CardMaxHeight` = `Floor(1080 / 1 × 0.62)` = **669**。
有落位记录的两条都满足 `Top + Height + 16 = 1076` = 副屏 `WorkArea.Bottom`（769+291+16、789+271+16）
⇒ **好坏样本用的是同一块屏、同一个边距**。钳高式是 `Min(669, Max(160, 页面报高))`，于是：

> **窗口 271 只可能来自「页面第一条消息就报了 271」**——上限 669 根本没碰到它（差 398px）。
> 同一份 `measure.json` 里页面自己的 `layout.natural.contentHeight` 是 291、`underReportedPx` 是 20：
> 页面报出去的那一刻比它最终排版矮了 20px。`probe.trace` 里还留着一条 `resize{291}`、`phase=measure`
> （窗口还没显示）——**页面自己随后就说了 291，宿主只认第一条**（D-45 的「只认第一条」没变，改成让第一条就正确）。
>
> 2026-11-15 复核：三组各 30 次（安静 / 4 个 CPU 加压 / 安静）**90 次全部 291、跨度 0、裁切 0、量小 0**，
> `maxHeight=669`、`areaHeight=1080`、`scale=1`、`firstType=ready`、`firstHeight=natural=291`（30/30），
> flash log **没有一行 `height-clamp`** ⇒ **钳高这一条彻底排除**，271 只可能来自页面那一条消息。

**根因**：**页面的首条高度消息可能早于布局稳定。** 页面在首个被动 effect 里就量高并 `postToHost`，
而宿主只认第一条，所以那一条一旦早于最终排版（字体激活、附注条/页脚行盒建立、代码块折行都可能
落在首帧之后），窗口就永久矮 20px；20–40ms 后页面自己量到 291 并发了 `resize`，宿主按 D-45 不改窗口。
这是结构性窗口，不依赖「机器在编译」：机器忙只是把「首帧之后」这段时间拉长了，让窗口更容易被踩到。
（270.23 → 271 与 290.23 → 291 的差正好 20px，可能是代码框少一行、附注条没有行盒、或根 flex 两个
`gap:10` 没算进去，三者都能造成同一个数；90 次干净数据里 `firstCode=80`、`firstStrip=27.84`、
`firstRoot=290.23` 都已定格，说明**稳定之后的签名是唯一的**，不稳定那 20px 落在哪一块不影响修法。）

**修法（确定性收口：只改报高时机，不改协议、不改外壳接管方式）**：

- 页面侧 `app/src/settle.ts`（纯函数，`tests/settle.mjs` 直接测产品那份）：报高必须同时满足
  ① `document.fonts.ready` 已 resolve；② 连续**两次采样**的样本完全一致
  （`#root` 的高度与 `scrollHeight` 都相等）。满足才发，且**只发一条** `ready`。
  采样的时钟**不是** `requestAnimationFrame`——第一版用了 rAF，真机 30/30 全落兜底，见下一节。
- 一直不一致时不无限等、也不 sleep 固定时长：硬预算 `MEASURE_SETTLE_BUDGET_MS = 500`，到点按
  **最后一次**量到的报，并把「哪两次高度不一样」带回去（`unstable{first,last,reason,fontsReady,frames}`）。
  稳定判定排在预算之前：同一时刻既稳定又超预算时按「稳定」报，不留无意义的埋点。
- 宿主侧（`webview2.ps1` 消息泵）收到带 `unstable` 的 `ready` 只写一行 `kind=measure-unstable`
  （`firstHeight`/`lastHeight`/`reason`/`frames`/`fontsReady`/`area`/`scale`/`hwnd`），
  **不改接管流程**：ready 仍然只做「记下高度」这一件事。埋点不是协议对话，是取证线。
- `resize` 仍是取证线，且只在「报过高度之后」装上：由 `measurePosted` 这个 state 触发观察器重跑
  （报高改成异步之后，effect 里读 `readySent` ref 会永远读到 false，观察器就再也装不上了）。

**修正（2026-11-15 真机，推翻第一版的采样时钟）**：

第一版把「连续两次一致」挂在 `requestAnimationFrame` 上，真机 **30 次全部落到兜底 360**
（`兜底命中 4`、`量高不稳 0`、`钳高不符 30`、`underReportedPx = -69`，即窗口 360 比页面 291 **高** 69px——
这正是用户最早那句「偶尔会出现这么高的」的形状）。时间线（`run-01.measure.json`，t0 = 页面脚本起点）：

| 事件 | 时间 |
| :--- | :--- |
| trace 首个 `measure` 帧 | **t = 2327ms** |
| `ready`（h=291） | t = 2330ms |
| `resize`（h=291，populate 之后） | t = 2382ms |
| 宿主兜底 `kind=height-fallback, segment=ready` | `elapsedMs = 2280` |

**根因是时钟，不是判据**：宿主是「拿到 ready 才 `ShowWindow`」，在那之前窗口不可见、WebView2 基本不产帧，
`requestAnimationFrame` 回调被饿死——第一帧等了 2.3 秒，而宿主的 ready 预算是 2000ms。于是
**宿主等页面 ready、页面等 rAF、rAF 等窗口可见、窗口可见等宿主拿到 ready**，一个闭环死锁，最后宿主按
360 建窗，窗口一显示 rAF 才开始跑（t=2330 那条 ready 是显示之后才发出去的，已经没人听了）。
`fonts.ready` 这条路没问题，坏的是把「等布局稳定」绑成了「等窗口可见」。

改法（**只换时钟，判定逻辑一行没动**）：

- `App.tsx`：`setTimeout(step, MEASURE_SAMPLE_INTERVAL_MS)` 排下一次采样（`MEASURE_SAMPLE_INTERVAL_MS = 16`，
  在 `settle.ts` 里）。定时器不依赖帧生产，不可见窗口里照跑。
- effect 里**先同步采一次**：万一定时器也被节流，至少有一个真样本，预算到点时不会「一次都没量过」。
- `document.fonts.ready` 一到就立刻再采一次（不必等下一个 16ms）：字体就绪 + 两样本一致就马上报。
- `resize` 取证线仍然用 rAF（那条不发就不发，不影响接管），所以 `App.tsx` 里 rAF **只允许剩这一处**——
  `tests\card-shell.ps1` 现在按行扫，多一处就红。
- 判定与时钟彻底解耦：`settle.ts` 不取时间、不排定时器（`tests\settle.mjs` 直接扫源码钉住），
  换成任何 tick 源结论都一样。

**为什么「把 2s 预算调大」被否**：这不是长度问题，是依赖关系问题。rAF 在窗口显示前不产帧，调多大都等不到；
调大只会让用户多等一秒半才看到卡片，并且仍然落兜底 360。同理**兜底 360 也不动**：它是「页面真的没报」
的最后一道线，动了就把「量不到」掩盖成「量到 360」。

**构建注意（本机 sandbox 下必看）**：`npm run build` 的 esbuild 会在工作区外建临时目录并在退出时清理，
两者都可能被文件沙箱拒（表现为 `spawn EPERM` 或清理失败）。协调会话实测的解法是把 `TEMP` / `TMP`
指到工作区内（如 `.session-files\tmp\esbuild-tmp`）再构建。**vite 会先清空 `dist\` 再干活**，
构建中途失败会留下空目录——先 `git checkout -- shared/ui-card/dist` 恢复，别把空产物当成果交出去。
（受限于沙箱的子会话里 `spawn` 本身就被拒，这一步只能由协调会话来跑。）

**未复现（单列，不当作已修）**：271 在 v2 时间线脚本 + 「屏区只解析一次 + `-Area` 传递」之后
再没出现过（90/90 干净）。**这两者谁是关键没有证据分开**，所以本节只写「已消除可观测的窗口」，
不写「已修」。是否真修好看新埋点：`measure-unstable` 出现次数 >0 说明当时布局两帧内确实没停下来
（那时高度仍是「最后一次」的，不会再矮）；为 0 说明两帧判据一次都没被踩到。

**复验（可执行）**：

- `tests\settle.mjs` **27/27**（`node tests\settle.mjs`）：首帧不报、两次一致才报、先 271 后 291 时报 291
  （复刻 11-12 那次的形状）、`fonts.ready` 没到不报、预算到点报最后一次并带走 `first/last`、
  字体一直不来也不卡死、预算是小于宿主 2 秒的正数常量、采样间隔 ≤50ms 且远小于预算、
  **采样节奏被拉长到 900ms 结论不变**（时钟无关）、又稳定又超预算时按稳定报、
  `settle.ts` 里没有 `requestAnimationFrame(`/`setTimeout(`/`performance.now(`/`Date.now(`。
- `tests\card-shell.ps1` **113/113**：本轮新增 2 条——「采样时钟是定时器、不是 rAF」（按行扫 `App.tsx`，
  rAF 只许剩 resize 取证那一处，`settle.ts` 自己不许取时间/碰帧）、「字体+两次采样一致才报且 ready 只一处」；
  上一轮 4 条（预算到点带回两次高度、`measure-unstable` 埋点字段齐、桩测试 import 产品那份、
  产物不早于源码）与屏区/钳高 5 条不变。
- `tests\card-placement.ps1` **21/21**：`Resolve-CardScreenArea` 三条退让分支、「三块全空/全零/高为 0
  → `$null`」、「返回值必是传进去的某一块」、「返回值等于某块**真屏**的 `WorkingArea`」、
  「连调 20 次一致」、「无屏区时抛错」。
- `debug\height-stability.ps1 -Runs 30`（**需提权**；渲染与真机点击只能协调会话做）：
  判据 6「窗口高 = Min(上限, 页面报高)」、判据 7「上限能由记录的屏区算出来」，
  汇总里另报「量高不稳」次数（只报数、不判失败）。

**被否的方案**：

- **把 62% 调大**：上限本来就没生效（669 ≫ 291），调大只会让「真超长命令」的卡片失控。
- **把 271 当正常 / 接受这个跨度**：271 时附注条被裁 19px，是用户看得见的错，不是审美差异。
- **加一个固定 360 / 按行数估高度**：写死或估算的值永远不是内容（用户 2026-10-30 否过「估算高度」）。
- **接受晚到的 `resize` 再把窗口改高**：窗口会当场跳一下、按钮位置变（T-09 / B-28 / R-24 明令禁止）；
  「晚到的量不能改窗口」不变，所以只能让**第一条就正确**。
- **先报一个粗高度、稳了再补一条**：两次量高＝两次改窗口，与上一条同罪。只发一条，且发之前就得稳。
- **用固定 `setTimeout` / `Start-Sleep` 等布局**：那是拿常数赌「大概够了」，机器一忙就破；
  等的依据只能是「两帧一模一样」。
- **`Get-CardScreenArea` 失败时退回全零矩形**：0 高 → 限高被 160 下限抬走、落位落 `(0,0)`，
  等于凭空造尺寸；宁可报错、不出图（出图脚本缺屏本来就是环境问题）。
- **落位固定主屏**：多屏时卡片会跑到用户没在用的那块屏（PREFERENCES B-24，D-25）。

