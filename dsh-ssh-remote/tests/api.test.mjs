/**
 * 维护接口单测（`node:test`）：路由外壳（鉴权 / 状态码 / 请求体）+ 业务动作（主机、接入点）。
 *
 * 全部用临时数据目录 + 假 DPAPI + 假连接池 + 假接入点客户端：
 * **不联网、不弹窗、不碰真实密码库**，也不需要 WebView2。
 *
 * 跑法：`node --test --test-isolation=none "tests/*.test.mjs"`（或单跑本文件）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { apply } from '../index.js'
import { createApiHandlers } from '../lib/api/handlers.mjs'
import { API_PREFIX, createApiRoutes } from '../lib/api/routes.mjs'
import { addrHash } from '../lib/hosts.mjs'
import { jmsBindHash, jmsSecretKey, LEGACY_SECRET_KEY } from '../lib/jms/config.mjs'
import { createPaths, StateStore } from '../lib/store.mjs'

// ---- 夹具 -------------------------------------------------------------------

function fakeDpapi() {
  return {
    async protect(path, value) {
      writeFileSync(path, Buffer.from(value, 'utf8').toString('base64'), 'utf8')
    },
    async unprotect(path) {
      return Buffer.from(readFileSync(path, 'utf8'), 'base64').toString('utf8')
    },
  }
}

/** 假 vault 文件（与 `fakeDpapi` 的落盘格式一致：base64 的明文 JSON）。 */
function seedVault(paths, entries) {
  const document = { version: 1, entries }
  writeFileSync(paths.vaultDat, Buffer.from(JSON.stringify(document), 'utf8').toString('base64'), 'utf8')
}

function readVault(paths) {
  return JSON.parse(Buffer.from(readFileSync(paths.vaultDat, 'utf8'), 'base64').toString('utf8'))
}

/**
 * 假连接池：记下被关掉的主机、能查「已连接」、`connect` 可配置成成功/失败。
 * `authCooldown` 用真 Map，因为 handler 会真的删它。
 */
function fakePool({ connect } = {}) {
  const state = { statuses: [], closed: [], connected: [], cooldown: new Map() }
  return {
    state,
    authCooldown: state.cooldown,
    entries: new Map(),
    status() {
      return state.statuses
    },
    close(hostId) {
      state.closed.push(hostId)
    },
    async connect(host) {
      state.connected.push(host.id)
      if (typeof connect === 'function') return await connect(host)
      return { hostId: host.id }
    },
  }
}

/** 假接入点客户端：只实现维护接口用到的两个方法。 */
function fakeApi({ assets = [], accounts = {} } = {}) {
  const calls = { list: 0, accounts: [] }
  return {
    calls,
    async listAssets() {
      calls.list += 1
      return { assets, skipped: 0 }
    },
    async assetAccounts(assetId) {
      calls.accounts.push(String(assetId))
      return accounts[String(assetId)] ?? []
    },
  }
}

/**
 * 一套「假的宿主」：临时目录 + 真 StateStore + 假池 + 假 ctx 的 `webServer.register`。
 * 路由真的挂在假 webServer 上，测试调的就是挂上去的那个 handler。
 */
function harness({ hosts = {}, config = {}, vault = null, rejection, api = null, pool = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-api-'))
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts }), 'utf8')
  writeFileSync(paths.configJson, JSON.stringify(config), 'utf8')
  if (vault !== null) seedVault(paths, vault)

  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  const chosenPool = pool ?? fakePool()
  const handlers = createApiHandlers({
    store,
    pool: chosenPool,
    createClientApi:
      api === null
        ? () => {
            throw new Error('这个用例不该建接入点客户端')
          }
        : () => api,
  })
  const routes = createApiRoutes({ handlers, authorize: () => rejection })
  const registered = []
  const webServer = {
    register(route) {
      registered.push(route)
      return () => {
        route.removed = true
      }
    },
  }
  const dispose = routes.register(webServer)
  return { dir, paths, store, pool: chosenPool, handlers, routes, registered, webServer, dispose }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.headersSent = true
    },
    once() {},
    off() {},
  }
}

/** 发一次请求：`path` 是路由名（`hosts/list`），或自己拼的完整路径。 */
async function call(h, path, body, { method = 'POST', raw = null } = {}) {
  const payload = raw ?? (body === undefined ? '' : JSON.stringify(body))
  const req = Readable.from(payload === '' ? [] : [Buffer.from(payload, 'utf8')])
  req.method = method
  req.url = path.startsWith('/') ? path : `${API_PREFIX}/${path}`
  req.headers = { 'content-length': String(Buffer.byteLength(payload)) }
  const res = fakeRes()
  await h.routes.handle(req, res)
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body,
    body: res.body === '' ? null : JSON.parse(res.body),
  }
}

const WEB1 = { address: '192.168.1.11', port: 22, user: 'deploy', label: '生产 Web', tags: ['prod'] }

// ---- 路由外壳 ---------------------------------------------------------------

test('注册：只在假 ctx 的 webServer 上挂一条前缀路由，前缀里没有产品名', () => {
  const h = harness()
  assert.equal(h.registered.length, 1, '只挂一条前缀路由')
  assert.equal(h.registered[0].kind, 'prefix')
  assert.equal(h.registered[0].path, API_PREFIX)
  assert.equal(API_PREFIX, '/plugin-data/ssh-remote/api')
  assert.doesNotMatch(API_PREFIX, /jumpserver|jms/i, '前缀里不许出现产品名')
  h.dispose()
  assert.equal(h.registered[0].removed, true, '卸载时路由被摘掉')
})

