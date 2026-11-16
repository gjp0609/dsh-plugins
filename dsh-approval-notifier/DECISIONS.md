# dsh-approval-notifier · 决策记录

每条一段，写清「为什么这么做」「被否的方案」「怎么复验」。动这块代码之前先读这里。

---

## D-01 审批卡上的命令不再截断（2026-10-29）

**现象**：审批卡上显示的命令被截成 400 字符 + `…`。用户看到的不是将要执行的那条命令，
超过 400 字符的命令（多行脚本、长命令行）后半段直接消失，末尾还被补了一个原文里没有的省略号。
判定标准取自 `PREFERENCES.md` **C-08**「命令原文原样展示，不加 `$` 前缀、不改写」——
显示与执行不一致属于**正确性缺陷**，不是版面问题。

**根因**：截断发生在**生产端**，不在渲染端。`index.js` 的 `buildCommandText()` 把摘要
（`command` / `file_path` / `path` / `pattern` / `url` / `argv`）截到 `SUMMARY_MAX_CHARS = 400`
再拼 `…`，然后才写进弹窗载荷的 `command` 字段；卡片 `<pre>` 只是原样渲染拿到的字符串。
另一路已用离屏渲染复刻同一张卡（436 字符、末行完整、无省略号、窗口 680×300），证明渲染层没问题。

**结论**：**删掉**摘要截断（`SUMMARY_MAX_CHARS` 与那行 `slice` 一并删除），命令 / 路径 / 参数
原文完整进载荷。`COMMAND_MAX_CHARS = 6000` **保留**，但只作用于「参数取不到摘要、退回显示 JSON」
这条兜底路径，且截断处显式写 `…（已截断）`（不是静默截断）。

**为什么删而不调大**：调大只是把「不一致」从 400 推到另一个数字，缺陷性质不变——只要存在上限，
总有一条命令会踩到，用户仍然看不到完整原文；而且上限是多少完全由版面猜，命令长度由业务决定。
正确做法是让「卡上的命令 = 业务层的原文」恒成立。卡片已支持框内滚动（B-28 方向），长命令变长
不会把卡顶爆，**版面不是在生产端截的理由**。

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| 把 `SUMMARY_MAX_CHARS` 调到 2000 | 只把缺陷推迟；2000 字符以上的命令仍然「显示 ≠ 执行」，且 2000 这个数字没有任何依据 |
| 保留 `…` 但加一行提示「已截断，完整命令见浏览器」 | 审批卡的意义就是「不看浏览器也能判断」；把判断依据推回浏览器等于这张卡在长命令上失效。而且提示文案救不了「用户以为看到的就是全部」的误判风险 |
| 在渲染层展开/折叠来「藏」长命令 | 那是卡片交互（B-28 / B-29），不是生产端截断的理由；藏起来也得是用户自己点的，不能默认少给内容 |
| 删掉兜底 JSON 的 6000 上限一起放开 | 兜底 JSON 可能是 Write 的整份文件内容（上兆字符），全塞进载荷既没信息量又拖慢弹窗；这条路径**已经显式标注**，不构成「静默截断」，所以保留 |

**同一文件的相邻检查**（本次逐个看过，结论：卡面内容只剩这一处静默截断）：

- `readCollected()` 里的 `text.slice(0, 2000)`：只用于失败诊断写进 `popup-no-decision` 日志，
  **不进卡面**，保留；
- `describeArguments()` 里的 `value.trim()`：只做首尾空白归一（命令首尾空白不影响执行语义），
  不是截断，未改；
- `textOrNull()` 的 `trim()`：同上，只用于元信息/理由/日志字段。

**复验方式**：

1. 自动化：`node dsh-approval-notifier\tests\orchestration.test.mjs`，看 U / V / W / X 四组
   （1200 字符多行命令长度一致且末尾无省略号；兜底 JSON 超 6000 带「已截断」；7000 字符命令
   不受 6000 上限影响；长 `file_path` 完整进载荷）；
