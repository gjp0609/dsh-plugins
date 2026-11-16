/**
 * 数据层单测：hosts 解析、目标解析、vault 的 fail closed 与 addrHash 绑定、
 * config 的越界处理、StateStore 的 reload / 热加载。
 *
 * 不依赖 DSH、不依赖真实 DPAPI：`dpapi` 用 base64 假实现注入。
 *
 * 运行：node dsh-ssh-remote/tests/state.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, ensureConfigFile, mergeSettings } from '../lib/config.mjs'
import { addrHash, normalizeHostsDocument, resolveTarget, targetLabel } from '../lib/hosts.mjs'
import { StateStore, createPaths } from '../lib/store.mjs'
import { Vault, VaultError } from '../lib/vault.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/** 假 DPAPI：真写文件（vault 会 stat 它），只是把「加密」换成 base64。 */
function fakeDpapi() {
  return {
    async protect(path, text) {
      writeFileSync(path, Buffer.from(text, 'utf8').toString('base64'), 'utf8')
    },
    async unprotect(path) {
      const raw = readFileSync(path, 'utf8')
      if (raw.startsWith('garbage')) throw new Error('密文损坏')
      return Buffer.from(raw, 'base64').toString('utf8')
    },
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'ssh-remote-state-'))
}

/** 抓住抛出的错误对象（`assert.throws` 不返回它）。 */
function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('本该抛错但没有抛')
}

const WEB1 = { address: '192.168.1.11', port: 22, user: 'deploy' }

await test('hosts：合法条目收下，非法条目跳过并记 warning', () => {
  const warnings = []
  const doc = normalizeHostsDocument(
    {
      hosts: {
        web1: { address: '192.168.1.11', user: 'deploy', label: '生产 Web', tags: ['prod', ' '] },
        'bad id': { address: '1.2.3.4', user: 'x' },
        db1: { address: '192.168.1.12' },
        db2: { address: '192.168.1.13', user: 'root', port: 70000 },
      },
      wsl: { Debian: { label: '本机 Debian' }, '': {} },
      defaults: { connectTimeoutMs: 20000, maxConnections: -1 },
    },
    { warnings },
  )
  assert.deepEqual(Object.keys(doc.hosts), ['web1'])
  assert.equal(doc.hosts.web1.port, 22)
  assert.deepEqual(doc.hosts.web1.tags, ['prod'])
  assert.deepEqual(Object.keys(doc.wsl), ['Debian'])
  assert.equal(doc.wsl.Debian.user, null)
  assert.equal(doc.defaults.connectTimeoutMs, 20000)
  assert.equal(doc.defaults.maxConnections, 10, '非法值退回内置默认')
  assert.equal(warnings.length, 5, `应记 5 条 warning，实际 ${warnings.length}：${warnings.join(' / ')}`)
  assert.match(warnings.join(' / '), /bad id/)
  assert.match(warnings.join(' / '), /db2/)
  assert.match(warnings.join(' / '), /maxConnections/)
})

await test('addrHash 随地址/端口/用户名变化，且对同一份输入稳定', () => {
  const base = addrHash(WEB1)
  assert.equal(addrHash({ ...WEB1 }), base)
  assert.notEqual(addrHash({ ...WEB1, port: 2222 }), base)
  assert.notEqual(addrHash({ ...WEB1, address: '192.168.1.99' }), base)
  assert.notEqual(addrHash({ ...WEB1, user: 'root' }), base)
  assert.equal(base.length, 64)
})

await test('resolveTarget：远程 / wsl: 前缀 / 未知目标报可用清单', () => {
  const { hosts, wsl } = normalizeHostsDocument({
    hosts: { web1: WEB1 },
    wsl: { Debian: {} },
  })
  assert.equal(resolveTarget('web1', { hosts, wsl }).id, 'web1')
  assert.equal(resolveTarget(' wsl:debian ', { hosts, wsl }).distro, 'Debian')
  assert.throws(() => resolveTarget('nope', { hosts, wsl }), /可用：web1/)
  assert.throws(() => resolveTarget('wsl:Nope', { hosts, wsl }), /可用：Debian/)
})

