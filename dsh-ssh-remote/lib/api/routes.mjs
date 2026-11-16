/**
 * 维护接口的 HTTP 外壳：路由表、鉴权、请求体、状态码与 JSON 响应。
 *
 * 这里**不认识**主机、密码或接入点——业务全在 `lib/api/handlers.mjs`，本文件只回答
 * 「这个请求能不能进、进哪个 handler、出错回什么码」。所以它可以直接对着
 * `node:http` 的 `IncomingMessage` / `ServerResponse` 写，不依赖任何框架。
 *
 * 宿主侧约定（`@deepseek-ai/dsh-host-webserver` 的 `WebRoute`，见 DECISIONS D-41）：
 * - `register({ kind, path, handler })` 返回「摘掉这条路由」的 disposer；
 * - `kind: 'prefix'` 的 `path` 匹配 `path` 本身与 `path/<任何>`，最长前缀优先；
 * - handler **自己拥有响应生命周期**；handler 抛错时宿主只回一个空 body 的 400
 *   并把错误写进日志，所以所有状态码必须在这里自己给。
 */
export const API_PREFIX = '/plugin-data/ssh-remote/api'

/** 请求体上限：设置页的 JSON 只有几 KB，超过这个数就是恶意/写错了。 */
const BODY_LIMIT_BYTES = 64 * 1024

/** 错误文本上限：报错是给人看的，不要把一整个堆栈或长正文塞进响应。 */
const ERROR_TEXT_LIMIT = 300

/**
 * 路由表：一条路径一行。`methods` 的第一项是主用法。
 * `hosts/list` 同时收 GET：设置页首屏可以直链取，其余接口一律 POST + JSON。
 */
export const API_ROUTES = [
  { path: 'hosts/list', methods: ['POST', 'GET'] },
  { path: 'hosts/save', methods: ['POST'] },
  { path: 'hosts/remove', methods: ['POST'] },
  { path: 'hosts/label', methods: ['POST'] },
  { path: 'hosts/test', methods: ['POST'] },
  { path: 'gateway/list', methods: ['POST'] },
  { path: 'gateway/save', methods: ['POST'] },
  { path: 'gateway/remove', methods: ['POST'] },
  { path: 'gateway/assets', methods: ['POST'] },
  { path: 'gateway/import', methods: ['POST'] },
]

/** 入参校验失败（400）：消息可以直接给人看，不许带凭据。 */
export class ApiInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ApiInputError'
  }
}

/** 接入点那一侧失败（502）：网络、认证、权限，都不是「请求写错了」。 */
export class ApiUpstreamError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ApiUpstreamError'
  }
}

/** 统一 JSON 响应：不缓存（主机清单、连接状态都是随时会变的活事实）。 */
function sendJson(res, status, payload) {
  if (res.headersSent === true) {
    try {
      res.end()
    } catch {
      // 已经结束的响应不用再管
    }
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 路由名（`hosts/list`）：只认前缀下**一段**路径，不认更深或更浅的。 */
function routeOf(pathname) {
  if (!pathname.startsWith(`${API_PREFIX}/`)) return undefined
  const rest = pathname.slice(API_PREFIX.length + 1).replace(/\/+$/, '')
  return API_ROUTES.find((route) => route.path === rest)
}

/** 手工读流：有上限、有内容类型容错，读不完/超限都算 400。 */
async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    req.resume()
    throw new ApiInputError(`请求体过大（上限 ${BODY_LIMIT_BYTES / 1024} KB）`)
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > BODY_LIMIT_BYTES) {
      req.resume()
      throw new ApiInputError(`请求体过大（上限 ${BODY_LIMIT_BYTES / 1024} KB）`)
    }
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiInputError('请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiInputError('请求体必须是 JSON 对象')
  }
  return parsed
}

/**
 * 错误文本：只留 message（不带堆栈），去掉换行，并**抹掉请求里带过的密码/密钥**。
 *
 * 抹凭据这一步是最后一道闸：业务层本来就不该把凭据写进错误，但上游库的报错不受我们控制，
 * 所以按「宁可多抹」处理——同一个串出现在错误里就换成 `***`。
 */
function errorText(error, body) {
  let text = typeof error?.message === 'string' ? error.message : String(error ?? '')
  const secrets = []
  if (body !== null && typeof body === 'object') {
    if (typeof body.password === 'string') secrets.push(body.password)
    if (typeof body.secret === 'string') secrets.push(body.secret)
  }
  for (const secret of secrets) {
    if (secret === '') continue
    text = text.split(secret).join('***')
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text === '') return '内部错误（没有更多信息）'
  return text.length > ERROR_TEXT_LIMIT ? `${text.slice(0, ERROR_TEXT_LIMIT)}…` : text
}

/**
 * 装配路由。
 * @param handlers - 键是 `API_ROUTES` 里的 path，值是 `(body, { signal }) => 结果`（可 async）
 * @param authorize - `(req) => undefined | 401 | 403`；非 undefined 一律回 403（不给业务数据）
 */
export function createApiRoutes({ handlers, authorize }) {
  if (typeof authorize !== 'function') throw new Error('维护接口缺少鉴权函数')
  for (const route of API_ROUTES) {
    if (typeof handlers?.[route.path] !== 'function') {
      throw new Error(`维护接口缺实现「${route.path}」`)
    }
  }

  async function handle(req, res) {
    let rejection
    try {
      rejection = authorize(req)
    } catch {
      // 鉴权服务自己出错时按「拒绝」处理（fail closed），不把错误细节回给调用方。
      rejection = 403
    }
    if (rejection !== undefined) {
      req.resume()
      sendJson(res, 403, { error: '未授权：这次请求不能访问本机维护接口' })
      return
    }

    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const route = routeOf(url.pathname)
    if (route === undefined) {
      req.resume()
      sendJson(res, 404, { error: '不认识的接口' })
      return
    }

    const method = String(req.method ?? 'GET').toUpperCase()
    if (!route.methods.includes(method)) {
      req.resume()
      res.setHeader('allow', route.methods.join(', '))
      sendJson(res, 405, { error: `这个接口只支持 ${route.methods.join(' / ')}` })
      return
    }

    // 客户端断开时把长动作（真连一次 SSH、拉资产清单）一起停掉，别在后台空跑。
    const controller = new AbortController()
    const abort = () => controller.abort()
    req.once?.('aborted', abort)
    res.once?.('close', abort)

    let body = {}
    try {
      body = method === 'GET' ? {} : await readJsonBody(req)
      const payload = await handlers[route.path](body, { signal: controller.signal })
      sendJson(res, 200, payload ?? {})
    } catch (error) {
      const status =
        error instanceof ApiInputError ? 400 : error instanceof ApiUpstreamError ? 502 : 500
      sendJson(res, status, { error: errorText(error, body) })
    } finally {
      req.off?.('aborted', abort)
      res.off?.('close', abort)
    }
  }

  return {
    prefix: API_PREFIX,
    handle,
    /** 挂到宿主 Web 服务上；返回的 disposer 由调用方的 `ctx.effect` 负责在卸载时执行。 */
    register(webServer) {
      return webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handle })
    },
  }
}
