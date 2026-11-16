/**
 * hosts.json 的解析与校验。
 *
 * 原则：**元数据永远明文**（地址、端口、用户名、标签），密码只在 vault.dat 里。
 * 校验失败不抛整体错误，而是跳过该条并累积 warning——一个手滑的条目不该让所有主机不可用。
 */
import { asArray, asString, sha256Hex } from './util.mjs'

/** 主机 id：字母数字开头，允许 `. _ -`，最长 64。会进工具参数与卡片，所以限制得死一点。 */
export const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export const DEFAULT_PORT = 22

/** hosts.json 里 `defaults` 允许覆盖的字段（与 config.json 同名，后者优先级更高）。 */
export const HOST_DEFAULTS = {
  connectTimeoutMs: 15000,
  stepTimeoutMs: 30000,
  idleTimeoutMs: 600000,
  maxConnections: 10,
}

/**
 * 密码与主机的绑定哈希：`sha256(address|port|user)`。
 * 连接前比对，防止「改了地址/用户名之后旧密码被发给另一台机器」。
 */
export function addrHash(host) {
  const address = String(host?.address ?? '').trim()
  const port = Number.isInteger(host?.port) ? host.port : DEFAULT_PORT
  const user = String(host?.user ?? '').trim()
  return sha256Hex(`${address}|${port}|${user}`)
}

/**
 * 「是不是同一台」的判据：`地址|端口|用户名`（与 `addrHash` 同一个口径，D-38）。
 *
 * 判重只用这个三元组，不看 id：id 只是 hosts.json 的存储键，改简称、重建 id 都不该
 * 让用户以为「又加了一台」。反过来，只差端口或只差用户名就是另一台机器——同一台地址上
 * 跑两个 sshd、或同一台机器上的两个账号，密码与连接都不同，合并会让其中一台的密码被覆盖。
 */
export function hostIdentity(host) {
  const address = String(host?.address ?? '').trim()
  const port = Number.isInteger(host?.port) ? host.port : DEFAULT_PORT
  const user = String(host?.user ?? '').trim()
  return `${address}|${port}|${user}`
}

/** 按三元组找已有主机（没有就返回 `undefined`）。 */
export function findHostByIdentity(document, host) {
  const wanted = hostIdentity(host)
  return Object.values(document?.hosts ?? {}).find((item) => hostIdentity(item) === wanted)
}

/**
 * 新增主机时生成一个短 id（存储键）：默认就是地址本身（`192.168.1.12` 这种最好像）。
 *
 * 被占用了才退到 `地址-端口`、`地址-端口-2`……：同一个地址上第二台机器（只差端口）必须
 * 有自己的键，而 id 会进 `ssh_run` 的 `hosts` 参数，越短越好记。
 * 只做「能当 id 用」的清洗（小写、非法字符换 `-`），不猜业务含义。
 */
