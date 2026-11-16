# 插件升级验收（一页）

> 一条命令判「四个插件在新版 dsh 上还能不能用」。依赖面清单见 [`plugin-dsh-contract.md`](./plugin-dsh-contract.md)。

## 1. 分工：两条线互不代判

- **dsh 会话**只管 dsh 本体与两个本地补丁（preset、profile、沙箱、compaction），产出他那份 11 项验证。
- **插件会话**只管四个插件的代码、构建、部署与兼容性判断，产出下面脚本的结果 + 4 条人工项。
- 兼容性结论**各出各的**：外部那份（`PLUGIN-COMPATIBILITY.md` / `PLAN.md`）是 dsh 视角、人写的、可能滞后，只当线索；插件侧一律拿新版实包自己核对（§3）。

## 2. 每次升级的动作顺序（固定）

| # | 谁 | 做什么 | 判定 |
| :--- | :--- | :--- | :--- |
| 1 | 插件会话（**停服前**） | `tools\deploy.ps1 -Tag <tag>`：只往生产树拷文件，运行中的旧 dsh 不受影响 | tag == `git rev-parse --short HEAD`，且 `tests\plugin-bundle.ps1` 绿 |
| 2 | dsh 会话（停服窗口） | 停 web → 装包 → 打两个补丁 → 改 profile → 启动 | `dsh -V` = 目标版本；两个补丁 `-Status` 显示「已打」 |
| 3 | 各自验证（启动后） | dsh 侧跑他那 11 项；插件侧跑下面的 Post + 4 条人工项 | 脚本「通过 N / 失败 0」+ 4 条勾完；结果贴进 `RESULT.md` 的「插件」段 |

**停服窗口里插件侧什么都不做**（不构建、不部署、不重启），避免和补丁脚本抢文件；部署必须是窗口之前的那一步。

```powershell
# 升级前（随时可跑，10 项，必须全绿）
pwsh -NoProfile -File tests\upgrade-accept.ps1 -Phase Pre
# 收到「dsh -V 已变」的信号后（12 项 + 4 条人工）
pwsh -NoProfile -File tests\upgrade-accept.ps1 -Phase Post -ExpectedVersion 0.2.2-rc.3
```

Pre 查：四个 `engines.dsh`、四个插件的 node 单测、根级 `*.test.mjs`、`shared-ui-guard.ps1`。
Post 多查：`dsh -V`（传了 `-ExpectedVersion` 就断言相等，没传只打印）、构建产物不旧（`plugin-bundle.ps1`）；并打印 4 条人工项——`ssh_status` 能列主机 / `ssh_run` 弹卡并执行一条只读命令 / 审批卡（提权）能弹能批 / 侧栏 pin 还在。
版本没到 → 宿主项全部 `SKIP` 并退出 0：那是信号没来，不是失败。

## 3. 事前调查：拿新版实包核对触点表

1. 取新版实包并解到 `.session-files\tmp\v<版本>\`（`npm pack @deepseek-ai/dsh@<版本>`，或从隔离目录里已装的包取）。
2. 对 [`plugin-dsh-contract.md`](./plugin-dsh-contract.md) 每一行，在新包里检索同一个符号 / 字段 / 事件名 / 槽名 / `class` 后缀；命中打勾，没命中记「哪一行、谁会用不了」。
3. 全命中就升；有缺口**先改那一列对应的插件**，再升。

本轮实例：外部文档列的四处破坏性变更（删 `list-agents` 导出、`modelSelectionSettings` 改名、`MenuTarget`→`ContextMenuTarget`、`tools.mode`→`z<never>`）与我们无关——这是按触点表逐行核对后得出的，不是抄的。

## 4. 红了怎么办

1. **先分清**：`SKIP` = 版本没到（等信号），`FAIL` = 插件真坏了。
2. **先回滚**：`tools\deploy.ps1 -Tag <上一个 tag>` + 重启，让线上先回到能用的版本，别边坏边修。
3. **再一个插件一个插件修**：对着失败项改那一列的插件，修完重跑脚本；不要四个一起动。
4. 单测报 `ERR_MODULE_NOT_FOUND` 是测试树没装依赖（worktree 常见）：在该插件目录 `pnpm install` 后重跑，不算插件坏。

## 附：4 条人工项（脚本会打印，人自己点）

- `ssh_status` 能列主机 —— 会话里调一次，输出里有配置过的主机。
- `ssh_run` 弹卡并执行一条只读命令 —— 一条 `uname -a`：卡片出现、勾选、命令跑通。
- 审批卡（提权）能弹能批 —— 触发一次提权：浏览器卡片出现，批准/拒绝生效。
- 侧栏 pin 还在 —— 折叠侧栏，已 pin 的会话方块仍在、点得进去。
