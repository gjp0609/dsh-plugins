/**
 * vault.dat：DPAPI 密文里的凭据仓库。
 *
 * 硬规则：
 * - 明文只在内存与 `protect.ps1` 的 stdin 里出现，绝不写盘、不写日志、不进工具参数/结果；
 * - 任何解不开的情况 **fail closed**：状态转 error，之后 `passwordFor()` 一律拒绝，
 *   不回落明文、不拿空密码去连；
 * - 写盘前留 `.bak`（脚本内部还会先写临时文件再替换）。
 */
import { existsSync, statSync } from 'node:fs'
import { addrHash } from './hosts.mjs'
import { backupFile, nowIso } from './util.mjs'

export const VAULT_VERSION = 1

export class VaultError extends Error {
  /**
   * @param message - 给人看的中文说明
   * @param code - `corrupt` | `version` | `unusable` | `missing` | `address-changed`
   */
  constructor(message, code = 'corrupt') {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

/** 校验并规范化 vault 文档结构；任何异常结构都抛 VaultError。 */
export function normalizeVaultDocument(raw) {
  if (raw === null || typeof raw !== 'object') throw new VaultError('vault 内容不是对象')
  if (raw.version !== VAULT_VERSION) {
    throw new VaultError(`vault 版本 ${JSON.stringify(raw.version)} 不认识（当前支持 ${VAULT_VERSION}）`, 'version')
  }
  const entries = raw.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new VaultError('vault.entries 不是对象')
  }
  const result = {}
  for (const [hostId, entry] of Object.entries(entries)) {
    if (entry === null || typeof entry !== 'object') throw new VaultError(`vault 条目「${hostId}」不是对象`)
    if (typeof entry.password !== 'string' || entry.password === '') {
      throw new VaultError(`vault 条目「${hostId}」缺 password`)
    }
    if (typeof entry.addrHash !== 'string' || entry.addrHash === '') {
      throw new VaultError(`vault 条目「${hostId}」缺 addrHash`)
    }
    result[hostId] = { password: entry.password, addrHash: entry.addrHash }
  }
  return result
}

export class Vault {
  /** @param dpapi - `{ protect(path, text), unprotect(path) }`（见 lib/dpapi.mjs，可注入假实现） */
  constructor({ path, dpapi }) {
    this.path = path
    this.dpapi = dpapi
    /** `unloaded` | `empty` | `ok` | `error` */
    this.state = 'unloaded'
    this.entries = {}
    /** 写操作的串行队列（见 mutate）。 */
    this.queue = Promise.resolve()
    this.error = null
    this.cipherBytes = null
    this.loadedAt = null
  }

  get usable() {
    return this.state !== 'error'
  }

  /** 磁盘上的条目数（不含错误状态）。 */
  count() {
    return Object.keys(this.entries).length
  }

  /** 从磁盘重载。永不抛错：失败转 error 状态。 */
  async load() {
    this.loadedAt = nowIso()
    try {
      if (!existsSync(this.path)) {
        this.entries = {}
        this.state = 'empty'
        this.error = null
        this.cipherBytes = null
        return this
      }
      this.cipherBytes = statSync(this.path).size
      const text = await this.dpapi.unprotect(this.path)
      this.entries = normalizeVaultDocument(JSON.parse(text))
      this.state = this.count() === 0 ? 'empty' : 'ok'
      this.error = null
      return this
    } catch (error) {
      this.entries = {}
      this.state = 'error'
      this.error = `vault 读取失败，已 fail closed（不回落明文、也不会用空密码连接）：${error?.message ?? error}`
      return this
    }
  }