export function suggestHostId(document, { address, port = DEFAULT_PORT } = {}) {
  const hosts = document?.hosts ?? {}
  const seed = String(address ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 56)
  const base = seed === '' ? 'host' : seed
  if (hosts[base] === undefined) return base
  const withPort = `${base}-${port}`
  if (hosts[withPort] === undefined) return withPort
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${withPort}-${index}`
    if (hosts[candidate] === undefined) return candidate
  }
  throw new Error(`地址「${address}」已经用满 id（${withPort}-2…），请先到插件设置页「SSH 主机」里删掉不再用的条目`)
}

function clampPositiveInt(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  const rounded = Math.round(number)
  return rounded > 0 ? rounded : fallback
}

/** `hosts.defaults`：只认认识的字段，非法值退回内置默认。 */
export function normalizeHostDefaults(raw, warnings = []) {
  const result = { ...HOST_DEFAULTS }
  if (raw === null || typeof raw !== 'object') return result
  for (const key of Object.keys(HOST_DEFAULTS)) {
    if (raw[key] === undefined) continue
    const next = clampPositiveInt(raw[key], HOST_DEFAULTS[key])
    if (next !== Number(raw[key])) warnings.push(`defaults.${key} 不是正整数，已用 ${next}`)
    result[key] = next
  }
  return result
}

/**
 * 解析整份 hosts.json。
 * @returns `{ hosts, wsl, defaults, warnings }`；hosts 以 id 为键，wsl 以发行版名为键。
 */
export function normalizeHostsDocument(raw, { warnings = [] } = {}) {
  const doc = raw !== null && typeof raw === 'object' ? raw : {}
  const hosts = {}

  const rawHosts = doc.hosts !== null && typeof doc.hosts === 'object' ? doc.hosts : {}
  for (const [id, entry] of Object.entries(rawHosts)) {
    if (!HOST_ID_RE.test(id)) {
      warnings.push(`主机 id「${id}」不合法（字母数字开头，只允许 . _ -，最长 64），已跳过`)
      continue
    }
    if (entry === null || typeof entry !== 'object') {
      warnings.push(`主机「${id}」不是对象，已跳过`)
      continue
    }
    const address = asString(entry.address)
    const user = asString(entry.user)
    if (address === undefined || user === undefined) {
      warnings.push(`主机「${id}」缺 address 或 user，已跳过`)
      continue
    }
    const port = entry.port === undefined ? DEFAULT_PORT : Number(entry.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      warnings.push(`主机「${id}」端口「${entry.port}」不合法，已跳过`)
      continue
    }
    const via = normalizeHostSource(entry.via)
    if (entry.via !== undefined && via === undefined) {
      warnings.push(`主机「${id}」的来源标记不完整，已忽略（按普通主机连接）`)
    }
    hosts[id] = {
      id,
      kind: 'remote',
      address,
      port,
      user,
      label: asString(entry.label) ?? id,
      tags: asArray(entry.tags)
        .filter((tag) => typeof tag === 'string' && tag.trim() !== '')
        .map((tag) => tag.trim()),
      ...(via === undefined ? {} : { via }),
    }
  }

  const wsl = {}
  const rawWsl = doc.wsl !== null && typeof doc.wsl === 'object' ? doc.wsl : {}
  for (const [distro, entry] of Object.entries(rawWsl)) {
    if (distro.trim() === '' || /[\u0000-\u001f]/.test(distro)) {
      warnings.push(`WSL 发行版名「${distro}」不合法，已跳过`)
      continue
    }
    const spec = entry !== null && typeof entry === 'object' ? entry : {}
    wsl[distro] = {
      id: `wsl:${distro}`,
      kind: 'wsl',
      distro,
      label: asString(spec.label) ?? distro,
      user: asString(spec.user) ?? null,
    }
  }

  return { hosts, wsl, defaults: normalizeHostDefaults(doc.defaults, warnings), warnings }
}

/**
 * 把模型给的单个名字解析成目标描述：`web1` → 远程主机；`wsl:Debian` → WSL 发行版。
 * 找不到就抛错（错误信息里带上可用名字，方便模型自己纠正）。
 */
export function resolveTarget(name, { hosts, wsl }) {
  const raw = String(name ?? '').trim()
  if (raw === '') throw new Error('目标名不能为空')
  if (raw.toLowerCase().startsWith('wsl:')) {
    const distro = raw.slice(4).trim()
    const target = Object.values(wsl ?? {}).find((item) => item.distro.toLowerCase() === distro.toLowerCase())
    if (target === undefined) {
      const available = Object.keys(wsl ?? {})
      throw new Error(`没有配置 WSL 发行版「${distro}」${available.length === 0 ? '（hosts.json 里还没有 wsl 段）' : `，可用：${available.join('、')}`}`)
    }
    return target
  }
  const host = hosts?.[raw]
  if (host === undefined) {
    const available = Object.keys(hosts ?? {})
    throw new Error(`没有配置主机「${raw}」${available.length === 0 ? '（hosts.json 里还没有 hosts 段）' : `，可用：${available.join('、')}`}`)
  }
  return host
}

/**
 * 卡片的、错误信息里用的短标签（别名）。
 *
 * B-22：非 WSL 一律写成 `地址:端口 · 别名`。只写别名时，几台同型号测试机在卡上长得一模一样，
 * 分不清要勾的是哪台；地址是唯一能定位到机器的那一段，必须出现。
 * 端口不省略（22 也写出来）：同一个地址上跑两个 sshd 的两台主机，省了端口就完全重名。
 * WSL 是用户明确点的例外——本机发行版没有 `地址:端口` 这回事，保持 `WSL(Debian)`。
 *
 * **别名与地址（或 id）相同就不拼**：导入主机的备注在资产名等于 IP 时就是地址，
 * 拼出来是 `192.168.1.16:22 · 192.168.1.16`——同一句念两遍，反而把「哪一段是别名」搅浑。
 * 比较不分大小写（`db1` 与 `DB1` 也是重复），只去空白、不猜语义。
 */
export function targetLabel(target) {
  if (target.kind === 'wsl') return `WSL(${target.distro})`
  const head = `${target.address}:${target.port}`
  const label = String(target.label ?? target.id ?? '').trim()
  if (label === '') return head
  const lower = (value) => String(value ?? '').trim().toLowerCase()
  if (lower(label) === lower(target.id) || lower(label) === lower(target.address)) return head
  return `${head} · ${label}`
}

/**
 * 主机条目的「内部来源标记」：`via = { gatewayId, assetId, accountAlias, accountUser }`。
 *
 * 只有批量导入的那条路会写它，插件内部用它决定「建连时要不要先换一次连接凭据、找哪个接入点」；
 * 列表、卡片、错误信息一律不展示、也不翻译成任何来源系统的名字。
 * 校验刻意宽松（多出来的键丢掉、缺字段就当没有）：这是**本插件自己写的**辅助段，
 * 手改坏了最多是那台主机按普通主机连接，不该让整份 hosts.json 不可用。
 * `gatewayId` 可选：旧数据没有它，按首个接入点算（D-45）。
 *
 * @returns 规范化后的标记；不是合法形状时返回 `undefined`（并让调用方记一条 warning）
 */
export function normalizeHostSource(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const assetId = raw.assetId === undefined || raw.assetId === null ? undefined : String(raw.assetId).trim()
  const accountAlias = asString(raw.accountAlias)
  const accountUser = asString(raw.accountUser)
  if (assetId === undefined || assetId === '' || accountAlias === undefined || accountUser === undefined) {
    return undefined
  }
  // `gatewayId` 可选：旧数据没有这个字段，按首个接入点（`default`）算（D-45 的迁移规则）。
  const gatewayId = asString(raw.gatewayId)
  return { assetId, accountAlias, accountUser, ...(gatewayId === undefined ? {} : { gatewayId }) }
}

/** 一台主机来自哪个接入点（旧数据没有 `gatewayId`＝首个接入点）。 */
export function viaGatewayId(host) {
  const value = host?.via?.gatewayId
  return typeof value === 'string' && value !== '' ? value : 'default'
}

