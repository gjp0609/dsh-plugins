/**
 * 导入主机这一层：表单字段、多选卡的行、以及「资产 + 账号 → hosts.json 条目」。
 *
 * 四条与需求对齐的硬约束：
 * - **一个账号一台主机**：一台资产常常有多个受管账号（真机：`example` 有、`root` 没有），
 *   连接凭据必须按账号别名签发，所以「资产 × 账号」才是可导入的单位，一个账号一行；
 * - **外部同构**：导入出来的条目与普通主机是同一个形状（`address/port/user/label/tags`），
 *   多的只是一段内部标记 `via`（接入点 id、资产 id、账号 alias、账号 username）。列表、卡片、错误信息里
 *   一律不出现来源系统的任何名字——唯一能看出差别的是「凭据已接入」这种中性话；
 * - **id 用资产 IP**：既能当存储键又短；被占用时交给 `suggestHostId` 让到 `IP-22`、`IP-22-2`
 *   （需求里写的是 `jms-<ip>`，那会把产品名漏到 `ssh_admin list` 与错误信息里，按「不许出现
 *   产品名」的硬要求改成中性后缀，见 DECISIONS）；
 * - **判重口径不动**：仍然是 `地址|端口|用户名`。同一台机器 + 同一个账号再导一次＝更新
 *   那条（id 不变、标签跟着资产名刷新），不会多出一条；同一台机器的两个账号用户名不同，
 *   天然就是两台主机。同身份的**直连**条目真实环境里不存在（导入的主机不会有同身份的直连记录），
 *   万一出现只让路新增，绝不改写那一台。
 */
import { DEFAULT_PORT, findHostByIdentity, suggestHostId, viaGatewayId } from '../hosts.mjs'
import { DEFAULT_JMS_PORT } from './config.mjs'

/** 是不是「经接入点导入」的主机（`via` 是唯一内部标记）。 */
export function isJmsHost(host) {
  return host !== undefined && host !== null && host.via !== undefined && host.via !== null
}

/**
 * 「资产 × 账号」的键：判定「这个账号导没导过」用。
 *
 * 不能用资产 id 单独判：同一台资产的两个账号各自独立（导了 `example` 不代表 `root` 也导了）。
 * 分隔符用 `|`——资产 id 与账号别名都是服务端给的不透明串，不会含它。
 */
export function accountKey(assetId, alias) {
  return `${String(assetId ?? '')}|${String(alias ?? '')}`
}

/**
 * 某个接入点已经导入过哪些「资产 × 账号」（键见 `accountKey`）。
 *
 * 按接入点分开数：两个接入点各有各的资产清单，资产 id 只在同一台接入点内唯一。
 * 不传 `gatewayId` 时数全部。
 */
export function importedAccountKeys(hosts, gatewayId) {
  const keys = new Set()
  const scope = typeof gatewayId === 'string' && gatewayId !== '' ? gatewayId : null
  for (const host of Object.values(hosts ?? {})) {
    if (!isJmsHost(host)) continue
    if (scope !== null && viaGatewayId(host) !== scope) continue
    keys.add(accountKey(host.via.assetId, host.via.accountAlias))
  }
  return keys
}

/**
 * 某个接入点已经导入过哪些资产（不看账号）。
 *
 * 只用于「这台资产至少导过一个账号」这种粗判断；账号级的已导入状态用
 * `importedAccountKeys`（D-47）。
 */
export function importedAssetIds(hosts, gatewayId) {
  const ids = new Set()
  const scope = typeof gatewayId === 'string' && gatewayId !== '' ? gatewayId : null
  for (const host of Object.values(hosts ?? {})) {
    if (!isJmsHost(host)) continue
    if (scope !== null && viaGatewayId(host) !== scope) continue
    ids.add(String(host.via.assetId))
  }
  return ids
}


