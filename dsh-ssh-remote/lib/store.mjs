/**
 * 运行时状态：hosts / wsl / 设置 / vault 的单一来源，带 `fs.watch` 热加载。
 *
 * 设计取舍：热加载失败**不清空**上一份可用状态，只把错误记进 `lastError`；
 * 唯独 vault 解密失败会把 `vault.usable` 置 false（fail closed）。
 */
import { watch } from 'node:fs'
import { join } from 'node:path'
import { serializeHostsDocument } from './admin.mjs'
import { HOST_DEFAULTS, normalizeHostsDocument } from './hosts.mjs'
import { mergeSettings } from './config.mjs'
import { DEFAULT_JMS, migrateLegacyJmsSecret, normalizeJmsConfig, writeJmsConfig } from './jms/config.mjs'
import { Vault } from './vault.mjs'
import { nowIso, readJsonFile, writeJsonAtomic } from './util.mjs'

/** 数据目录下的文件布局。 */
export function createPaths(dataDir) {
  return {
    dataDir,
    hostsJson: join(dataDir, 'hosts.json'),
    vaultDat: join(dataDir, 'vault.dat'),
    vaultBackupDat: join(dataDir, 'vault.dat.bak'),
    configJson: join(dataDir, 'config.json'),
    knownHostsJson: join(dataDir, 'known_hosts.json'),
    logsDir: join(dataDir, 'logs'),
    auditDir: join(dataDir, 'logs', 'audit'),
  }
}

/** 会触发重载的文件名（`.bak` 变化不用管）。 */
const WATCHED_FILES = new Set(['hosts.json', 'config.json', 'vault.dat'])

export class StateStore {
  /** @param dpapi - 见 lib/dpapi.mjs；测试里注入假实现 */
  constructor({ paths, dpapi }) {
    this.paths = paths
    this.vault = new Vault({ path: paths.vaultDat, dpapi })
    this.settings = mergeSettings([{}])
    /**
     * 接入点列表（`config.json` 的 `jms.gateways`）；密钥不在这个文件里。
     * 旧形态（单个 `jms.address/appid/kokoPort`）读进来就是这个列表里 id `default` 的那一个，
     * 下一次写入时才落成新形态（见 `saveJmsConfig`）。
     */
    this.jms = { ...DEFAULT_JMS, gateways: [] }
    this.hosts = {}
    this.wsl = {}
    this.hostDefaults = { ...HOST_DEFAULTS }
    this.warnings = []
    this.lastError = null
    this.lastReloadAt = null
    this.revision = 0
    this.loading = null
    this.#watcher = null
    this.#timer = null
    this.#queue = Promise.resolve()
  }

  #watcher
  #timer
  #queue

  /** 第一次被工具调用时确保已经从磁盘读过一遍（apply 里的首次读取是异步的）。 */
  async ensureLoaded() {
    if (this.revision > 0) return this.snapshot()
    this.loading ??= this.reload()
    await this.loading
    return this.snapshot()
  }

  /** 重新读三个文件。永不抛错；失败进 lastError。 */
  async reload() {
    const warnings = []
    const errors = []

    let hostsLoaded = false
    try {
      const { found, value } = readJsonFile(this.paths.hostsJson)
      const doc = normalizeHostsDocument(found ? (value ?? {}) : {}, { warnings })
      this.hosts = doc.hosts
      this.wsl = doc.wsl
      this.hostDefaults = doc.defaults
      hostsLoaded = true
    } catch (error) {
      errors.push(`hosts.json：${error?.message ?? error}`)
    }

    try {
      const { found, value } = readJsonFile(this.paths.configJson)
      const configDocument = found && value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
      this.settings = mergeSettings(
        [configDocument, hostsLoaded ? this.hostDefaults : HOST_DEFAULTS],
        warnings,
      )
      // 接入点的地址 / appid / 接入端口与超时那批设置同住 config.json；密钥不在这个文件里。
      this.jms = normalizeJmsConfig(configDocument.jms, warnings)
    } catch (error) {
      errors.push(`config.json：${error?.message ?? error}`)
      // 保留上一份可用设置：热重载失败（编辑器原地写造成的半写窗口）不该让
      // maxConnections / 超时 / 输出预算瞬间回到默认值。
    }

    await this.vault.load()
    if (!this.vault.usable) errors.push(this.vault.error ?? 'vault 不可用')

    this.warnings = warnings
    this.lastError = errors.length === 0 ? null : errors.join('；')
    this.lastReloadAt = nowIso()
    this.revision += 1
    return this.snapshot()
  }