test('未授权：requestRejection 判为拒绝时一律 403，且不回业务数据', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 }, rejection: 401 })
  const result = await call(h, 'hosts/list', {})
  assert.equal(result.status, 403)
  assert.match(result.body.error, /未授权/)
  assert.equal(result.body.hosts, undefined, '拒绝时不带主机清单')
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(result.headers['cache-control'], 'no-store')

  const direct = await call(h, `/${API_PREFIX}/hosts/save`, { address: '1.2.3.4', user: 'root', password: 'p' })
  assert.equal(direct.status, 403, '完整路径也走同一条鉴权')
  assert.equal(existsSync(h.paths.vaultDat), false, '未授权时一个字节都不写')
})

test('路由：不认识的路径 404、方法不对 405、非 JSON 请求体 400', async () => {
  const h = harness()
  assert.equal((await call(h, 'nope/nope', {})).status, 404)
  assert.equal((await call(h, API_PREFIX, {})).status, 404, '前缀本身不是接口')
  const wrong = await call(h, 'hosts/save', undefined, { method: 'GET' })
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'POST')
  assert.equal((await call(h, 'hosts/save', undefined, { raw: '{bad json' })).status, 400)
  assert.equal((await call(h, 'hosts/save', undefined, { raw: '[1,2]' })).status, 400)
  assert.equal(
    (await call(h, 'hosts/save', undefined, { raw: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }) })).status,
    400,
  )
})

// ---- 主机 -------------------------------------------------------------------

test('hosts/list：主机形状与来源，已连接只认池子里的 ready', async () => {
  const pool = fakePool()
  const h = harness({
    hosts: {
      '192.168.1.11': WEB1,
      '192.168.1.12': {
        address: '192.168.1.12',
        port: 2222,
        user: 'root',
        label: '导入的',
        tags: [],
        via: { assetId: '7', accountAlias: 'a7', accountUser: 'root' },
      },
    },
    pool,
  })
  pool.state.statuses = [
    { hostId: '192.168.1.11', state: 'ready' },
    { hostId: '192.168.1.12', state: 'closed' },
  ]
  const result = await call(h, 'hosts/list', {})
  assert.equal(result.status, 200)
  assert.deepEqual(Object.keys(result.body).sort(), ['config', 'hosts'])
  assert.deepEqual(result.body.hosts[0], {
    id: '192.168.1.11',
    address: '192.168.1.11',
    port: 22,
    user: 'deploy',
    label: '生产 Web',
    tags: ['prod'],
    source: 'direct',
    connected: true,
  })
  assert.equal(result.body.hosts[1].source, 'gateway')
  assert.equal(result.body.hosts[1].connected, false)
  assert.equal(result.body.hosts[1].via, undefined, '内部来源标记不对外')
  for (const key of ['connectTimeoutMs', 'stepTimeoutMs', 'idleTimeoutMs', 'maxConnections', 'maxCardRows']) {
    assert.equal(typeof result.body.config[key], 'number', `config.${key}`)
  }
  // GET 也能取（设置页首屏直链）
  assert.equal((await call(h, 'hosts/list', undefined, { method: 'GET' })).status, 200)
})

test('hosts/save 新增：密码真进 vault，返回里没有密码', async () => {
  const h = harness()
  const password = 'pw-新增-123'
  const result = await call(h, 'hosts/save', { ...WEB1, password })
  assert.equal(result.status, 200)
  assert.equal(result.body.created, true)
  assert.equal(result.body.passwordSaved, true)
  assert.equal(result.body.host.id, '192.168.1.11')
  assert.equal(result.body.host.password, undefined)
  assert.equal(result.body.host.passwordSaved, undefined)
  assert.doesNotMatch(result.text, new RegExp(password), '响应正文里没有密码')

  const vault = readVault(h.paths)
  assert.equal(vault.entries['192.168.1.11'].password, password, '密码真落进密文')
  assert.equal(vault.entries['192.168.1.11'].addrHash, addrHash({ address: '192.168.1.11', port: 22, user: 'deploy' }))

  const onDisk = JSON.parse(readFileSync(h.paths.hostsJson, 'utf8'))
  assert.deepEqual(Object.keys(onDisk.hosts), ['192.168.1.11'])
  assert.equal(onDisk.hosts['192.168.1.11'].label, '生产 Web')
  assert.doesNotMatch(readFileSync(h.paths.hostsJson, 'utf8'), new RegExp(password), 'hosts.json 里没有密码')
})

test('hosts/save 改地址（带 id）：id 不变、地址更新、密码重新绑定；不带密码则拒绝', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 }, vault: {} })
  const refused = await call(h, 'hosts/save', { id: '192.168.1.11', address: '192.168.1.99', port: 22, user: 'deploy' })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /重填密码/)

  const password = 'pw-新地址'
  const result = await call(h, 'hosts/save', {
    id: '192.168.1.11',
    address: '192.168.1.99',
    port: 22,
    user: 'deploy',
    password,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.created, false)
  assert.equal(result.body.host.id, '192.168.1.11', 'id 是存储键，不跟着地址变')
  assert.equal(result.body.host.address, '192.168.1.99')
  assert.equal(readVault(h.paths).entries['192.168.1.11'].addrHash, addrHash({ address: '192.168.1.99', port: 22, user: 'deploy' }))
  assert.ok(h.pool.state.closed.includes('192.168.1.11'), '地址变了要关旧连接')
})

