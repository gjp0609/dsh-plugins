/**
 * 连接池的「状态 / 关闭 / 丢条目 / 清扫器 / 限流 / 串行化」一段（D-33）。
 *
 * 本模块是 `lib/pool/` 里唯一的叶子：不 import 任何别的 pool 模块。
 * `AUTH_COOLDOWN_MS`、`EXIT_SETTLE_MS`、`PoolError` 也因此落在这里——`connect.mjs` 与
 * `exec.mjs` 都要用它们，若把它们留在 `lib/pool.mjs` 再从这里 import 回来，就成了
 * `pool.mjs → connect/exec → pool.mjs` 的环。
 *
 * 每个函数第一个参数是池子本身（`pool`），它就是原来方法里的 `this`：依赖显式传入，
 * 函数体不认 `this`，所以同一段代码可以被类方法、被 connect、被 exec 以同样方式调用。
 */

/** 密码认证失败后的冷却时间：这段时间内不再尝试连接，避免把账号试锁。 */
export const AUTH_COOLDOWN_MS = 60_000

/**
 * 收到 exit-status 后，等多少毫秒把 stderr 收尾再结算（不等通道 close）。
 * 给得短：stderr 通常与 exit 同时到；这个值只是用来兜住「close 永远不来」的服务端。
 * 代价要认：真碰上慢链路上大量 stderr 时，尾部可能少几行——但总比永久等下去强。
 */
export const EXIT_SETTLE_MS = 300

export class PoolError extends Error {
  /** @param code - `auth` | `connect` | `timeout` | `aborted` | `exec` | `vault` */
  constructor(message, code = 'exec') {
    super(message)
    this.name = 'PoolError'
    this.code = code
  }
}

/** 连接状态摘要（给 ssh_status 用，不含密码）。 */
export function status(pool) {
  return [...pool.entries.values()].map((entry) => ({
    hostId: entry.hostId,
    state: entry.state,
    connectedMs: entry.connectMs,
    idleMs: entry.state === 'ready' ? pool.now() - entry.lastUsed : null,
    lastError: entry.lastError,
  }))
}

/** 关闭某台主机（下一次用会重新连）。 */
export function close(pool, hostId) {
  const entry = pool.entries.get(hostId)
  if (entry === undefined) return
  pool.entries.delete(hostId)
  entry.state = 'closed'
  try {
    entry.client.end()
  } catch {
    // 已经断了就算了
  }
}

/**
 * 连接**在 ready 之后**断掉（keepalive 超时、网络中断、对端重启）时把条目摘掉。
 *
 * 两个必须做的理由：
 * 1. ssh2 在这些场景会 `emit('error')`；一个没挂监听器的 EventEmitter 抛的是**未捕获异常**，
 *    整个 DSH 宿主进程会跟着崩。所以 ready 之后必须常驻一个 error 监听器。
 * 2. 连接断了池子却以为它还 ready，后续命令全在死连接上失败，模型看到失败会去重试
 *    ——对 `rm`/`mv` 这类命令，重试就是二次伤害。
 */
export function dropEntry(pool, hostId, entry, error) {
  const message = String(error?.message ?? error ?? '连接已断开')
  if (entry.state !== 'closed') {
    entry.state = 'closed'
    entry.lastError = message
  }
  if (pool.entries.get(hostId) === entry) pool.entries.delete(hostId)
  try {
    entry.client.end()
  } catch {
    // 已经断了就算了
  }
}

export function closeAll(pool) {
  for (const hostId of [...pool.entries.keys()]) close(pool, hostId)
  if (pool.sweeper !== null) {
    clearInterval(pool.sweeper)
    pool.sweeper = null
  }
}

/** 起一个定时器清理空闲/超额的连接。重复调用只装一次。 */
export function startSweeper(pool) {
  if (pool.sweeper !== null) return
  const every = Math.max(15000, Math.min(60000, Math.floor(pool.getSettings().idleTimeoutMs / 4)))
  pool.sweeper = setInterval(() => sweep(pool), every)
  if (typeof pool.sweeper.unref === 'function') pool.sweeper.unref()
}

export function sweep(pool) {
  const idleLimit = pool.getSettings().idleTimeoutMs
  for (const [hostId, entry] of [...pool.entries.entries()]) {
    if (entry.state !== 'ready') continue
    if ((entry.busy ?? 0) > 0) continue
    if (pool.now() - entry.lastUsed > idleLimit) close(pool, hostId)
  }
  enforceLimit(pool)
}

/** 连接数超标时关掉最久没用的（刚建好的那条、正在搬运的都除外）。 */
export function enforceLimit(pool, keepHostId) {
  while (pool.entries.size > pool.getSettings().maxConnections) {
    const victim = [...pool.entries.values()]
      .filter((entry) => entry.state === 'ready' && entry.hostId !== keepHostId && (entry.busy ?? 0) === 0)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0]
    if (victim === undefined) break
    close(pool, victim.hostId)
  }
}

/** 每台主机一条串行队列：同一主机上的操作按顺序跑，不同主机互不阻塞。 */
export function serial(pool, hostId, task) {
  const previous = pool.queues.get(hostId) ?? Promise.resolve()
  const next = previous.then(task, task)
  pool.queues.set(
    hostId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}