await test('targetLabel：远程带「地址:端口 · 别名」，WSL 仍是 WSL(发行版)（B-22）', () => {
  const { hosts, wsl } = normalizeHostsDocument({
    hosts: {
      web1: { address: '192.168.1.13', user: 'root', label: 'project-a 主机D' },
      // 同一地址、不同端口：端口必须写出来，否则两台主机标签一模一样
      web2: { address: '192.168.1.13', port: 2222, user: 'root', label: 'project-a 主机D' },
    },
    wsl: { Debian: { label: '本机 Debian' } },
  })
  assert.equal(targetLabel(hosts.web1), '192.168.1.13:22 · project-a 主机D', '22 也要写端口')
  assert.equal(targetLabel(hosts.web2), '192.168.1.13:2222 · project-a 主机D')
  assert.notEqual(targetLabel(hosts.web1), targetLabel(hosts.web2), '只差端口的两台不能重名')
  assert.equal(targetLabel(wsl.Debian), 'WSL(Debian)', 'WSL 是用户点的例外，不带地址')
})

await test('config：越界值忽略并记 warning，缺省值补齐', () => {
  const warnings = []
  const settings = mergeSettings([{ maxCardRows: 99, stepTimeoutMs: 500, idleTimeoutMs: 600000 }, {}], warnings)
  assert.equal(settings.maxCardRows, DEFAULT_SETTINGS.maxCardRows)
  assert.equal(settings.stepTimeoutMs, DEFAULT_SETTINGS.stepTimeoutMs)
  assert.equal(settings.idleTimeoutMs, 600000)
  assert.equal(warnings.length, 2)
})

await test('config：ensureConfigFile 只在文件不存在时写模板', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  assert.equal(ensureConfigFile(path), true)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.maxCardRows, DEFAULT_SETTINGS.maxCardRows)
  assert.ok(Array.isArray(written._说明))
  assert.equal(ensureConfigFile(path), false, '已存在则不动用户改动')
})

await test('vault：没有文件＝empty；save 后可读回，且写盘留 .bak', async () => {
  const dir = tempDir()
  const path = join(dir, 'vault.dat')
  const vault = new Vault({ path, dpapi: fakeDpapi() })
  await vault.load()
  assert.equal(vault.state, 'empty')
  assert.equal(vault.usable, true)

  await vault.setPassword('web1', WEB1, 'p@ss')
  assert.equal(vault.state, 'ok')
  assert.equal(vault.count(), 1)
  assert.equal(vault.passwordFor('web1', WEB1), 'p@ss')

  const firstCipher = readFileSync(path, 'utf8')
  // 第二次写入前应把上一版留成 .bak
  await vault.setPassword('web1', WEB1, 'p@ss2')
  assert.ok(existsSync(`${path}.bak`), '第二次写入前应留下 .bak')
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), firstCipher)

  // 落盘是 base64（模拟密文），不含明文
  assert.ok(!readFileSync(path, 'utf8').includes('p@ss'))

  const reloaded = new Vault({ path, dpapi: fakeDpapi() })
  await reloaded.load()
  assert.equal(reloaded.state, 'ok')
  assert.equal(reloaded.passwordFor('web1', WEB1), 'p@ss2')
})

await test('vault：并发写不丢条目（读改写要串行）', async () => {
  const dir = tempDir()
  const vault = new Vault({ path: join(dir, 'vault.dat'), dpapi: fakeDpapi() })
  // 两后台任务同时设密码：不串行的话后写的会基于旧快照覆盖前一次，表现为"设了两台只剩一台"。
  await Promise.all([
    vault.setPassword('web1', WEB1, 'pw1'),
    vault.setPassword('web2', { ...WEB1, address: '192.168.1.12' }, 'pw2'),
  ])
  assert.equal(vault.passwordFor('web1', WEB1), 'pw1')
  assert.equal(vault.passwordFor('web2', { ...WEB1, address: '192.168.1.12' }), 'pw2')
})

await test('vault：地址改过就拒绝复用旧密码（address-changed）', async () => {
  const dir = tempDir()
  const vault = new Vault({ path: join(dir, 'vault.dat'), dpapi: fakeDpapi() })
  await vault.setPassword('web1', WEB1, 'p@ss')
  const err = caught(() => vault.passwordFor('web1', { ...WEB1, address: '10.9.9.9' }))
  assert.ok(err instanceof VaultError)
  assert.equal(err.code, 'address-changed')
  assert.match(err.message, /重新设置密码/)
})

