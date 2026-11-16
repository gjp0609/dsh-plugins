/**
 * 审计日志：一天一个 JSONL 文件，按天清理。
 *
 * 只记「发生了什么」的元信息：时间、目标、命令、是否批准、退出码、耗时、字节数、阶段。
 * **不记密码、不记完整输出**（只留长度），也不记卡片的 Markdown。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** `phase` 的三个合法取值（D-30）：等卡片 / 建连接 / 执行中。 */
export const PHASES = ['approval', 'connect', 'exec']

/**
 * 「进入某个阶段」的事件（D-30）：**追加**一条，不覆盖上一条。
 *
 * 为什么不做「跑完写一条带 phases 时间线」的汇总记录：卡住时工具根本走不到写汇总那一步，
 * 汇总记录就等于不存在；只有进入阶段就落盘，审计里才留得下「最后一次动静停在 approval」这种证据。
 * 同一个 `callId` 把一次调用的记录串起来，相邻两条的 `ts` 之差就是前一个阶段停了多久。
 */
export function phaseEntry({ kind, phase, callId }) {
  if (!PHASES.includes(phase)) throw new Error(`审计阶段只能是 ${PHASES.join(' / ')}，收到：${phase}`)
  return { kind, event: 'enter', phase, ...(callId === undefined || callId === null ? {} : { callId }) }
}

/** 本地日期 `YYYYMMDD`（按本机时区，不按 UTC，方便和用户对时间）。 */
export function dayStamp(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/** 只保留白名单字段，防止调用方顺手把密码或整段输出塞进来。 */
function sanitize(entry) {
  const allowed = ['sessionId', 'kind', 'target', 'command', 'approved', 'exitCode', 'dropped', 'ms', 'bytes', 'stdoutBytes', 'stderrBytes', 'error', 'event', 'phase', 'callId']
  const out = {}
  for (const key of allowed) {
    if (entry[key] !== undefined) out[key] = entry[key]
  }
  return out
}

export function createAudit({ dir, getSettings, now = () => new Date() }) {
  let lastPruneStamp = null

  function record(entry) {
    try {
      mkdirSync(dir, { recursive: true })
      const line = JSON.stringify({ ts: now().toISOString(), ...sanitize(entry) })
      appendFileSync(join(dir, `audit-${dayStamp(now())}.jsonl`), `${line}\n`, 'utf8')
    } catch {
      // 审计写失败不能影响正事
    }
  }

  /** 删掉超过保留天数的文件；一天最多扫一次。 */
  function prune() {
    const stamp = dayStamp(now())
    if (lastPruneStamp === stamp) return 0
    lastPruneStamp = stamp
    if (!existsSync(dir)) return 0
    const keepDays = Math.max(1, Number(getSettings?.()?.auditRetentionDays ?? 30))
    const cutoff = now().getTime() - keepDays * 24 * 3600 * 1000
    let removed = 0
    try {
      for (const name of readdirSync(dir)) {
        const match = /^audit-(\d{4})(\d{2})(\d{2})\.jsonl$/.exec(name)
        if (match === null) continue
        const fileTime = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
        if (fileTime >= cutoff) continue
        rmSync(join(dir, name), { force: true })
        removed += 1
      }
    } catch {
      // 清理失败不影响正事
    }
    return removed
  }

  return { record, prune }
}
