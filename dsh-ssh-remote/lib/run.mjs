/**
 * `ssh_run`：命令 × 主机组，一次调用内闭环「展开 → 预连接 → 弹卡 → 执行」。
 *
 * 关键约束：
 * - 每条 step 必须有 `why`（给自己的解释，也是卡片的「原因」列）；
 * - 一行 = 一条命令 × 一组主机（K-008），不是每台主机一行；
 * - 未勾选的行绝不执行；空选择 = 全部跳过；
 * - 预连接在弹卡之前发起，用用户读卡的时间覆盖握手延迟（K-003）。
 */
import { askApproval, buildApprovalQuestion, cardApprovalChannel, labelsOf, resolveWorkDir } from './approval.mjs'
import { phaseEntry } from './audit.mjs'
import { resolveTarget, targetLabel } from './hosts.mjs'

/** 校验并规范化模型给的 steps；错误信息写清楚怎么改。 */
export function normalizeSteps(args, { maxRows = 8 } = {}) {
  const rawSteps = args?.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error('steps 必须是非空数组')
  if (rawSteps.length > maxRows) throw new Error(`一次最多 ${maxRows} 条 step，这次给了 ${rawSteps.length} 条；请分批`)

  return rawSteps.map((raw, index) => {
    const where = `第 ${index + 1} 条 step`
    // CRLF 必须先归一：`\r` 不是 POSIX shell 的空白，`pwd\r` 会变成 command not found，
    // `then\r` 直接语法错，`> f\r` 连文件名都带个回车。单行命令碰巧被 trim 掉，
    // 所以这个问题只在多行命令（从 Windows 文档里粘来的）上炸。
    const command = typeof raw?.command === 'string' ? raw.command.replace(/\r\n?/g, '\n').trim() : ''
    if (command === '') throw new Error(`${where} 缺 command`)
    const why = typeof raw?.why === 'string' ? raw.why.trim() : ''
    if (why === '') throw new Error(`${where} 缺 why：必须写清这条命令为什么要跑（会显示在审批卡上）`)
    const hosts = Array.isArray(raw?.hosts) ? raw.hosts : []
    if (hosts.length === 0) throw new Error(`${where} 的 hosts 不能为空（可以是主机 id，也可以是 wsl:<发行版>）`)
    const cwd = typeof raw?.cwd === 'string' && raw.cwd.trim() !== '' ? raw.cwd.trim() : undefined
    // cwd 会拼进审批卡正文和 `cd` 命令，换行能在卡上伪造出一块内容。
    if (cwd !== undefined && /[\r\n]/.test(cwd)) throw new Error(`${where} 的 cwd 不能包含换行`)
    const timeoutMs = Number.isFinite(Number(raw?.timeoutMs)) ? Math.max(1000, Math.round(Number(raw.timeoutMs))) : undefined
    const hostNames = hosts.map((name) => String(name).trim()).filter((name) => name !== '')
    // 过滤后为空（`hosts: [""]` / `["  "]`）会产出一个「零目标 step」：卡上是空白勾选项，
    // 勾了也不执行任何东西，还会被渲染成「未勾选」。
    if (hostNames.length === 0) throw new Error(`${where} 的 hosts 里没有有效目标（收到了空白字符串）`)
    return { index, command, why, hostNames, cwd, timeoutMs }
  })
}

/** 把 host 名字解析成目标；解析失败的消息里带可用清单。 */
export function resolveStepTargets(steps, state) {
  return steps.map((step) => ({
    ...step,
    targets: step.hostNames.map((name) => resolveTarget(name, state)),
  }))
}

/**
 * 卡片行：一条 step 一行；命令用围栏代码块（正文字段只认块级元素），工作目录与超时放进附加信息。
 *
 * 选项那一行只写主机（B-23）：以前拼的是「主机 · 命令首行」，长命令被截成
 * `… for u in https://download.dock…`，除了看不懂还占掉了主机名的位置。
 * 同一台主机的多条 step 会得到完全相同的标签，由 `buildApprovalQuestion` 加 ①②③ 区分。
 */
