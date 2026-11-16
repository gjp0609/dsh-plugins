/**
 * `ssh_copy`：在远程主机与 WSL 之间搬文件/目录。
 *
 * 三条设计决定（都有代价，写在这里免得以后自己都忘了为什么）：
 *
 * 1. **两端都当成「会跑 sh 的端点」**，不引入 SFTP。
 *    文件用 `cat`（源）/`cat > tmp`（目标），目录用 `tar -cf -` / `tar -xf -`。
 *    好处：远端↔远端、远端↔WSL、WSL↔WSL 共用一条中继，字节始终只在两条流之间走，
 *    既不落本地磁盘，也不依赖服务器的 sftp-server（很多机器默认关掉它）。
 *    代价：要求对端有 POSIX sh + tar + cat——任何 Linux/macOS 服务器都满足。
 *
 * 2. **先写临时名、再 rename 到位**。
 *    目标端脚本是「先收完（或解包完）再替换」，所以中途断流只会留下一个 `.dsh-copy-*`
 *    垃圾，不会把旧数据毁掉一半。覆盖目录时也只在新内容完整落地后才 `rm -rf` 旧的。
 *
 * 3. **默认不覆盖**。目标已存在就在预检阶段整单失败（并提示把 `overwrite` 设为 true），
 *    绝不「悄悄地跳过」或「悄悄地覆盖」——这两种都让人事后才发现少了/多了东西。
 *
 * 审批：一项一行，源→目标与体积/覆盖标记都写在卡片上；未勾选的项一律不执行。
 *
 * 实现按职责分在 `lib/copy/` 四个模块里（路径 / 命令构造 / 条目解析 / 传输）；
 * 这个文件只留工具本体，并把拆分前导出的符号原样再导出一次。
 */
import { askApproval, buildApprovalQuestion, cardApprovalChannel, resolveWorkDir } from './approval.mjs'
import { phaseEntry } from './audit.mjs'
import { itemsToRows, normalizeItems } from './copy/items.mjs'
import { formatBytes } from './copy/paths.mjs'
import { preflight, transferItem } from './copy/transfer.mjs'
import { targetLabel } from './hosts.mjs'

// 对外导出面与拆分前逐字一致：`index.js` 只用 `createCopyTool`，但 `tests/copy.test.mjs`
// 直接 import 其它符号，所以这里把搬走的每一个名字都原样再导出（名字、签名都不变）。
export { CopyError, assertPath, formatBytes, joinPath, shQuote, splitPath, stripTrailingSlash } from './copy/paths.mjs'
export { buildProbeCommand, buildSinkCommand, buildSourceCommand, parseProbe, parseWroteBytes } from './copy/commands.mjs'
export { describeAction, describeFlags, itemsToRows, normalizeItems, parseEndpoint } from './copy/items.mjs'
export { isEarlyClose, relayBytes } from './copy/transfer.mjs'

// ===========================================================================
// 工具
// ===========================================================================