test('hosts/save 改密码（身份不变）：只换密文、返回不含密码', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 }, vault: {} })
  const first = 'pw-一'
  const second = 'pw-二'
  await call(h, 'hosts/save', { id: '192.168.1.11', address: '192.168.1.11', port: 22, user: 'deploy', password: first })
  const result = await call(h, 'hosts/save', {
    id: '192.168.1.11',
    address: '192.168.1.11',
    port: 22,
    user: 'deploy',
    password: second,
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.passwordSaved, true)
  assert.equal(readVault(h.paths).entries['192.168.1.11'].password, second)
  assert.doesNotMatch(result.text, new RegExp(second))
})

test('hosts/save 同一身份重复（不带 id）：按既有规则更新那一条，不新增', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 } })
  const result = await call(h, 'hosts/save', {
    address: '192.168.1.11',
    port: 22,
    user: 'deploy',
    label: '新简称',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.created, false)
  assert.equal(result.body.host.id, '192.168.1.11')
  assert.equal(result.body.host.label, '新简称')
  assert.equal(result.body.passwordSaved, false, '留空＝不改密码')
  const onDisk = JSON.parse(readFileSync(h.paths.hostsJson, 'utf8'))
  assert.deepEqual(Object.keys(onDisk.hosts), ['192.168.1.11'])
})

test('hosts/save 只差端口＝另一台；经接入点导入的主机不许改身份', async () => {
  const h = harness({
    hosts: {
      '192.168.1.11': WEB1,
      '192.168.1.12': {
        address: '192.168.1.12',
        port: 22,
        user: 'root',
        label: '导入的',
        via: { assetId: '7', accountAlias: 'a7', accountUser: 'root' },
      },
    },
  })
  const another = await call(h, 'hosts/save', {
    address: '192.168.1.11',
    port: 2222,
    user: 'deploy',
    password: 'pw-另一台',
  })
  assert.equal(another.status, 200)
  assert.equal(another.body.created, true)
  assert.equal(another.body.host.id, '192.168.1.11-2222')

  const refused = await call(h, 'hosts/save', {
    id: '192.168.1.12',
    address: '192.168.1.13',
    port: 22,
    user: 'root',
    password: 'pw-别的资产',
  })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /接入点导入/)
})

test('hosts/remove：删主机、删密码、关连接；不存在则 400', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 }, vault: {} })
  await call(h, 'hosts/save', { id: '192.168.1.11', address: '192.168.1.11', port: 22, user: 'deploy', password: 'pw' })
  const result = await call(h, 'hosts/remove', { id: '192.168.1.11' })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { removed: true })
  assert.deepEqual(JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts, {})
  assert.deepEqual(readVault(h.paths).entries, {})
  assert.ok(h.pool.state.closed.includes('192.168.1.11'))

  const again = await call(h, 'hosts/remove', { id: '192.168.1.11' })
  assert.equal(again.status, 400)
  assert.match(again.body.error, /没有配置主机/)
})

test('hosts/label：留空退回地址；未知 id 400', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 } })
  const result = await call(h, 'hosts/label', { id: '192.168.1.11', label: '   ' })
  assert.equal(result.status, 200)
  assert.equal(result.body.host.label, '192.168.1.11')
  assert.equal(JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts['192.168.1.11'].label, '192.168.1.11')
  assert.equal((await call(h, 'hosts/label', { id: 'nope', label: 'x' })).status, 400)
})

test('hosts/test：真连一次返回 ok/ms，失败也是 200 + error，且不含密码', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 } })
  const okResult = await call(h, 'hosts/test', { id: '192.168.1.11' })
  assert.equal(okResult.status, 200)
  assert.equal(okResult.body.ok, true)
  assert.equal(typeof okResult.body.ms, 'number')
  assert.deepEqual(h.pool.state.connected, ['192.168.1.11'])

  const failing = harness({
    hosts: { '192.168.1.11': WEB1 },
    pool: fakePool({ connect: async () => { throw new Error('连接 192.168.1.11 失败：ECONNREFUSED') } }),
  })
  const failed = await call(failing, 'hosts/test', { id: '192.168.1.11' })
  assert.equal(failed.status, 200)
  assert.equal(failed.body.ok, false)
  assert.match(failed.body.error, /ECONNREFUSED/)
  assert.equal((await call(failing, 'hosts/test', { id: 'nope' })).status, 400)
})

// ---- 接入点（多接入点 · D-45）-----------------------------------------------

const GW_A = { id: 'default', label: '默认', address: '192.168.1.9', appid: 'app1', port: 2222 }
const GW_B = { id: '192-168-1-8', label: '测试', address: '192.168.1.8', appid: 'app2', port: 52222 }

const GATEWAY_CONFIG = { jms: { gateways: [GW_A] } }
const GATEWAY_CONFIG_TWO = { jms: { gateways: [GW_A, GW_B] } }

