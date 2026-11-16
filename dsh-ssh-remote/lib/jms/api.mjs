/**
 * 接入点的 HTTP 客户端（只被设置页的接入点维护接口与建连两处调用）。
 *
 * 三条约束：
 * - **自签证书**是这类接入点的常态（内网 IP），所以 `rejectUnauthorized: false`；
 * - 报错文案要能区分「认证失败 / 拉资产失败 / 没这台资产的权限 / 连不上」，
 *   并且**不含敏感信息**：密钥、凭据值一律不进消息，服务端返回的正文只按白名单摘几个
 *   错误码（`perm_account_invalid` 这类），其余丢弃；
 * - 地址可以是 `192.168.1.1`、`192.168.1.1:8443`、`https://192.168.1.1`：没写协议按 https，
 *   写在地址里的端口是 **Web 端口**；接入端口（默认 2222）单独存，两者互不影响。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { buildSignature, httpDate } from './sign.mjs'

/** 一次只取这么多响应体（资产列表也不该到 MB 级；超了说明对端给的不是 JSON）。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** 服务端正文里只认这些错误码，其余不往消息里搬。 */
const SAFE_CODES = ['perm_account_invalid', 'permission_denied', 'not_found', 'invalid']

export class JmsApiError extends Error {
  /**
   * @param message - 给人看的中文说明（不含密钥、不含产品名）
   * @param code - `config` | `network` | `auth` | `perm` | `http` | `token`
   */
  constructor(message, code = 'http') {
    super(message)
    this.name = 'JmsApiError'
    this.code = code
  }
}

/** 把服务端正文压成一句能安全展示的话：只留认识的错误码。 */
function safeDetail(text, status) {
  const value = String(text ?? '')
  const codes = []
  for (const code of SAFE_CODES) {
    if (value.toLowerCase().includes(code)) codes.push(code)
  }
  const head = `HTTP ${status}`
  if (codes.length === 0) return head
  return `${head} ${codes.join('/')}`
}

/**
 * 解析用户填的地址 → `{ protocol, hostname, port, origin }`。
 * `origin` 只用于展示（`https://192.168.1.1:8443`），连接用 hostname/port。
 */
export function parseBaseAddress(address) {
  const raw = String(address ?? '').trim()
  if (raw === '') throw new JmsApiError('地址不能为空（写成 192.168.1.1 或 https://192.168.1.1:8443）', 'config')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url
  try {
    url = new URL(withScheme)
  } catch {
    throw new JmsApiError(`地址「${raw}」看不懂（写成 192.168.1.1 或 https://192.168.1.1:8443）`, 'config')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new JmsApiError(`地址「${raw}」的协议只支持 http/https`, 'config')
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  return {
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    hostname: url.hostname,
    port,
    origin: `${url.protocol}//${url.host}`,
  }
}

/** 发一次请求，拿回 `{ status, text }`。连不上/超时抛 `network`。 */
function requestOnce(base, { method, path, headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const request = base.protocol === 'https' ? httpsRequest : httpRequest
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(new JmsApiError(`连不上 ${base.hostname}:${base.port}：${String(error?.message ?? error)}`, 'network'))
    }

    let req
    try {
      req = request(
        {
          hostname: base.hostname,
          port: base.port,
          path,
          method,
          headers: {
            ...headers,
            ...(payload === null
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) }),
          },
          // 自签证书：这类接入点基本都是内网自签，证书链没有可信根。
          rejectUnauthorized: false,
          timeout: Math.max(1000, Number(timeoutMs) || 15000),
        },
        (res) => {
          const chunks = []
          let size = 0
          res.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
              req.destroy(new Error('响应过大'))
              return
            }
            chunks.push(chunk)
          })
          res.on('end', () => {
            if (settled) return
            settled = true
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
          })
          res.on('error', fail)
        },
      )
    } catch (error) {
      fail(error)
      return
    }

    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.on('error', fail)
    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy(new Error('请求被中断'))
        return
      }
      signal.addEventListener('abort', () => req.destroy(new Error('请求被中断')), { once: true })
    }
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** 把响应正文解析成 JSON；不是 JSON 时按 `http` 报错（带状态码，不带正文）。 */
function parseJson(result, what) {
  try {
    return JSON.parse(result.text)
  } catch {
    throw new JmsApiError(`${what}：返回的不是 JSON（${safeDetail('', result.status)}）`, 'http')
  }
}

/**
 * @param config - `{ address, appid, port }`（一个接入点；端口是登录通道的接入端口）
 * @param secret - 密钥（只在内存里参与签名）
 * @param timeoutMs - 单次请求超时
 * @param signal - 取消信号（点「停止」时不该继续等网络）
 */
