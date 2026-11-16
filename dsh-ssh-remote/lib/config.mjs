/**
 * config.json：插件自己的可调参数。首次运行自动生成一份带说明的模板，改完即时生效（watcher 重载）。
 *
 * 优先级：内置默认 < hosts.json 的 `defaults` < config.json。
 */
import { existsSync } from 'node:fs'
import { writeJsonAtomic } from './util.mjs'
import { HOST_DEFAULTS } from './hosts.mjs'

/** 全部可调参数与默认值。 */
export const DEFAULT_SETTINGS = {
  connectTimeoutMs: HOST_DEFAULTS.connectTimeoutMs,
  stepTimeoutMs: HOST_DEFAULTS.stepTimeoutMs,
  idleTimeoutMs: HOST_DEFAULTS.idleTimeoutMs,
  maxConnections: HOST_DEFAULTS.maxConnections,
  keepaliveIntervalMs: 15000,
  /** 一张审批卡最多几行；超了让模型分批。 */
  maxCardRows: 8,
  /** 每个 step 的结果保留多少字节（尾部）。 */
  outputBytesPerStep: 16 * 1024,
  /** 一次工具调用所有 step 合计保留多少字节。 */
  outputBytesTotal: 64 * 1024,
  /** 审计日志保留天数。 */
  auditRetentionDays: 30,
  /** 搬运前的目录预检：最多列多少条、最多花多少毫秒。 */
  walkMaxEntries: 5000,
  walkMaxMs: 2000,
  /** 单次搬运的体积上限（字节）。超了在预检阶段就拒绝，避免误搬几十 GB。 */
  copyMaxBytes: 2 * 1024 ** 3,
}

/** 允许的取值区间（越界就当非法值退回默认，并记一条 warning）。 */
const BOUNDS = {
  connectTimeoutMs: [1000, 300000],
  stepTimeoutMs: [1000, 3600000],
  idleTimeoutMs: [10000, 86400000],
  maxConnections: [1, 64],
  keepaliveIntervalMs: [5000, 300000],
  maxCardRows: [1, 20],
  outputBytesPerStep: [1024, 1024 * 1024],
  outputBytesTotal: [1024, 4 * 1024 * 1024],
  auditRetentionDays: [1, 3650],
  walkMaxEntries: [100, 200000],
  walkMaxMs: [200, 60000],
  copyMaxBytes: [1024 * 1024, 1024 ** 4],
}

/**
 * 把若干层来源合并成最终设置。前面的层优先级更高。
 * @param layers - 例如 `[configJson, hostsDefaults]`
 */
export function mergeSettings(layers, warnings = []) {
  const result = { ...DEFAULT_SETTINGS }
  // 低优先级先铺，高优先级后覆盖。
  for (const layer of [...layers].reverse()) {
    if (layer === null || typeof layer !== 'object') continue
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (layer[key] === undefined) continue
      const [min, max] = BOUNDS[key]
      const number = Math.round(Number(layer[key]))
      if (!Number.isFinite(number) || number < min || number > max) {
        warnings.push(`设置项 ${key}=${JSON.stringify(layer[key])} 超出范围 [${min}, ${max}]，已忽略`)
        continue
      }
      result[key] = number
    }
  }
  return result
}

/** config.json 不存在时写一份模板（字段顺序即说明顺序）。 */
export function ensureConfigFile(path, settings = DEFAULT_SETTINGS) {
  if (existsSync(path)) return false
  writeJsonAtomic(path, {
    _说明: [
      '这个文件可以随时改，保存后插件自动重载，不用重启 DSH。',
      '超时单位是毫秒。maxCardRows 是一张审批卡最多几行，超了模型会分批。',
      'hosts.json 的 defaults 段也能设前四项；这里优先级更高。',
    ],
    ...settings,
  })
  return true
}