2. 真机：让模型发一条 **>400 字符、多行**的命令触发审批（例如一段多行 pwsh 脚本），
   弹卡后确认**末行完整、没有 `…`**，与模型给出的原文逐字一致；长命令应在卡片中部滚动，
   而不是被截掉。

**测试断言变更（`AGENTS.md` §3：旧断言 → 新断言 + 为什么是修 bug 不是放宽）**：

- 旧断言：**没有**任何一条测试依赖「400 字符截断」这个行为（`orchestration.test.mjs` 原有
  52 条断言全部保留、一条未改、一条未放宽；`card-select.ps1` 也未涉及命令长度）。
- 新断言：新增 8 条（U×3、V×3、W×1、X×1），把「命令完整进载荷」「兜底 JSON 截断必须显式标注」
  钉成回归。合计 60 条，全绿。
- 因此本次**没有**「旧断言固化了错误行为」需要改写的情形；新增断言只加不减。

---

## D-02 说明句从框外正文块搬进命令框（2026-10-29）

**现象**：审批卡上「模型给的理由」是命令框**上面**单独一块正文（`note`），和设备 ssh 卡不一致——
ssh 卡早就是框内第一行 `# 原因`。同一个外壳出现两种说明形态：同一条说明的归属要靠「离得最近」去猜，
理由很长时还会把命令推到卡片折叠线以下（README「已知瑕疵」第 4 条就是这个）。

**根因**：适配层 `scripts/ui/shared.ps1` 的 `New-ApprovalCardPayload` 把理由交给了
`New-CardNoteBlock`（框外正文），命令块只用 `New-CardCodeBlock`，而外壳的 `CodeBlock.comment`
（框内第一行注释，`PREFERENCES.md` B-31）根本没被审批卡用上。

**结论**：

- 理由 → 命令块的 `comment` 字段（外壳渲染成框内第一行 `# …`，灰色、等宽），**删掉框外那个 `note` 块**
  ——同一句说明只出现一处，不许「框内一行 + 框外一段」重复；
- `comment` 里**不加** `# ` 前缀（前缀由外壳加，否则会渲染成 `# # …`）；长度**不截断**（理由也没有 400 字符
  那类上限，见 D-01）；
- 理由里的换行折成**一个空格**：`comment` 只有一行，框里其余每一行都会被读成「还要执行的命令」。
  在审批卡上，多出来的一行没有 `#` 前缀的说明会被误读成命令，这是会误导判断的显示错误，所以折行是修 bug。
  措辞一个字不改；
- 没有命令（`command` 为空，例如纯说明/确认）时**不产生 comment**，说明退回正文块——不许把说明硬塞进一个
  没有框的卡（任务约定 §2.4）；
- 没有说明时不写 `comment`，也**不再**给「（这次没有给理由）」这种占位块：命令本身就是卡的主体，不存在
  「留一块空白」的问题，凭空多一行注释反而像模板文案（B-14 的精神）；
