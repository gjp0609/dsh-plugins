# DECISIONS

本文件记录 `dsh-rail-pins` 里非显然的选择：为什么这么做、被否的方案、以后怎么复验。
改动前先读这里；结论变了就改这份文件。

---

## D-01 用 `shell.overlay` + 量取 `_listArea`，而不是替换侧栏或 portal

**现象**
需要把「已 pin 的会话」画进 rail 搜索图标下面那块空白（约 36px 宽），且不能碰 DSH 自己的搜索按钮、工作区树、会话行。

**判定**
满足三点才算对：① 不替换官方 UI；② 折叠/展开、窗口缩放后位置跟得上；③ 量不到时宁可整块不显示。

**根因**
`shell.overlay` 是框架级、可追加的 `kind:"list"` 槽，层本身 click-through，条目自己开 pointer events；而 `_listArea` 是 `ui-workspace` 内部的 DOM，不是 slot，也没有稳定类名（`bhn1Oq_listArea` 的哈希每次构建会变）。

**候选与代价**

| 方案 | 代价 |
| :--- | :--- |
| 替换 `sidebar.workspaces` | 这是 `single` 槽，`ui-workspace` 的整个浏览器（搜索、工作区树、会话行、行菜单）都挂在里面；注册进去是整块替换，要重写一遍官方侧栏，且 DSH 一升级就坏。 |
| React portal 进 `_listArea` | `_listArea` 不是 slot，插件拿不到它的 React 容器；按 DOM 找节点再 `createPortal` 需要 `react-dom`（Module Loader 只给 baseline 模块），且节点重建时 portal 目标失效，比浮层更脆。 |
| 用 `sidebar.panellist` | 这个槽不存在。`sidebar` 下只有 `sidebar.workspaces`、`sidebar.session.row.leading/menu/action` 等；`listArea` 内部没有槽。 |
| `shell.overlay` + 量取 rect | 只依赖 `_listArea` 后缀；需要 `ResizeObserver` + `MutationObserver` + 宽度判定；量不到就隐藏。 |

**结论**
选第 4 个：`shell.overlay` 注册条目（`id:'rail-pins'`，`order:50`），`position:fixed` 盖在 `getBoundingClientRect()` 上；宽度 `> 80` 视为展开态不接管；`display:none` / 0×0 / 找不到节点都不渲染。

**复验**
折叠侧栏（或 <1024px）→ 方块出现且与 `listArea` 等宽等高；展开（宽 > 80）→ 立即消失；DevTools 删掉 `_listArea` 节点 → 不渲染。

---

## D-02 纯函数保留两份：`src/pure.mjs` 是真源，`client.js` 放逐字副本

**现象**
断言要 `import` 真实纯函数来跑；但插件运行时的 `client.js` 由 DSH 的 Module Loader 装载，只允许 `require` baseline 模块（react 等），不能 `import './src/pure.mjs'`。

**判定**
两份代码要么不会漂移，要么漂移时立刻被测试抓住；不能出现「测试跑 A、线上跑 B」。

**根因**
Module Loader 的 `factory(require)` 没有本地 ESM 解析；`dsh.client.external` 也只能声明基线之外的模块表请求，不解决本地文件。

**候选与代价**

| 方案 | 代价 |
| :--- | :--- |
| 只写 `client.js`，测试用正则把函数抠出来 eval | 抠取逻辑本身易碎（括号/注释/字符串），测试跑的不是模块导出。 |
| 只写 `src/pure.mjs`，运行期动态 `import()` | 需要把文件塞进浏览器可达的模块表，等于自带构建/发布流程，超出「纯 JS 不构建」约束。 |
| 两份 + 逐字同步断言 | 多一份副本；但标记块 + `tests/pure-sync.test.mjs` 在漂移时报第一处差异，成本可控。 |

**结论**
`src/pure.mjs` 是唯一真源；`client.js` 内用
`// ==== pure（与 src/pure.mjs 逐字一致，见 DECISIONS.md）====` / `// ==== /pure ====`
包住副本。副本与真源只允许差每个函数行首的 `export `；同步测试去掉 `export ` 后逐字比较，并把两边都规范化到 LF。

**复验**
`node --test --test-isolation=none "dsh-rail-pins/tests/*.test.mjs"`；随手改任一侧一个字符，`pure-sync` 应失败并打印第几行不同。

