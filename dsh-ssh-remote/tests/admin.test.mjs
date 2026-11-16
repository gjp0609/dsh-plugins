/**
 * ssh_admin 单测：**只读工具**（B-47：会话侧只剩 `list`）+ 设置页仍在复用的写盘纯函数。
 *
 * 2026-11-16 起会话侧不再有 add_host / set_label / remove_host（用户：「ssh 相关的弹窗只剩审批」，
 * 新增/改密码/改备注/删除/接入点导入都在插件设置页做）。所以这里断言两件事：
 *   ① 工具 schema 与执行路径只剩 list，旧动作一律得到明确报错；
 *   ② `upsertHost` / `serializeHostsDocument` 这些设置页也要用的纯函数，行为不变。
 *
 * 运行：node dsh-ssh-remote/tests/admin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdmin, createAdminTool, serializeHostsDocument, upsertHost } from '../lib/admin.mjs'
import { normalizeHostsDocument } from '../lib/hosts.mjs'
import { StateStore, createPaths } from '../lib/store.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

function caught(fn) {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('本该抛错但没有抛')
}

function fakeDpapi() {
  return {
    async protect(path, text) {
      writeFileSync(path, Buffer.from(text, 'utf8').toString('base64'), 'utf8')
    },
    async unprotect(path) {
      return Buffer.from(readFileSync(path, 'utf8'), 'base64').toString('utf8')
    },
  }
}

async function setup({ hosts = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-admin-'))
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify({ hosts }), 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  await store.reload()
  const admin = createAdmin({ store })
  return { dir, paths, store, admin, tool: createAdminTool(admin) }
}

const WEB1 = { address: '192.168.1.11', port: 22, user: 'deploy', label: '生产 Web', tags: ['prod'] }

await test('serializeHostsDocument：写回时去掉内部合成字段', () => {
  const { hosts, wsl, defaults } = normalizeHostsDocument({
    hosts: { web1: { address: '192.168.1.11', user: 'deploy' } },
    wsl: { Debian: { label: '本机' } },
    defaults: { connectTimeoutMs: 20000 },
  })
  const doc = serializeHostsDocument({ hosts, wsl, defaults })
  assert.deepEqual(Object.keys(doc.hosts.web1).sort(), ['address', 'label', 'port', 'tags', 'user'])
  assert.equal(doc.wsl.Debian.user, null)
  assert.equal(doc.defaults.connectTimeoutMs, 20000)
})

await test('upsertHost：判重只看 user+地址+端口，命中＝更新那台（id 不变）', () => {
  const base = normalizeHostsDocument({ hosts: { web1: { address: '192.168.1.11', user: 'deploy', label: '旧简称' } } })
  const { document, host, replaced } = upsertHost({ ...base }, { address: '192.168.1.11', port: 22, user: 'deploy', label: '新简称' })
  assert.equal(replaced, true, '同 user+地址+端口就是同一台')
  assert.equal(host.id, 'web1', 'id 是 vault 的存储键，更新时不许换（换了等于丢密码）')
  assert.equal(document.hosts.web1.label, '新简称')
  assert.deepEqual(Object.keys(document.hosts), ['web1'], '主机数量不变')
})

await test('upsertHost：新增时生成短 id（默认就是地址），简称留空用地址', () => {
  const base = normalizeHostsDocument({ hosts: {} })
  const { document, host, replaced } = upsertHost({ ...base }, { address: '192.168.1.12', port: 2222, user: 'root' })
  assert.equal(replaced, false)
  assert.equal(host.id, '192.168.1.12', '地址本身就是合法的短 id')
  assert.equal(host.label, '192.168.1.12', '简称留空＝用地址')
  assert.equal(host.port, 2222)
  assert.equal(document.hosts['192.168.1.12'].user, 'root')
})

await test('upsertHost：只差端口 / 只差用户名都是另一台（id 让路，不覆盖别人的密码）', () => {
  const one = upsertHost(normalizeHostsDocument({ hosts: {} }), { address: '192.168.1.12', port: 22, user: 'root' })
  const otherPort = upsertHost(one.document, { address: '192.168.1.12', port: 2222, user: 'root' })
  assert.equal(otherPort.replaced, false, '同一地址上另一个 sshd 是另一台')
  assert.equal(otherPort.host.id, '192.168.1.12-2222', '地址键被占了就让到「地址-端口」')
  const otherUser = upsertHost(otherPort.document, { address: '192.168.1.12', port: 22, user: 'deploy' })
  assert.equal(otherUser.replaced, false, '同一台机器上的另一个账号也是另一台')
  assert.equal(otherUser.host.id, '192.168.1.12-22')
  assert.equal(Object.keys(otherUser.document.hosts).length, 3, '三台各自有键，谁也没覆盖谁')
})

await test('upsertHost：id 只由地址派生（小写、非法字符换 -）', () => {
  const { host } = upsertHost(normalizeHostsDocument({ hosts: {} }), { address: 'Web.Example.COM', user: 'root' })
  assert.equal(host.id, 'web.example.com')
  const ipv6 = upsertHost(normalizeHostsDocument({ hosts: {} }), { address: 'fe80::1', user: 'root' })
  assert.match(ipv6.host.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, '清洗后的 id 必须满足 hosts.json 的 id 规则')
})

await test('upsertHost：空地址 / 空用户名 / 非法端口都抛错', () => {
  const base = normalizeHostsDocument({ hosts: {} })
  assert.match(caught(() => upsertHost({ ...base }, { ...WEB1, address: '  ' })).message, /address/)
  assert.match(caught(() => upsertHost({ ...base }, { ...WEB1, user: ' ' })).message, /user/)
  assert.match(caught(() => upsertHost({ ...base }, { ...WEB1, port: 70000 })).message, /port/)
})

await test('工具 schema：动作只剩 list，描述里写明维护在设置页（B-47）', async () => {
  const env = await setup()
  const properties = env.tool.parameters.properties
  assert.deepEqual(properties.action.enum, ['list'], '会话侧只剩只读 list')
  // 旧动作的参数一个都不许留：模型传了也没地方用，还会误以为能维护
  for (const key of ['id', 'address', 'port', 'user', 'label', 'tags']) {
    assert.equal(Object.hasOwn(properties, key), false, `${key} 参数应随动作一起删除`)
  }
  assert.match(env.tool.description, /设置页/, '工具描述要点明维护入口在设置页')
  assert.match(env.tool.description, /只读/, '工具描述要点明只读')
  assert.match(env.tool.description, /没有任何卡片/, '会话侧不再弹维护卡')
})

await test('旧动作已删：add_host / set_label / remove_host / set_password 都只得到「不认识的 action」，且不写盘', async () => {
  const env = await setup({ hosts: { '192.168.1.11': WEB1 } })
  const before = readFileSync(env.paths.hostsJson, 'utf8')
  for (const action of ['add_host', 'set_label', 'remove_host', 'set_password']) {
    const result = await env.tool.execute({ action, id: '192.168.1.11' }, {})
    assert.equal(result.ok, false, `${action} 必须被拒`)
    assert.match(result.message, /不认识的 action/, `${action} 的报错要说明动作不存在`)
    assert.match(result.message, /只剩 list/, '报错要指出只剩 list，免得模型反复试')
  }
  assert.equal(readFileSync(env.paths.hostsJson, 'utf8'), before, '旧动作一个字节都不许写')
  assert.equal(env.store.vault.count(), 0, '也不许往 vault 写密码')
})

await test('list：列出主机、凭据状态与 WSL 发行版', async () => {
  const env = await setup({
    hosts: {
      '192.168.1.11': WEB1,
      '192.168.1.12': { address: '192.168.1.12', port: 2222, user: 'root', label: '主机B', via: { gatewayId: 'default', assetId: 'a1', accountAlias: 'root', accountUser: 'root' } },
    },
  })
  const result = await env.tool.execute({ action: 'list' }, {})
  const text = result.lines.join('\n')
  assert.equal(result.ok, true)
  assert.match(text, /192\.168\.1\.11 {2}deploy@192\.168\.1\.11:22/)
  assert.match(text, /主机B/)
  assert.match(text, /无密码/, '直连但没存密码的主机要标出来')
  assert.match(text, /凭据已接入/, '接入点导入的主机标「凭据已接入」')
})

await test('未知 action 变成 ok:false 而不是抛给宿主', async () => {
  const env = await setup()
  const unknown = await env.tool.execute({ action: 'nuke' }, {})
  assert.equal(unknown.ok, false)
  assert.match(unknown.message, /不认识的 action「nuke」/)
})

console.log(`\n结果：全部通过（${passed} 项）`)