- **实现（外壳已支持，直接传参）**：外壳的 `New-CardCodeBlock` 有 `-Comment`（写进块的 `comment` 字段，
  `ConvertTo-CardBlockList` 透传、没给就不写这个键），适配层建块时直接
  `New-CardCodeBlock -Command … -Lang sh -Comment <说明>`；说明为空就不传 `-Comment`（块里连键都没有）。
  本轮之前（外壳还没有 `-Comment` 时）用过一段临时补丁 `Add-ApprovalCodeComment`——在载荷拼好之后
  往 code 块上补字段；外壳参数到位后已删除（见文末「收尾」）。

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| 框外保留理由块，同时框内再放一份 `comment` | 「同一句说明出现两处」正是本次要消除的；重复两块文字在窄卡里白占高度，还让人以为是两件事 |
| 把理由塞进 `command` 正文（自己拼 `# xxx\n` 前缀） | 复制按钮会连注释一起复制（外壳的 `commandOnly()` 只去 `comment`，不会去命令里手写的注释行），而且违反 B-32「复制出去的是命令本体」 |
| `comment` 自己加 `# ` 前缀 | 外壳已经加一次，会渲染成 `# # 理由` |
| 理由超长时截断以适应「一行注释」 | 理由就是判断依据，截断等于藏证据（与 D-01 同一判断） |
| 多行理由原样塞进 `comment`（只首行有 `#`） | 后续行在命令框里看起来就是命令，审批卡上不能靠读者自己分辨哪行会执行 |
| 改 `shared/ui-card/card-html.ps1` 加 `-Comment` 参数 | 该目录不归本插件改（本轮禁改），且外壳侧已有独立任务在推；审批侧先按「载荷拼好后补字段」落地。（后续：外壳自己补上了 `-Comment`，审批侧已在文末「收尾」改成传参、补丁函数已删） |

**复验方式**：

1. `pwsh -NoProfile -File dsh-approval-notifier\tests\card-select.ps1`：**34** 条断言（收尾前 32 条，
   收尾新增 2 条负向/守卫断言，见文末「收尾」），其中
   「说明进命令框（B-33）」「说明不截断」「说明换行折成一行」「说明为空不出 comment」「没有命令退回正文块」
   五条专门守这次改动；
2. `node dsh-approval-notifier\tests\orchestration.test.mjs`：60 条断言不变（载荷里仍带 `reason`，
   进 `comment` 是适配层的事，宿主侧不受影响）；
3. 真机：触发一次审批，框内第一行应是灰色 `# …`（内容 = 模型理由，去掉宿主那句「允许本次操作使用 … 权限：」），
   框外不再有理由正文；点右上角复制，粘出来的只有命令本体。

**测试断言变更（`AGENTS.md` §3：旧断言 → 新断言 + 为什么是有意的结构变化）**：

| 旧断言（`tests/card-select.ps1`） | 新断言 | 为什么改 |
| :--- | :--- | :--- |
| 「结构：抬头 / 标题路径 / **理由块** / 命令块 / 两个按钮」：`body` **2** 块，`body[0].kind='note'`、`body[1].kind='code'` | 同名（去掉「理由块」）：`body` **1** 块，唯一的块是 `code` | 说明搬进命令框后，框外那块 `note` 被**删掉**了（本次的要求：同一句说明不许出现两处）。断言数的是真实结构，不数旧结构 |
| 「理由：**保留换行**；命令块只放原文」：`body[0].text` 含 `\n`、含「第二行理由」 | 拆成两条：「命令块：只放原文（不带 caption），说明走 comment」查 `command`/`lang`/无 `caption`/无 `text`；「说明换行：折成一行注释」查 `comment` 无换行、且等于「第一行说明 第二行说明」 | 旧断言固定的正是被删掉的「理由在正文块里、换行原样」；新行为是注释单行（见上面「换行折成一个空格」的理由）。`body[0].text` 已经不存在，断言必须跟着结构走 |
| 「理由为空：给 muted 占位」：`body[0].muted=$true`、文案含「没有给理由」 | 「说明为空：不出 comment、也不留占位块」：`body` 1 块、无 `comment` 字段、命令原文不变 | 占位句是给「框外空白正文块」救场的；现在说明在框里，没有说明就没有那一行，不需要（也不该）凭空造一句注释 |
| 「转义：**理由**/命令里的 HTML 字符…」：`$back.body[0].text` 等于原文 | 同名：`$back.body[0].comment` 等于原文 | 理由的落点从 `body[0].text` 变成 `body[0].comment`（同一个块，换字段） |
| （无） | 新增「说明进命令框（B-33）：理由出现在 `code` 块的 `comment` 里，`body` 里不再有同一句」+ 新增「没有命令：说明退回正文块，不硬塞 comment」 | 前者是本轮的验收要求（用可识别的中文说明句比对「在 comment 里」「body 里没有重复」）；后者守住 §2.4「没有命令就不要 comment」 |

