/**
 * dsh-approval-allow —— Host 半边。
 *
 * 作用：在审批瀑布里按配置文件的锚定正则，把 pwsh / bash 的审批（含沙箱提权）自动答成
 * 「允许一次」，弹窗根本不出现；没命中、命中 deny、配置坏了、拿不到命令文本，一律交回下游。
 *
 * 关键约束（改动前先看 README.md 与 DECISIONS.md）：
 * - 审批请求只有 toolName + callId，没有命令文本；命令来自 tools/pre-execute 抓到的
 *   exec.arguments.command，按 callId 存进有界缓存（上限 256、TTL 10 分钟）；
 * - 只碰 pwsh / bash；其他工具一律 next()，不缓存、不放行；
 * - 任何不确定都 fail-closed：callId 缺失 / 缓存未命中 / 规则作废 / JSON 坏 → next()；
 * - 放行只跳过「问」，不绕过沙箱；提权审批被放行等于自动同意越界，安全由规则严格度负责；
 * - 只用 Node 内置模块，不 import 任何 @deepseek-ai/* 包。
 */
import { isAbsolute } from 'node:path'
import { createAudit, createCallCache } from './lib/audit.mjs'
import { createConfigStore, resolveDataDir } from './lib/config.mjs'
import { decide } from './lib/match.mjs'

/** 只做这两个通道；ssh_run 的多选卡不经过这里。 */
export const SHELL_TOOLS = Object.freeze(['pwsh', 'bash'])
/** 缓存上限与 TTL（与 README / DECISIONS 一致）。 */
export const CALL_CACHE_MAX = 256
export const CALL_CACHE_TTL_MS = 10 * 60 * 1000

/** 取非空字符串，否则 null。 */
function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * patch 行配置：只有三个键会改变挂载行为。
 * `enabled` / `dataDir` / `debug` 改了必须重启；规则文件不在 patch 里，改完即生效。
 */
function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    enabled: source.enabled !== false,
    debug: source.debug === true,
    dataDir: textOrNull(source.dataDir),
  }
}

/** debug 为 true 时才把插件自身诊断打到宿主控制台。 */
function createLogger(debug) {
  return (event) => {
    if (!debug) return
    try {
      console.log(`[approval-allow] ${JSON.stringify(event)}`)
    } catch {
      // 控制台写不出去不影响审批
    }
  }
}

/**
 * 项目根 = 会话当前工作目录（一手来源），不是宿主进程的 process.cwd()。
 * 顺序：`workingDirectory` 服务的已提交目录 → `session.header.cwd` → null（只用全局名单）。
 * 相对路径一律不认（join 会把它接到 process.cwd() 上，等于拿错项目）。
 */
function projectRootOf(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return null
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service !== undefined && typeof service.get === 'function') {
      const cwd = service.get(session)
      if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
    }
  } catch {
    // 服务不可用/会话未就绪：退回下一手来源
  }
  const headerCwd = session.header?.cwd
  if (typeof headerCwd === 'string' && isAbsolute(headerCwd)) return headerCwd
  return null
}

/**
 * 预执行：只把 pwsh/bash 的 callId → {tool, command} 记进缓存，然后原样放行。
 * 不在这里做审批判断：放行统一在 approval/request 瀑布里做，免得越过后面的 guard / ask。
 */
function handlePreExecute(runtime, exec) {
  if (runtime.stopped) return
  const name = exec?.name
  if (!SHELL_TOOLS.includes(name)) return
  const command = exec?.arguments?.command
  if (typeof command !== 'string' || command === '') return
  const callId = exec?.callId
  if (typeof callId !== 'string' || callId === '') return
  runtime.cache.remember(callId, { tool: name, command })
  runtime.log({ event: 'cache', phase: 'remember', tool: name, callId, commandLength: command.length })
}

/** 审计行：六个键永远在，缺值写 null（统计侧不需要处理字段缺失）。 */
function auditEntry({ tool, command, outcome, rule = null, reason = null }) {
  return {
    ts: new Date().toISOString(),
    tool,
    command,
    outcome,
    rule,
    reason,
  }
}