---

## D-03 状态按标量订阅；当前会话高亮用官方 `mainView` 保留口径

**现象**
`useSessionStatus` 返回的 `Map` 每次状态变化都整体重建，连每个 status 对象都是新的。如果方块订阅整张 Map 或整个 status 对象，任何会话一有状态变化，所有方块全量重渲染。

**判定**
一个方块的状态变化只应重渲染它自己；空闲/审批/运行/未读四态由同一个映射函数给出。

**根因**
快照 hook 默认 `Object.is` 比较；订阅对象引用必然每次都变，订阅标量才稳定。

**结论**
每个方块用三个标量 selector：`pendingInteraction.kind`（字符串或 null）、`running === true`、`completionUnread === true`，再交给纯函数 `statusPresentation` 映射。标题用 `useSessions(s => s.byId[id])` 单行订阅（列表快照不变时引用稳定）。
当前会话没有独立 hook：按 `ui-workspace` 的同款口径，在 `useSessions` 里找 `retainedBy.mainView > 0` 的那一行（返回 id 标量，不订阅大对象），并用 `usePanelInfo(s => s.activePanelId !== null)` 在全局面板打开时关掉高亮。

**复验**
打开两个会话，其中一个进入「等待审批」；React DevTools 的 highlight 只应闪对应方块。切换会话时方块高亮跟随；打开 Settings 全局面板后高亮消失。

**风险**
如果以后 DSH 改掉 `retainedBy.mainView` 的口径，高亮会失效（不报错，不影响点击）；届时改 `findCurrentSessionId` 一处即可。

---

## D-04 气泡放在容器层，不放在方块/滚动区里

**现象（冷读时否决的第一稿）**
第一稿把气泡放在每个方块的 wrapper 里，用 `left:100%; margin-left:8px; top:0`。这符合视觉规格，但方块列表必须 `overflow-y:auto`；CSS 规范下当一个轴是 `auto` 时另一个轴的 `visible` 会计算成 `auto`，气泡会被滚动容器裁掉（还会撑出横向滚动条）。

**判定**
气泡要浮在滚动区外面、位置仍贴着方块右侧；滚动时不能跟着错位。

**根因**
`overflow-y:auto` 的滚动容器同时成为气泡的裁剪边界。

**候选与代价**
- 给滚动容器 `overflow:visible`：列表就滚不动了。
- 气泡 portal 到 body：需要 `react-dom`，且坐标要自己维护，复杂。
- 滚动区外、容器内放**一个**气泡（选中的）：容器本身不滚动、不被裁剪；`left:100%` 仍是 36px 处的右侧。

**结论**
气泡是容器的绝对定位子元素，`left:100%; margin-left:8px`；`top` 在 hover/focus 时由方块的 `getBoundingClientRect().top` 换算成容器内偏移。列表滚动时关闭气泡（`onScroll`），避免气泡与方块脱节。

**复验**
方块多于容器高度时滚动：气泡不出现横向滚动条、不被裁；hover 靠下的方块，气泡完整显示在右侧。

---

## D-05 折叠判定只看宽度；失败一律不渲染

**现象**
同一套 DOM 在展开态和 rail 态都存在，插件必须只在 rail 态接管。

**判定**
判定必须便宜、与槽外不可见的状态解耦；误判的代价是「盖住官方会话列表」，比不显示严重。

**根因**
`shell.overlay` 的 standardProps 里没有 sidebar 的 `collapsed/width`（那是 `sidebar` 槽的 ownerProps）；`data-sidebar-collapsed` 也不该由插件依赖。

**结论**
直接用 `listArea.getBoundingClientRect().width`：rail 下约 36px（56px 轨道减左右各 10px 内距），展开时几百 px；`> 80` 不接管。量不到 / 宽高为 0 / 找不到节点 → 返回 `null`，分隔线也不画。

**复验**
拖动侧栏宽度或缩放窗口跨越 80px 时，浮层应立即出现/消失；Windows Electron 折叠（`regionArea` 被 `display:none`）下应完全不出现。

---

## D-06 包名与 manifest 注入

**现象**
本机 profile 里已装插件都是不带 scope 的包名，用 `link:` 指向目录。

