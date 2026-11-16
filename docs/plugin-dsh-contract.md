# 插件 ↔ dsh 触点表（从我们自己的代码倒推）

> 这张表回答一件事：**升级后我们的插件凭什么还能用**。每一行都是代码里真实出现的符号，不是抄来的清单。
> 用法见文末三步；验收脚本 `tests\upgrade-accept.ps1` 就是这张表的「测试版」。

## 宿主 · 工具与执行

| 面 | 具体用什么 | 我们哪里在用（文件:行号） | 依赖它的插件 | 变了会怎样 |
| :--- | :--- | :--- | :--- | :--- |
| 工具定义与注册 | `{ name, description, parameters, output: { schema, render }, execute(args, exec) }`；`ctx.tools.register(tool)` | `dsh-ssh-remote/lib/status.mjs:6`、`:10`、`:15`、`:36`；`lib/run.mjs:187`；`index.js:168` | ssh-remote | 五个 `ssh_*` 工具全不出现或结果不渲染 |
| 预执行事件字段 | `exec.name`、`exec.arguments.command`、`exec.callId`（`tools/pre-execute` 入参） | `dsh-approval-allow/index.js:84-89`、`:216` | approval-allow | 命令缓存永远空 → 只剩全局名单生效（不误放，但项目级规则失效） |
| 取消信号 | `exec.signal` | `lib/run.mjs:206`、`:233`、`:261`；`lib/copy.mjs:189`；`lib/admin.mjs:500` | ssh-remote | 点「停止」杀不掉卡片与远端命令 |
| 会话工作区 | `exec.agent.session.header.cwd` | `dsh-ssh-remote/lib/approval.mjs:205` | ssh-remote | 卡片抬头退回宿主进程 cwd（2026-11-12 修过的 bug 复活） |

## 宿主 · ctx 服务

| 面 | 具体用什么 | 我们哪里在用（文件:行号） | 依赖它的插件 | 变了会怎样 |
| :--- | :--- | :--- | :--- | :--- |
| 硬依赖注入 | `export const inject = ['subprocess','tools']` / `['subprocess']` | `dsh-ssh-remote/index.js:33`；`dsh-approval-notifier/index.js:21` | ssh-remote、approval-notifier | 服务名一改，整个插件不加载 |
| 子进程 | `ctx.subprocess.spawn({ argv, cwd, stdio: { stdin, stdout: { maxBytes }, stderr }, graceMs })` → `handle.done` / `handle.collected.stdout` / `handle.terminate()` | `dsh-approval-notifier/index.js:477`、`:493`、`:505`、`:513`；`lib/admin.mjs:213`、`:232` | ssh-remote、approval-notifier | 审批卡/密码卡起不来；ssh 没有卡片可用，直接拒绝执行 |
| HTTP 挂载 | `ctx.inject(['webServer','connection'], scope)`；`scope.webServer.register({ kind:'prefix', path, handler })`；`scope.connection.requestRejection(request)` | `dsh-ssh-remote/index.js:150`、`:154`、`:157`；`lib/api/routes.mjs:202` | ssh-remote | 设置页整块 405/403（D-44 原症状） |
| 项目根 | `ctx.get('workingDirectory').get(session)` | `dsh-approval-allow/index.js:65-68` | approval-allow | 退回 `header.cwd`；项目级规则可能失配 |
| 提示词段落 | `ctx.get('systemPrompt').section({ name, order, text })`；`getSectionOrder('MCP_SERVERS')` | `dsh-ssh-remote/index.js:181-199` | ssh-remote | 模型看不到主机清单（工具还在，但不会去用） |
| 客户端在线判断 | `ctx.get('typertGateway').hasLiveClient()` | `dsh-approval-notifier/index.js:298` | approval-notifier | 退化成「按有页面处理」，每次多等 10 秒 |
| 生命周期 | `ctx.effect(fn, label)`、`ctx.on(event, fn, { prepend: true })` | `dsh-approval-allow/index.js:208-229`；`dsh-approval-notifier/index.js:809-836`；`dsh-ssh-remote/index.js:157-198` | 除 rail-pins 外三个 | 卸载不干净（监听/定时器/路由残留） |

