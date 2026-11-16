/**
 * 接入点的配置与密钥落点（多接入点，D-45）。
 *
 * | 值 | 落点 | 为什么 |
 * | :-- | :-- | :-- |
 * | 名称 / appid / 地址 / 接入端口 | 数据目录 `config.json` 的 `jms.gateways[]` | 明文、可手改、热加载；与超时那批设置同一个文件 |
 * | 密钥 | `vault.dat` 里一条**非主机**条目 `jms:<gatewayId>:secret` | 复用 DPAPI 那一套（不新建存储、不写明文） |
 *
 * 三条规则：
 * - **一个接入点一份密钥**：键里带 `gatewayId`，删掉一个接入点不会带走另一个的密钥；
 * - **密钥与配置绑定**：`addrHash(地址|接入端口|appid)`；改了地址/端口/appid 之后旧密钥会被拒绝，
 *   与「主机地址改过就不复用旧密码」是同一条规则——不让凭据被悄悄发到另一个接入点；
 * - **旧形态只读兼容、写时迁移**：`jms.address/appid/kokoPort` + vault 键 `jms:secret` 在读的时候
 *   换算成 id `default`、名称「默认」的那一个接入点；第一次写入时落成新形态，并把旧密钥迁到
 *   `jms:default:secret`（`migrateLegacyJmsSecret`，幂等）。
 */
import { addrHash } from '../hosts.mjs'
import { asString, readJsonFile, writeJsonAtomic } from '../util.mjs'
import { VaultError } from '../vault.mjs'

/** 首个（也是迁移出来的）接入点固定用这个 id：vault 键与 `via.gatewayId` 都按它写。 */
export const DEFAULT_GATEWAY_ID = 'default'
/** 迁移出来的接入点的名称。 */
export const DEFAULT_GATEWAY_LABEL = '默认'
/** 旧版本的单个接入点密钥键；只用于迁移与回读，新数据一律写 `jms:<id>:secret`。 */
export const LEGACY_SECRET_KEY = 'jms:secret'

/**
 * 接入端口的默认值（随配置存；地址里若带端口，那个端口是 Web 端口，不是它）。
 * 标准默认 **2222**：用户自己环境里改成了 52222，但那是环境差异，不能当默认值写死。
 */
export const DEFAULT_JMS_PORT = 2222

/** 内存里的空配置：一个接入点都没有。 */
export const DEFAULT_JMS = { gateways: [] }

/** 一个接入点的密钥在 vault 里的键（`:` 让它不可能是主机 id）。 */
export function jmsSecretKey(gatewayId) {
  return `jms:${String(gatewayId)}:secret`
}

/** 密钥与这个接入点当前配置的绑定哈希（改地址 / 接入端口 / appid 就作废旧密钥）。 */
export function jmsBindHash(gateway) {
  return addrHash({ address: gateway?.address, port: gateway?.port, user: gateway?.appid })
}

/** 按 id 找一个接入点。 */
export function gatewayById(jms, id) {
  const list = Array.isArray(jms?.gateways) ? jms.gateways : []
  const key = String(id ?? '')
  return list.find((gateway) => gateway.id === key)
}

/** 把一个接入点放进列表：同 id 就替换（保持原顺序），否则追加。 */
export function upsertGateway(gateways, gateway) {
  const list = Array.isArray(gateways) ? [...gateways] : []
  const index = list.findIndex((item) => item.id === gateway.id)
  if (index === -1) list.push(gateway)
  else list[index] = gateway
  return list
}

/**
 * 接入点 id：由地址派生（稳定、可读、能当 vault 键）。
 * 只在**新建**时调用——改地址不改 id，否则 `via.gatewayId` 与密钥键会一起漂。
 */
export function deriveGatewayId(gateways, address) {
  const list = Array.isArray(gateways) ? gateways : []
  const base =
    String(address ?? '')
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'gateway'
  let id = base
  let n = 2
  while (list.some((gateway) => gateway.id === id)) {
    id = `${base}-${n}`
    n += 1
  }
  return id
}

/**
 * 一个接入点的规范化：只认 `{ id, label, address, appid, port }`，非法值退回默认并记 warning。
 * 返回 `undefined` 表示这条不能用（整条丢掉，而不是把配置读成半截）。
 */
export function normalizeGateway(raw, warnings = []) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('config.json 的 jms.gateways 里有一条不是对象，已忽略')
    return undefined
  }
  const address = asString(raw.address) ?? ''
  const appid = asString(raw.appid) ?? ''
  const id = asString(raw.id) ?? deriveGatewayId([], address)
  if (id === '') return undefined

  let port = DEFAULT_JMS_PORT
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    const value = Number(raw.port)
    if (Number.isInteger(value) && value >= 1 && value <= 65535) port = value
    else warnings.push(`接入点「${id}」的 port=${JSON.stringify(raw.port)} 不合法，已用 ${DEFAULT_JMS_PORT}`)
  }
  const label = asString(raw.label) ?? address
  return { id, label, address, appid, port }
}

/**
 * `config.json` 的 `jms` 段 → 内存形态 `{ gateways: [...] }`。
 *
 * - 已经是新形态（有 `gateways` 数组）：逐条规范化，id 重复的丢掉并记 warning；
 * - 旧形态（顶层 `address` / `appid` / `kokoPort`）：换算成**一个** id `default`、名称「默认」的接入点；
 *   三个字段全空（老版本的空配置）则当作没有接入点；
 * - 其它形状：一条警告 + 空列表。
 */