`orchestration.test.mjs` 一条未改、一条未放宽：它断言的是宿主写出的 `reason` 字段（`index.js` 未改），
说明进 `comment` 发生在 PowerShell 适配层，宿主侧没有观察点。

### 收尾（2026-10-29）：拆掉临时补丁，改普通传参

**背景**：外壳已正式支持代码块注释字段——`shared/ui-card/card-html.ps1` 的 `New-CardCodeBlock`
有 `-Comment`（非空才写 `comment`），`ConvertTo-CardBlockList` 透传、没给就不写这个键
（master `0c475f5`「产物：重建 dist（裸参数回正文色 + comment 参数）」）。

**结论**：

- 删掉 `scripts/ui/shared.ps1` 的 `Add-ApprovalCodeComment` 与它的调用点；
  `New-ApprovalCardPayload` 建块时直接传参：说明非空才传 `-Comment`，空说明不传
  （块里连 `comment` 键都没有，不是空字符串）；载荷拼好之后不再二次加工；
- 语义一字未变：换行仍折成一个空格（`ConvertTo-ApprovalCommentText` 保留）、措辞不改、不截断、
  不加 `# ` 前缀；没有命令时说明仍退回正文块、不硬塞 `comment`；
- `shared/ui-card/**` 未改：`-Comment` 是外壳自己的参数，本插件只是改成用它。

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| 留着 `Add-ApprovalCodeComment` 做「兼容旧外壳」 | 本仓库不做兼容层（`AGENTS.md` §0）：外壳与插件同仓同版本，参数缺失只会是「改了一半」，那种状态本来就该报错 |
| 无条件传 `-Comment $comment`（空串也传） | 外壳把空串当「没给」（`IsNullOrWhiteSpace`），行为等价；但「说明为空就不传」才和「不出注释行」一一对应，读代码时不留歧义 |
| 在适配层保留「comment 从哪来」的兜底分支 | 能重试的失败不做兜底：外壳有没有 `-Comment` 是构建期事实，不是运行期分支 |

**测试断言变更（`AGENTS.md` §3：旧断言 → 新断言 + 为什么）**：

- **现有断言一条未改**：32 条原样通过。没有任何一条引用 `Add-ApprovalCodeComment` 的名字或内部行为
  ——它们断言的都是载荷结果（`body[].comment` 有说明、`body` 里没有重复说明、空说明时无 `comment`），
  所以拆补丁不需要动它们。顺带更正：D-02 原文写「33 条」是计数笔误，收尾前实测为 **32 条**。
- **新增 2 条（合计 34 条）**：
  1. 「说明为空：载荷里根本没有 comment 键（不是空字符串，序列化后也不出现）」——负向断言：
     `Contains` 与 `PSObject.Properties` 两路都查键不存在，序列化后的 JSON 里也不出现 `"comment"`。
     为什么需要：旧断言只查了 `body[0].Contains('comment')`；若哪天有人传空串、或外壳写成 `comment: ""`，
     页面上会多出一行空的 `#`，而「有键、值为空」在只看「有没有说明」的旧断言下容易蒙混过关；
  2. 「适配层不再有 comment 补丁：说明由 `New-CardCodeBlock -Comment` 直出」——
     断言 `Add-ApprovalCodeComment` 不存在，并用一次真实的
     `New-CardCodeBlock -Comment` → `New-CardPayload` → JSON 链路证明 `comment` 一路透传。
     为什么需要：这是本轮「拆补丁」本身的回归守卫，防止补丁以别的名字悄悄回来。