export function createCopyTool({ store, io, audit, dialog }) {
  const settings = () => store.settings

  return {
    name: 'ssh_copy',
    description:
      '在远程主机与 WSL 发行版之间复制文件或目录（目录递归）。源与目标各写成 { target, path }，target 是主机 id 或 wsl:<发行版>，两端都可以是远程主机。这是复制，不是同步：不会删除目标端多余的文件，也不会因为「已存在」就跳过。默认不覆盖——目标已存在会直接报错，确实要覆盖时把该项 overwrite 设为 true。每一项都会先在多选卡里单独一行给用户勾选，只有被勾选的才执行。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: '要搬运的项；一项一行卡片，最多 8 项',
          items: {
            type: 'object',
            properties: {
              from: {
                type: 'object',
                description: '源',
                properties: {
                  target: { type: 'string', description: '主机 id 或 wsl:<发行版>' },
                  path: { type: 'string', description: '绝对路径；目录会连同内容一起递归复制' },
                },
                required: ['target', 'path'],
                additionalProperties: false,
              },
              to: {
                type: 'object',
                description: '目标；path 结尾带 / 或本身是目录时，落到该目录下并沿用源的名字',
                properties: {
                  target: { type: 'string', description: '主机 id 或 wsl:<发行版>' },
                  path: { type: 'string', description: '绝对路径' },
                },
                required: ['target', 'path'],
                additionalProperties: false,
              },
              why: { type: 'string', description: '为什么搬这个（会显示在审批卡上，必填）' },
              overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
            },
            required: ['from', 'to', 'why'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          approved: { type: 'number' },
          skipped: { type: 'number' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item: { type: 'number' },
                from: { type: 'string' },
                to: { type: 'string' },
                ok: { type: 'boolean' },
                kind: { type: 'string' },
                bytes: { type: 'number' },
                ms: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['item', 'from', 'to', 'ok'],
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        required: ['approved', 'skipped', 'results'],
        additionalProperties: false,
      },
      render(_args, value) {
        if (typeof value?.error === 'string' && value.error !== '') {
          return [{ type: 'text', text: `没有搬运任何东西：${value.error}` }]
        }
        if (value.results.length === 0) {
          return [{ type: 'text', text: `没有搬运任何东西（批准 ${value.approved} 项，跳过 ${value.skipped} 项）。` }]
        }
        const lines = value.results.map((row) => {
          const head = `${row.ok ? '✅' : '❌'} 第 ${row.item + 1} 项 · ${row.from} → ${row.to} · ${row.kind}${row.ok ? ` · ${formatBytes(row.bytes)} · ${row.ms}ms` : ''}`
          return row.error === undefined || row.error === '' ? head : `${head}\n错误：${row.error}`
        })
        // 没勾的项也要留痕迹：只报「搬了什么」，模型会以为整单都搬了。
        const doneItems = new Set(value.results.map((row) => row.item))
        const skippedLines = []
        for (const [index, item] of (Array.isArray(_args?.items) ? _args.items : []).entries()) {
          if (doneItems.has(index)) continue
          const from = item?.from?.path ?? ''
          const to = item?.to?.path ?? ''
          skippedLines.push(`第 ${index + 1} 项${from !== '' ? `（${from} → ${to}）` : ''}`)
        }
        if (skippedLines.length > 0) lines.push(`⏭ 未勾选，未搬运：${skippedLines.join('、')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },

    async execute(args, exec) {
      // 审计靠它把同一次调用的记录串成一条时间线（D-30）。
      const callId = exec?.callId
      const snapshot = await store.ensureLoaded()
      const state = { hosts: snapshot.hosts, wsl: snapshot.wsl }

      let items
      try {
        items = normalizeItems(args, { maxRows: settings().maxCardRows })
      } catch (error) {
        return { approved: 0, skipped: 0, results: [], error: String(error?.message ?? error) }
      }

      // 进入 connect：搬运的第一步是预检——先连上两端、问出类型/大小/存在性。
      // 卡在这里说明卡在「建连接 / 认证」，不是卡在搬字节（D-30）。
      audit.record(phaseEntry({ kind: 'copy', phase: 'connect', callId }))
      // 预检：整单要么全过、要么把问题一次说清，避免用户对着一张半残的卡做决定。
      const plans = []
      const failures = []
      for (const item of items) {
        try {
          plans.push(await preflight(item, { io, settings: settings(), state }))
        } catch (error) {
          failures.push(`第 ${item.index + 1} 项：${error?.message ?? error}`)
        }
      }
      if (failures.length > 0) {
        return { approved: 0, skipped: items.length, results: [], error: failures.join('；') }
      }

      let question
      try {
        question = buildApprovalQuestion({
          header: 'SSH · 搬运确认',
          question: '勾选要搬运的行',
          rows: itemsToRows(plans),
          maxRows: settings().maxCardRows,
        })
      } catch (error) {
        return { approved: 0, skipped: 0, results: [], error: String(error?.message ?? error) }
      }

      // 进入 approval：从这一刻起卡住，就是「在等用户点卡片」（D-30）。
      audit.record(phaseEntry({ kind: 'copy', phase: 'approval', callId }))
      let approval
      try {
        approval = await askApproval({ question, fallbackSelect: cardApprovalChannel(dialog, resolveWorkDir(exec)), signal: exec?.signal })
      } catch (error) {
        return { approved: 0, skipped: plans.length, results: [], error: String(error?.message ?? error) }
      }

      const approvedSet = new Set(approval.indices)
      const approvedPlans = plans.filter((plan) => approvedSet.has(plan.index))
      if (approvedPlans.length === 0) {
        return { approved: 0, skipped: plans.length, results: [] }
      }

      // 进入 exec：这条之后的记录都是搬运结果（D-30）。
      audit.record(phaseEntry({ kind: 'copy', phase: 'exec', callId }))

      const results = []
      for (const plan of approvedPlans) {
        const from = `${targetLabel(plan.src.target)}:${plan.src.path}`
        const to = `${targetLabel(plan.dst.target)}:${plan.finalPath}`
        try {
          const outcome = await transferItem(plan, { io, settings: settings(), signal: exec?.signal })
          results.push({
            item: plan.index,
            from,
            to,
            ok: true,
            kind: plan.srcInfo.type === 'dir' ? '目录' : '文件',
            bytes: outcome.bytes,
            ms: outcome.ms,
          })
          audit.record({
            kind: 'copy',
            event: 'result',
            phase: 'exec',
            callId,
            target: `${targetLabel(plan.src.target)} → ${targetLabel(plan.dst.target)}`,
            command: `${plan.src.path} → ${plan.finalPath}`,
            approved: true,
            ms: outcome.ms,
            bytes: outcome.bytes,
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          results.push({
            item: plan.index,
            from,
            to,
            ok: false,
            kind: plan.srcInfo.type === 'dir' ? '目录' : '文件',
            bytes: 0,
            ms: 0,
            error: message,
          })
          audit.record({
            kind: 'copy',
            event: 'result',
            phase: 'exec',
            callId,
            target: `${targetLabel(plan.src.target)} → ${targetLabel(plan.dst.target)}`,
            command: `${plan.src.path} → ${plan.finalPath}`,
            approved: true,
            ms: 0,
            bytes: 0,
            error: message,
          })
        }
      }

      return { approved: approvedPlans.length, skipped: plans.length - approvedPlans.length, results }
    },
  }
}
