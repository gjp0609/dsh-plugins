# dsh-rail-pins

侧栏折叠成 56px 轨道（rail）时，在搜索图标下面那块空位显示**已 pin 的会话**：每个会话一个 36×36 的首字方块，右下角挂官方四态状态角标，悬停出四行详情，点击切到该会话。

纯 JS，无构建、无依赖；Host 半边是空的，全部逻辑在 `client.js`。

## 为什么只能走浮层

DSH 的左侧栏结构里，搜索图标下面是 `ui-workspace` 自己渲染的 `_listArea`：

- `shell.overlay` 是框架级、可追加（`kind:"list"`）的浮层槽；它 click-through，条目自己再打开 pointer events，所以盖在侧栏上不会挡住下面的界面。
- `_listArea` 不是 slot，也不在 `sidebar.workspaces` 里——`sidebar.workspaces` 是 `single` 槽，被 `ui-workspace` 的整个浏览器占着（搜索、工作区树、会话行、菜单都在里面）。注册进去是**整块替换**，不是追加。
- 没有名为 `sidebar.panellist` 的槽；`listArea` 内部也没有可插入的槽。
- `listArea` 的类名带构建哈希（例如 `bhn1Oq_listArea`），所以只按 `_listArea` 后缀找节点，绝不写死前缀。

因此做法是：在 `shell.overlay` 里放一个 `position:absolute; inset:0` 的外层（永不移动），里面放一个零尺寸锚点，它的 rect 就是「层原点」；再用 `[class*="_listArea"]` 的 `getBoundingClientRect()` 减掉锚点 origin，得到相对层的左/上/宽/高，交给内层 body 绝对定位。这样即使祖先带 `transform` / `filter` / `will-change`，也不会出现「fixed 用视口、rect 用视口坐标」的错位。量不到（没有节点、`display:none`、0×0、锚点全 0）就不渲染内层——宁可不显示，也不画歪。折叠判定直接看这块矩形的宽度：rail 下约 36px，展开时是几百 px，**宽度 > 80 就不接管**。

折叠/展开有约 150ms 的动画，只在 mount 量一次会停在中间值：每次 `resize` / `ResizeObserver` / `transitionend` / 侧栏根节点属性变化后，都会开一个 **500ms 的 rAF 跟随窗**逐帧重算，到期自动停，不常驻 rAF。

## 视觉

- 顶部 1px 分隔线（`--dsw-alias-border-l2`），下面 12px；只有方块区滚动，分隔线固定。
- 方块 36×36、圆角 12px、居中；首字取标题第一个词的前 3 个字符（保留原文大小写），中文/数字/符号开头只取 1 个码点；字号阶梯 1 字 16px、2 字 14px + `letter-spacing:-0.2px`、3 字 12px + `-0.3px`；间距 12px；hover 与当前会话用 `--dsw-alias-interactive-bg-hover`（当前会话再加 `font-weight:500`）。
- 状态角标直接用官方的 `StateDot`（`@deepseek-ai/dsh-client-ui-primitives`）：显式 `size=10`（官方默认 ongoing 14、其它 10，14 在 36px 方块里太抢），词汇是 `warning` / `ongoing` / `done`；`idle` 不画。父会话或任一子代理在跑都算 `ongoing`，子代理单独在跑时气泡写「N 个子代理运行中」。拿不到 primitives 模块时只显示首字，不画角标。
- 所有颜色走 DSH 主题 token，并给同色系 hex 兜底，不写死主题色。
- 容器 `pointer-events:none`，方块与气泡 `pointer-events:auto`，不影响主界面点击。

## 交互

- 点击方块：`ctx.uiWorkspace.openSession(id)`，同步切主视图。
- 方块顺序与展开侧栏的 pin 行一致：按工作区顺序、组内按 `workspace.sessionIds`，不属于任何工作区的 pin 垫后。
- 键盘：方块是原生 `<button>`，`Tab` 可达，`Enter`/`Space` 打开。
- 悬停/聚焦：右侧 8px 出气泡，四行——标题、工作区路径（`C:\Users\<用户>\...` 缩成 `~\...`）、相对时间（刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前）、状态文字（空闲也写）。
- 一个 pin 都没有：外层锚点常驻但不可见，内层与分隔线都不渲染（视觉上没有这块东西）。
- 折叠状态：手动折叠/展开时把 `'1'` / `'0'` 写进 localStorage 的 `dsh-rail-pins.sidebar-collapsed`；下次加载等一帧，存值与当前态不一致才 `ctx.layout.toggleSidebar()` 恢复一次，无痕模式读写失败静默跳过。

## 安装（本机 profile）

插件目录（worktree 里的 `dsh-rail-pins/`）没有任何构建步骤，直接把目录登记进 profile 即可：

1. 在 profile `web` 的 `package.json` 里加依赖：
   `"dsh-rail-pins": "link:<插件目录绝对路径>"`