**复验方式**：`pwsh -NoProfile -File dsh-approval-notifier\tests\card-select.ps1`（34 条全绿，输出「全部通过」）、
`node dsh-approval-notifier\tests\orchestration.test.mjs`（60 条全绿）。本轮不跑渲染、不构建、不装卸宿主。

---

## D-03 桌面卡答完就撤掉网页里的审批提示（2026-11-02）

**现象**：桌面审批卡已经给出决定（允许一次 / 拒绝）之后，网页里那条审批提示还挂着，用户必须再点一次
或刷新页面才消失。用户原话：「这个是现在最影响使用的一个点」。

**判定**：属于双通道体验缺陷，不是安全缺陷 —— 决定已经生效、工具按桌面卡的选择执行；但提示不消失
会让用户以为「没批上」，于是去点第二次或刷新，这正是最影响使用的地方。判定标准：桌面卡落定后，
**不点网页、不刷新**，网页里的提示应当自行消失；网页与桌面卡不能同时给出两个决定。

**根因**（`文件:行` 均指**调研时的 DSH 版本 `@deepseek-ai/dsh@0.2.1-rc.2`**，行号以该版本为准；
升级后行号会漂，按名字找）：

1. `dsh-user-approval/lib/index.js:172-176`：`decide()` 在派发瀑布**之前**同步取走 `const signal = req.signal`，
   瀑布在 microtask 里才跑。所以之后谁替换 `req.signal`，都不参与「谁赢」的判定。
2. 本插件 `index.js` 的 `handleApproval` 用 `prepend: true` 排最外层，但它**先把请求 `next()` 给下游**
   （改动前 `index.js:605` 的 `settleDownstream(next)`，编排竞速在 `:638-648`）；下游是 `dsh-api-remotes`
   / `dsh-api-gateway` 的转发桥，把请求投影给浏览器。
3. 浏览器端 `dsh-client-ui-approval/lib/client.js:284-310` 据此建 `PendingApproval` 并 `await pending.result`，
   只在 `finally` 里 `remove()`（`:306-309`）；另一个出口是请求 signal 被 abort（`:191-201` → `:240-245`）。
   面板本身（`:48-139`）只有「拒绝 / 允许一次」两个按钮，**没有超时、也没有关闭按钮**。
4. cancel 帧的唯一出口：宿主侧 signal abort 触发 `dsh-api-gateway/lib/index.js:1082-1085`（`cancelRemoteEvent`）
   → `:1150-1154` 的 `finishRemoteEvent` 向浏览器推 `{type:'cancel'}` 帧 → 浏览器端
   `dsh-api-gateway/lib/types/client/remote-events.js:76-79` 收到帧后 abort 这次投递的 signal。
5. 桌面卡赢时插件直接 `return` 决定，**没有任何人 abort 那个已经投给浏览器的请求** → 面板永远挂着。

**结论（方案 A）**：给每次审批请求套一个**我们自己的 `AbortController`**，把 `req.signal` 换成
`AbortSignal.any([原 signal, 我们自己的 signal])`（本来没有 signal 时直接用自己的），**在调用 `next()` 之前换**，
然后照原样交给下游与编排。三种出口（① 弹窗给出决定 ② 下游/网页先给出决定 ③ 外部 abort）都汇到
`handleApproval` 的 `finally`，**只 abort 一次**自己的 controller，`reason = Error('approval already decided')`。

实现形状（`handleApproval` 只做「装 signal / 收口 abort」，原编排改名 `decideApproval`，语义一字未改）：

```js
const own = new AbortController()
const origin = req.signal
req.signal = origin === undefined || origin === null ? own.signal : AbortSignal.any([origin, own.signal])
try {
  return await decideApproval(runtime, req, next)
} finally {
  if (!own.signal.aborted) own.abort(new Error('approval already decided'))
}
```

为什么这样安全：

- **不改判定**：`decide()` 早已取走原 signal（根因第 1 条），融合信号只决定「网页提示何时撤掉」；
  融合信号 abort **不会反向 abort 原 signal**，工具自己的 `exec.signal` 不受影响，命令照常执行。