**判定**
包名、bundle patch 的 `name`、`__ModuleLoader__.load` 的 `id` 必须一致，否则懒加载工厂找不到条目。

**结论**
三者统一为 `dsh-rail-pins`。`dsh.client.inject` 按 manifest 文档是**包名顺序依赖**（不是 Cordis 服务注入），所以只列真正需要先存在的客户端包：`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-layout`（声明 `shell.overlay`）、`@deepseek-ai/dsh-client-ui-workspace`（提供 `_listArea` 与 `useWorkspaces` 来源）、`@deepseek-ai/dsh-client-ui-primitives`（`StateDot`，见 D-09）；不列 conversation，因为本插件不碰 composer。Cordis 服务注入在 `client.js` 的 `inject` 数组里：`['slots', 'uiWorkspace', 'locale']`。

**复验**
Plugin Manager 里插件行显示标题/图标；浏览器控制台无 `slot entry crashed`、无 `factory declares locale namespace ... no locale face`；点击方块能切会话。

---

## D-07 不假定 occupant 一定能拿到 `t`；四个标准 props 先判后调

**现象**
`shell.overlay` 的注册选项在 catalog 里只列了 `id` / `order` / `label`，**没有 `locale`**。shipped 插件确实传 `locale: NS`，但没有实测证据证明它一定给 occupant 注入 `t` prop。原实现有 8 处 `props.t(...)` 直接调用；`t` 若是 `undefined`，整块渲染抛异常，侧栏上直接出现错误边界。同理，`useSessions` / `useSessionStatus` / `useWorkspaces` / `usePanelInfo` 由槽的 owner 提供，插件激活时未必齐全。

**判定**
文案缺失可以退英文，但**不能因为文案把列表整个弄没**；标准 props 缺一个就当「这台宿主没装这个功能」，返回 `null`，且不能先调用再炸。

**根因**
`locale` 选项只表示「这个 occupant 想用某个 locale face」，不是 `t` prop 的契约；而 standardProps 是宿主实现细节，版本间可能增删。

**候选与代价**

| 方案 | 代价 |
| :--- | :--- |
| 信任 `props.t`，直接用 | 一旦没注入就是整块 UI 崩，最坏连侧栏都白 |
| 自己用 `locale.bind(NS)` 拿 `t` | 仍依赖 `ctx.locale` 的 face 已装；且多一条与 occupant 不一致的翻译路径 |
| `t` 兜底英文词典 + 四个 props 守卫 | 最坏英文文案；列表照常显示、点击照常工作 |
| 不注册 locale，只写英文 | 中文用户看不到中文，且 Plugin Manager 的标题/描述也丢 |

**结论**
`RailPins` 顶部先判四个 hook，任一不是函数直接 `return null`；再取
`const t = typeof props.t === 'function' ? props.t : (key, vars) => interpolate(EN[key] ?? key, vars)`。
`interpolate` 进 `src/pure.mjs`（缺变量保留 `{x}`、非字符串模板退空串、不抛），`client.js` 副本同步。locale 改为**逐语言三参数**注册（`register(NS, 'en', EN)` / `register(NS, 'zh', ZH)`），每条单独 try/catch，disposer 也 try/catch；slot 注册选项里的 `locale: NS` **去掉**——拿不到 `t` 的前提下留着只会误导后来人。

**复验**
`node --test --test-isolation=none "dsh-rail-pins/tests/*.test.mjs"`：36 条全绿；其中 `client-smoke` 里「缺 `usePanelInfo` 时返回 null 且 `useWorkspaces` 一次都没调」与「locale 注册抛错仍注册 slot」分别守住两条新约束。

---

## D-08 刷新后覆盖层偏到正文上：`fixed` 的包含块 ≠ 视口坐标

**现象**
刷新页面后不碰窗口，覆盖层第一帧出现在 rail 右侧、盖在正文上；调整窗口宽度后才跳回 `_listArea` 上。折叠/展开动画期间还会停在中间位置。

**判定标准**
刷新后第一帧必须精确盖住 `_listArea`；resize、折叠/展开动画全程跟随，结束后不残留偏移；量不到时仍然不渲染。