/** 一个接入点的一份密钥：键是 `jms:<id>:secret`，绑定它自己的地址 / 端口 / appid。 */
function gatewayVault(secret, gateway = GW_A) {
  return { [jmsSecretKey(gateway.id)]: { password: secret, addrHash: jmsBindHash(gateway) } }
}

test('gateway/list：一个接入点一条，永不返回密钥；旧单接入点配置读出来是「默认」', async () => {
  const secret = 'secret-不许回声'
  const h = harness({ config: GATEWAY_CONFIG_TWO, vault: gatewayVault(secret, GW_A) })
  const result = await call(h, 'gateway/list', {})
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.gateways, [
    { id: 'default', label: '默认', address: '192.168.1.9', appid: 'app1', port: 2222, hasSecret: true, configured: true },
    { id: '192-168-1-8', label: '测试', address: '192.168.1.8', appid: 'app2', port: 52222, hasSecret: false, configured: false },
  ], '两个接入点各自回答自己的 hasSecret，不串')
  assert.doesNotMatch(result.text, new RegExp(secret))
  assert.equal(result.body.gateways[0].secret, undefined)

  const empty = await call(harness({}), 'gateway/list', {})
  assert.deepEqual(empty.body.gateways, [], '没配过就是一个空列表，不凭空造一个「默认」')

  // 旧形态（单个 address/appid/kokoPort）→ 内存里就是 id default、名称「默认」的那一个。
  const legacy = harness({
    config: { jms: { address: '192.168.1.9', appid: 'app1', kokoPort: 52222 } },
    vault: { [LEGACY_SECRET_KEY]: { password: 'old', addrHash: jmsBindHash({ address: '192.168.1.9', appid: 'app1', port: 52222 }) } },
  })
  const migrated = await call(legacy, 'gateway/list', {})
  assert.deepEqual(migrated.body.gateways, [
    { id: 'default', label: '默认', address: '192.168.1.9', appid: 'app1', port: 52222, hasSecret: true, configured: true },
  ], '旧配置换算成 default，旧密钥照样能用（只读兼容）')
  // 读路径绝不写盘：旧形态要等下一次写入才迁移。
  assert.deepEqual(JSON.parse(readFileSync(legacy.paths.configJson, 'utf8')).jms, {
    address: '192.168.1.9',
    appid: 'app1',
    kokoPort: 52222,
  })
})

test('gateway/save：不带 id 新增（id 由地址派生）、带 id 更新（id 不变），密钥各进各的键', async () => {
  const secret = 'secret-写进去'
  const h = harness({ config: { ...GATEWAY_CONFIG, stepTimeoutMs: 45000, _说明: ['别丢'] } })
  const created = await call(h, 'gateway/save', {
    label: '生产',
    address: 'https://192.168.1.7:8443',
    appid: 'app9',
    port: 52222,
    secret,
  })
  assert.equal(created.status, 200)
  assert.equal(created.body.created, true)
  assert.equal(created.body.passwordSaved, true)
  assert.equal(created.body.gateway.id, '192-168-1-7-8443', 'id 由地址派生（协议与标点都净化掉），稳定可读')
  assert.equal(created.body.gateway.label, '生产')
  assert.equal(created.body.gateway.hasSecret, true)
  assert.doesNotMatch(created.text, new RegExp(secret))
  assert.equal(readVault(h.paths).entries[jmsSecretKey('192-168-1-7-8443')].password, secret)

  const onDisk = JSON.parse(readFileSync(h.paths.configJson, 'utf8'))
  assert.deepEqual(onDisk.jms.gateways, [
    { ...GW_A },
    { id: '192-168-1-7-8443', label: '生产', address: 'https://192.168.1.7:8443', appid: 'app9', port: 52222 },
  ], '落盘一定带 id 与 port，旧键 kokoPort 不再出现')
  assert.equal(onDisk.stepTimeoutMs, 45000, 'config.json 其它键原样保留')
  assert.deepEqual(onDisk._说明, ['别丢'])

  // 带 id：改的是那一个，id 不变，别的接入点一个字不动。
  const renamed = await call(h, 'gateway/save', {
    id: 'default',
    label: '改名了',
    address: '192.168.1.9',
    appid: 'app1',
    port: 2222,
  })
  assert.equal(renamed.body.created, false)
  assert.equal(renamed.body.gateway.id, 'default')
  assert.equal(renamed.body.gateway.label, '改名了')
  assert.deepEqual(
    JSON.parse(readFileSync(h.paths.configJson, 'utf8')).jms.gateways.map((gateway) => gateway.id),
    ['default', '192-168-1-7-8443'],
  )

  // 留空＝不改密钥：同一份配置再存一次，密文还在。
  const saved = harness({ config: GATEWAY_CONFIG_TWO, vault: gatewayVault(secret, GW_B) })
  const again = await call(saved, 'gateway/save', { id: '192-168-1-8', address: '192.168.1.8', appid: 'app2', port: 52222 })
  assert.equal(again.body.gateway.hasSecret, true)
  assert.equal(readVault(saved.paths).entries[jmsSecretKey('192-168-1-8')].password, secret)

  // 地址改了、密钥没重填：旧密钥绑定不上，状态如实说「未配置」。
  const moved = await call(saved, 'gateway/save', { id: '192-168-1-8', address: '192.168.1.18', appid: 'app2', port: 52222 })
  assert.equal(moved.body.gateway.configured, false)
  assert.equal(moved.body.gateway.hasSecret, false)

  const missing = await call(saved, 'gateway/save', { id: 'nope', address: '192.168.1.9', appid: 'app1' })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /没有这个接入点/)
})