- **只在决定产生之后 abort**：`finally` 在编排返回后执行；唯一「不返回」的路径是弹窗没给出决定后
  继续等浏览器（原 `popup-no-decision` 分支），那条路不会走到 `finally`，因此不会被误 abort。
- **只 abort 一次**：外部 abort 结束的是融合信号，我们自己的 controller 仍然活着一份，`finally` 补一次；
  有 `own.signal.aborted` 守门，不存在第二次。
- 新增测试 Y / Z / AA / AB 分别钉住「弹窗赢」「下游赢」「外部 abort」「弹窗无决定不许 abort」四种情形，
  并额外断言「决定产生之前 signal 仍是活的」（防止把 abort 挪到入口、提前掐断浏览器通道）与
  「工具自己的 signal 没有被 abort」。

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| 改 `node_modules/@deepseek-ai/dsh-*`，让宿主在决定后自己发 cancel 帧 | 第三方包不在本仓库，升级/重装即失效，等于每次升级都要重打补丁；出问题无人兜，且违反「不新增 vendor patch」 |
| 调换顺序：先弹窗，弹窗无决定才 `next()` 给浏览器 | 这是放弃双通道：`delayMs` 内浏览器本来可以先答（现有决议），先弹窗会让每次审批都多等一次、多弹一次，且网页端不再有机会先答 |
| 网页端加超时或关闭按钮 | 改不了第三方客户端包；而且「提示何时该消失」只有生产端知道，客户端猜不出决定已经产生 |
| 桌面卡赢后由插件另发事件/刷新页面通知浏览器 | 没有现成协议，等于在审批链外再造一条通道；cancel 帧本来就是为此存在的 |
| 只在弹窗赢时 abort，下游赢/外部 abort 交给原有逻辑 | 下游赢时原先也没人 abort；三处各写一遍容易漏、容易重复，`finally` 一处收口才能保证「只 abort 一次」 |

**测试断言变更（`AGENTS.md` §3：旧断言 → 新断言 + 为什么）**：

- **现有 60 条一条未改、一条未放宽**（A–X 原样通过）；`tests/card-select.ps1` 等 PowerShell 断言未动。
- **新增 24 条（合计 84 条）**：Y×6、Z×7、AA×5、AB×6。只加不减。
  - Y/Z 各有一条「决定产生之前 signal 仍是活的」：第一稿只断言「结束后 aborted」，
    若哪天有人把 abort 挪到入口，网页通道会被提前掐断而测试仍绿 —— 这条专门堵它。
  - AA 用 `signal.reason === 外部 reason` 证明我们没提前/覆盖外部 abort，用计数器证明自己的 controller 只 abort 一次。
  - AB 用 `never()` 的下游把请求停在「等浏览器」上，确认 `popup-no-decision` 之后 signal 仍是活的、
    一次 abort 都没有，然后才外部取消收尾。
  - 计数器实现：用例期间用子类替换全局 `AbortController`，记录每次 `abort(reason)`，`try/finally` 恢复。
    本文件是顺序脚本（顶层 `await`），**不要改成并行执行**，否则会互相串味。

**复验方式**：

1. 自动化：`cd dsh-approval-notifier && node --test --test-isolation=none "tests/*.test.mjs"` ——
   84 条全绿（基线 60 条）；重点看 Y / Z / AA / AB 四组。
2. 真机（必须人点，脚本注入点击禁止）：
   - 触发一次审批，桌面卡点「允许一次」，**不点网页、不刷新**：网页里那条提示应在 1 秒内自行消失；
     工具只执行一次；`allow` 生效范围仍是一次；
   - 再触发一次，让网页先答：桌面卡应同时关闭，网页提示随决定消失；
   - 再触发一次，点宿主「停止」：结果仍是 `cancelled`，卡片与网页提示都不残留。
