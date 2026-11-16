/**
 * 连接池单测：用假 ssh2 客户端驱动，不需要真服务器。
 *
 * 覆盖：命令包装与截断、同主机串行、不同主机并行、认证失败冷却（防锁号）、
 * 超时废连接、中断、空闲清理、最大连接数淘汰、字节流通道（搬运用）。
 *
 * 运行：node dsh-ssh-remote/tests/pool.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { AUTH_COOLDOWN_MS, ConnectionPool, PoolError, tailBytes, wrapCommand } from '../lib/pool.mjs'
import { DEFAULT_SETTINGS } from '../lib/config.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

async function caughtAsync(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('本该抛错但没有抛')
}

const SETTINGS = { ...DEFAULT_SETTINGS, connectTimeoutMs: 2000, idleTimeoutMs: 60000 }

/** 假客户端：行为按 `behaviours[host]` 决定。 */
class FakeClient extends EventEmitter {
  constructor(host, behaviours) {
    super()
    this.host = host
    this.behaviour = behaviours[host] ?? {}
    this.connectCalls = 0
    this.execCalls = []
    this.ended = false
    this.active = 0
    this.maxActive = 0
  }

  connect(config) {
    this.connectCalls += 1
    this.config = config
    const delay = this.behaviour.connectDelayMs ?? 5
    setTimeout(() => {
      const mode = this.behaviour.connect ?? 'ok'
      if (mode === 'authFail') this.emit('error', new Error('All configured authentication methods failed'))
      else if (mode === 'refuse') this.emit('error', new Error('connect ECONNREFUSED'))
      else if (mode === 'hang') return
      else this.emit('ready')
    }, delay)
  }

  exec(command, callback) {
    this.execCalls.push(command)
    // 与 ssh2 一致：错误走回调；成功时**先回调给 stream**，之后才吐数据。
    if (this.behaviour.exec === 'fail') {
      callback(new Error('exec failed'))
      return new EventEmitter()
    }

    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    callback(undefined, stream)

    const delay = this.behaviour.execDelayMs ?? 10
    setTimeout(() => {
      if (this.behaviour.exec === 'hang') return
      stream.emit('data', Buffer.from(`out:${command}`))
      this.active -= 1
      // 'dropped'：链路断了——服务端/网络直接把通道关了，既没有 exit-status 也没有 exit-signal
      // （远端重启、断网、中间设备掐连接）。
      if (this.behaviour.exec === 'dropped') {
        stream.emit('close', undefined, null)
        return
      }
      // 'killed'：远端进程被信号杀掉——没有退出码，但有 exit-signal，不算断链。
      if (this.behaviour.exec === 'killed') {
        stream.emit('close', undefined, 'KILL')
        return
      }
      // 'exitOnly'：模拟 macOS 上实测到的情形——进程退出了，通道 close 却迟迟不来。
      if (this.behaviour.exec === 'exitOnly') {
        stream.emit('exit', this.behaviour.exitCode ?? 0, null)
        return
      }
      stream.emit('close', this.behaviour.exitCode ?? 0, null)
    }, delay)
    return stream
  }

  end() {
    this.ended = true
    this.emit('close')
  }
}

function makePool({ behaviours = {}, settings = SETTINGS, now = () => Date.now() } = {}) {
  const clients = []
  const vault = {
    passwordFor(hostId, host) {
      if (hostId === 'nopass') throw new Error('主机还没有保存密码')
      return `pw-for-${hostId}`
    },
  }
  const pool = new ConnectionPool({
    settings,
    vault,
    now,
    createClient: () => {
      const holder = { client: null }
      const client = new FakeClient(undefined, behaviours)
      // 连接时才知道 host：用 getter 让 connect 之前按 config 设定 behaviour
      const originalConnect = client.connect.bind(client)
      client.connect = (config) => {
        client.behaviour = behaviours[config.host] ?? {}
        client.host = config.host
        originalConnect(config)
      }
      holder.client = client
      clients.push(client)
      return client
    },
  })
  return { pool, clients }
}

const HOST = { id: 'web1', address: '192.168.1.11', port: 22, user: 'deploy' }
const HOST2 = { id: 'web2', address: '192.168.1.12', port: 22, user: 'deploy' }