export function createApi({ config, secret, timeoutMs = 15000, signal }) {
  const base = parseBaseAddress(config?.address)
  if (String(config?.appid ?? '').trim() === '') {
    throw new JmsApiError('appid 不能为空（在接入卡里填）', 'config')
  }

  async function call(method, path, body) {
    const date = httpDate()
    const signed = buildSignature({ appid: config.appid, secret, method, path, date })
    return await requestOnce(base, {
      method,
      path,
      headers: { Date: date, Authorization: signed.authorization, Accept: 'application/json' },
      body,
      timeoutMs,
      signal,
    })
  }

  return {
    /** 接入点地址的展示形式（错误文案里用），例如 `https://192.168.1.18`。 */
    origin: base.origin,
    /** 接入点主机名（连它，不连资产 IP）。 */
    hostname: base.hostname,
    /** Web 端口（只用于 HTTP；接入端口是配置里的另一个值）。 */
    port: base.port,

    /**
     * 这台 appid 能看到的全部资产。
     * @returns `{ assets: [{ id, name, address }], skipped: number }`；`id` 一律转成字符串
     */
    async listAssets() {
      const result = await call('GET', '/api/v1/perms/users/self/assets/?limit=100')
      if (result.status === 401) throw new JmsApiError('认证失败：appid 或密钥不正确（HTTP 401）', 'auth')
      if (result.status === 403) throw new JmsApiError('拉取资产失败：这个 appid 没有资产列表权限（HTTP 403）', 'perm')
      if (result.status !== 200) {
        throw new JmsApiError(`拉取资产失败：${safeDetail(result.text, result.status)}`, 'http')
      }
      const parsed = parseJson(result, '拉取资产失败')
      // 这个接口正常返回数组；要是哪天改成 `{ results: [...] }`，这里也只认这两种形状。
      const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : null
      if (raw === null) throw new JmsApiError('拉取资产失败：返回的结构不认识（既不是数组也没有 results）', 'http')

      const assets = []
      let skipped = 0
      for (const item of raw) {
        if (item === null || typeof item !== 'object') {
          skipped += 1
          continue
        }
        const id = item.id === undefined || item.id === null ? '' : String(item.id).trim()
        const address = String(item.address ?? '').trim()
        if (id === '' || address === '') {
          skipped += 1
          continue
        }
        const name = String(item.name ?? '').trim() === '' ? address : String(item.name).trim()
        assets.push({ id, name, address })
      }
      return { assets, skipped }
    },

    /**
     * 一台资产上「这个 appid 能用的账号」。
     * @returns `[{ alias, username, id }]`；一项都没有表示没有可用账号（导入时跳过这台）
     */
    async assetAccounts(assetId) {
      const path = `/api/v1/perms/users/self/assets/${encodeURIComponent(String(assetId))}/`
      const result = await call('GET', path)
      if (result.status === 401) throw new JmsApiError('认证失败：appid 或密钥不正确（HTTP 401）', 'auth')
      if (result.status === 403) throw new JmsApiError('没有这台资产的权限（HTTP 403）', 'perm')
      if (result.status !== 200) throw new JmsApiError(safeDetail(result.text, result.status), 'http')
      const parsed = parseJson(result, '读取资产账号失败')
      const raw = Array.isArray(parsed?.permed_accounts) ? parsed.permed_accounts : []
      const accounts = []
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue
        const alias = String(item.alias ?? '').trim()
        const username = String(item.username ?? '').trim()
        if (alias === '' || username === '') continue
        accounts.push({ alias, username, id: item.id === undefined ? null : item.id })
      }
      return accounts
    },

    /**
     * 换一次性的连接凭据。
     * **`account` 必须是 alias**：传 username 会被服务端判成 `perm_account_invalid`（已实测）。
     * @returns `{ id, value, expireSeconds }`
     */
    async createConnectionToken(assetId, alias) {
      const result = await call('POST', '/api/v1/authentication/connection-token/', {
        asset: assetId,
        account: alias,
        protocol: 'ssh',
        connect_method: 'ssh_client',
      })
      if (result.status === 401) throw new JmsApiError('认证失败：appid 或密钥不正确（HTTP 401）', 'auth')
      if (result.status === 400 || result.status === 403) {
        throw new JmsApiError(`没有这台资产的登录权限：${safeDetail(result.text, result.status)}`, 'token')
      }
      if (result.status !== 200 && result.status !== 201) {
        throw new JmsApiError(`申请连接凭据失败：${safeDetail(result.text, result.status)}`, 'token')
      }
      const parsed = parseJson(result, '申请连接凭据失败')
      const id = parsed?.id === undefined || parsed?.id === null ? '' : String(parsed.id).trim()
      const value = typeof parsed?.value === 'string' ? parsed.value : ''
      if (id === '' || value === '') throw new JmsApiError('申请连接凭据失败：返回里没有 id / value', 'token')
      const expireSeconds = Number(parsed?.expire_time)
      return { id, value, expireSeconds: Number.isFinite(expireSeconds) ? expireSeconds : null }
    },
  }
}
