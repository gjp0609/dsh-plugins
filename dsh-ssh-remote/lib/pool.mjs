/**
 * SSH 连接池：每台主机一条常驻连接、一条串行队列；不同主机可并行。
 *
 * 设计要点（K-003）：
 * - 懒连接、keepalive；空闲超时与最大连接数来自设置；
 * - **认证失败不重试**（防锁号），连接直接丢弃并记错误；
 * - 命令超时/中断时连连接一起废掉，避免把半死不活的会话留给下一条命令；
 * - 断线的处理方式是「下一次操作重新连」，不在这里做无脑重试。
 *
 * `createClient` 可注入，单测用假客户端驱动，不需要真服务器。
 *
 * 本文件只留 `ConnectionPool` 类本体与对外导出面（D-33）：类的每个方法都只是把 `this`
 * 显式传给 `lib/pool/` 里的同名函数，自己没有业务逻辑。分段与理由见
 * `pool/lifecycle.mjs`、`pool/connect.mjs`、`pool/exec.mjs` 的文件头。
 */
import { Client } from 'ssh2'
import {
  close as closeHost,
  closeAll as closeAllHosts,
  dropEntry as dropEntryOf,
  enforceLimit as enforceLimitOn,
  serial as serialOn,
  startSweeper as startSweeperOn,
  status as statusOf,
  sweep as sweepPool,
} from './pool/lifecycle.mjs'
import { connectEntry } from './pool/connect.mjs'
import { openChannel as openChannelOn, openChannels, runCommand } from './pool/exec.mjs'

// 对外导出面一字不动：常量、错误类型、两个纯函数都从新模块原样再导出，
// 所以 `import { … } from './lib/pool.mjs'` 的调用方（index.js、pool.test.mjs）无需改。
export { AUTH_COOLDOWN_MS, EXIT_SETTLE_MS, PoolError } from './pool/lifecycle.mjs'
export { tailBytes, wrapCommand } from './pool/exec.mjs'

export class ConnectionPool {
  /**
   * @param settings - `{ connectTimeoutMs, idleTimeoutMs, keepaliveIntervalMs, maxConnections, outputBytesPerStep }`
   * @param vault - 取密码 / 密钥；只在这里被调用，密码不会外流
   * @param jms - 接入点配置的 getter（`store.jms`＝`{ gateways }`）；只有带内部标记的主机建连时才读
   * @param createClient - 默认 `() => new Client()`；单测注入假客户端
   */
  constructor({ settings, vault, jms, createClient = () => new Client(), now = () => Date.now() }) {
    // settings 既可以是对象，也可以是 getter：配置热加载后新连接立刻用新参数。
    this.getSettings = typeof settings === 'function' ? settings : () => settings
    this.vault = vault
    // 接入点配置同样用 getter：改完 config.json 后下一次重连就生效，不需要重启。
    this.getJms = typeof jms === 'function' ? jms : () => jms
    this.createClient = createClient
    this.now = now
    this.entries = new Map()
    this.queues = new Map()
    /** 主机 → 冷却到期时间：密码认证失败后暂停一段时间，避免把账号试锁。 */
    this.authCooldown = new Map()
    this.sweeper = null
  }

  /** 连接状态摘要（给 ssh_status 用，不含密码）。 */
  status() {
    return statusOf(this)
  }

  /** 关闭某台主机（下一次用会重新连）。 */
  close(hostId) {
    closeHost(this, hostId)
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
  dropEntry(hostId, entry, error) {
    dropEntryOf(this, hostId, entry, error)
  }

  closeAll() {
    closeAllHosts(this)
  }

  /** 起一个定时器清理空闲/超额的连接。重复调用只装一次。 */
  startSweeper() {
    startSweeperOn(this)
  }

  sweep() {
    sweepPool(this)
  }

  /** 连接数超标时关掉最久没用的（刚建好的那条、正在搬运的都除外）。 */
  enforceLimit(keepHostId) {
    enforceLimitOn(this, keepHostId)
  }

  /** 每台主机一条串行队列：同一主机上的操作按顺序跑，不同主机互不阻塞。 */
  serial(hostId, task) {
    return serialOn(this, hostId, task)
  }

  /** 取（必要时建立）一条可用连接。 */
  async connect(host, { signal } = {}) {
    return await connectEntry(this, host, { signal })
  }

  /**
   * 在远端执行一条命令，返回 `{ exitCode, signalName, dropped, stdout, stderr, ms }`。
   *
   * `dropped === true` 表示通道在给出退出码之前就关了（链路断了），`exitCode` 因此是 `null`；
   * 调用方必须把它当成「命令可能没执行完」而不是「命令以某个退出码失败」（D-26）。
   */
  async run(host, command, { cwd, timeoutMs, signal } = {}) {
    return await runCommand(this, host, command, { cwd, timeoutMs, signal })
  }

  /**
   * 打开 `commands.length` 条字节流通道（搬运用），**一次占一个串行槽位**。
   *
   * 为什么要一次要齐：`serial()` 按主机排队，如果分两次调用取通道，第二次永远排不上
   * （第一次的槽位被流自己占着）。所以同一台主机的源与目标是同一台时必须走这里。
   *
   * 返回的句柄：`{ stdout, stdin, done, kill, release }`。
   * `done` 解析成 `{ exitCode, signalName, stderr }`；**用完必须 `release()`**，
   * 否则这条连接永远算「忙」，空闲淘汰不会回收它。
   */
  async channels(host, commands, { cwd, signal } = {}) {
    return await openChannels(this, host, commands, { cwd, signal })
  }

  /** 在已连接的 entry 上开一条 exec 通道（内部用，不做排队）。 */
  async openChannel(entry, command, { signal } = {}) {
    return await openChannelOn(this, entry, command, { signal })
  }
}