## 审批与提问

| 面 | 具体用什么 | 我们哪里在用（文件:行号） | 依赖它的插件 | 变了会怎样 |
| :--- | :--- | :--- | :--- | :--- |
| `approval/request` 请求字段 | `toolName`、`callId`、`agent.session.header.cwd`、`signal`、`reason`、`displayReason.zh\|en` | `dsh-approval-allow/index.js:112-115`；`dsh-approval-notifier/index.js:598-615` | approval-allow、approval-notifier | 自动放行失效；弹窗没理由、没工作区 |
| `approval/request` 结果闭集 | 我们只返回 `'allowed-once'`；下游的 `'rejected'`/`'cancelled'` 原样透传 | `dsh-approval-allow/index.js:166`；`dsh-approval-notifier/index.js:511`、`:646-660` | approval-allow、approval-notifier | 批了等于没批（宿主不认这个字符串） |
| `user-questions/request` | `questions[].id`、`wait.callId`、`wait.timed`、`agent.id`、`signal`；只旁听透传 | `dsh-approval-notifier/index.js:732-743`、`:836` | approval-notifier | 日志字段变 null；行为不变 |
| 新提问变体 | `kind: 'approval'`（我们只读 `id`，可能为 null） | `dsh-approval-notifier/index.js:737` | approval-notifier | `questionIds` 全 null（排查误导，不影响功能） |
| 包依赖 | **不 import** `@deepseek-ai/dsh-user-approval` / `dsh-user-questions`，只依赖事件名与字段 | `dsh-approval-allow/index.js:13`；`dsh-approval-notifier/index.js:8-9` | approval-allow、approval-notifier | 这两包改名/合并我们无感；事件名或字段改名才是真断点 |

## 客户端

| 面 | 具体用什么 | 我们哪里在用（文件:行号） | 依赖它的插件 | 变了会怎样 |
| :--- | :--- | :--- | :--- | :--- |
| 模块加载与服务注入 | `window.__ModuleLoader__.load({ id, factory(require) })`；`exports.inject` + `exports.apply(ctx)`；注入 `slots`、`locale`、`layout`、`uiWorkspace`（只这四个） | `dsh-rail-pins/client.js:8`、`:754-756`、`:763`、`:780`、`:783`；`dsh-ssh-remote/lib/client.js:23`、`:1427-1428` | rail-pins、ssh-remote | 客户端半片整个不加载（浮层、设置页都没了） |
| 槽注册 | `ctx.slots.inject(name, cb)` + `ctx.slots.register({ name, id, order, label(), locale }, Component)` | `dsh-rail-pins/client.js:785-789`；`dsh-ssh-remote/lib/client.js:1438-1449` | rail-pins、ssh-remote | 浮层/设置页挂不上 |
| `shell.overlay` 宿主 props | occupant 收到 `useSessions`、`useSessionStatus`、`useWorkspaces`、`usePanelInfo`、`t`、`openSession` | `dsh-rail-pins/client.js:606-627`、`:700-710` | rail-pins | pin 列表空白（props 形状不对我们返回 null，不崩） |
| `settings.section` | 注册项带 `label()` 与 `locale`；槽是 `{ kind:'list', scope:'root' }`，宿主给组件注 `t` | `dsh-ssh-remote/lib/client.js:107`、`:1223`、`:1436-1451` | ssh-remote | 「SSH 主机」从设置左栏消失 |
| locale | `locale.register(ns, id, dict)` / `register(ns, { zh, en })` / `bind(ns)` | `dsh-rail-pins/client.js:763`；`dsh-ssh-remote/lib/client.js:1431`、`:1435` | rail-pins、ssh-remote | 文案退英文兜底或 key 裸露 |
| baseline 模块 | `require('react')`；`require('@deepseek-ai/dsh-client-ui-primitives')`（`StateDot`；`Button/Input/Modal/Tag/IconEditOutlineRegular`） | `dsh-rail-pins/client.js:11`、`:17`；`dsh-ssh-remote/lib/client.js:89-92` | rail-pins、ssh-remote | 组件缺失：rail-pins 降级不画角标，ssh 设置页直接崩 |
| DOM 结构与主题 | `[class*="_listArea"]`、`[class*="_frame"]` + `data-sidebar-collapsed`、`layout.toggleSidebar()`；`--dsw-alias-*` | `dsh-rail-pins/client.js:221`、`:331`、`:388`、`:469-488`、`:268`、`:579`、`:680`、`:725-727` | rail-pins | 量不到位置 → 整块浮层不渲染（**最容易变**；配色有 hex fallback，只影响观感） |
| 自己的 HTTP 前缀 | 浏览器 `fetch('/plugin-data/ssh-remote/api/...')` | `dsh-ssh-remote/lib/client.js:114`、`:307`；`lib/api/routes.mjs:14` | ssh-remote | 设置页首屏 405/空（与「HTTP 挂载」同一根因） |

