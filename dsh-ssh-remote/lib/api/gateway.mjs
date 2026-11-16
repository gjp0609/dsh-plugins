/**
 * 维护接口的接入点动作：列表、保存、删除、资产清单、批量导入。
 *
 * 四条边界：
 * - **对外不出现产品名**：路径与文案统一叫「接入点」（`gateway/...`）。来源系统的名字
 *   不进列表、不进错误、不进界面文案——导入后的主机与直连主机外部同构（D-40）；
 * - **密钥不回声**：`secret` 从请求体直接进 vault（`jms:<gatewayId>:secret`，DPAPI 密文），
 *   列表里只回答 `hasSecret`；改了地址 / appid / 接入端口之后旧密钥的绑定对不上，
 *   状态自动变成未配置（不许把旧密钥悄悄发给另一个接入点）；
 * - **一个接入点一份密钥**：`gateway/save` 带 `id` 就改那一个（id 不变），不带就是新建
 *   （id 由地址派生、撞名自动加序号）；删除只删这一个的配置与密钥；
 * - **一个账号一行**：一台资产可以有多个受管账号，连接凭据按账号别名签发，所以
 *   「资产 × 账号」才是可导入的单位（D-47）；这里只负责「取资产、取账号、写回、关旧连接」，
 *   判重与备注全在 `applyAssetImports` 里。
 */
import {
  DEFAULT_JMS_PORT,
  deriveGatewayId,
  gatewayById,
  gatewayView,
  readJmsSecret,
  removeJmsSecret,
  saveJmsSecret,
} from '../jms/config.mjs'
import { parseBaseAddress } from '../jms/api.mjs'
import { accountKey, applyAssetImports, importedAccountKeys } from '../jms/hosts.mjs'
import { ApiInputError } from './routes.mjs'
import { closeHost, clearCooldown, parsePort, say, text, upstream } from './shared.mjs'
import { mapLimited } from '../util.mjs'

/** 拉资产账号时的并发度：一次一台太慢，几十台齐发又是在打接入点。 */
const ACCOUNT_FETCH_LIMIT = 4

/** 错误与列表里指代一个接入点：优先说人给的名字，没有才退回 id。 */
const nameOf = (gateway) => String(gateway?.label ?? '').trim() || String(gateway?.id ?? '')

/**
 * @param store - StateStore（`store.jms.gateways` 是接入点列表，密钥在 `store.vault`）
 * @param pool - 连接池（导入后把旧连接废掉）
 * @param createClientApi - 造接入点客户端；单测注入假实现，不发真请求
 */