2. 在同一个 `package.json` 的 `dsh.profile.bundles` 数组里加 `"dsh-rail-pins"`（放在 `dsh-approval-notifier` 等自定义插件旁边，顺序无硬要求）。
3. 在 profile 目录跑一次包安装（`dsh plugin --profile web install`，或等价 pnpm 安装），让 `node_modules/dsh-rail-pins` 这个 link 生效。
4. 重启 `dsh web`。Client 半边会在启动时注册 `shell.overlay` 条目。

> 也可以走 Plugin Manager 的 `install_bundle`；它同样需要把 bundle 加进 `dsh.profile.bundles`。本仓库的正式树部署仍只走 `tools/deploy.ps1 -Tag <tag>`，与本文的测试树安装是两件事。

## 怎么验

1. 打开 Web GUI，Settings / Plugin Manager 里能看到「折叠栏会话 / Rail Pinned Sessions」和自绘图标，没有 metadata 诊断。
2. **刷新页面、不碰窗口大小**：rail 里第一帧就精确盖在 `_listArea` 上；再拖动窗口宽度、来回折叠/展开，动画过程中跟着走，结束后不残留偏移。
3. 把侧栏收成 rail（或把窗口缩到 1024px 以下触发自动折叠）：搜索图标下方出现 1px 分隔线，下面是已 pin 会话的方块；没有 pin 时什么都没有。
4. pin 3 个不同工作区的会话，悬停每个方块：右侧气泡四行齐全，路径显示 `~\...`，时间与状态正确；再分别制造「等待审批 / 运行中 / 未读完成 / 空闲」四种状态，确认 `StateDot` 的 warning / ongoing / done 圆点，空闲无角标。
5. 点方块切会话；展开侧栏（宽度 > 80）整块立即消失；取消全部 pin 后整块消失。

命令行快速检查（72 条）：

```powershell
node --test --test-isolation=none "dsh-rail-pins/tests/*.test.mjs"
```

`node --test dsh-rail-pins/tests/` 在受限沙箱里会因 `spawn EPERM` 失败（测试运行器默认给每个文件起子进程），
用 `--test-isolation=none` + 文件 glob 可在当前进程内跑完；普通桌面终端里两种写法都可以。

## 已知边界

- **Windows Electron 桌面版折叠时看不到**：`[data-windows-titlebar] .collapsed .regionArea { display:none }` 会把 `_listArea` 整块藏掉，量到的矩形是 0，插件按 fail-closed 不渲染。这是官方侧栏的 CSS 行为，不是插件 bug；本插件不为了桌面版去替换官方侧栏。
- **<1024px 自动折叠也会出现**：这是 rail，按设计显示。
- **量取失效时自动隐藏**：类名后缀规则变化、节点换成 0×0、或页面上出现多个 `_listArea` 时，可能找不到正确节点；插件选择不渲染，而不是画到错误位置。
- **当前会话高亮**：依赖 `SessionSummary.retainedBy.mainView`（ui-workspace 判定当前会话的同款口径），并在全局面板打开（`activePanelId !== null`）时不高亮；口径若变化，高亮失效但不影响点击。
- **状态角标由 primitives 决定**：形状、配色、运行中动画都跟官方 `StateDot` 走；本插件只负责定位。官方升级改了圆点，这里自动跟上，不需要改代码。
- **宿主没注入 `t` 时文案退英文**：`shell.overlay` 的注册选项没有承诺 `locale` 会给 occupant 注入 `t`，插件用英文词典兜底（`src/pure.mjs` 的 `interpolate`），列表与点击不受影响；四个标准 hooks 任一缺失则整块不渲染。
- **不写 `plugin-data`**：pin 列表、工作区与标题、状态全部来自 DSH 快照；折叠偏好是唯一落盘项，写在浏览器 localStorage（键 `dsh-rail-pins.sidebar-collapsed`，见 D-13），不注册 Host 服务。

## 文件

- `client.js` — 全部渲染与量取；内部含一份与 `src/pure.mjs` 逐字一致的纯函数副本（原因见 `DECISIONS.md`）。
- `src/pure.mjs` — 纯函数真源，测试直接 `import` 它。
- `tests/pure.test.mjs` — 65 条行为断言（含 `interpolate` 三条、`layerOffset` 五条、首字取词与大小写十条、字号阶梯三条、运行状态回落三条、子代理计数与状态合成九条、方块排序七条）。
- `tests/pure-sync.test.mjs` — 逐字比对 `client.js` 副本与 `src/pure.mjs`，漂移即红。
- `tests/client-smoke.test.mjs` — 用最小 React 替身加载 `client.js`，核对工厂 id、`inject`、逐语言 locale 注册、`shell.overlay` 选项、缺 props 守卫与中英词典键集合。
- `index.js` — Host 半边，空实现。
- `cordis.patch.yml` / `package.json` / `locale/*.json` / `icon.svg` — bundle 与显示元数据。