test('gateway/remove：删配置与它那份密钥，从它导入的主机留着；别的接入点不受影响', async () => {
  const h = harness({
    config: GATEWAY_CONFIG_TWO,
    vault: { ...gatewayVault('secret-a', GW_A), ...gatewayVault('secret-b', GW_B) },
    hosts: {
      '192.168.1.11': {
        address: '192.168.1.11',
        port: 22,
        user: 'deploy',
        via: { gatewayId: '192-168-1-8', assetId: '7', accountAlias: 'a7', accountUser: 'deploy' },
      },
      '192.168.1.12': {
        address: '192.168.1.12',
        port: 22,
        user: 'root',
        via: { assetId: '8', accountAlias: 'a8', accountUser: 'root' },
      },
    },
  })
  const result = await call(h, 'gateway/remove', { id: '192-168-1-8' })
  assert.equal(result.status, 200)
  assert.deepEqual({ removed: result.body.removed, hostsKept: result.body.hostsKept }, { removed: true, hostsKept: 1 })

  const onDisk = JSON.parse(readFileSync(h.paths.configJson, 'utf8'))
  assert.deepEqual(onDisk.jms.gateways, [{ ...GW_A }], '只删这一个')
  const entries = readVault(h.paths).entries
  assert.equal(entries[jmsSecretKey('192-168-1-8')], undefined, '它的密钥一起删')
  assert.equal(entries[jmsSecretKey('default')].password, 'secret-a', '别人的密钥不动')
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts).sort(),
    ['192.168.1.11', '192.168.1.12'],
    '主机是用户的资产，删接入点不该顺手删主机',
  )

  assert.equal((await call(h, 'gateway/remove', { id: 'nope' })).status, 400)
  assert.equal((await call(h, 'gateway/remove', {})).status, 400)
  // 旧的单接入点接口整体下线：未知路由就是 404，不留兼容层。
  assert.equal((await call(h, 'gateway/status', {})).status, 404)
})

test('gateway/assets：一台资产的每个账号一行，已导入按 assetId + 账号别名判定', async () => {
  const api = fakeApi({
    assets: [
      { id: '7', name: '生产 Web', address: '192.168.1.11' },
      { id: '8', name: '192.168.1.12', address: '192.168.1.12' },
      { id: '9', name: '空账号', address: '192.168.1.13' },
    ],
    accounts: {
      // 真机就是这么一台两个账号：只取第一个会丢掉 root。
      '7': [
        { alias: 'example', username: 'example' },
        { alias: 'root', username: 'root' },
      ],
      '8': [{ alias: 'a8', username: 'root' }],
    },
  })
  const h = harness({
    config: GATEWAY_CONFIG_TWO,
    vault: { ...gatewayVault('secret-a', GW_A), ...gatewayVault('secret-b', GW_B) },
    api,
    hosts: {
      '192.168.1.11': {
        address: '192.168.1.11',
        port: 22,
        user: 'example',
        label: '生产 Web · example',
        via: { assetId: '7', accountAlias: 'example', accountUser: 'example' },
      },
    },
  })
  const first = await call(h, 'gateway/assets', { gatewayId: 'default' })
  assert.equal(first.status, 200)
  assert.equal(first.body.gatewayId, 'default')
  assert.deepEqual(first.body.assets, [
    { assetId: '7', name: '生产 Web', address: '192.168.1.11', account: { alias: 'example', username: 'example' }, imported: true },
    { assetId: '7', name: '生产 Web', address: '192.168.1.11', account: { alias: 'root', username: 'root' }, imported: false },
    { assetId: '8', name: '192.168.1.12', address: '192.168.1.12', account: { alias: 'a8', username: 'root' }, imported: false },
    { assetId: '9', name: '空账号', address: '192.168.1.13', account: null, imported: false },
  ], '一台资产两个账号＝两行；只导了 example 时 root 仍是未导入；没有账号的资产仍留一行')
  assert.equal(first.body.assets.length, 4, '行数是账号数 + 无账号资产数，不是资产台数')

  const second = await call(h, 'gateway/assets', { gatewayId: '192-168-1-8' })
  assert.equal(second.body.gatewayId, '192-168-1-8')
  assert.deepEqual(
    second.body.assets.map((row) => row.imported),
    [false, false, false, false],
    '别的接入点里这些账号都不算已导入（旧 via 没有 gatewayId 的按 default 算，也不该串过来）',
  )
  assert.equal(api.calls.list, 2, '每个接入点各拉一次')
  assert.deepEqual(api.calls.accounts.sort(), ['7', '7', '8', '8', '9', '9'])
})