## 打包与加载

| 面 | 具体用什么 | 我们哪里在用（文件:行号） | 依赖它的插件 | 变了会怎样 |
| :--- | :--- | :--- | :--- | :--- |
| manifest 字段 | `engines.dsh`（`>=0.2.2-rc.2`）；`dsh.bundle.patch`；`dsh.client`（`platform: 'web'`，rail-pins 另有 `immediately` 与三个客户端包名） | 四个 `package.json:4`；`dsh-approval-allow/package.json:26`、`dsh-approval-notifier/package.json:27`、`dsh-rail-pins/package.json:24-38`、`dsh-ssh-remote/package.json:29-44` | 四个 | 判不兼容 → 装不上；patch 不生效 → 插件没插进 profile（插件页却显示已安装）；客户端半片不加载 |
| patch id | `approval-allow`、`approval-notifier`、`dsh-rail-pins`、`ssh-remote` | 各自 `cordis.patch.yml:12` / `:12` / `:2` / `:8` | 四个 | 与 profile 里已有 id 冲突 → 重复挂载或覆盖错 |

## 会话与事件

| 面 | 具体用什么 | 我们哪里在用（文件:行号） | 依赖它的插件 | 变了会怎样 |
| :--- | :--- | :--- | :--- | :--- |
| 会话日志读取 | `session.seq`；`session.eventAt(seq)`；`tool/call` 事件的 `data.{ callId, arguments, name }` | `dsh-approval-notifier/index.js:226-238` | approval-notifier | 弹窗不显示参数（官方已标 deprecated，我们全程容错） |

## 怎么用这张表（每次升级，三步）

1. **取新版实包并解包**：`npm pack @deepseek-ai/dsh@<版本>`（或从隔离目录里已装的包取），解到 `.session-files\tmp\v<版本>\` 下。
2. **逐行检索**：对上面每一行，在新包里查同一个符号 / 字段 / 事件名 / 槽名 / `class` 后缀；命中打勾，没命中就记「哪一行、谁会用不了」。
3. **下结论**：全命中就直接升；有缺口**先改那一列对应的插件**，再升。

**为什么不信外部结论**：那份（`PLUGIN-COMPATIBILITY.md`、`PLAN.md` 之类）是按 dsh 视角列的关注面——preset、沙箱、compaction、patch id——**不覆盖我们真实用到的每个接口**，而且是人写的、可能滞后。它只能当线索，不能当依据。

本轮实例：外部文档列的四处破坏性变更（删 `list-agents` 导出、`modelSelectionSettings` 改名、`MenuTarget`→`ContextMenuTarget` 无别名、`tools.mode`→`z<never>`）与我们四个插件无关——这个结论是按上表逐行核对后得出的，不是抄的。

## 最容易在升级时变的三行

- **工具定义与注册**：`output.render`、`parameters` 这类形状没承诺稳定，一变五个 `ssh_*` 全哑。
- **子进程**：`handle.done` / `handle.collected` / `terminate()` 是宿主封装，两个插件全靠它拉卡片。
- **DOM 结构**：`_listArea` / `_frame` / `data-sidebar-collapsed` 是宿主私有类名与属性，最脆；rail-pins 整块浮层就建在它上面。