**根因**
`getBoundingClientRect()` 永远返回**视口坐标**，而 `position: fixed` 的定位基准是「最近的、能构成包含块的祖先」——祖先一旦有 `transform` / `filter` / `will-change` / `contain: paint`，包含块就不再是视口。两个坐标系一错位，整块就整体偏移；窗口 resize 触发重排、那个 transform 被清掉，于是看起来「自己跳回正常」。
第二层原因：折叠动画约 150ms，布局连续变化，只在 mount 量一次拿到的必然是中间值。

**候选与代价**

| 方案 | 代价 |
| :--- | :--- |
| A. 锚点相对定位 + 500ms 跟随窗 | 需要两层 DOM（外层 `inset:0` 永不移动 + 锚点 + 内层 body）和一段有界的 rAF；不依赖任何额外模块。 |
| B. portal 到 `document.body` | 需要 `react-dom`；客户端只允许 `require` baseline 模块，等于自带构建/模块表，代价更大，且仍要处理 body 上的 transform。 |
| C. 只在 `transitionend` 时重量一次 | 动画中间会跳，不满足「全程跟随」；如果 transition 被取消（快速反向折叠）还会漏掉。 |

**结论**
选 A，两层结构，缺一不可：
- **外层 root**：`position:absolute; left/top/right/bottom:0; pointer-events:none`，铺满 slot 层、**永不移动**；
- **锚点**：外层内 `position:absolute; left:0; top:0; width:0; height:0`，它的 `getBoundingClientRect()` 就是层原点；
- **内层 body**：`position:absolute`，`left/top/width/height` 来自纯函数 `layerOffset(targetRect, anchorRect)`（`src/pure.mjs`，`client.js` 逐字副本）。

锚点绝不能放进内层：内层一按偏移移动，锚点跟着动，下一帧算出的原点就变了，会「自己量自己」漂移。`layerOffset` 是纯函数，同一对输入永远同一结果，测试里连续调用两次断言结果一致。
`layerOffset` 对锚点缺失/全 0（通常是没挂载）与目标 0 尺寸返回 `null`；锚点是 0×0 但 origin 非 0（Windows 标题栏偏移）是合法输入。层原点正好是 (0,0) 时，0×0 锚点的 rect 与「未挂载」完全一样，纯函数按 fail-closed 返回 `null`，调用方再用 `anchor.isConnected` 把它认回来（只有 DOM 层能区分）。
跟随窗：`resize`、`ResizeObserver`、`document` 的 `transitionend`（capture）、`document.documentElement` 上 `data-sidebar-collapsed` / `class` / `style` 变化都启动 500ms 的 rAF 循环，窗内逐帧重算，到期自动停；body 的 `childList/subtree` 观察仍只在跟踪节点掉线时重量一次。卸载时取消两个 rAF、移除全部监听、断开两个 observer。

**复验**
- `node --test --test-isolation=none "dsh-rail-pins/tests/*.test.mjs"`：当前 47 条全绿，其中 5 条覆盖 `layerOffset`（正常、负偏移、锚点缺失/全 0、目标 0 尺寸、连续两次一致）。
- 真机：刷新页面不碰窗口 → 第一帧就在 `_listArea` 上；拖宽窗口、来回折叠 → 动画全程贴着走，结束后无偏移；快速反向折叠也不残留。

---

## D-09 角标改用官方 `StateDot`，不再自绘

**现象**
原实现自己画 8×8、`border-radius:2px`、带侧栏底色描边的方块，运行中再画一个转圈环。真机上和官方会话行里的状态点不是同一种东西：官方是 `@deepseek-ai/dsh-client-ui-primitives` 的 `StateDot`——8×8 圆点、**无描边**，状态词汇只有 `warning` / `ongoing` / `done` / `idle`，运行中动画也由 primitives 提供。

**判定**
角标的形状、配色、动画必须和官方同一来源；本插件只负责把它定位到方块右下角。官方升级改了圆点，本插件应自动跟上，而不是跟着改参数。

**根因**
状态视觉是 primitives 的职责，不是本插件的业务；复制一份样式就必然随版本漂移，暗色主题和运行中动画尤其容易对不上。

**候选与代价**

| 方案 | 代价 |
| :--- | :--- |
| A. 继续自绘、按官方调参 | 每次官方改圆点都要人肉跟一次；没有唯一真源，暗色 token 与动画仍可能偏。 |
| B. 只把圆角改圆、不做无描边 | 仍是半套复制：描边、尺寸、颜色、运行中动画都留在自己手里，升级继续漂。 |
| C. `require` primitives 的 `StateDot`，只留定位 wrapper | 依赖一个客户端共享模块；拿不到时降级不画角标，不影响首字与点击。 |

