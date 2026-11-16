/**
 * dsh-ssh-remote：受控的多主机 SSH 执行与搬运。
 *
 * 边界（设计上刻意为之）：
 * - 只依赖 Node 内置模块 + `ssh2`，不 import 任何 `@deepseek-ai/*`；
 * - 凭据用 Windows DPAPI 加密存在插件数据目录，只在插件进程内存里出现；
 * - 每条远端操作都先弹一张多选审批卡，未勾选的一律不执行；卡是本插件自己的 dialog
 *   （共享外壳的 WebView2 卡），**不经**宿主的 userQuestions；
 * - 可选服务分两种：`webServer` / `connection` 用 `ctx.inject()`——服务就位才挂维护接口，
 *   headless 组合永不激活、但插件其余部分照常工作；`systemPrompt` 走 `ctx.get()`（每次组装
 *   现取一次）。两者都不能写进模块级 `inject`（那会让 headless 组合整个插件都不加载）。
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdmin, createAdminTool, createDialogRunner } from './lib/admin.mjs'
import { createApiHandlers } from './lib/api/handlers.mjs'
import { createApiRoutes } from './lib/api/routes.mjs'
import { createAudit } from './lib/audit.mjs'
import { ensureConfigFile } from './lib/config.mjs'
import { createCopyTool } from './lib/copy.mjs'
import { createDpapi } from './lib/dpapi.mjs'
import { createEndpointIO } from './lib/endpoint.mjs'
import { ConnectionPool } from './lib/pool.mjs'
import { createRunTool } from './lib/run.mjs'
import { createStatusTool } from './lib/status.mjs'
import { createPaths, StateStore } from './lib/store.mjs'
import { createWslRunner } from './lib/wsl.mjs'

/** 硬依赖：起子进程（wsl/pwsh）与注册工具。 */
export const inject = ['subprocess', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_DIR = join(HERE, 'scripts')
const PLUGIN_DIR_NAME = 'ssh-remote'

/** 数据目录：patch 配置里的 dataDir 优先，否则 `%USERPROFILE%\.dsh\plugin-data\ssh-remote`。 */
export function resolveDataDir(config) {
  const configured =
    config !== null && typeof config === 'object' && typeof config.dataDir === 'string' && config.dataDir.trim() !== ''
      ? config.dataDir.trim()
      : null
  return configured ?? join(homedir(), '.dsh', 'plugin-data', PLUGIN_DIR_NAME)
}

/** 可选服务取法：Cordis 里读未 inject 的属性会抛错（K-010）。 */
export function optionalService(ctx, name) {
  if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * 给模型看的提示词段落：有哪些目标、规则是什么。每次组装时现算，所以加主机立刻可见。
 */
export function renderHostsSection(store) {
  const snapshot = store.snapshot()
  const lines = ['## SSH 远端操作（插件 dsh-ssh-remote）', '', '可用目标：']
  const hosts = Object.values(snapshot.hosts)
  if (hosts.length === 0) lines.push('- （还没有远程主机；到插件设置页的「SSH 主机」里添加）')
  for (const host of hosts) {
    const passwordText = store.vault.has(host.id)
      ? '密码已保存'
      : host.via === undefined
        ? '**无密码**（连接会失败，到插件设置页的「SSH 主机」里重填密码）'
        : '凭据已接入'
    const tags = host.tags.length === 0 ? '' : ` [${host.tags.join(', ')}]`
    lines.push(`- \`${host.id}\`：${host.user}@${host.address}:${host.port}，${host.label}${tags}，${passwordText}`)
  }
  for (const item of Object.values(snapshot.wsl)) {
    lines.push(`- \`wsl:${item.distro}\`：本机 WSL（${item.label}），不用密码`)
  }
  lines.push(
    '',
    '规则：',
    '1. 远端操作只准用 `ssh_run` / `ssh_copy`，**不要**用 bash/pwsh 工具去调 ssh/scp/rsync 绕开审批。',
    '2. 每条 step 必须写 `why`（会显示在审批卡上）。',
    `3. 一次最多 ${snapshot.settings.maxCardRows} 行；要做更多就分批调用。`,
    '4. 用户没勾选的行一律视为「不执行」：不要换个写法重试，也不要拆成小命令绕过。',
    '5. 查状态用 `ssh_status`（不需要审批）。',
    '6. 子代理也能用 `ssh_run` / `ssh_copy`：审批一律走本机桌面卡片（共享外壳的 WebView2，关窗口＝一行都不执行），不经过宿主的内置问题弹窗。别因为担心审批而绕开这两个工具。',
    '',
    '主机与接入点的维护（新增 / 改密码 / 改备注 / 删除 / 导入）只在**插件设置页「SSH 主机」**里做，会话侧没有入口。',
  )
  if (snapshot.vault.usable === false) {
    lines.push('', `⚠ 密码库当前不可用：${snapshot.vault.error ?? '原因未知'}。在修好之前不会连接任何主机。`)
  }
  return lines.join('\n')
}

export function apply(ctx, config) {
  const dataDir = resolveDataDir(config)
  const paths = createPaths(dataDir)
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(paths.auditDir, { recursive: true })
  ensureConfigFile(paths.configJson)

  const dpapi = createDpapi({ subprocess: ctx.subprocess, scriptDir: SCRIPT_DIR, cwd: HERE })
  const store = new StateStore({ paths, dpapi })
  const audit = createAudit({ dir: paths.auditDir, getSettings: () => store.settings })
  void store.reload().then(() => audit.prune())

  // 改 hosts.json / config.json / 密码后自动重载；监听失败只记 lastError。
  const pool = new ConnectionPool({ settings: () => store.settings, vault: store.vault, jms: () => store.jms })
  store.watch((snapshot) => {
    // 热重载改了地址/端口/用户名、或删掉了主机之后，旧连接必须扔掉：
    // 否则同一个 id 会复用旧连接——审批卡上写新地址、命令却跑在旧机器上；删掉的主机也还能连。
    for (const [hostId, entry] of [...pool.entries.entries()]) {
      const next = snapshot?.hosts?.[hostId]
      if (next === undefined) {
        pool.close(hostId)
        continue
      }
      const before = entry.host ?? {}
      const changed =
        before.address !== next.address ||
        Number(before.port) !== Number(next.port) ||
        before.user !== next.user ||
        // 来源标记变了（同一台机器换账号 / 重新导入）也要重连：旧连接是按旧账号建的。
        JSON.stringify(before.via ?? null) !== JSON.stringify(next.via ?? null)
      if (changed) pool.close(hostId)
    }
  })
  pool.startSweeper()

  const dialog = createDialogRunner({ subprocess: ctx.subprocess, scriptDir: SCRIPT_DIR, cwd: HERE })
  const admin = createAdmin({ store })
  const wsl = createWslRunner({ subprocess: ctx.subprocess, cwd: HERE })
  const io = createEndpointIO({ pool, wsl })

  // 维护接口（插件设置页用）：一份实现在宿主，浏览器同源 fetch 直接调，不写第二套。
  //
  // 必须用 `ctx.inject`，不能在 apply 里 `ctx.get('webServer')` 取一次：插件激活常常早于
  // webServer / connection 就位，取不到就永久跳过、且静默无声（真机症状：整条前缀回 405，
  // 那是 DSH 静态处理器的响应，我们的路由压根没挂上去）。
  // `ctx.inject(names, cb)` 是 cordis 的「服务可用才激活」写法（`RegistryService.inject`：
  // “Start a callback once the requested dependencies are available”，服务变化时先卸载子
  // scope 再重跑）。两个服务都就位才回调；永远不出现就一直不激活，也不抛错。
  ctx.inject(['webServer', 'connection'], (scope) => {
    const routes = createApiRoutes({
      handlers: createApiHandlers({ store, pool }),
      // 未授权一律 403（`requestRejection` 自己只回答 401/403/undefined，响应由我们写）。
      authorize: (request) => scope.connection.requestRejection(request),
    })
    // 路由的 disposer 交给子 scope：服务换掉或插件卸载时自动摘掉，不会留下指向旧 handler 的路由。
    scope.effect(() => routes.register(scope.webServer), `ssh-remote: 维护接口 ${routes.prefix}`)
  })

  const tools = [
    createStatusTool({ store, pool, dataDir }),
    createAdminTool(admin),
    createRunTool({ store, pool, wsl, audit, dialog }),
    createCopyTool({ store, io, audit, dialog }),
  ]
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `ssh-remote: ${tool.name}`)
  }

  // 卸载时收尾：关连接、停监听。工具注销由上面的 effect 负责。
  ctx.effect(
    () => () => {
      pool.closeAll()
      store.dispose()
    },
    'ssh-remote: 连接与监听清理',
  )

  // 提示词段落：可选服务，缺失就跳过（例如 headless 组合）。
  const systemPrompt = optionalService(ctx, 'systemPrompt')
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
    let order = 3150
    if (typeof systemPrompt.getSectionOrder === 'function') {
      try {
        order = systemPrompt.getSectionOrder('MCP_SERVERS') + 50
      } catch {
        order = 3150
      }
    }
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'ssh-remote:hosts',
          order,
          text: () => renderHostsSection(store),
        }),
      'ssh-remote: 提示词段落',
    )
  }
}