await test('wrapCommand：无 cwd 原样；有 cwd 前置 cd 并转义单引号', () => {
  assert.equal(wrapCommand('uname -a'), 'uname -a')
  // 必须是 `|| exit 1` + 换行，不能用 `&&`：换行会终止 and-or 列表，
  // `&&` 只保护第一行，cd 失败后其余行会在 $HOME 里继续跑。
  assert.equal(wrapCommand('uname -a', '/tmp'), `cd -- '/tmp' || exit 1\nuname -a`)
  assert.equal(wrapCommand('ls', "/tmp/it's"), `cd -- '/tmp/it'\\''s' || exit 1\nls`)
  // 多行命令：cd 失败时一行都不该跑（而不是只跳过第一行）。
  assert.equal(wrapCommand('pwd\nrm -rf ./*', '/srv'), `cd -- '/srv' || exit 1\npwd\nrm -rf ./*`)
  // cwd 以 - 开头时 `--` 挡住 cd 自己的选项解析（`cd -` 是 OLDPWD）。
  assert.equal(wrapCommand('pwd', '-'), `cd -- '-' || exit 1\npwd`)
})

await test('tailBytes：超长只留尾部', () => {
  const buffer = Buffer.from('0123456789')
  assert.equal(tailBytes(buffer, 20).toString(), '0123456789')
  assert.equal(tailBytes(buffer, 4).toString(), '6789')
})

await test('同一主机两条命令复用一条连接，且按顺序执行', async () => {
  const { pool, clients } = makePool()
  const [first, second] = await Promise.all([
    pool.run(HOST, 'one'),
    pool.run(HOST, 'two'),
  ])
  assert.equal(clients.length, 1, '只应建一条连接')
  assert.equal(clients[0].connectCalls, 1)
  assert.equal(clients[0].maxActive, 1, '同一主机必须串行')
  assert.match(first.stdout, /out:/)
  assert.match(second.stdout, /out:/)
  assert.deepEqual(clients[0].execCalls, ['one', 'two'])
  pool.closeAll()
})

await test('不同主机并行（各自一条连接）', async () => {
  const { pool, clients } = makePool()
  await Promise.all([pool.run(HOST, 'a'), pool.run(HOST2, 'b')])
  assert.equal(clients.length, 2)
  assert.ok(clients.every((client) => client.connectCalls === 1))
  pool.closeAll()
})

await test('连接参数：密码来自 vault，keepalive 与超时按设置', async () => {
  const { pool, clients } = makePool()
  await pool.run(HOST, 'x')
  const config = clients[0].config
  assert.equal(config.host, '192.168.1.11')
  assert.equal(config.port, 22)
  assert.equal(config.username, 'deploy')
  assert.equal(config.password, 'pw-for-web1')
  assert.equal(config.readyTimeout, SETTINGS.connectTimeoutMs)
  assert.equal(config.keepaliveInterval, SETTINGS.keepaliveIntervalMs)
  pool.closeAll()
})

await test('vault 没密码：直接失败，不尝试连接', async () => {
  const { pool, clients } = makePool()
  const error = await caughtAsync(pool.run({ ...HOST, id: 'nopass' }, 'x'))
  assert.ok(error instanceof PoolError)
  assert.equal(error.code, 'vault')
  assert.equal(clients.length, 0)
  pool.closeAll()
})

await test('认证失败：报 auth 并冷却，冷却期内不再连接（防锁号）', async () => {
  let clock = 1_000_000
  const { pool, clients } = makePool({
    behaviours: { '192.168.1.11': { connect: 'authFail' } },
    now: () => clock,
  })
  const first = await caughtAsync(pool.run(HOST, 'x'))
  assert.equal(first.code, 'auth')
  assert.match(first.message, /密码认证失败/)
  assert.equal(clients.length, 1)

  const second = await caughtAsync(pool.run(HOST, 'x'))
  assert.equal(second.code, 'auth')
  assert.match(second.message, /已暂停/)
  assert.equal(clients.length, 1, '冷却期内不该再建连接')

  clock += AUTH_COOLDOWN_MS + 1
  await caughtAsync(pool.run(HOST, 'x'))
  assert.equal(clients.length, 2, '冷却结束后允许再试一次')
  pool.closeAll()
})

await test('命令超时：报 timeout，并丢弃连接（下一次重连）', async () => {
  const { pool, clients } = makePool({ behaviours: { '192.168.1.11': { exec: 'hang' } } })
  const error = await caughtAsync(pool.run(HOST, 'sleep 999', { timeoutMs: 1200 }))
  assert.equal(error.code, 'timeout')
  assert.equal(pool.entries.size, 0, '超时后连接应被丢弃')

  await pool.run({ ...HOST, address: '192.168.1.99' }, 'ok') // 另一台机器仍可正常连
  assert.equal(clients.length, 2)
  pool.closeAll()
})