3. 反向核对：桌面卡「拒绝」后网页提示同样消失；网页端不应还能在已消失的提示上再点一次
   （cancel 后 `PendingApproval` 已 settle，`answerable === false`）。

## D-04 点按钮就崩：OnShown 回调的返回值漏进外壳返回值，`[int]` 收到数组（2026-11-02）

**现象**：真机上点桌面卡按钮的那一刻弹窗进程崩掉，决定没有写出去，宿主只能继续等网页那张卡；
用户必须去网页里再点一次。日志形态（`popup-no-decision`）：

```
stage:shown  →  (约 6 秒后，正是人点按钮的时刻)  stage:card-failed
error: Cannot convert the "System.Object[]" value of type "System.Object[]" to type "System.Int32".
```

**判定**：正确性缺陷（决定丢失 + 双通道失效），不是观感问题。判定标准：点「允许一次 / 拒绝」后，
结果文件必须写出对应决定；`card-failed` 只允许出现在「卡片根本没起来」这种不可重试路径上。

**根因**（三处合起来才成立，`文件:行` 指本次修复前的 worktree）：

1. `scripts/prompt.ps1:265`（`$onShown` 回调）直接调用 `Invoke-TaskbarFlash -Handle $form.Handle`
   而**没接住返回值**。`Invoke-TaskbarFlash` 会 `return [pscustomobject]@{ StopAfterMs; Watch }`
   （`shared/ui-card/environment.ps1:235`）。
2. `shared/ui-card/webview2.ps1:424` 的 `try { & $OnShown $showInfo $form $ctrl } catch { }`
   同样没接住输出。PowerShell 把回调的输出接进 `Show-CardWindow` 的输出流，于是
   `Show-CardWindow` 返回 `@(<flash 会话>, <结果对象>)` 而不是结果对象本身。
3. `scripts/ui/card.ps1:128` 的 `[int]$window.ContentWidth`：`$window` 是 `Object[]` 时，
   **非严格模式**的成员枚举会按元素逐个取值、缺属性的位置补 `$null`，得到 `@($null, 680)`；
   `[int]` 对数组强转 → `Cannot convert ... to type "System.Int32"`。
   `prompt.ps1:318` 的 `Set-StrictMode -Off` 正是让这一步走到强转而不是先报 property 错的原因
   （严格模式下 `$window.Action` 会先抛，报错点会变成第 123 行）。

为什么只在「点按钮」时炸：`Show-CardWindow` 只有在收到终态消息（`decision` / `cancel` / `expired`）
或关窗、到点时才返回。点按钮 → 立刻返回 → 立刻崩；手关窗与到点同样会崩（17:07、17:09 那两次
没记 `card-failed`，是因为用户在网页先答、宿主把弹窗进程取消了，`cancelled=true`）。
所以不是「点击路径特有」，而是**任何一次正常返回都崩**，点击只是决定被丢掉的那条。

**证实方法**：按 `prompt.ps1` 的加载顺序（`environment.ps1` → `card.ps1` → `Set-StrictMode -Off`）
dot-source 真实适配层，用同名假 `Show-CardWindow` 返回 `@(<flash 会话>, <结果对象>)`，
调用 `Invoke-CardApproval` 复现出**逐字相同**的错误与行号：

```
THREW: Cannot convert the "System.Object[]" value of type "System.Object[]" to type "System.Int32".
at Invoke-CardApproval, ...\scripts\ui\card.ps1: line 128
```

修复后同一段代码返回 `count=1 kind=allowed-once cw=680 (Int32)`。

**结论**：两头都收口，不在消费端吞异常。

1. `scripts/prompt.ps1`：`$null = Invoke-TaskbarFlash ...`（回调不再吐返回值）。
2. `shared/ui-card/webview2.ps1`：`$null = & $OnShown ...` / `$null = & $OnRendered ...`
   —— 外壳契约改成「回调的返回值一律丢弃」，任何调用方的回调都不可能再污染 `Show-CardWindow`
   的返回值（ssh 插件那条路径也一并受益）。