test('gateway/import：一个账号一台主机，via.accountAlias 各自正确，多账号备注带用户名', async () => {
  const api = fakeApi({
    assets: [
      { id: '7', name: 'Web 1', address: '192.168.1.11' },
      { id: '8', name: 'db', address: '192.168.1.12' },
      { id: '9', name: '空账号', address: '192.168.1.13' },
    ],
    accounts: {
      '7': [
        { alias: 'example', username: 'example' },
        { alias: 'root', username: 'root' },
      ],
      '8': [{ alias: 'a8', username: 'root' }],
    },
  })
  const h = harness({ config: GATEWAY_CONFIG, vault: gatewayVault('secret'), api })

  const result = await call(h, 'gateway/import', {
    gatewayId: 'default',
    items: [
      { assetId: '7', account: 'example' },
      { assetId: '7', account: 'root' },
      { assetId: '7', account: 'gone' },
      { assetId: '9', account: 'root' },
      { assetId: '99', account: 'root' },
    ],
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.gatewayId, 'default')
  assert.deepEqual(
    result.body.imported.map((item) => [item.id, item.user, item.account, item.created]),
    [
      ['192.168.1.11', 'example', 'example', true],
      ['192.168.1.11-22', 'root', 'root', true],
    ],
    '同一台资产的两个账号＝两台主机，各自的别名都对',
  )
  assert.deepEqual(
    result.body.skipped.map((item) => [item.assetId, item.account]),
    [['7', 'gone'], ['9', 'root'], ['99', 'root']],
    '账号被撤销 / 没有可用账号 / 资产不可见，都逐项跳过',
  )

  const hosts = JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts
  assert.deepEqual(Object.keys(hosts).sort(), ['192.168.1.11', '192.168.1.11-22'])
  assert.equal(hosts['192.168.1.11'].label, 'Web 1 · example', '多账号资产的备注带用户名，否则两台同名分不清')
  assert.equal(hosts['192.168.1.11-22'].label, 'Web 1 · root')
  assert.deepEqual(hosts['192.168.1.11'].via, {
    gatewayId: 'default',
    assetId: '7',
    accountAlias: 'example',
    accountUser: 'example',
  })
  assert.deepEqual(hosts['192.168.1.11-22'].via, {
    gatewayId: 'default',
    assetId: '7',
    accountAlias: 'root',
    accountUser: 'root',
  })

  // 只有一个账号的资产：备注就是资产名，不拼用户名。
  const single = await call(h, 'gateway/import', { gatewayId: 'default', items: [{ assetId: '8', account: 'a8' }] })
  assert.deepEqual(single.body.imported, [{ id: '192.168.1.12', address: '192.168.1.12', user: 'root', account: 'a8', created: true }])
  assert.equal(JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts['192.168.1.12'].label, 'db')

  // 幂等：同一个「资产 + 账号」再导一次＝更新那一条，id 不变、不多出一条。
  const again = await call(h, 'gateway/import', { gatewayId: 'default', items: [{ assetId: '7', account: 'root' }] })
  assert.deepEqual(again.body.imported, [
    { id: '192.168.1.11-22', address: '192.168.1.11', user: 'root', account: 'root', created: false },
  ])
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts).sort(), [
    '192.168.1.11',
    '192.168.1.11-22',
    '192.168.1.12',
  ])
})