await test('外部中断：报 aborted 并丢弃连接', async () => {
  const { pool } = makePool({ behaviours: { '192.168.1.11': { exec: 'hang' } } })
  const controller = new AbortController()
  const pending = caughtAsync(pool.run(HOST, 'sleep', { signal: controller.signal }))
  setTimeout(() => controller.abort(), 50)
  const error = await pending
  assert.equal(error.code, 'aborted')
  assert.equal(pool.entries.size, 0)
  pool.closeAll()
})

await test('断链：close 没带退出码 → dropped=true 且丢掉连接（D-26）', async () => {
  const { pool } = makePool({ behaviours: { '192.168.1.11': { exec: 'dropped' } } })
  const outcome = await pool.run(HOST, 'systemctl restart nginx')
  assert.equal(outcome.exitCode, null, '断链不许编一个退出码')
  assert.equal(outcome.signalName, null)
  assert.equal(outcome.dropped, true, '没有退出码也没有退出信号＝链路断了')
  assert.equal(pool.entries.size, 0, '链路已经不可信：下一条命令必须重连')

  // 正常退出的命令不能被标成断链，否则「命令失败」与「链路断了」又混在一起。
  const { pool: healthy } = makePool()
  const okOutcome = await healthy.run(HOST, 'uname -a')
  assert.equal(okOutcome.dropped, false)
  assert.equal(okOutcome.exitCode, 0)
  healthy.closeAll()
  pool.closeAll()
})

await test('远端进程被信号杀掉：没有退出码但有 exit-signal，不算断链', async () => {
  const { pool } = makePool({ behaviours: { '192.168.1.11': { exec: 'killed' } } })
  const outcome = await pool.run(HOST, 'sleep 999')
  assert.equal(outcome.exitCode, null)
  assert.equal(outcome.signalName, 'KILL')
  assert.equal(outcome.dropped, false, '这是命令被杀，不是链路断了')
  pool.closeAll()
})

await test('空闲超过 idleTimeoutMs 会被清理', async () => {
  let clock = 1_000_000
  const { pool } = makePool({ now: () => clock })
  await pool.run(HOST, 'x')
  assert.equal(pool.entries.size, 1)
  clock += SETTINGS.idleTimeoutMs + 1
  pool.sweep()
  assert.equal(pool.entries.size, 0, '空闲连接应被关掉')
  pool.closeAll()
})

await test('超过 maxConnections 时淘汰最久未用的连接', async () => {
  let clock = 1_000_000
  const { pool } = makePool({
    settings: { ...SETTINGS, maxConnections: 1 },
    now: () => clock,
  })
  await pool.run(HOST, 'x')
  clock += 10
  await pool.run(HOST2, 'y')
  assert.equal(pool.entries.size, 1, '只允许一条连接')
  assert.equal([...pool.entries.keys()][0], 'web2', '留下最近用的那条')
  pool.closeAll()
})

await test('ready 之后连接报错：不崩进程，并把条目摘掉', async () => {
  const { pool, clients } = makePool()
  await pool.run(HOST, 'x')
  const client = clients[0]
  // 没挂 error 监听器时，EventEmitter.emit('error') 抛的是未捕获异常——整个宿主会崩。
  assert.ok(client.listenerCount('error') > 0, 'ready 之后必须常驻 error 监听器')
  assert.ok(client.listenerCount('close') > 0, 'ready 之后必须常驻 close 监听器')

  assert.doesNotThrow(() => client.emit('error', new Error('Keepalive timeout')))
  // 连接已经不可信：池里必须摘掉，下一次 run 会重连而不是在死连接上失败。
  assert.equal(pool.entries.has('web1'), false)
  assert.deepEqual(pool.status(), [])

  await pool.run(HOST, 'y')
  assert.equal(clients.length, 2, '旧连接被摘掉后应当新建一条')
})

await test('同一个 id 改了地址：必须重连，不能复用旧连接', async () => {
  const { pool, clients } = makePool()
  await pool.run(HOST, 'x')
  assert.equal(clients.length, 1)

  // hosts.json 是热重载的：id 不变、地址变了，旧的 ready 连接必须作废。
  const moved = { ...HOST, address: '192.168.1.99' }
  await pool.run(moved, 'y')
  assert.equal(clients.length, 2, '地址变了就不该复用旧连接')
  assert.equal(clients[0].ended, true, '旧连接要主动关掉')
  assert.equal(clients[1].config.host, '192.168.1.99')
})