3. `scripts/ui/card.ps1`：外壳输出先收进 `$outputs`，再按「有没有 `Action` 字段」认出**唯一**
   结果对象（不按位置取，回调输出落在结果前后都不怕）；认不出唯一结果就抛一条能读的错，
   `[int]` 不再可能收到数组，也不会把「外壳形状变了」静默当成「没决定」。
4. `scripts/prompt.ps1` 的 `catch` 增记 `stack = $_.ScriptStackTrace`（截断 4000 字符）：
   上次只有 Message，定位多花了一轮；下次直接看行号。

**为什么不能只加 `catch`**：那会把「决定已经产生、只是写不出去」变成「没有决定」，
用户被迫去网页再点一次——正是本缺陷的表现；而且数组会继续喂给 `[int]`，只是被藏起来。

**被否方案**：

| 方案 | 为什么否 |
| :--- | :--- |
| 把 `[int]$window.ContentWidth` 换成 `[int]::TryParse` / `-as [int]`，失败给 0 | 把「外壳返回值被污染」藏进尺寸字段：崩是不崩了，但决定仍可能被静默改写；诊断字段也不该吃垃圾 |
| 只改 `prompt.ps1` 的 `$null = Invoke-TaskbarFlash` | 只堵住本插件这一处；外壳的 `& $OnShown` 仍然是「谁的回调吐对象谁把外壳返回值搞成数组」，ssh 与后续接入方随时复发 |
| 只改外壳，消费端仍按位置/单对象假设取值 | 外壳契约修好之后确实不炸，但消费端仍在「假设外壳只返回一个对象」；断言里那条数组形态会重新变红，等于没有防线 |
| 让 `OnShown` 不再闪任务栏 | 闪任务栏是 B-27 / D-28 定的「不置顶时唯一别漏看的手段」，不能为了绕 bug 砍功能 |
| 在 `catch` 里把异常当「用户没决定」静默收尾 | 明确禁止：等于用错误掩盖决定丢失，fail-closed 变成「fail-silent」 |

**断言（`tests/decision-scalar.ps1`，11 条，新增文件不动既有基线）**：

- 「外壳返回数组时不炸，决定类型正确」「返回对象只有一个」「数值都是标量（[int] / [string]）」
  —— 直接跑 `Invoke-CardApproval`，用数组形态的假窗口当输入；
- 「单对象时行为不变」「数组形态下 failed 仍交出 error」「数组形态下 cancel / 到点不算作答」
  —— 防新的取值方式把正常路径或失败信息吃掉；「外壳没吐结果对象时抛明确错误」—— 防静默当「没决定」；
- 「映射函数只返回一个字符串」；
- 源码契约三条：外壳接住 `OnShown` / `OnRendered`、`prompt.ps1` 接住 `Invoke-TaskbarFlash`、
  `$window` 从 `$outputs` 里按 `Action` 认出来（不按位置）；`card-failed` 诊断带 `stack` 且截断 4000。

**复验方式**：

1. `pwsh -NoProfile -File dsh-approval-notifier\tests\decision-scalar.ps1` → 11 条全绿；
2. `cd dsh-approval-notifier && node --test --test-isolation=none "tests/*.test.mjs"` → 84 条全绿；
3. `pwsh -NoProfile -File dsh-approval-notifier\tests\card-select.ps1`（既有 34 条）与仓库根
   `tests\card-shell.ps1`（83 条）不变红；
4. 真机（必须人点）：触发一次审批，桌面卡点「允许一次」，**不点网页**：命令应执行一次、
   网页提示应自行消失（D-03），`notifier.log` 里**不再出现** `card-failed`；
   再点一次「拒绝」，结果应为 `rejected`。