export function createGatewayHandlers({ store, pool, createClientApi }) {
  /** 现查一个接入点：不存在就是 400（先让用户刷新，而不是发一个必然失败的请求）。 */
  function requireGateway(id) {
    const key = text(id)
    if (key === '') throw new ApiInputError('id 不能为空')
    const gateway = gatewayById(store.jms, key)
    if (gateway === undefined) throw new ApiInputError(`没有这个接入点「${key}」（可能已经被删掉了）`)
    return gateway
  }

  /** 接入点 + 密钥 → 客户端；没配全就是 400。 */
  function gatewayClient(gateway, signal) {
    if (text(gateway.address) === '' || text(gateway.appid) === '') {
      throw new ApiInputError(`接入点「${nameOf(gateway)}」还没填地址与 appid`)
    }
    let secret
    try {
      secret = readJmsSecret(store.vault, gateway)
    } catch {
      throw new ApiInputError(
        `接入点「${nameOf(gateway)}」的密钥不可用（没保存过，或与当前地址 / appid 不匹配）：请重新填写一次密钥`,
      )
    }
    try {
      return createClientApi({ config: gateway, secret, timeoutMs: store.settings.connectTimeoutMs, signal })
    } catch (error) {
      throw new ApiInputError(say(error))
    }
  }

  /** 写回整个列表（唯一入口：串行化 + 原子替换 + 顺手迁移旧密钥）。 */
  async function saveList(gateways) {
    await store.saveJmsConfig({ gateways })
    return gateways
  }

  return {
    /** 接入点列表（**永远不返回密钥**，每个只回答 `hasSecret` / `configured`）。 */
    async 'gateway/list'() {
      await store.ensureLoaded()
      const list = Array.isArray(store.jms?.gateways) ? store.jms.gateways : []
      return { gateways: list.map((gateway) => gatewayView(gateway, store.vault)) }
    },

    /**
     * 保存一个接入点：带 `id` 改那一个（id 不变），不带 `id` 新建一个（id 由地址派生）。
     * `secret` 有值才写 vault（键 `jms:<id>:secret`），留空＝不改密钥。
     * 留空但地址或 appid 变了时，旧密钥会因绑定不匹配而失效（列表里显示未配置）——这是有意的。
     */
    async 'gateway/save'(body) {
      await store.ensureLoaded()
      const id = text(body?.id)
      const address = text(body?.address)
      if (address === '') throw new ApiInputError('address 不能为空')
      const appid = text(body?.appid)
      if (appid === '') throw new ApiInputError('appid 不能为空')
      const port = parsePort(body?.port, DEFAULT_JMS_PORT)
      try {
        parseBaseAddress(address)
      } catch (error) {
        throw new ApiInputError(say(error))
      }
      const secret = typeof body?.secret === 'string' ? body.secret : ''
      const labelInput = text(body?.label)

      const list = [...(Array.isArray(store.jms?.gateways) ? store.jms.gateways : [])]
      let gateway
      let created = false
      if (id === '') {
        gateway = {
          id: deriveGatewayId(list, address),
          label: labelInput === '' ? address : labelInput,
          address,
          appid,
          port,
        }
        list.push(gateway)
        created = true
      } else {
        const index = list.findIndex((item) => item.id === id)
        if (index === -1) throw new ApiInputError(`没有这个接入点「${id}」（可能已经被删掉了）`)
        gateway = { ...list[index], address, appid, port, label: labelInput === '' ? address : labelInput }
        list[index] = gateway
      }

      // 先写密钥、再写配置（导入也走这个顺序）：密钥绑定的是新配置，反过来会留下一份
      // 绑不上新配置的密钥。
      if (secret !== '') await saveJmsSecret(store.vault, gateway, secret)
      await saveList(list)
      return { gateway: gatewayView(gateway, store.vault), created, passwordSaved: secret !== '' }
    },

    /**
     * 删掉一个接入点（配置 + 它的那一份密钥）。
     *
     * **从它导入的主机保留**：那是用户的机器清单，删配置不该顺手删主机；连接时
     * `jms/remote.mjs` 会报「接入点已被删除」。已建立的连接也不主动断开（还开着的工作不该被打断）。
     */
    async 'gateway/remove'(body) {
      await store.ensureLoaded()
      const gateway = requireGateway(body?.id)
      const kept = Object.values(store.hosts ?? {}).filter(
        (host) => host?.via !== undefined && host.via !== null && String(host.via.gatewayId ?? 'default') === gateway.id,
      )
      await removeJmsSecret(store.vault, gateway)
      await saveList((store.jms?.gateways ?? []).filter((item) => item.id !== gateway.id))
      return { removed: true, id: gateway.id, hostsKept: kept.length }
    },

    /**
     * 这台接入点的 appid 能看到的资产，**每个受管账号一行**。
     *
     * 一台资产常有多个账号（真机：`example` 在、`root` 也在），连接凭据必须按账号别名签发，
     * 所以「资产 × 账号」才是可勾选的单位；台数不是行数（D-47）。
     *
     * 每行 `{ assetId, name, address, account: { alias, username }, imported }`：
     * - `imported` 按 **(assetId + accountAlias)** 判定——同一台资产的两个账号各自独立；
     * - 这台资产没有可用账号（或账号读失败）时仍出一行、`account: null`：界面要能说明
     *   「这台看得见但导不了」，而不是让它凭空消失。
     */
    async 'gateway/assets'(body, { signal } = {}) {
      await store.ensureLoaded()
      const gateway = requireGateway(body?.gatewayId)
      const api = gatewayClient(gateway, signal)
      const listed = await upstream(() => api.listAssets())
      const imported = importedAccountKeys(store.hosts, gateway.id)
      // 逐台取账号：一台一台问太慢，几十台齐发又是在打接入点。
      const accountsOf = await mapLimited(listed.assets, ACCOUNT_FETCH_LIMIT, async (asset) => {
        try {
          return await api.assetAccounts(asset.id)
        } catch {
          return []
        }
      })

      const rows = []
      for (const [index, asset] of listed.assets.entries()) {
        const accounts = accountsOf[index] ?? []
        const head = { assetId: String(asset.id), name: asset.name, address: asset.address }
        if (accounts.length === 0) {
          rows.push({ ...head, account: null, imported: false })
          continue
        }
        for (const account of accounts) {
          rows.push({
            ...head,
            account: { alias: String(account.alias ?? ''), username: String(account.username ?? '') },
            imported: imported.has(accountKey(asset.id, account.alias)),
          })
        }
      }
      return { gatewayId: gateway.id, assets: rows, skipped: listed.skipped ?? 0 }
    },

    /**
     * 批量导入：`gatewayId` + `items: [{ assetId, account }]`（`account` 是账号别名，签令牌要用它）。
     *
     * 逐项取账号（找不到 / 取不到的进 `skipped`，不因为一项失败就整批不导），然后整批走
     * `applyAssetImports` 一次写回：`created` 区分「新增」与「更新已导入的那条」。
     * 同一台资产的两个账号导入后是两台主机（身份是 `地址|端口|用户名`）。
     */
    async 'gateway/import'(body, { signal } = {}) {
      await store.ensureLoaded()
      const gateway = requireGateway(body?.gatewayId)
      const requested = Array.isArray(body?.items) ? body.items : []
      const wanted = []
      for (const item of requested) {
        const assetId = text(item?.assetId)
        const alias = text(item?.account)
        if (assetId === '' || alias === '') {
          throw new ApiInputError('items 里每一项都要有 assetId 与 account（账号别名）')
        }
        wanted.push({ assetId, alias })
      }
      if (wanted.length === 0) throw new ApiInputError('items 不能为空（要导入的「资产 + 账号」数组）')

      // 同一项点两次（或界面上重复勾）只导一次。
      const seen = new Set()
      const unique = wanted.filter((item) => {
        const key = accountKey(item.assetId, item.alias)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const api = gatewayClient(gateway, signal)
      const listed = await upstream(() => api.listAssets())
      const byId = new Map(listed.assets.map((asset) => [String(asset.id), asset]))

      const items = []
      const skipped = []
      const cache = new Map()
      for (const want of unique) {
        const asset = byId.get(want.assetId)
        if (asset === undefined) {
          skipped.push({ assetId: want.assetId, account: want.alias, reason: '这次的资产清单里没有它（可能已经没有权限）' })
          continue
        }
        let accounts
        try {
          if (!cache.has(want.assetId)) cache.set(want.assetId, await api.assetAccounts(want.assetId))
          accounts = cache.get(want.assetId)
        } catch (error) {
          skipped.push({ assetId: want.assetId, account: want.alias, reason: say(error) })
          continue
        }
        const account = accounts.find((candidate) => String(candidate.alias ?? '') === want.alias)
        if (account === undefined) {
          skipped.push({
            assetId: want.assetId,
            account: want.alias,
            reason: accounts.length === 0 ? '这台资产没有可用账号' : '这个账号已经不在资产上了（可能被撤销）',
          })
          continue
        }
        items.push({ asset, account, accountCount: accounts.length })
      }
      if (items.length === 0) return { gatewayId: gateway.id, imported: [], skipped }

      let outcome
      await store.updateHosts((document) => {
        outcome = applyAssetImports(document, items, { gatewayId: gateway.id })
        return outcome.document
      })

      const created = new Set(outcome.added.map((host) => host.id))
      for (const host of [...outcome.added, ...outcome.updated]) {
        closeHost(pool, host.id)
        clearCooldown(pool, host.id)
      }
      return {
        gatewayId: gateway.id,
        imported: [...outcome.added, ...outcome.updated].map((host) => ({
          id: host.id,
          address: host.address,
          user: host.user,
          account: String(host.via?.accountAlias ?? ''),
          created: created.has(host.id),
        })),
        skipped,
      }
    },
  }
}