  /**
   * 覆盖写入整份条目；写前备份 `.bak`。抛错表示没写成（此时内存状态不变）。
   *
   * **读到过错误就绝不写**：读失败时 `entries` 已被清空，此时写入等于拿空集覆盖整份密码库，
   * 其它主机的密码会静默丢光（只剩 .bak）。而设置页的错误提示恰好会引导用户重填密码，
   * 正好踩上来。宁可报错让用户先处理 vault。
   */
  async save(entries) {
    if (this.state === 'error') {
      throw new VaultError(
        `vault 当前不可用，已拒绝写入以免覆盖其它主机的密码：${this.error ?? '读取失败'}`,
        'unusable',
      )
    }
    const normalized = normalizeVaultDocument({ version: VAULT_VERSION, entries })
    backupFile(this.path)
    await this.dpapi.protect(this.path, JSON.stringify({ version: VAULT_VERSION, entries: normalized }))
    this.entries = normalized
    this.state = this.count() === 0 ? 'empty' : 'ok'
    this.error = null
    this.cipherBytes = existsSync(this.path) ? statSync(this.path).size : null
    this.loadedAt = nowIso()
    return this
  }

  /**
   * 取某主机的密码。地址/端口/用户名与保存时不一致 → 拒绝（防手滑把旧密码发给别的机器）。
   */
  passwordFor(hostId, host) {
    if (this.state === 'error') throw new VaultError(this.error ?? 'vault 不可用', 'unusable')
    const entry = this.entries[hostId]
    if (entry === undefined) {
      throw new VaultError(`主机「${hostId}」还没有保存密码（到插件设置页「SSH 主机」里重填，或 sshctl set）`, 'missing')
    }
    const expected = addrHash(host)
    if (entry.addrHash !== expected) {
      throw new VaultError(
        `主机「${hostId}」的地址/端口/用户名改过，与保存密码时不一致。为防把旧密码发给别的机器，已拒绝连接；请重新设置密码。`,
        'address-changed',
      )
    }
    return entry.password
  }

  has(hostId) {
    return this.entries[hostId] !== undefined
  }

  /**
   * 取一条**绑定在任意标识上**的密文（`key` 不是主机 id，例如接入凭据）。
   *
   * 与 `passwordFor` 同一套规则：绑定哈希对不上就拒绝（地址/参数改过之后不复用旧值），
   * 没有这条返回 `null`（由调用方决定报什么）。
   */
  credentialFor(key, bindHash) {
    if (this.state === 'error') throw new VaultError(this.error ?? 'vault 不可用', 'unusable')
    const entry = this.entries[key]
    if (entry === undefined) return null
    if (entry.addrHash !== bindHash) {
      throw new VaultError('保存的密钥与当前配置（地址 / 接入端口 / appid）不匹配，请重新填写一次密钥', 'address-changed')
    }
    return entry.password
  }

  /** 写一条绑定在任意标识上的密文（只进密文，不回显）。 */
  async setCredential(key, bindHash, secret) {
    if (typeof secret !== 'string' || secret === '') throw new VaultError('密钥不能为空', 'missing')
    if (typeof bindHash !== 'string' || bindHash === '') throw new VaultError('绑定哈希不能为空', 'missing')
    await this.mutate((entries) => ({ ...entries, [key]: { password: secret, addrHash: bindHash } }))
  }

  /**
   * 进程内串行化「读当前条目 → 改 → 整份写」。
   *
   * 不串行的话，两次并发（例如同一轮里给两台机器重填密码）会各自基于旧快照写盘，
   * 后写的那次把前一次的结果覆盖掉——表现为「设了两台，只剩一台」。
   */
  async mutate(fn) {
    const run = async () => {
      const next = fn({ ...this.entries })
      await this.save(next)
    }
    const pending = this.queue.then(run, run)
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return await pending
  }

  /** 设/改一台主机的密码（密码只进密文，不回显）。 */
  async setPassword(hostId, host, password) {
    if (typeof password !== 'string' || password === '') throw new VaultError('密码不能为空', 'missing')
    await this.mutate((entries) => ({ ...entries, [hostId]: { password, addrHash: addrHash(host) } }))
  }

  async remove(hostId) {
    if (this.entries[hostId] === undefined) return false
    await this.mutate((entries) => {
      delete entries[hostId]
      return entries
    })
    return true
  }

  /** 只给 `ssh_status` / `sshctl list` 用的元信息，绝不含密码。 */
  describe() {
    return Object.entries(this.entries).map(([hostId, entry]) => ({
      hostId,
      addrHashPrefix: entry.addrHash.slice(0, 12),
      passwordLength: entry.password.length,
    }))
  }
}
