/**
 * 进程内缓存与 JSONL 落盘。
 *
 * - createCallCache：callId → {tool, command}，有界（默认 256 条）+ TTL（默认 10 分钟）；
 * - createAudit：approvals.jsonl（决策流水）与 config-errors.log（配置诊断）两个追加写。
 *
 * 落盘失败一律吞掉并尽力打一条 console：审计写不出去不能改变审批结果。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 缓存默认上限。 */
export const CACHE_MAX = 256
/** 缓存默认存活时间（10 分钟）。 */
export const CACHE_TTL_MS = 10 * 60 * 1000
/** 审批决策流水。 */
export const AUDIT_FILE_NAME = 'approvals.jsonl'
/** 配置诊断。 */
export const DIAGNOSTICS_FILE_NAME = 'config-errors.log'

/**
 * 有界 + TTL 的 callId 缓存。插入顺序即淘汰顺序（Map 保序），重复 remember 会移到最新。
 *
 * @param {object} [options]
 * @param {number} [options.max] 条数上限
 * @param {number} [options.ttlMs] 存活毫秒数
 * @param {() => number} [options.now] 时钟（测试用）
 */
export function createCallCache({ max = CACHE_MAX, ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
  const entries = new Map()

  function remember(callId, value) {
    if (typeof callId !== 'string' || callId === '') return false
    if (typeof value?.tool !== 'string' || typeof value?.command !== 'string') return false
    entries.delete(callId)
    entries.set(callId, Object.freeze({ tool: value.tool, command: value.command, at: now() }))
    while (entries.size > max) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    return true
  }

  function lookup(callId) {
    if (typeof callId !== 'string' || callId === '') return null
    const entry = entries.get(callId)
    if (entry === undefined) return null
    if (now() - entry.at > ttlMs) {
      entries.delete(callId)
      return null
    }
    return entry
  }

  function clear() {
    entries.clear()
  }

  return {
    remember,
    lookup,
    clear,
    get size() {
      return entries.size
    },
  }
}

/**
 * 造两个追加写 JSONL 的落盘器。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录；首次写入时递归创建
 * @param {(event: object) => void} [options.log] debug 日志
 */
export function createAudit({ dataDir, log = () => {} }) {
  const auditFile = join(dataDir, AUDIT_FILE_NAME)
  const diagnosticsFile = join(dataDir, DIAGNOSTICS_FILE_NAME)
  const warned = new Set()
  let dirReady = false

  function ensureDir() {
    if (dirReady) return
    mkdirSync(dataDir, { recursive: true })
    dirReady = true
  }

  function append(file, entry, label) {
    try {
      ensureDir()
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
      warned.delete(label)
      return true
    } catch (error) {
      if (!warned.has(label)) {
        warned.add(label)
        const message = error instanceof Error ? error.message : String(error)
        try {
          log({ event: 'write-failed', phase: label, file, error: message })
        } catch {
          // 日志本身失败也不再往外抛
        }
        try {
          console.warn(`[approval-allow] ${label} 写入失败（审批不受影响）: ${message}`)
        } catch {
          // 没有 console 也不影响审批
        }
      }
      return false
    }
  }

  return {
    /** 追加一条审批决策（一行一条、字段稳定，见 README「审计」）。 */
    audit(entry) {
      return append(auditFile, entry, 'audit')
    },
    /** 追加一条配置诊断。 */
    diagnostic(entry) {
      return append(diagnosticsFile, entry, 'diagnostic')
    },
    files: { auditFile, diagnosticsFile },
  }
}
