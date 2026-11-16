/**
 * 维护接口几个 handler 共用的小工具：入参清洗、错误包装、连接状态视图。
 *
 * 只放**与业务无关**的东西（这里是「怎么读一个端口」「怎么查一条连接」），
 * 主机规则在 `handlers.mjs`、接入点规则在 `gateway.mjs`——两边都 import 这一份，不各写一遍。
 */
import { ApiInputError, ApiUpstreamError } from './routes.mjs'

/** 一条错误/说明文本（不含堆栈、不含凭据）。 */
export const say = (error) => (typeof error?.message === 'string' ? error.message : String(error ?? ''))

/** 只把字符串当文本，其余一律按「没填」。 */
export function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 端口：缺省用 `fallback`，给了就必须是 1-65535 的整数。 */
export function parsePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiInputError(`端口「${String(value)}」不合法（1-65535）`)
  }
  return port
}

/** tags：不是数组就当没给；给了就过滤空串并去空白（与 `upsertHost` 同一口径）。 */
export function parseTags(value) {
  if (!Array.isArray(value)) return undefined
  return value.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
}

/** 池子里的连接状态；池子不可用时按「全未连接」处理，不让列表接口跟着失败。 */
export function connectionsOf(pool) {
  try {
    const list = pool?.status?.()
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 一条主机对外长什么样（不含密码、不含内部来源标记的具体内容）。 */
export function hostView(host, connection) {
  return {
    id: host.id,
    address: host.address,
    port: host.port,
    user: host.user,
    label: host.label,
    tags: [...(host.tags ?? [])],
    source: host.via === undefined ? 'direct' : 'gateway',
    connected: connection?.state === 'ready',
  }
}

/** 一条主机的对外视图：现查一次连接状态，不缓存。 */
export function viewOf(pool, host) {
  const connection = connectionsOf(pool).find((entry) => entry.hostId === host.id)
  return hostView(host, connection)
}

/** 关掉某台主机的连接（身份变了、主机删了）。 */
export function closeHost(pool, hostId) {
  try {
    pool?.close?.(hostId)
  } catch {
    // 关不掉不影响这次写入的结果
  }
}

/**
 * 清掉认证冷却。冷却会挡住下一次连接（防锁号），而「刚重填完密码还连不上」
 * 正是「旧密码失败留下的冷却 + 新密码」这个组合造成的。
 */
export function clearCooldown(pool, hostId) {
  try {
    pool?.authCooldown?.delete?.(hostId)
  } catch {
    // 同上
  }
}

/** 把上游失败统一成 502：网络/认证/权限都不是「请求写错了」。 */
export async function upstream(task) {
  try {
    return await task()
  } catch (error) {
    if (error instanceof ApiInputError || error instanceof ApiUpstreamError) throw error
    throw new ApiUpstreamError(say(error))
  }
}

