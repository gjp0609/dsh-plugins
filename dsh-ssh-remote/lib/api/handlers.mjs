/**
 * 维护接口的主机动作：清单、增改、删除、改备注、真连一次。
 *
 * 三条边界（与 `lib/admin.mjs` 的会话入口同一套规则，只是入口换成浏览器）：
 * - **写盘只有一条路**：`store.updateHosts()`（读-改-写 + 原子替换 + 重载，串行化）；
 *   这里不直接写 `hosts.json`，否则和文件监听会互相触发回环；
 * - **密码只在内存里过一手**：从请求体直接进 vault（DPAPI 密文），不写日志、不进返回值、
 *   不进错误文本；响应里只有 `passwordSaved: true` 这种布尔；
 * - **复用既有纯函数**：`upsertHost` / `setHostLabel`。判重、备注退回地址、导入主机的
 *   来源标记这些规则都在原处，这里不复制。
 *
 * 接入点那一半在 `gateway.mjs`；两者由 `createApiHandlers()` 合成一张表。
 */
import { setHostLabel, upsertHost } from '../admin.mjs'
import { DEFAULT_PORT, hostIdentity } from '../hosts.mjs'
import { createApi } from '../jms/api.mjs'
import { ApiInputError } from './routes.mjs'
import {
  clearCooldown,
  closeHost,
  connectionsOf,
  hostView,
  parsePort,
  parseTags,
  say,
  text,
  viewOf,
} from './shared.mjs'
import { createGatewayHandlers } from './gateway.mjs'

/**
 * @param store - StateStore（hosts / config / vault 的唯一来源与唯一写入口）
 * @param pool - 连接池（列表里的连接状态、改完关旧连接、`hosts/test` 真连一次）
 */