**结论**
选 C：
- `client.js` 顶层带 `try/catch` 取一次 `StateDot`（不是函数就当没有），拿不到只显示首字；
- **不把 `@deepseek-ai/dsh-client-ui-primitives` 写进 `dsh.client.inject`**：官方 `dsh-client-ui-workspace` 也 `require` 它（`lib/client.js` 一处），而它的 inject 里**没有**这一项——说明 primitives 是 shell 打包进 `assets/index-*.js` 的共享 external，不是可挂载的客户端插件包。写进 inject 会让加载器去找一个不存在的模块条目，**重启后本插件直接挂不上**（2026-11-03 上线时发现宿主下发的清单仍是旧的三项，属侥幸未触发）；
- 删掉 `badgeStyle()`、自绘 `span` 的样式、`@keyframes dsh-rail-pins-spin` 与 `prefers-reduced-motion` 那套；角标只剩一个定位 wrapper：`position:absolute; bottom:2px; right:2px; display:flex; pointer-events:none`；
- `statusPresentation` 改为官方词汇 `warning` / `ongoing` / `done`，空闲返回 `tone: null`（不渲染角标）；优先级保持 pending → running → unread。

**复验**
`node --test --test-isolation=none "dsh-rail-pins/tests/*.test.mjs"`：状态映射 7 条改为官方词汇，覆盖「pending 同时 running 出 warning」「running 同时 unread 出 ongoing」；真机四态角标应与官方会话行完全一致，空闲无角标。

---

## D-10 分隔线改用 `--dsw-alias-border-l2`

**现象**
真机看折叠栏顶部分隔线偏淡，和官方侧栏自己的分隔线不在一个层级。

**判定**
分隔线应与官方分隔线同色：官方 `dsh-client-ui-theme` 的 `border-bottom` 用的是 `.5px solid var(--dsw-alias-border-l2)`。

**根因**
本插件用了 `--dsw-alias-border-l1`（浅色约 4% 黑），比官方分隔线的 l2（约 10% 黑）淡一档；不是主题没生效，是选错了 token。

**结论**
- 分隔线改成 `background: var(--dsw-alias-border-l2, #0000001a)`，fallback 与 l2 同值；
- 气泡边框保持 `--dsw-alias-border-l1`（浮层描边淡一点是对的，不改）；
- 版本 `0.1.2`；纯函数不涉及，断言仍 47 条。

**被否**
- 自己调 l1 的 alpha（如 `#0000001f`）：脱离 token 阶梯，主题切换、暗色模式不会跟。
- 直接用 l3（`#0000001f`）：比官方分隔线重一档，与官方视觉不一致。

---

## D-11 运行状态两级回落，角标统一 10×10

**现象**
刷新页面后，正在运行的会话右下角没有角标，要等状态变化（跑完/再开跑）才出现；运行中的转圈 14×14 在 36×36 方块里偏大。

**判定**
刷新后即使没有任何状态事件，运行中的会话第一帧就必须显示 `ongoing` 角标；所有状态角标统一 10×10。

**根因**
- 状态表里的 `SessionStatus.running` 在基线或事件到达前是 `undefined`（类型注释原话："absent until a baseline or event establishes it"），官方 `sessionNode` 用 `status?.running ?? s.running` 回落到 `SessionSummary.running`；本插件只读状态表且写死 `=== true`，`undefined` 被当成 `false`，只能等下一次状态事件。
- 尺寸上官方 `StateDot` 默认 `size ?? (state === 'ongoing' ? 14 : 10)`，本插件没传 `size`，运行中因此用了 14。

**结论**
- `src/pure.mjs` 新增 `resolveRunning(statusRunning, summaryRunning)`：状态表给出 `true`/`false` 时用它（更权威的实时值），否则用摘要的 `=== true`，两级都缺省返回 `false`；
- `RailPinTile` 的订阅仍是标量 `s.get(id)?.running`（`boolean | undefined`），再用 `resolveRunning(statusRunning, summary?.running)` 组合；不返回整个 status 对象；
- `pendingInteraction` / `completionUnread` 保持只读状态表，不加回落（官方也只读状态表）；
- 角标渲染改为 `h(StateDot, { state: tone, size: 10 })`，所有状态统一 10×10；
- 版本 `0.1.3`，断言 47 + 新增 3 = 50 条。