await test('vault：读坏了就不许写——否则一条新密码会把整份密码库覆盖成一条', async () => {
  const dir = tempDir()
  const path = join(dir, 'vault.dat')
  writeFileSync(path, 'garbage-not-ciphertext', 'utf8')
  const vault = new Vault({ path, dpapi: fakeDpapi() })
  await vault.load()
  assert.equal(vault.state, 'error')

  const error = await vault.setPassword('web1', WEB1, 'pw').then(() => null, (e) => e)
  assert.ok(error instanceof VaultError, '读失败后必须拒绝写入')
  assert.equal(error.code, 'unusable')
  // 磁盘上的旧密文不能被这次写入覆盖
  assert.equal(readFileSync(path, 'utf8'), 'garbage-not-ciphertext')
})

await test('vault：密文坏了＝fail closed（usable=false，且拒绝取密码）', async () => {
  const dir = tempDir()
  const path = join(dir, 'vault.dat')
  writeFileSync(path, 'garbage-not-ciphertext', 'utf8')
  const vault = new Vault({ path, dpapi: fakeDpapi() })
  await vault.load()
  assert.equal(vault.state, 'error')
  assert.equal(vault.usable, false)
  assert.match(vault.error, /fail closed/)
  const err = caught(() => vault.passwordFor('web1', WEB1))
  assert.ok(err instanceof VaultError)
  assert.equal(err.code, 'unusable')
})

await test('vault：结构不合法（缺 addrHash）也按损坏处理', async () => {
  const dir = tempDir()
  const path = join(dir, 'vault.dat')
  const bad = { version: 1, entries: { web1: { password: 'x' } } }
  writeFileSync(path, Buffer.from(JSON.stringify(bad), 'utf8').toString('base64'), 'utf8')
  const vault = new Vault({ path, dpapi: fakeDpapi() })
  await vault.load()
  assert.equal(vault.state, 'error')
  assert.match(vault.error, /缺 addrHash/)
})

await test('store：reload 汇总三份文件；坏 hosts 保留旧值并记 lastError', async () => {
  const dir = tempDir()
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts: { web1: WEB1 }, wsl: { Debian: {} } }), 'utf8')
  writeFileSync(paths.configJson, JSON.stringify({ maxCardRows: 5 }), 'utf8')

  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  const first = await store.reload()
  assert.equal(first.lastError, null)
  assert.equal(Object.keys(first.hosts).length, 1)
  assert.equal(first.settings.maxCardRows, 5)
  assert.equal(first.vault.state, 'empty')

  writeFileSync(paths.hostsJson, '{ 这不是 JSON', 'utf8')
  const second = await store.reload()
  assert.match(second.lastError, /hosts\.json/)
  assert.equal(Object.keys(second.hosts).length, 1, '坏文件不应清空上一份可用状态')
  assert.equal(second.revision, 2)

  store.dispose()
})

await test('store：fs.watch 能感知 hosts.json 变化并回调', async () => {
  const dir = tempDir()
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts: {} }), 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  await store.reload()

  let fired = 0
  const seen = new Promise((resolve) => {
    store.watch((snapshot) => {
      fired += 1
      if (Object.keys(snapshot.hosts).length > 0) resolve(snapshot)
    })
  })
  // 等监听装好再写文件，避免竞态
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts: { web9: { address: '10.1.1.9', user: 'u' } } }), 'utf8')

  const snapshot = await Promise.race([
    seen,
    new Promise((_, reject) => setTimeout(() => reject(new Error('5 秒内没有收到热加载回调')), 5000)),
  ])
  assert.equal(Object.keys(snapshot.hosts)[0], 'web9')
  assert.ok(fired >= 1)
  store.dispose()
})

await test('store：dispose 之后不再重载（定时器已清）', async () => {
  const dir = tempDir()
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts: {} }), 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  await store.reload()
  store.watch(() => {})
  store.dispose()
  const revision = store.revision
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(store.revision, revision)
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n结果：全部通过（${passed} 项）`)
