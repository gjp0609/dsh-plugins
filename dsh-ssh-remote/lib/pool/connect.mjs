/**
 * 建连一段（D-33）：认证尝试、失败冷却、重试、取消。
 *
 * 依赖全部显式传入：`pool` 是池子（entries / authCooldown / vault / createClient / now /
 * getSettings），`host` 是目标，`signal` 是取消信号。这里不认 `this`，所以
 * `ConnectionPool.connect()`、`run`、`channels` 走的是同一条路径。
 */
import { isJmsHost } from '../jms/hosts.mjs'
import { jmsCredentials } from '../jms/remote.mjs'
import { AUTH_COOLDOWN_MS, PoolError, close, dropEntry, enforceLimit } from './lifecycle.mjs'

/** 取（必要时建立）一条可用连接。 */
export async function connectEntry(pool, host, { signal } = {}) {
  const imported = isJmsHost(host)
  const cooldownUntil = pool.authCooldown.get(host.id)
  if (cooldownUntil !== undefined) {
    if (pool.now() < cooldownUntil) {
      const seconds = Math.max(1, Math.round((cooldownUntil - pool.now()) / 1000))
      throw new PoolError(
        `主机「${host.id}」上次密码认证失败，已暂停 ${seconds} 秒（防锁号）。确认密码后到插件设置页「SSH 主机」里重填。`,
        'auth',
      )
    }
    pool.authCooldown.delete(host.id)
  }

  let existing = pool.entries.get(host.id)
  if (existing !== undefined && existing.state === 'ready') {
    // 复用前必须核对「连的还是不是这台机器」：hosts.json 是热重载的，同一个 id 改地址/端口/用户后，
    // 旧连接还活着。不比对的话，审批卡上写的是新地址、命令却跑在旧机器上——这是最危险的一种错。
    if (endpointOf(existing.host) === endpointOf(host)) {
      existing.lastUsed = pool.now()
      return existing
    }
    close(pool, host.id)
    // close() 只把条目从池里摘掉，这个对象和它的 client 已经废了：必须真的重建。
    existing = undefined
  }
  if (existing !== undefined && existing.state === 'connecting' && existing.ready !== null) {
    return await existing.ready
  }

  let password
  let endpoint = { host: host.address, port: host.port, username: host.user, gateway: null }
  try {
    if (imported) {
      // 带内部来源标记的主机：连的是接入点，凭据**现在**签一次（299 秒一次性、可重复签）。
      // 已建立的会话不受过期影响，所以池子照旧复用；只有重连才再签。
      const credential = await jmsCredentials({
        host,
        jms: pool.getJms?.(),
        vault: pool.vault,
        timeoutMs: pool.getSettings().connectTimeoutMs,
        signal,
      })
      endpoint = credential
      password = credential.password
    } else {
      password = pool.vault.passwordFor(host.id, host)
    }
  } catch (error) {
    if (error instanceof PoolError) throw error
    throw new PoolError(String(error?.message ?? error), 'vault')
  }

  let entry = existing
  if (entry === undefined) {
    entry = {
      hostId: host.id,
      host,
      client: pool.createClient(),
      state: 'closed',
      ready: null,
      lastUsed: pool.now(),
      connectMs: null,
      lastError: null,
      /** 正在被搬运占用的流通道数：>0 时不允许被空闲/超额淘汰，否则搬一半连接没了。 */
      busy: 0,
    }
    pool.entries.set(host.id, entry)
  }

  const client = entry.client
  entry.state = 'connecting'
  entry.lastError = null

  const connectedAt = pool.now()
  entry.ready = new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => finish(new PoolError('连接被中断', 'aborted'))
    const finish = (error) => {
      if (settled) return
      settled = true
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
      client.removeListener('close', onClose)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (error === undefined) {
        entry.state = 'ready'
        entry.connectMs = pool.now() - connectedAt
        entry.lastUsed = pool.now()
        // ready 之后必须常驻监听器：
        // - 没有 'error' 监听器时，ssh2 的 keepalive 超时（远端重启/断网）抛的是**未捕获异常**，
        //   整个宿主进程会崩；
        // - 没有 'close' 监听器时，连接断了池子还以为它 ready，后续命令在死连接上失败，
        //   模型看到失败就去重试——对 rm/mv 这类命令，重试是二次伤害。
        if (entry.hooked !== true) {
          entry.hooked = true
          client.on('error', (clientError) => dropEntry(pool, host.id, entry, clientError))
          client.on('close', () => dropEntry(pool, host.id, entry, new Error('连接已断开')))
        }
        enforceLimit(pool, host.id)
        resolve(entry)
      } else {
        entry.state = 'closed'
        entry.lastError = String(error?.message ?? error)
        pool.entries.delete(host.id)
        try {
          client.end()
        } catch {
          // 忽略
        }
        reject(error)
      }
    }
    const onReady = () => finish(undefined)
    const onError = (error) => {
      const message = String(error?.message ?? error)
      const authFailed = /authentication|all configured authentication methods failed|permission denied/i.test(message)
      if (authFailed) {
        if (imported) {
          // 凭据是刚签出来的，被拒说明这个账号在这台资产上不可用（或接入点拒了这次会话）。
          // 不设冷却：这不是「密码试错」，下一次操作重新签一次就能区分「临时」与「没权限」。
          finish(new PoolError(`主机「${host.id}」连接认证失败（接入点拒绝了这个账号）：${message}`, 'auth'))
          return
        }
        // 认证失败不重试：设冷却，别把账号试锁。
        pool.authCooldown.set(host.id, pool.now() + AUTH_COOLDOWN_MS)
        finish(new PoolError(`主机「${host.id}」密码认证失败：${message}`, 'auth'))
        return
      }
      finish(new PoolError(connectFailureText(host, endpoint, message), 'connect'))
    }
    const onClose = () =>
      finish(
        new PoolError(
          imported ? `连接「${host.id}」被关闭（接入点 ${endpoint.gateway}）` : `连接 ${host.id} 被关闭`,
          'connect',
        ),
      )

    client.once('ready', onReady)
    client.once('error', onError)
    client.once('close', onClose)

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      client.connect({
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        password,
        readyTimeout: pool.getSettings().connectTimeoutMs,
        keepaliveInterval: pool.getSettings().keepaliveIntervalMs,
        keepaliveCountMax: 3,
        tryKeyboard: true,
      })
    } catch (error) {
      finish(new PoolError(connectFailureText(host, endpoint, `${error?.message ?? error}`), 'connect'))
      return
    }

    // 部分服务器只开 keyboard-interactive：用同一个密码回答。
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
      done(prompts.map(() => password))
    })
  })

  return await entry.ready
}

/** 连接身份：同一个 id 改了地址/端口/用户之后，绝不能复用旧连接。 */
function endpointOf(host) {
  if (host === undefined || host === null) return ''
  return `${host.address ?? ''}|${host.port ?? 22}|${host.user ?? ''}`
}

/**
 * 连接失败的文案：普通主机照旧；导入的主机要多一句「接入点是谁」——
 * 端口填错、接入点网络不通都长成 `connect ECONNREFUSED`，不写出来就没法区分是资产不通还是接入点不通。
 */
function connectFailureText(host, endpoint, message) {
  if (endpoint?.gateway === null || endpoint?.gateway === undefined) return `连接 ${host.id} 失败：${message}`
  return `连接「${host.id}」失败（接入点 ${endpoint.gateway}）：${message}`
}