**被否**
- 改成订阅整张状态 Map：任一状态变动都会让所有方块重渲染，标量 selector 的意义就没了。
- mount 时轮询等状态基线：只能猜时间，刷新首帧仍可能空窗；官方既然给了摘要回落的写法，直接照做。

---

## D-12 子代理在跑也显示 ongoing

**现象**
后台子代理在跑的会话，展开侧栏的官方会话行有运行中转圈，折叠栏里本插件的方块却没有角标。

**判定**
子代理在跑也算 `ongoing`；折叠栏的状态必须与官方会话行一致，父会话自己没跑、子代理在跑时气泡显示「N 个子代理运行中」。

**根因**
- 子代理的运行不体现在父会话的 `SessionStatus.running` 上；
- 官方 `runningChildCount(list, parentId, statuses)` 遍历 `projectionsBySession[parentId].values.subagentCatalog`，每个子代理都用 `statuses.get(child.id)?.running ?? list.byId[child.id]?.running` 两级回落，再数 `=== true`；`sessionStatuses` 即使父会话 `running` 为 false，只要 `runningSubagentCount > 0` 也返回 `ongoing`；
- 本插件只读父会话状态表，完全没看子代理目录。

**结论**
- `src/pure.mjs` 新增 `parseRunBits(bits)`（`'1'`/`'0'`/`'-'` → `true`/`false`/`undefined`）与 `countRunningChildren(childIds, statusRuns, summaryRuns)`（逐个子代理走 `resolveRunning` 再计数）；
- `RailPinTile` 用三个标量订阅：`childIdsKey`（目录 id 拼串）、`summaryBits`（子代理摘要 running 位串）、`statusBits`（状态表 running 位串）；不订阅整张 catalog 或 status Map，避免引用变化打穿 `React.memo`；
- `statusPresentation(pendingKind, running, completionUnread, runningSubagents)` 追加第四参：pending → warning；父会话 running → ongoing（`status.running`）；否则子代理数 > 0 → ongoing（`status.subagentsRunning.one/other` + `labelVars.n`）；否则 unread → done；否则 null；
- 气泡与 aria-label 用 `t(labelKey, labelVars)`，`EN` 兜底同步两条；
- 版本 `0.1.5`（与 D-13、C 条同一提交），断言 50 + 新增 9 = 59 条。

**被否**
- 订阅整张 status Map：任一子代理或会话状态变动都会让所有方块重渲染，正是标量 selector 要避免的。
- 只读 `byId[child].running`、不做状态表回落：与官方不一致；状态表才是实时值，摘要只在基线前兜底。

---

## D-13 折叠状态记在 localStorage，刷新后恢复

**现象**
手动把左侧栏折叠成 rail，刷新页面后又回到展开态，每次都要重新折一次。

**判定**
折叠后刷新，第一帧起就是折叠态；展开后刷新就是展开态。两个方向都要记住。

**为什么用 localStorage**
- 纯客户端状态，插件没有 Host 半边，不该为它加进程/文件；
- 不能进 `<DSH_HOME>` 数据目录：仓库规范要求运行期数据只落在 `plugin-data/<插件名>/`，而这是浏览器侧偏好，跟着 profile 走反而更自然；
- 键名固定 `dsh-rail-pins.sidebar-collapsed`，值 `'1'` / `'0'`，不写 JSON、不写版本号。

**为什么只能 toggle**
- 官方 `ILayout`（`@deepseek-ai/dsh-client-ui-layout`）只暴露 `toggleSidebar()`，没有 `setSidebarCollapsed(bool)`；
- 官方注释写明侧栏「偏好就是宽度」，关闭会忘记用户拖拽过的宽度，所以它本身不提供「直接设成某个状态」的语义；
- 恢复只能「读到的值与当前不一致时 toggle 一次」，且只在页面加载后做一次。