/**
 * 审批瀑布：命中缓存命令 → 查配置 → 命 allow 且未命 deny 才 allowed-once，其余 next()。
 * 返回 next() 时不吞掉下游错误，也不改变 downstream 结果。
 */
async function handleApproval(runtime, req, next) {
  if (runtime.stopped) return next()
  const tool = typeof req?.toolName === 'string' ? req.toolName : null
  if (!SHELL_TOOLS.includes(tool)) return next()

  const callId = typeof req?.callId === 'string' && req.callId !== '' ? req.callId : null
  if (callId === null) {
    runtime.audit.audit(
      auditEntry({ tool, command: null, outcome: 'asked', reason: 'call-id-missing' }),
    )
    runtime.log({ event: 'approval', phase: 'call-id-missing', tool })
    return next()
  }

  const cached = runtime.cache.lookup(callId)
  if (cached === null || cached.tool !== tool) {
    runtime.audit.audit(
      auditEntry({
        tool,
        command: null,
        outcome: 'asked',
        reason: cached === null ? 'cache-miss' : 'tool-mismatch',
      }),
    )
    runtime.log({ event: 'approval', phase: 'cache-miss', tool, callId })
    return next()
  }

  const command = cached.command
  let decision
  try {
    const projectRoot = projectRootOf(runtime.ctx, req?.agent)
    const snapshot = runtime.configStore.snapshot(projectRoot)
    runtime.log({
      event: 'approval',
      phase: 'config',
      tool,
      projectRoot,
      projectId: snapshot.projectId,
      configPath: snapshot.globalPath,
    })
    decision = decide(snapshot.rules, { tool, command })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    runtime.audit.audit(
      auditEntry({ tool, command, outcome: 'asked', reason: `evaluation-error: ${message}` }),
    )
    runtime.log({ event: 'approval', phase: 'evaluation-error', tool, error: message })
    return next()
  }

  if (decision.kind === 'allow') {
    runtime.audit.audit(
      auditEntry({ tool, command, outcome: 'auto-allowed', rule: decision.rule.id }),
    )
    runtime.log({ event: 'approval', phase: 'auto-allowed', tool, rule: decision.rule.id })
    return 'allowed-once'
  }
  if (decision.kind === 'deny') {
    runtime.audit.audit(
      auditEntry({ tool, command, outcome: 'asked', rule: decision.rule.id, reason: 'deny-rule' }),
    )
    runtime.log({ event: 'approval', phase: 'deny-rule', tool, rule: decision.rule.id })
    return next()
  }
  runtime.audit.audit(auditEntry({ tool, command, outcome: 'asked', reason: 'no-rule' }))
  runtime.log({ event: 'approval', phase: 'no-rule', tool })
  return next()
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) return

  const dataDir = resolveDataDir({ dataDir: settings.dataDir })
  const log = createLogger(settings.debug)
  const audit = createAudit({ dataDir, log })
  const configStore = createConfigStore({
    dataDir,
    reportDiagnostic: (entry) => audit.diagnostic(entry),
  })
  const runtime = {
    ctx,
    log,
    audit,
    configStore,
    cache: createCallCache({ max: CALL_CACHE_MAX, ttlMs: CALL_CACHE_TTL_MS }),
    stopped: false,
  }

  // 先读一次全局配置：坏文件在挂载时就写进 config-errors.log，而不是等第一次审批。
  try {
    configStore.snapshot(null)
  } catch (error) {
    log({ event: 'plugin', phase: 'initial-read-failed', error: String(error?.message ?? error) })
  }
  log({ event: 'plugin', phase: 'activated', dataDir, cacheMax: CALL_CACHE_MAX, cacheTtlMs: CALL_CACHE_TTL_MS })

  ctx.effect(
    () => () => {
      runtime.stopped = true
      runtime.cache.clear()
    },
    'approval-allow: 停止缓存',
  )

  ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      handlePreExecute(runtime, exec)
      return next()
    },
    { prepend: true },
  )

  ctx.on(
    'approval/request',
    (req, next) => handleApproval(runtime, req, next),
    { prepend: true },
  )
}
