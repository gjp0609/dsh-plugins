/**
 * `ssh_copy` 的条目解析与卡片文案（纯函数，单测覆盖，不需要网络）。
 *
 * 从 `lib/copy.mjs` 的「纯函数：路径与命令拼装」那一段原样拆出。
 * 只负责「模型给的东西怎么变成条目、一条条目在卡上怎么说」，不认识连接与字节流
 * （所以它不 import `transfer.mjs`，方向永远是 transfer → items，不会反过来）。
 */
import { targetLabel } from '../hosts.mjs'
import { assertPath, CopyError, formatBytes } from './paths.mjs'

/** 校验模型给的 items，错误信息里写清怎么改。 */
export function normalizeItems(args, { maxRows = 8 } = {}) {
  const rawItems = args?.items
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new CopyError('items 必须是非空数组', 'args')
  if (rawItems.length > maxRows) {
    throw new CopyError(`一次最多 ${maxRows} 项，这次给了 ${rawItems.length} 项；请分批调用`, 'args')
  }

  return rawItems.map((raw, index) => {
    const where = `第 ${index + 1} 项`
    const from = parseEndpoint(raw?.from, `${where} 的 from`)
    const to = parseEndpoint(raw?.to, `${where} 的 to`)
    const why = typeof raw?.why === 'string' ? raw.why.trim() : ''
    if (why === '') throw new CopyError(`${where} 缺 why：必须写清为什么要搬这个（会显示在审批卡上）`, 'args')
    if (from.target === to.target && from.path === to.path) {
      throw new CopyError(`${where} 的源和目标指向同一个位置：${from.path}`, 'args')
    }
    return { index, from, to, why, overwrite: raw?.overwrite === true }
  })
}

/** 一个端点 = `{ target, path }`，target 写主机 id 或 `wsl:<发行版>`。 */
export function parseEndpoint(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CopyError(`${where} 必须是 { target, path } 对象`, 'args')
  }
  const target = typeof raw.target === 'string' ? raw.target.trim() : ''
  if (target === '') throw new CopyError(`${where} 缺 target（主机 id 或 wsl:<发行版>）`, 'args')
  return { target, path: assertPath(raw.path, `${where} 的 path`) }
}

/** 这项是什么：目录几项 / 文件多大，再加覆盖标记。卡片上最该被先看见的就是这几个字。 */
export function describeFlags(plan) {
  const flags = []
  if (plan.srcInfo.type === 'dir') {
    flags.push(plan.entriesCapped ? `目录 ≥${plan.entries} 项` : `目录 ${plan.entries} 项`)
  } else {
    flags.push(`文件 ${formatBytes(plan.size)}`)
  }
  if (plan.dstExists) flags.push(plan.overwrite ? '⚠ 覆盖' : '目标已存在')
  return flags
}

export function describeAction(plan) {
  return `[${describeFlags(plan).join(' · ')}] ${plan.src.path} → ${plan.finalPath}`
}

/**
 * 卡片一行：一项一行。
 * 标题只写目标；同机搬运（源和目标是同一台）加「本机内」避免出现 `A → A` 这种废话。
 * 正文用 `fields`（渲染成无序列表）：卡片正文是 Markdown，单个换行只会被当成空格。
 * 选项那一行也只写目标（B-23）：同一对主机之间搬多项时标签会重名，由
 * `buildApprovalQuestion` 加 ①②③ 区分，不把文件名或路径接在选项后面。
 *
 * 同一个行对象要供两条路用，措辞不同但数据只有一份（D-37）：
 * - `fields`（中文「源 / 目标」、值带反引号）→ 浏览器审批文案（`buildApprovalQuestion` 的 Markdown 列表）；
 * - `text`（`Source:` / `Target:`、不带反引号）+ `lang: 'text'` → 桌面卡的框内正文。
 *   搬运的目标路径是**说明文字**，不是要执行的命令：按 `sh` 高亮会把 `Source:` 当命令名涂色，
 *   反引号也会原样露出来（用户 2026-11-02 真机反馈）。
 */
export function itemsToRows(plans) {
  return plans.map((plan) => {
    const srcLabel = targetLabel(plan.src.target)
    const dstLabel = targetLabel(plan.dst.target)
    const sameTarget = plan.src.target.kind === plan.dst.target.kind && plan.src.target.id === plan.dst.target.id
    return {
      target: sameTarget ? `${srcLabel}（本机内）` : `${srcLabel} → ${dstLabel}`,
      head: sameTarget ? srcLabel : `${srcLabel} → ${dstLabel}`,
      meta: describeFlags(plan).join(' · '),
      fields: [
        { label: '源', value: `\`${plan.src.path}\`` },
        { label: '目标', value: `\`${plan.finalPath}\`` },
      ],
      text: `Source: ${plan.src.path}\nTarget: ${plan.finalPath}`,
      lang: 'text',
      why: plan.why,
    }
  })
}