export function createHostHandlers({ store, pool }) {
  return {
    /** 主机清单 + 当前设置。已连接的判断来自连接池（`ready` 才算）。 */
    async 'hosts/list'() {
      await store.ensureLoaded()
      const connections = new Map(connectionsOf(pool).map((entry) => [entry.hostId, entry]))
      return {
        hosts: Object.values(store.hosts).map((host) => hostView(host, connections.get(host.id))),
        config: { ...store.settings },
      }
    },

    /**
     * 新增或更新一台主机。
     *
     * - 不带 `id`：走 `upsertHost` 的既有判重（地址+端口+用户名 命中＝更新那条，id 不变）；
     * - 带 `id`：改这一条（设置页的编辑态）。改了地址/端口/用户名时**必须同时给新密码**，
     *   否则旧密码的绑定对不上，那台机器会变成「连不上」；经接入点导入的主机不允许改身份
     *   （改了就指向另一台资产），只能删了重导。
     * - `password` 有值才写 vault；返回里只有 `passwordSaved`，没有密码本身。
     */
    async 'hosts/save'(body) {
      await store.ensureLoaded()
      const address = text(body?.address)
      if (address === '') throw new ApiInputError('address 不能为空')
      const user = text(body?.user)
      if (user === '') throw new ApiInputError('user 不能为空')
      const port = parsePort(body?.port, DEFAULT_PORT)
      const label = text(body?.label)
      const tags = parseTags(body?.tags)
      const password = typeof body?.password === 'string' ? body.password : ''
      const id = text(body?.id)

      let saved
      await store.updateHosts(async (document) => {
        if (id !== '') {
          const existing = document.hosts[id]
          if (existing === undefined) throw new ApiInputError(`没有配置主机「${id}」`)
          const identityChanged = hostIdentity(existing) !== hostIdentity({ address, port, user })
          if (identityChanged && existing.via !== undefined) {
            throw new ApiInputError(
              `主机「${id}」是经接入点导入的，改地址 / 端口 / 用户名会指向另一台资产：请先 remove 再重新 import`,
            )
          }
          if (identityChanged && password === '') {
            throw new ApiInputError(
              `主机「${id}」改了地址 / 端口 / 用户名，必须同时重填密码（旧密码绑定的是原来的地址）`,
            )
          }
          const updated = {
            ...existing,
            address,
            port,
            user,
            label: label === '' ? address : label,
            tags: tags ?? existing.tags,
          }
          // 先写密码库、再落 hosts.json（与 `ssh_admin` 同序）：反过来一旦 vault 写失败，
          // 就会留下一个「改了地址却没有可用密码」的主机。
          if (password !== '') await store.vault.setPassword(id, updated, password)
          saved = { host: updated, created: false, identityChanged }
          return { ...document, hosts: { ...document.hosts, [id]: updated } }
        }

        let result
        try {
          result = upsertHost(document, { address, port, user, label, tags })
        } catch (error) {
          throw new ApiInputError(say(error))
        }
        if (!result.replaced && password === '') {
          throw new ApiInputError('新增主机的密码不能为空')
        }
        if (password !== '') await store.vault.setPassword(result.host.id, result.host, password)
        saved = { host: result.host, created: !result.replaced, identityChanged: false }
        return result.document
      })

      if (saved.identityChanged) {
        closeHost(pool, saved.host.id)
        clearCooldown(pool, saved.host.id)
      } else if (password !== '') {
        clearCooldown(pool, saved.host.id)
      }
      return {
        host: viewOf(pool, saved.host),
        created: saved.created,
        passwordSaved: password !== '',
      }
    },

    /** 删一台主机（连同它的密码与连接）。界面自己负责确认；这里不弹卡。 */
    async 'hosts/remove'(body) {
      await store.ensureLoaded()
      const id = text(body?.id)
      if (id === '') throw new ApiInputError('id 不能为空')
      await store.updateHosts((document) => {
        if (document.hosts[id] === undefined) throw new ApiInputError(`没有配置主机「${id}」`)
        const hosts = { ...document.hosts }
        delete hosts[id]
        return { ...document, hosts }
      })
      await store.vault.remove(id)
      closeHost(pool, id)
      clearCooldown(pool, id)
      return { removed: true }
    },

    /** 只改备注；留空退回地址（规则在 `setHostLabel` 里，这里不复制）。 */
    async 'hosts/label'(body) {
      await store.ensureLoaded()
      const id = text(body?.id)
      if (id === '') throw new ApiInputError('id 不能为空')
      let saved
      await store.updateHosts((document) => {
        let result
        try {
          result = setHostLabel(document, id, body?.label)
        } catch (error) {
          throw new ApiInputError(say(error))
        }
        saved = result.host
        return result.document
      })
      return { host: viewOf(pool, saved) }
    },

    /**
     * 真连一次（走现有池子：超时、认证、导入主机的换票都是同一条路径）。
     * 连不上不是接口错误——`ok: false` 才是结果，HTTP 仍然 200。
     */
    async 'hosts/test'(body, { signal } = {}) {
      await store.ensureLoaded()
      const id = text(body?.id)
      if (id === '') throw new ApiInputError('id 不能为空')
      const host = store.hosts[id]
      if (host === undefined) throw new ApiInputError(`没有配置主机「${id}」`)
      if (typeof pool?.connect !== 'function') throw new Error('连接池不可用，无法测试连接')

      const started = Date.now()
      try {
        await pool.connect(host, { signal })
        return { ok: true, ms: Date.now() - started }
      } catch (error) {
        return { ok: false, ms: Date.now() - started, error: say(error).slice(0, 300) }
      }
    },
  }
}

/**
 * 装配整张 handler 表（路由名 → 动作）；`createApiRoutes` 只认这张表。
 * @param createClientApi - 造接入点客户端；单测注入假实现，不发真请求
 */
export function createApiHandlers({ store, pool, createClientApi = createApi }) {
  return {
    ...createHostHandlers({ store, pool }),
    ...createGatewayHandlers({ store, pool, createClientApi }),
  }
}
