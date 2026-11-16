/**
 * 建连时现签一次连接凭据（只在 `pool/connect.mjs` 里被调用）。
 *
 * 为什么只在建连那一刻签：凭据 299 秒一次性，且**已建立的会话不受过期影响**。
 * 所以池子里的常驻连接可以一直用；只有重连（缓存被淘汰、链路断、超时后废连接）才会再签一次。
 * 池化 key 与判重口径都不变（仍是 `地址|端口|用户名`），凭据不参与任何缓存——
 * 把它写进 key 会让每次签出来的凭据都变成「另一台主机」，池子直接失效。
 *
 * **按 `via.gatewayId` 找接入点**（多接入点：每台主机归属于导入它的那一个）：
 * 那个接入点被删掉之后不静默失败——报一句能看懂的话（`gateway-missing`），
 * 用户要么重新导入这台主机，要么把接入点加回来。
 *
 * 返回的是 ssh2 的 `connect()` 参数：连的是接入点（地址里的 Web 端口不参与），
 * 用户名固定 `JMS-<凭据 id>`、密码是凭据值（协议约定，见 DECISIONS 的实测记录）。
 */
import { viaGatewayId } from '../hosts.mjs'
import { PoolError } from '../pool/lifecycle.mjs'
import { createApi } from './api.mjs'
import { gatewayById, readJmsSecret } from './config.mjs'

/**
 * @param host - hosts.json 里的目标（必须带 `via`）
 * @param jms - `{ gateways: [...] }`（`store.jms`）
 * @param vault - 取密钥（DPAPI 密文，只在本进程内存里解密）
 * @param timeoutMs - 单次 HTTP 超时
 * @param signal - 取消信号
 * @returns `{ host, port, username, password, gateway }`；`gateway` 只用于错误信息
 */
export async function jmsCredentials({ host, jms, vault, timeoutMs, signal }) {
  const gatewayId = viaGatewayId(host)
  const gateway = gatewayById(jms, gatewayId)
  if (gateway === undefined) {
    throw new PoolError(
      `主机「${host.id}」来自接入点「${gatewayId}」，但它已经被删除了：请重新导入这台主机，或把接入点加回来`,
      'gateway-missing',
    )
  }
  if (String(gateway.address ?? '') === '' || String(gateway.appid ?? '') === '') {
    throw new PoolError(
      `主机「${host.id}」所属的接入点「${gateway.label || gateway.id}」没配完（地址或 appid 为空）：去设置页补上`,
      'config',
    )
  }

  let secret
  try {
    secret = readJmsSecret(vault, gateway)
  } catch (error) {
    throw new PoolError(`主机「${host.id}」的接入凭据取不出来：${String(error?.message ?? error)}`, 'vault')
  }

  const api = createApi({ config: gateway, secret, timeoutMs, signal })
  let credential
  try {
    // account 必须是 alias（传 username 会被服务端判成 perm_account_invalid，实测）。
    credential = await api.createConnectionToken(host.via.assetId, host.via.accountAlias)
  } catch (error) {
    throw new PoolError(`主机「${host.id}」取连接凭据失败：${String(error?.message ?? error)}`, 'token')
  }

  if (signal !== undefined && signal.aborted) throw new PoolError('连接被中断', 'aborted')

  return {
    host: api.hostname,
    port: gateway.port,
    username: `JMS-${credential.id}`,
    password: credential.value,
    gateway: `${api.hostname}:${gateway.port}`,
  }
}