  /** 给工具用的只读快照（不含任何密码）。 */
  snapshot() {
    return {
      revision: this.revision,
      lastReloadAt: this.lastReloadAt,
      lastError: this.lastError,
      warnings: [...this.warnings],
      hosts: this.hosts,
      wsl: this.wsl,
      settings: this.settings,
      jms: this.jms,
      vault: {
        state: this.vault.state,
        usable: this.vault.usable,
        count: this.vault.count(),
        cipherBytes: this.vault.cipherBytes,
        loadedAt: this.vault.loadedAt,
        error: this.vault.error,
      },
    }
  }

  /**
   * 串行化所有「写文件」的动作：两次并发保存（设置页连点、两处同时改）会各自基于旧快照
   * 写盘，后写的把前一次覆盖掉。队列保证「读当前 → 改 → 写 → 重载」一次只跑一段。
   */
  #serial(task) {
    const next = this.#queue.then(task, task)
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * 读-改-写 hosts.json（**唯一写入点**）。
   *
   * `mutate(document)` 拿到当前文档、返回改写后的文档（可以 async：写密码库要等 DPAPI）；
   * 写盘用原子替换，紧接着重载，内存与磁盘不会各说一套。`mutate` 抛错就一个字节都不写。
   */
  async updateHosts(mutate) {
    return await this.#serial(async () => {
      const current = {
        hosts: { ...this.hosts },
        wsl: { ...this.wsl },
        defaults: { ...this.hostDefaults },
      }
      const next = await mutate(current)
      writeJsonAtomic(this.paths.hostsJson, serializeHostsDocument(next))
      return await this.reload()
    })
  }

  /**
   * 改 config.json 的 `jms` 段（保留其它键：超时、`_说明` 都不动），随后重载。
   *
   * 写之前顺手把旧单接入点的密钥迁到 `jms:default:secret`：迁移只在写入路径上发生，
   * 读路径永远不动磁盘（文件监听会回环）。迁移是幂等的。
   */
  async saveJmsConfig(jms) {
    return await this.#serial(async () => {
      await migrateLegacyJmsSecret(this.vault, jms?.gateways)
      writeJmsConfig(this.paths.configJson, jms)
      return await this.reload()
    })
  }

  /**
   * 开始监听数据目录。`onReload(snapshot)` 在每次重载后调用；重复调用只装一次。
   */
  watch(onReload) {
    if (this.#watcher !== null) return
    try {
      this.#watcher = watch(this.paths.dataDir, { persistent: false }, (_event, filename) => {
        if (typeof filename === 'string' && filename !== '' && !WATCHED_FILES.has(filename)) return
        this.schedule(onReload)
      })
      this.#watcher.on('error', (error) => {
        this.lastError = `文件监听中断（改完文件仍会按下次读取生效）：${error?.message ?? error}`
      })
    } catch (error) {
      this.lastError = `无法监听数据目录（改完文件要重启才生效）：${error?.message ?? error}`
    }
  }

  /** 合并 250ms 内的多次变化再重载。 */
  schedule(onReload) {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.reload()
        .then((snapshot) => {
          try {
            onReload?.(snapshot)
          } catch {
            // 回调自己的错误不影响重载
          }
        })
        .catch((error) => {
          this.lastError = `重载失败：${error?.message ?? error}`
        })
    }, 250)
    if (typeof this.#timer.unref === 'function') this.#timer.unref()
  }

  dispose() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#watcher !== null) {
      try {
        this.#watcher.close()
      } catch {
        // 关不掉也没关系，进程退出就没了
      }
      this.#watcher = null
    }
  }
}
