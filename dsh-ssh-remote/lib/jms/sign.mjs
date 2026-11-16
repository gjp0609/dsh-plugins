/**
 * 接入点的 HTTP 签名（纯函数，单测覆盖；不联网、不读配置）。
 *
 * 协议（已实测，别改）：
 *   (request-target): <小写方法> <路径含查询串>
 *   date: <RFC1123 GMT>
 *   Authorization: Signature keyId="<appid>",algorithm="hmac-sha256",headers="(request-target) date",signature="<base64>"
 *
 * 两条容易写错的地方：
 * - `(request-target)` 里的方法必须**小写**，路径必须**带查询串**（`?limit=100`）；
 *   少了查询串或把方法写成大写，服务端会认成另一个待签串，签名永远对不上；
 * - `Date` 头必须**和签名串里的 date 是同一个字符串**。分开取两次时间就会差一秒，
 *   表现为「偶发 401」——很难查，所以这里只有一个入口造 date。
 */
import { createHmac } from 'node:crypto'

/** RFC1123 GMT 时间串（`Wed, 11 Nov 2026 05:44:15 GMT`）。 */
export function httpDate(date = new Date()) {
  return new Date(date).toUTCString()
}

/**
 * 造签名。
 * @param appid - 凭据的 appid（进 `keyId`）
 * @param secret - 密钥；只在内存里参与 HMAC，不落盘、不进日志
 * @param method - HTTP 方法（大小写都收，签名串里小写）
 * @param path - 路径**含查询串**，例如 `/api/v1/perms/users/self/assets/?limit=100`
 * @param date - RFC1123 GMT 串；调用方必须把它原样放进 `Date` 头
 * @returns `{ date, stringToSign, signature, authorization }`
 */
export function buildSignature({ appid, secret, method, path, date }) {
  const appIdText = String(appid ?? '')
  const secretText = String(secret ?? '')
  const target = `(request-target): ${String(method ?? 'GET').toLowerCase()} ${String(path ?? '/')}`
  const stringToSign = `${target}\ndate: ${date}`
  const signature = createHmac('sha256', secretText).update(stringToSign, 'utf8').digest('base64')
  const authorization =
    `Signature keyId="${appIdText}",algorithm="hmac-sha256",headers="(request-target) date",signature="${signature}"`
  return { date, stringToSign, signature, authorization }
}