test('gateway/import：不接管同身份的直连条目或别的接入点的条目', async () => {
  const api = fakeApi({
    assets: [
      { id: '7', name: '生产 Web', address: '192.168.1.11' },
      { id: '8', name: 'db', address: '192.168.1.12' },
    ],
    accounts: {
      '7': [{ alias: 'a7', username: 'deploy' }],
      '8': [{ alias: 'a8', username: 'root' }],
    },
  })
  const h = harness({
    config: GATEWAY_CONFIG_TWO,
    vault: { ...gatewayVault('secret-a', GW_A), ...gatewayVault('secret-b', GW_B) },
    api,
    hosts: { '192.168.1.11': WEB1 },
  })

  const result = await call(h, 'gateway/import', {
    gatewayId: '192-168-1-8',
    items: [
      { assetId: '7', account: 'a7' },
      { assetId: '8', account: 'a8' },
    ],
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.gatewayId, '192-168-1-8')
  assert.deepEqual(result.body.imported.map((item) => item.id).sort(), ['192.168.1.11-22', '192.168.1.12'])
  assert.ok(result.body.imported.every((item) => item.created === true))

  const onDisk = JSON.parse(readFileSync(h.paths.hostsJson, 'utf8'))
  assert.deepEqual(onDisk.hosts['192.168.1.11'], {
    address: '192.168.1.11',
    port: 22,
    user: 'deploy',
    label: '生产 Web',
    tags: ['prod'],
  }, '同身份的直连条目一个字都不改')
  assert.deepEqual(onDisk.hosts['192.168.1.11-22'].via, {
    gatewayId: '192-168-1-8',
    assetId: '7',
    accountAlias: 'a7',
    accountUser: 'deploy',
  }, 'via.gatewayId 必须落盘')
  assert.ok(h.pool.state.closed.includes('192.168.1.11-22'), '导入后旧连接要废掉')

  // 另一个接入点导入同样的身份：另起一条，原来那条的归属不动（不接管、不补 via）。
  const other = await call(h, 'gateway/import', { gatewayId: 'default', items: [{ assetId: '8', account: 'a8' }] })
  assert.equal(other.body.imported.length, 1)
  assert.notEqual(other.body.imported[0].id, '192.168.1.12')
  const after = JSON.parse(readFileSync(h.paths.hostsJson, 'utf8')).hosts
  assert.equal(after['192.168.1.12'].via.gatewayId, '192-168-1-8', '原来那条仍属于 192-168-1-8')
  assert.equal(after[other.body.imported[0].id].via.gatewayId, 'default')
  assert.deepEqual(Object.keys(after).sort(), ['192.168.1.11', '192.168.1.11-22', '192.168.1.12', '192.168.1.12-22'])
})

test('接入点不存在 / 没配全 / 入参不合法：assets 与 import 都是 400，且一次客户端都不建', async () => {
  const api = fakeApi()
  const h = harness({ api })
  const noGateway = await call(h, 'gateway/assets', { gatewayId: 'default' })
  assert.equal(noGateway.status, 400)
  assert.match(noGateway.body.error, /没有这个接入点/)
  assert.equal((await call(h, 'gateway/import', { gatewayId: 'default', items: [{ assetId: '7', account: 'a' }] })).status, 400)
  assert.equal((await call(h, 'gateway/assets', {})).status, 400, 'gatewayId 必填')
  assert.equal(api.calls.list, 0)

  const half = harness({ config: GATEWAY_CONFIG, api })
  const unconfigured = await call(half, 'gateway/assets', { gatewayId: 'default' })
  assert.equal(unconfigured.status, 400)
  assert.match(unconfigured.body.error, /密钥不可用|还没填地址/)
  assert.equal(api.calls.list, 0)
  assert.equal((await call(half, 'gateway/import', { gatewayId: 'default', items: [] })).status, 400)
  // 新的入参形状是 items（不再接受资产 id 数组，也不留兼容层）。
  assert.equal((await call(half, 'gateway/import', { gatewayId: 'default', assets: ['7'] })).status, 400)
  const missingAlias = await call(half, 'gateway/import', { gatewayId: 'default', items: [{ assetId: '7' }] })
  assert.equal(missingAlias.status, 400)
  assert.match(missingAlias.body.error, /assetId 与 account/)
})

test('迁移：旧密钥迁到 jms:default:secret（幂等），配置在写入时落成新形态', async () => {
  const legacyHash = jmsBindHash({ address: '192.168.1.9', appid: 'app1', port: 52222 })
  const h = harness({
    config: { jms: { address: '192.168.1.9', appid: 'app1', kokoPort: 52222 }, stepTimeoutMs: 30000 },
    vault: { [LEGACY_SECRET_KEY]: { password: 'old-secret', addrHash: legacyHash } },
  })
  // 写一次（带 id default、密钥留空）：迁移由写入路径顺带完成。
  const saved = await call(h, 'gateway/save', {
    id: 'default',
    label: '默认',
    address: '192.168.1.9',
    appid: 'app1',
    port: 52222,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.gateway.hasSecret, true, '迁移之后旧密钥照样能用')

  const entries = readVault(h.paths).entries
  assert.equal(entries[jmsSecretKey('default')].password, 'old-secret')
  assert.equal(entries[LEGACY_SECRET_KEY], undefined, '旧键迁完就删，不留两份')
  const onDisk = JSON.parse(readFileSync(h.paths.configJson, 'utf8'))
  assert.deepEqual(onDisk.jms, {
    gateways: [{ id: 'default', label: '默认', address: '192.168.1.9', appid: 'app1', port: 52222 }],
  }, '下一次写入就落成新形态')
  assert.equal(onDisk.stepTimeoutMs, 30000, '其它键照旧')

  // 幂等：再存一次不报错、密钥仍是那一份。
  const twice = await call(h, 'gateway/save', { id: 'default', address: '192.168.1.9', appid: 'app1', port: 52222 })
  assert.equal(twice.body.gateway.hasSecret, true)
  assert.equal(readVault(h.paths).entries[jmsSecretKey('default')].password, 'old-secret')

  // 旧键与迁移后的配置对不上（用户改过地址）：不迁、也不假装有密钥。
  const mismatched = harness({
    config: { jms: { address: '192.168.1.8', appid: 'app1', kokoPort: 2222 } },
    vault: { [LEGACY_SECRET_KEY]: { password: 'old', addrHash: jmsBindHash(GW_A) } },
  })
  const view = await call(mismatched, 'gateway/list', {})
  assert.equal(view.body.gateways[0].hasSecret, false)
  await call(mismatched, 'gateway/save', { id: 'default', address: '192.168.1.8', appid: 'app1', port: 2222 })
  assert.equal(readVault(mismatched.paths).entries[jmsSecretKey('default')], undefined, '绑不上的旧密钥不迁')
})

// ---- 错误边界 ---------------------------------------------------------------

test('入参非法一律 400（缺地址 / 缺 user / 端口越界 / 未知 id）', async () => {
  const h = harness({ hosts: { '192.168.1.11': WEB1 } })
  const cases = [
    ['hosts/save', { user: 'deploy', password: 'p' }],
    ['hosts/save', { address: '192.168.1.20', password: 'p' }],
    ['hosts/save', { address: '192.168.1.20', user: 'deploy', port: 70000, password: 'p' }],
    ['hosts/save', { id: 'nope', address: '192.168.1.20', user: 'deploy', password: 'p' }],
    ['hosts/save', { address: '192.168.1.20', user: 'deploy' }],
    ['hosts/remove', {}],
    ['hosts/label', { id: '' }],
    ['hosts/test', {}],
    ['gateway/save', { address: '', appid: 'a' }],
    ['gateway/save', { address: '192.168.1.9', appid: '' }],
    ['gateway/save', { address: 'ftp://192.168.1.9', appid: 'a' }],
  ]
  for (const [path, body] of cases) {
    const result = await call(h, path, body)
    assert.equal(result.status, 400, `${path} ${JSON.stringify(body)}`)
    assert.equal(typeof result.body.error, 'string')
  }
})

test('handler 抛错 → 500，错误文本里没有密码 / 密钥，也没有堆栈', async () => {
  // 把 vault 弄坏：读失败 → fail closed，写密码必然抛错
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-api-'))
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts: {} }), 'utf8')
  writeFileSync(paths.configJson, JSON.stringify(GATEWAY_CONFIG), 'utf8')
  writeFileSync(paths.vaultDat, 'not-a-vault', 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  const pool = fakePool()
  const handlers = createApiHandlers({ store, pool, createClientApi: () => fakeApi() })
  const routes = createApiRoutes({ handlers, authorize: () => undefined })
  const h = { routes }

  const password = 'pw-绝不能出现'
  const saved = await call(h, 'hosts/save', { address: '192.168.1.21', user: 'root', password })
  assert.equal(saved.status, 500)
  assert.match(saved.body.error, /vault/)
  assert.doesNotMatch(saved.text, new RegExp(password))
  assert.doesNotMatch(saved.text, /\bat .*\.mjs:\d+/, '不带堆栈')

  const secret = 'secret-绝不能出现'
  const gateway = await call(h, 'gateway/save', { address: '192.168.1.9', appid: 'app1', secret })
  assert.equal(gateway.status, 500)
  assert.doesNotMatch(gateway.text, new RegExp(secret))
})