await test('命令执行期间算「忙」：空闲回收不会把它杀掉', async () => {
  const settings = { ...SETTINGS, idleTimeoutMs: 1 }
  const { pool, clients } = makePool({ settings, behaviours: { '192.168.1.11': { execDelayMs: 30 } } })
  const running = pool.run(HOST, 'slow')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(pool.entries.get('web1').busy, 1, '执行期间 busy 必须 > 0')
  pool.sweep()
  const outcome = await running
  assert.equal(outcome.exitCode, 0, '命令不能被空闲回收打断')
  assert.equal(clients[0].ended, false)
})

await test('status 反映连接状态与连接耗时', async () => {
  const { pool } = makePool()
  await pool.run(HOST, 'x')
  const [status] = pool.status()
  assert.equal(status.hostId, 'web1')
  assert.equal(status.state, 'ready')
  assert.equal(typeof status.connectedMs, 'number')
  pool.closeAll()
  assert.deepEqual(pool.status(), [])
})

await test('channels：一次要齐多条通道，done 带回退出码，release 幂等', async () => {
  const { pool } = makePool()
  const handles = await pool.channels(HOST, ['tar -cf - -C /a -- b', 'tar -xf - -C /c'])
  assert.equal(handles.length, 2)
  assert.equal(pool.entries.get('web1').busy, 2)

  const [first, second] = await Promise.all([handles[0].done, handles[1].done])
  assert.equal(first.exitCode, 0)
  assert.equal(second.exitCode, 0)

  handles[0].release()
  assert.equal(pool.entries.get('web1').busy, 1)
  handles[0].release() // 重复调用不能再减
  assert.equal(pool.entries.get('web1').busy, 1)
  handles[1].release()
  assert.equal(pool.entries.get('web1').busy, 0)
  pool.closeAll()
})

await test('channels：槽位在流开着时就让出，同一台机器能再取通道', async () => {
  const { pool } = makePool()
  const first = await pool.channels(HOST, ['a'])
  // 若槽位被流占着，这一行会永久挂住（测试超时即是回归）。
  const second = await pool.channels(HOST, ['b'])
  assert.equal(second.length, 1)
  first[0].release()
  second[0].release()
  pool.closeAll()
})

await test('channels：搬运中的连接（busy>0）不会被空闲淘汰', async () => {
  let clock = 1_000_000
  const { pool } = makePool({ now: () => clock })
  const handles = await pool.channels(HOST, ['long transfer'])
  clock += SETTINGS.idleTimeoutMs + 1
  pool.sweep()
  assert.equal(pool.entries.size, 1, '忙的连接必须留着')
  handles[0].release()
  clock += SETTINGS.idleTimeoutMs + 1
  pool.sweep()
  assert.equal(pool.entries.size, 0, 'release 之后才按空闲超时淘汰')
})

await test('channels：开通道失败变成 PoolError，且不泄漏 busy 计数', async () => {
  const { pool } = makePool({ behaviours: { '192.168.1.11': { exec: 'fail' } } })
  const error = await caughtAsync(pool.channels(HOST, ['a']))
  assert.equal(error.code, 'exec')
  assert.match(error.message, /开通道失败/)
  assert.equal(pool.entries.get('web1').busy, 0, '失败也要把 busy 还回去')
  pool.closeAll()
})

await test('channels：服务端只发 exit、不发 close 也能结算（macOS 实测）', async () => {
  const { pool } = makePool({ behaviours: { '192.168.1.11': { exec: 'exitOnly', exitCode: 7 } } })
  const handles = await pool.channels(HOST, ['x'])
  const outcome = await handles[0].done
  assert.equal(outcome.exitCode, 7, 'exit-status 就是结论，不依赖通道 close')
  assert.equal(outcome.settledBy, 'exit')
  handles[0].release()
  pool.closeAll()
})

await test('exec 回调报错：变成 PoolError 而不是崩掉', async () => {
  const { pool } = makePool({ behaviours: { '192.168.1.11': { exec: 'fail' } } })
  const error = await caughtAsync(pool.run(HOST, 'x'))
  assert.equal(error.code, 'exec')
  assert.match(error.message, /执行失败/)
  pool.closeAll()
})

console.log(`\n结果：全部通过（${passed} 项）`)