export function normalizeJmsConfig(raw, warnings = []) {
  if (raw === null || raw === undefined) return { gateways: [] }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('config.json 的 jms 不是对象，已按「没有任何接入点」处理')
    return { gateways: [] }
  }

  if (Array.isArray(raw.gateways)) {
    const gateways = []
    const seen = new Set()
    for (const item of raw.gateways) {
      const gateway = normalizeGateway(item, warnings)
      if (gateway === undefined) continue
      if (seen.has(gateway.id)) {
        warnings.push(`config.json 里有两个接入点都用 id「${gateway.id}」，后一条已忽略`)
        continue
      }
      seen.add(gateway.id)
      gateways.push(gateway)
    }
    return { gateways }
  }

  // 旧形态：一个接入点。空配置（地址与 appid 都没有）视为「还没配」。
  const address = asString(raw.address) ?? ''
  const appid = asString(raw.appid) ?? ''
  if (address === '' && appid === '') return { gateways: [] }
  const legacy = normalizeGateway(
    { id: DEFAULT_GATEWAY_ID, label: DEFAULT_GATEWAY_LABEL, address, appid, port: raw.kokoPort },
    warnings,
  )
  return legacy === undefined ? { gateways: [] } : { gateways: [legacy] }
}

/** 读旧键里的密钥（只在 id 是 `default` 时看；绑定对不上就当没有，不抛错）。 */
function legacySecret(vault, gateway) {
  if (gateway?.id !== DEFAULT_GATEWAY_ID) return null
  try {
    return vault.credentialFor(LEGACY_SECRET_KEY, jmsBindHash(gateway))
  } catch {
    return null
  }
}

/**
 * 读密钥；没有或与当前配置不匹配都抛 `VaultError`（消息是给人看的中文说明）。
 * 只返回字符串，不打印、不写日志。
 */
export function readJmsSecret(vault, gateway) {
  const direct = vault.credentialFor(jmsSecretKey(gateway?.id), jmsBindHash(gateway))
  if (direct !== null) return direct
  const legacy = legacySecret(vault, gateway)
  if (legacy !== null) return legacy
  throw new VaultError(
    '还没有保存过密钥：到插件设置页「SSH 主机 → 接入点」里填一次密钥',
    'missing',
  )
}

/** 是否已有一份「与当前配置匹配」的密钥（用来决定卡片上密钥是否必填）。 */
export function hasJmsSecret(vault, gateway) {
  try {
    readJmsSecret(vault, gateway)
    return true
  } catch {
    return false
  }
}

/** 写密钥（只进密文）。 */
export async function saveJmsSecret(vault, gateway, secret) {
  await vault.setCredential(jmsSecretKey(gateway.id), jmsBindHash(gateway), secret)
}

/** 删掉一个接入点的密钥（连同旧键；接入点被删时调用）。 */
export async function removeJmsSecret(vault, gateway) {
  await vault.remove(jmsSecretKey(gateway?.id))
  if (gateway?.id === DEFAULT_GATEWAY_ID) await vault.remove(LEGACY_SECRET_KEY)
}

/**
 * 把旧单接入点的密钥迁到 `jms:default:secret`。
 *
 * 幂等：新键已经存在就什么都不做；旧键不在、或与迁移后的配置对不上（用户改过地址）也什么都不做——
 * 那种情况下旧密钥本来就已经作废。返回是否真的迁了一份，供日志/测试看。
 */
export async function migrateLegacyJmsSecret(vault, gateways) {
  const list = Array.isArray(gateways) ? gateways : []
  const target = list.find((gateway) => gateway.id === DEFAULT_GATEWAY_ID)
  if (target === undefined) return false
  const key = jmsSecretKey(target.id)
  if (vault.has(key)) return false
  const legacy = legacySecret(vault, target)
  if (legacy === null) return false
  await vault.setCredential(key, jmsBindHash(target), legacy)
  await vault.remove(LEGACY_SECRET_KEY)
  return true
}

/**
 * 一个接入点的对外视图：**永远不返回密钥**，只回答 `hasSecret` / `configured`。
 * `configured` = 地址与 appid 都有、且有一份能用的密钥（能真的拉资产）。
 */
export function gatewayView(gateway, vault) {
  const address = String(gateway?.address ?? '')
  const appid = String(gateway?.appid ?? '')
  let hasSecret = false
  try {
    hasSecret = hasJmsSecret(vault, gateway)
  } catch {
    hasSecret = false
  }
  return {
    id: String(gateway?.id ?? ''),
    label: String(gateway?.label ?? ''),
    address,
    appid,
    port: Number(gateway?.port ?? DEFAULT_JMS_PORT),
    hasSecret,
    configured: address !== '' && appid !== '' && hasSecret,
  }
}

/**
 * 把 `jms` 段写进 config.json：**保留文件里其它内容**（设置项、`_说明`），
 * 只覆盖 `jms`——否则一次接入会把用户调过的超时/host 默认值冲掉。
 * 写出去的一定是新形态（`gateways` 数组），旧形态靠这一次写入顺手迁掉。
 */
export function writeJmsConfig(path, jms) {
  const { found, value } = readJsonFile(path)
  const current = found && value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const list = Array.isArray(jms?.gateways) ? jms.gateways : []
  writeJsonAtomic(path, {
    ...current,
    jms: {
      gateways: list.map((gateway) => ({
        id: gateway.id,
        label: gateway.label,
        address: gateway.address,
        appid: gateway.appid,
        port: gateway.port,
      })),
    },
  })
}