// ---- 插件接线（index.js） ---------------------------------------------------

/**
 * 假宿主 ctx：把 `ctx.inject` 的请求记下来（**不**立刻回调，用来模拟服务还没就位），
 * 另有真的 `webServer.register` 收路由。
 */
function hostCtx() {
  const state = { injections: [], gets: [], registrations: [], tools: [], effects: [], scopeDisposers: [] }
  const webServer = {
    register(route) {
      state.registrations.push(route)
      return () => {
        route.removed = true
      }
    },
  }
  const ctx = {
    subprocess: { spawn() { throw new Error('测试里不该起子进程') } },
    tools: { register(tool) { state.tools.push(tool.name); return () => {} } },
    effect(fn) {
      const disposer = fn()
      state.effects.push(disposer)
      return disposer
    },
    get(name) {
      state.gets.push(name)
      return undefined
    },
    inject(names, callback) {
      state.injections.push({ names, callback })
      return () => {}
    },
  }
  return { ctx, state, webServer }
}

test('apply：webServer / connection 没就位时不挂路由、也不抛错，工具照常注册', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-api-apply-'))
  writeFileSync(join(dir, 'hosts.json'), JSON.stringify({ hosts: { '192.168.1.11': WEB1 } }), 'utf8')
  const { ctx, state } = hostCtx()

  assert.doesNotThrow(() => apply(ctx, { dataDir: dir }), 'headless 组合里 server 缺失不能炸插件')
  assert.deepEqual(state.tools.sort(), ['ssh_admin', 'ssh_copy', 'ssh_run', 'ssh_status'], '会话侧只有执行/搬运/只读：ssh_jms 已随 B-47 删除')
  assert.equal(state.registrations.length, 0, '服务没就位时一条路由都不该有（不能每个请求都 405 空 body）')

  // 晚绑定：只声明要这两个服务，不在 apply 里 `ctx.get()` 取一次就完（真机 405 的根因）。
  assert.equal(state.injections.length, 1)
  assert.deepEqual(state.injections[0].names, ['webServer', 'connection'])
  assert.equal(typeof state.injections[0].callback, 'function')
  assert.deepEqual(state.gets, ['systemPrompt'], 'apply 只该现取 systemPrompt；web 两个服务走 inject')
})

test('apply：服务晚到时由 ctx.inject 的回调挂上维护接口，能响应，卸载时摘除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-api-apply-'))
  writeFileSync(join(dir, 'hosts.json'), JSON.stringify({ hosts: { '192.168.1.11': WEB1 } }), 'utf8')
  const { ctx, state, webServer } = hostCtx()
  apply(ctx, { dataDir: dir })

  // cordis 在服务就位后回调一个子 scope：里面的 webServer / connection 就是那两个服务。
  const scope = {
    webServer,
    connection: { requestRejection: () => undefined },
    effect(fn) {
      const disposer = fn()
      state.scopeDisposers.push(disposer)
      return disposer
    },
  }
  state.injections[0].callback(scope)

  assert.equal(state.registrations.length, 1, '服务就位后只挂一条前缀路由')
  const apiRoute = state.registrations[0]
  assert.equal(apiRoute.path, API_PREFIX)
  assert.equal(apiRoute.kind, 'prefix')

  const req = Readable.from([])
  req.method = 'POST'
  req.url = `${API_PREFIX}/hosts/list`
  req.headers = { 'content-length': '0' }
  const res = fakeRes()
  await apiRoute.handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).hosts[0].id, '192.168.1.11')

  // 卸载：子 scope 的 disposer 被执行（服务换掉 / 插件卸载都会走这里）
  for (const disposer of state.scopeDisposers) disposer()
  assert.equal(apiRoute.removed, true, '路由被摘掉')
})