**结论**
- 从锚点往上找 `className` 含 `_frame` 的祖先（不写死哈希前缀），读它的 `data-sidebar-collapsed` 布尔属性；
- `MutationObserver` 只监听该属性，变了就写 `'1'` / `'0'`；写的是 localStorage，不会再触发属性变化，天然不循环；
- mount 后 `requestAnimationFrame` 等一帧再判：存值与当前态不一致才 `layout.toggleSidebar()`，模块级 `sidebarRestored` 保证每页只恢复一次；
- localStorage 读写、`toggleSidebar()` 全部 `try/catch`；Cordis 没注入 `layout` 时跳过恢复，照常渲染；
- Cordis `inject` 加 `'layout'`；`dsh.client.inject` 里 `@deepseek-ai/dsh-client-ui-layout` 本来就在。

**被否**
- 直接写 `data-sidebar-collapsed` 属性骗 UI：只改外观不改布局，rail 宽度与内容不会跟着变，必然错位。
- 改造 frame / 替换官方侧栏：那是官方插件的地盘，插件只消费它的属性，不接管它的 DOM。

---

## D-14 首字字号阶梯改为 16 / 14 / 12

**现象**
真机上 2 字 13px、3 字 11px 偏小，在 36×36 方块里显得空。

**结论**
`glyphStyle` 改为 1 字 `16px`（无字距）、2 字 `14px` + `-0.2px`、3 字 `12px` + `-0.3px`；纯函数与 `client.js` 副本、三条字号断言同步，版本 `0.1.6`。

**被否**
- 继续用 13 / 11：真机已经反馈偏小。
- 三档统一 14px：单字符反而显小，且丢掉「字数越多越收紧」的视觉层次。

---

## D-15 方块顺序跟展开侧栏的 pin 行一致

**现象**
方块按 pin 时间倒序排，和展开侧栏里 pin 行从上到下的顺序对不上；展开/折叠切换时位置全变。

**根因**
`pinnedSessionIds` 是 pin 时间顺序；展开侧栏的 `deriveGroups` 是「按 `workspaces.items` 工作区分组 → 组内 pinned 行在最前 → 组内按 `workspace.sessionIds`」，两套顺序本来不同。

**结论**
- 新增 `orderPinnedByWorkspace(pinnedIds, workspaces)`：按 `workspaces.items` 顺序遍历，组内按 `sessionIds` 取已 pin 的会话；不属于任何工作区的 pin 垫后并保持 `pinnedSessionIds` 原顺序；全程 `Set` 去重；
- `RailPins` 用 `orderPinnedByWorkspace(pinnedIds, workspaces)` 取代 `visiblePinnedIds(pinnedIds)`；`workspaces` 复用已有的 `props.useWorkspaces(s => s.items)`，不重复订阅；
- 删除不再使用的 `visiblePinnedIds` 及其断言；版本 `0.1.7`，断言 65 + 新增 7 = 72 条。

**被否**
- 保留 pin 时间序：用户明确要和展开侧栏对上号。
- 按标题排序：展开侧栏不这么排，只会制造第二套顺序。

---

## 冷读记录（第一稿产出物当别人的东西读）

1. **否决：气泡放在滚动容器里会被裁。** 已按 D-04 改到容器层。
2. **风险：`MutationObserver` 监听整个 `document.body`，流式输出时回调很频繁。** 处置：回调只做一次 `isConnected` 判断，只有跟踪节点掉线才排一次 rAF 量取；不读布局、不在每次变动时测量。
3. **风险：`node --test dsh-rail-pins/tests/` 在受限沙箱里 `spawn EPERM`。** 处置：测试本身不改，README 写明用 `--test-isolation=none` + glob 在当前进程跑；普通终端仍可直接跑目录。
4. **风险：硬编码 36px 方块在 rail 宽度变化时会偏。** 处置：接受——用户视觉规格写死 36，容器宽度仍取实测值，最坏是方块左对齐而不是铺满。
5. **否决：容器 `pointer-events:none` 会继承给方块。** `pointer-events` 是继承属性，只在容器和气泡上写 `auto` 仍然点不到方块；已给按钮显式补 `pointerEvents:'auto'`，否则「点击切会话」整条交互失效。
6. **风险：滚动区继承 `none` 后，滚轮落在方块之间的空隙上滚不动。** 处置：滚动区自己 `pointer-events:auto`（它只覆盖 rail 里本来空着的 36px 列，不挡主界面），方块与气泡仍各自 auto。