/**
 * 把「资产 + 账号」写进 hosts 文档（纯逻辑，不动磁盘）。
 *
 * 判重（`地址|端口|用户名`，与 `hostIdentity` 同一口径）只有两种结果：
 * - **同身份 + 同一个接入点 + 已经是导入的条目 + 同一个账号**（有 `via`）→ 更新那一条：
 *   id 不变，备注与账号跟进；
 * - **同身份却是直连条目**（真实环境里不会出现：导入的主机不会同时有一条同身份的直连记录），
 *   **同身份但来自另一个接入点**，或**同一台资产的不同账号恰好同名用户**（极少见） → 只**让路**：
 *   用 `suggestHostId` 另起一个新 id 新增，那一台一个字都不改。不接管、不补 `via`：
 *   那等于悄悄改写用户的凭据归属。
 *
 * @param document - `{ hosts, wsl, defaults }`
 * @param items - `[{ asset: { id, name, address }, account: { alias, username }, accountCount? }]`
 *   `accountCount` 是这台资产总共几个可用账号，用来决定备注（多账号时带上用户名，免得两台同名）
 * @param options.gatewayId - 这批资产来自哪个接入点（写进 `via.gatewayId`；缺省为首个接入点）
 * @returns `{ document, added, updated }`（后两个都是 host 对象数组，供结果行使用）
 */
export function applyAssetImports(document, items, { gatewayId = 'default' } = {}) {
  const hosts = { ...(document?.hosts ?? {}) }
  const added = []
  const updated = []
  const gateway = String(gatewayId ?? '') === '' ? 'default' : String(gatewayId)

  for (const item of items ?? []) {
    const address = String(item?.asset?.address ?? '').trim()
    const user = String(item?.account?.username ?? '').trim()
    const alias = String(item?.account?.alias ?? '').trim()
    const assetId = item?.asset?.id === undefined || item?.asset?.id === null ? '' : String(item.asset.id)
    if (address === '' || user === '' || alias === '' || assetId === '') continue

    const existing = findHostByIdentity({ hosts }, { address, port: DEFAULT_PORT, user })
    // 只有「同身份 + 同一个接入点 + 同一个账号 + 已是导入条目」才复用它：
    // - 同身份直连条目不算可复用（让路新增，见上）；
    // - 同身份但来自**另一个**接入点的条目也不算：那台机器的凭据绑在另一个接入点上，
    //   改写 `via.gatewayId` 等于把它的凭据换掉（D-45）；
    // - 同接入点但**账号不同**（`via.accountAlias` 对不上，只有两个账号撞了同名用户才会出现）
    //   也算让路：改它等于把 `root` 那台的凭据写成 `example` 的（D-47）。
    const reuse =
      existing !== undefined &&
      isJmsHost(existing) &&
      viaGatewayId(existing) === gateway &&
      String(existing.via.assetId) === assetId &&
      String(existing.via.accountAlias) === alias
        ? existing
        : undefined
    const id = reuse?.id ?? suggestHostId({ hosts }, { address, port: DEFAULT_PORT })
    // 备注（label）默认是资产名——**资产名等于地址或缺省时退回地址**：
    // 很多资产的名称本来就是 IP，`label` 再存一份同样的串只会在 `地址:22 · 备注` 里重复一次。
    // 一台资产有多个账号时加上用户名：否则两台主机同名，`ssh_admin list` 与审批卡上分不清谁是谁。
    // 备注之后可以在插件设置页「SSH 主机」里改。
    const assetName = String(item.asset.name ?? '').trim()
    const base = assetName === '' || assetName.toLowerCase() === address.toLowerCase() ? address : assetName
    const accounts = Number(item?.accountCount)
    const label = Number.isInteger(accounts) && accounts > 1 ? `${base} · ${user}` : base
    const host = {
      id,
      kind: 'remote',
      address,
      port: DEFAULT_PORT,
      user,
      label,
      tags: reuse?.tags ?? [],
      via: { gatewayId: gateway, assetId, accountAlias: alias, accountUser: user },
    }
    hosts[id] = host
    if (reuse === undefined) {
      added.push(host)
      continue
    }
    updated.push(host)
  }

  return { document: { ...document, hosts }, added, updated }
}