export function stepsToRows(steps) {
  return steps.map((step) => {
    const meta = []
    if (step.cwd !== undefined && step.cwd !== null) meta.push(`工作目录 ${step.cwd}`)
    if (step.timeoutMs !== undefined && step.timeoutMs !== null) meta.push(`超时 ${Math.round(step.timeoutMs / 1000)}s`)
    const label = labelsOf(step.targets)
    return {
      target: label,
      head: label,
      meta: meta.join(' · '),
      code: step.command,
      why: step.why,
    }
  })
}

/** 只保留尾部字节并标注被截断。 */
export function trimOutput(text, limit) {
  if (typeof text !== 'string' || text === '') return { text: '', truncated: false }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return { text, truncated: false }
  const buffer = Buffer.from(text, 'utf8')
  let tail = buffer.subarray(Math.max(0, buffer.length - limit))
  // 按字节切会把多字节字符切一半（"中文" 变成 "�文"）：跳过 UTF-8 续字节落到字符边界。
  let start = 0
  while (start < tail.length && start < 4 && (tail[start] & 0xc0) === 0x80) start += 1
  tail = tail.subarray(start)
  return { text: `…（已截断，只保留尾部）\n${tail.toString('utf8')}`, truncated: true }
}

export function createRunTool({ store, pool, wsl, audit, dialog }) {
  const settings = () => store.settings

  return {
    name: 'ssh_run',
    description:
      '在远程主机或 WSL 发行版上执行命令。每条 step 会先在多选卡里单独一行给用户勾选，只有被勾选的才会执行。目标写成主机 id（见 hosts.json）或 wsl:<发行版>。每条 step 都是一次独立 shell：`cd` 与环境变量不跨条保留；不传 `cwd` 时远端从登录用户家目录开始、WSL 从 $HOME 开始。',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '要执行的步骤；一行一张卡片条目，最多 8 条',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string', description: '要执行的命令（非交互式；不要跑 vim/top 这类）' },
              why: { type: 'string', description: '为什么跑这条（会显示在审批卡上，必填）' },
              hosts: {
                type: 'array',
                items: { type: 'string' },
                description: '目标：主机 id 或 wsl:<发行版>；多个目标共用同一行审批',
              },
              cwd: { type: 'string', description: '远端/发行版内的工作目录，可选' },
              timeoutMs: { type: 'number', description: '这条命令的超时毫秒数，默认取设置' },
            },
            required: ['command', 'why', 'hosts'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
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
                step: { type: 'number' },
                target: { type: 'string' },
                ok: { type: 'boolean' },
                exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                // 链路在拿到退出码之前就断了：与「命令自己失败（退出码 1）」是两回事，
                // 单看退出码会让人对 rm/mv 做二次操作，所以单独给一个标记（D-26）。
                dropped: { type: 'boolean' },
                stdout: { type: 'string' },
                stderr: { type: 'string' },
                ms: { type: 'number' },
                error: { type: 'string' },
              },
              required: ['step', 'target', 'ok'],
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
          return [{ type: 'text', text: `没有执行：${value.error}` }]
        }
        if (value.results.length === 0) {
          return [{ type: 'text', text: `没有执行任何命令（批准 ${value.approved} 行，跳过 ${value.skipped} 行）。` }]
        }
        const blocks = value.results.map((row) => {
          // 链路断了时不能只写「退出码 无」：读的人会以为是命令自己没退出，然后去重试。
          const status = row.dropped === true ? '连接中断' : `退出码 ${row.exitCode ?? '无'}`
          const head = `${row.ok ? '✅' : '❌'} 第 ${row.step + 1} 条 · ${row.target} · ${status} · ${row.ms ?? 0}ms`
          const parts = [head]
          if (typeof row.error === 'string' && row.error !== '') parts.push(`错误：${row.error}`)
          if (row.stdout !== '') parts.push('```\n' + row.stdout.replace(/\n$/, '') + '\n```')
          if (row.stderr !== '') parts.push('stderr:\n```\n' + row.stderr.replace(/\n$/, '') + '\n```')
          return parts.join('\n')
        })

        // 没勾的行也要留痕迹：只报「执行了什么」，模型会以为整单都跑了。
        const ranSteps = new Set(value.results.map((row) => row.step))
        const skippedLines = []
        for (const [index, step] of (Array.isArray(_args?.steps) ? _args.steps : []).entries()) {
          if (ranSteps.has(index)) continue
          const hosts = Array.isArray(step?.hosts) ? step.hosts : []
          skippedLines.push(`第 ${index + 1} 条${hosts.length > 0 ? `（${hosts.join(' / ')}）` : ''}`)
        }
        if (skippedLines.length > 0) {
          blocks.push(`⏭ 未勾选，未执行：${skippedLines.join('、')}`)
        }
        return [{ type: 'text', text: blocks.join('\n\n') }]
      },
    },

    async execute(args, exec) {
      // 审计靠它把同一次调用的记录串成一条时间线（D-30）。
      const callId = exec?.callId
      const snapshot = await store.ensureLoaded()
      const state = { hosts: snapshot.hosts, wsl: snapshot.wsl }
      let steps
      try {
        steps = resolveStepTargets(normalizeSteps(args, { maxRows: settings().maxCardRows }), state)
      } catch (error) {
        return { approved: 0, skipped: 0, results: [], error: String(error?.message ?? error) }
      }

      // 预连接：先连上，让用户读卡的时间覆盖握手；失败留给执行阶段报。
      const remotes = new Map()
      for (const step of steps) {
        for (const target of step.targets) {
          if (target.kind === 'remote' && !remotes.has(target.id)) {
            remotes.set(
              target.id,
              pool.connect(target, { signal: exec?.signal }).catch((error) => {
                remotes.set(target.id, { failed: String(error?.message ?? error) })
                return undefined
              }),
            )
          }
        }
      }

      // 建卡也可能失败（例如热加载把 maxCardRows 调小了，而 steps 是按旧值放行的）：
      // 包成结构化错误，别把原始异常抛给宿主。
      let question
      try {
        question = buildApprovalQuestion({
          header: 'SSH · 执行确认',
          question: '勾选要执行的行',
          rows: stepsToRows(steps),
          maxRows: settings().maxCardRows,
        })
      } catch (error) {
        return { approved: 0, skipped: 0, results: [], error: String(error?.message ?? error) }
      }

      // 进入 approval：从这一刻起卡住，就是「在等用户点卡片」（D-30）。
      audit.record(phaseEntry({ kind: 'run', phase: 'approval', callId }))
      let approval
      try {
        approval = await askApproval({ question, fallbackSelect: cardApprovalChannel(dialog, resolveWorkDir(exec)), signal: exec?.signal })
      } catch (error) {
        return { approved: 0, skipped: 0, results: [], error: String(error?.message ?? error) }
      }

      const approvedSet = new Set(approval.indices)
      const approvedSteps = steps.filter((step) => approvedSet.has(step.index))
      if (approvedSteps.length === 0) {
        return { approved: 0, skipped: steps.length, results: [] }
      }

      // 预连接在弹卡前就发起了（K-003），但工具真正卡在「建连接」的时刻是这里等它落地。
      // 纯 WSL 的调用没有连接可等，就不记 connect。
      if (remotes.size > 0) audit.record(phaseEntry({ kind: 'run', phase: 'connect', callId }))
      await Promise.allSettled([...remotes.values()])

      // 进入 exec：这条之后的记录都是执行结果（D-30）。
      audit.record(phaseEntry({ kind: 'run', phase: 'exec', callId }))

      const rows = []
      for (const step of approvedSteps) {
        const settled = await Promise.allSettled(
          step.targets.map(async (target) => {
            const timeoutMs = step.timeoutMs ?? settings().stepTimeoutMs
            if (target.kind === 'wsl') {
              const outcome = await wsl.run(target.distro, step.command, {
                workdir: step.cwd,
                timeoutMs,
                signal: exec?.signal,
              })
              return { target, outcome }
            }
            const outcome = await pool.run(target, step.command, {
              cwd: step.cwd,
              timeoutMs,
              signal: exec?.signal,
            })
            return { target, outcome }
          }),
        )

        for (let i = 0; i < settled.length; i += 1) {
          const target = step.targets[i]
          const item = settled[i]
          if (item.status === 'rejected') {
            const message = String(item.reason?.message ?? item.reason)
            rows.push({ step: step.index, target: targetLabel(target), ok: false, exitCode: null, stdout: '', stderr: '', ms: 0, error: message })
            audit.record({
              kind: 'run',
              event: 'result',
              phase: 'exec',
              callId,
              target: targetLabel(target),
              command: step.command,
              approved: true,
              exitCode: null,
              ms: 0,
              error: message,
            })
            continue
          }
          const outcome = item.value.outcome
          // WSL 的本地超时/被信号杀没有退出码也没有 stderr，只报「❌ 退出码 无」会让模型
          // 以为是远端命令失败，然后换个写法重试（可能是破坏性命令）。这里把归因写清楚。
          let localError
          if (outcome.timedOut === true) {
            localError = `本地超时 ${Math.round((step.timeoutMs ?? settings().stepTimeoutMs) / 1000)}s 被杀，远端可能只执行了一半`
          } else if (outcome.dropped === true) {
            // 远端链路在给出退出码之前就断了（服务端/网络把通道关了）：命令可能根本没跑，
            // 也可能跑到一半。这不是「命令自己失败」，所以不编一个退出码出来（D-26）。
            localError = `与 ${targetLabel(target)} 的连接中断（命令可能未执行完）`
          } else if (typeof outcome.signalName === 'string' && outcome.signalName !== '') {
            localError = `本地进程被信号 ${outcome.signalName} 终止，远端可能只执行了一半`
          }
          rows.push({
            step: step.index,
            target: targetLabel(target),
            ok: outcome.exitCode === 0,
            exitCode: outcome.exitCode ?? null,
            ...(outcome.dropped === true ? { dropped: true } : {}),
            stdout: outcome.stdout ?? '',
            stderr: outcome.stderr ?? '',
            ms: outcome.ms ?? 0,
            ...(localError === undefined ? {} : { error: localError }),
          })
          audit.record({
            kind: 'run',
            event: 'result',
            phase: 'exec',
            callId,
            target: targetLabel(target),
            command: step.command,
            approved: true,
            exitCode: outcome.exitCode ?? null,
            ...(outcome.dropped === true ? { dropped: true } : {}),
            ms: outcome.ms ?? 0,
            stdoutBytes: Buffer.byteLength(outcome.stdout ?? '', 'utf8'),
            stderrBytes: Buffer.byteLength(outcome.stderr ?? '', 'utf8'),
          })
        }
      }

      // 全局输出预算：逐行按剩余额度截断，保证工具结果不会撑爆上下文。
      let remaining = settings().outputBytesTotal
      for (const row of rows) {
        const limit = Math.max(0, Math.min(settings().outputBytesPerStep, remaining))
        const stdout = trimOutput(row.stdout, limit)
        remaining = Math.max(0, remaining - Buffer.byteLength(stdout.text, 'utf8'))
        const stderr = trimOutput(row.stderr, Math.max(0, Math.min(limit, remaining)))
        remaining = Math.max(0, remaining - Buffer.byteLength(stderr.text, 'utf8'))
        row.stdout = stdout.text
        row.stderr = stderr.text
      }

      return { approved: approvedSteps.length, skipped: steps.length - approvedSteps.length, results: rows }
    },
  }
}
