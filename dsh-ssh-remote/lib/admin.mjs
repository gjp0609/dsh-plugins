/**
 * 主机管理：设置页维护用的纯函数 + 只读工具 + 桌面勾选卡的执行器。
 *
 * 边界（2026-11-16 起，D-49）：
 * - **维护只在插件设置页**（`lib/api/*` + `lib/client.js` 的浏览器页面）：新增主机、改密码、
 *   改备注、删除主机、接入点导入都在那边做，会话侧不再有入口。这里留下的纯函数
 *   （`upsertHost` / `setHostLabel` / `serializeHostsDocument`）是设置页与 `store` 复用的那一份实现；
 * - 会话侧只剩两件事：`ssh_admin` 的 `list`（只读查询）与卡片执行器的 `selectRows`
 *   （执行 / 搬运的勾选卡，勾选卡就是审批）；
 * - 弹窗只有勾选卡这一种形态：本文件不再有确认卡（confirm）与表单卡（form）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PORT, findHostByIdentity, suggestHostId } from './hosts.mjs'

/** 把内部结构写回 hosts.json 的形状（去掉 `id` / `kind` 这类合成字段）。 */
export function serializeHostsDocument(document) {
  const hosts = {}
  for (const [id, host] of Object.entries(document.hosts ?? {})) {
    hosts[id] = {
      address: host.address,
      port: host.port,
      user: host.user,
      label: host.label,
      tags: [...(host.tags ?? [])],
      // 内部来源标记：写回时保留，否则「导入的主机」在下次重载后会退化成普通主机，
      // 建连改走密码认证（而它本来就没有密码）。
      ...(host.via === undefined || host.via === null ? {} : { via: { ...host.via } }),
    }
  }
  const wsl = {}
  for (const [distro, item] of Object.entries(document.wsl ?? {})) {
    wsl[distro] = { label: item.label, user: item.user ?? null }
  }
  return { hosts, wsl, defaults: { ...(document.defaults ?? {}) } }
}

/**
 * 新增或更新一台主机（纯逻辑，不动磁盘、不碰密码）。设置页保存主机时走这里。
 *
 * 判重只看 `地址 + 端口 + 用户名`（`hostIdentity`，D-38）：
 * - 命中 → 更新那台的简称/标签，**id 不变**（vault 以 id 为键，换 id 等于丢密码）；
 * - 没命中 → 生成一个短 id（默认就是地址）再加一条。
 *
 * 因此「改地址/改用户名会让已存密码失效」这件事在这里不再发生：那两种改动按判据就是
 * 另一台主机，会新增一条，原主机与它的密码原样保留。
 * 密码的写与不写由调用方（`lib/api/handlers.mjs`）决定：这里只回答「是哪台、写成什么样」。
 */
export function upsertHost(document, input) {
  const address = String(input?.address ?? '').trim()
  const user = String(input?.user ?? '').trim()
  if (address === '') throw new Error('address 不能为空')
  if (user === '') throw new Error('user 不能为空')
  const port = input?.port === undefined ? DEFAULT_PORT : Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port「${input?.port}」不合法（1-65535）`)

  // 简称留空＝用地址：设置页的占位就是这么写的，两态（新增/修改）用同一条规则。
  const labelText = String(input?.label ?? '').trim()
  const label = labelText === '' ? address : labelText
  const tags = Array.isArray(input?.tags)
    ? input.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
    : undefined

  const existing = findHostByIdentity(document, { address, port, user })
  const host = {
    id: existing?.id ?? suggestHostId(document, { address, port }),
    kind: 'remote',
    address,
    port,
    user,
    label,
    tags: tags ?? existing?.tags ?? [],
    // 手工再填一次同一台（地址+端口+用户名都相同）不该把它「降级」成普通主机：
    // 来源标记跟着走，建连方式不变；这次填的密码只写进密码库、不参与连接。
    ...(existing?.via === undefined ? {} : { via: { ...existing.via } }),
  }
  return {
    document: { ...document, hosts: { ...document.hosts, [host.id]: host } },
    host,
    replaced: existing !== undefined,
  }
}

/**
 * 改一台主机的备注（纯逻辑，不动磁盘）。设置页「改备注」走这里。
 *
 * 备注只是给人看的名字，不参与任何判据（判重是 `地址|端口|用户名`），所以改它**不动**地址、
 * 端口、用户名与密码——普通主机与导入的主机一视同仁。导入主机的备注原本写死成资产名，
 * 资产名等于 IP 时就等于没有备注，必须能改。
 *
 * `label` 留空＝退回地址（与 `upsertHost` 同一条规则：不许出现空备注）。
 * @returns `{ document, host, previousLabel, changed }`
 */
export function setHostLabel(document, hostId, label) {
  const id = String(hostId ?? '').trim()
  if (id === '') throw new Error('id 不能为空')
  const host = document?.hosts?.[id]
  if (host === undefined) throw new Error(`没有配置主机「${id}」`)
  const address = String(host.address ?? '').trim()
  const text = String(label ?? '').trim()
  const nextLabel = text === '' ? address : text
  const updated = { ...host, label: nextLabel }
  return {
    document: { ...document, hosts: { ...document.hosts, [id]: updated } },
    host: updated,
    previousLabel: host.label,
    changed: nextLabel !== host.label,
  }
}

/**
 * 卡片子进程的「退出后排空窗口」（`graceMs`）。
 *
 * 宿主的 `ctx.subprocess.spawn` 结算 `done` 的条件是：**目标进程退出**（runner 的 target-exit）
 * 之后，再等 stdout/stderr 关闭；等不到就在 `graceMs` 后强制结算（D-26 记了这条实测结论）。
 * 卡片宿主会拉起 WebView2 子进程，它们继承着这两个管道——宿主进程没了，管道写端还在，
 * `close` 永远不来。所以这个窗口必须短：默认的 20s 会让「卡片已经没影了」还要干等 20 秒。
 * 500ms 只用于把 pwsh 退出前写下的那点 stdout/stderr 收干净，不是卡片的存活时间。
 */
const DIALOG_DRAIN_GRACE_MS = 500

/**
 * 读子进程已收集的一段输出；拿不到就当空串（诊断路径不该反过来抛异常）。
 * @param reader - `handle.collected.stdout` / `.stderr`
 */
function readCollected(reader) {
  try {
    return reader?.readFrom?.(0)?.text ?? ''
  } catch {
    return ''
  }
}

/**
 * 桌面勾选卡的执行器（执行 / 搬运的审批界面）。
 *
 * 弹窗只有这一种形态：新增主机、改密码、改备注、删除主机这些维护动作只在插件设置页里做
 * （浏览器页面），会话侧不再弹表单卡与确认卡。
 * @param subprocess - `ctx.subprocess`
 * @param scriptDir - `scripts/` 绝对路径
 */
export function createDialogRunner({ subprocess, scriptDir, cwd }) {
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
    throw new Error('拿不到 subprocess 服务，无法弹原生对话框')
  }

  /**
   * 卡片进程这一侧只有一条铁律（D-26）：**它结束（正常退出、被杀、崩掉）都必须
   * ① 让等待立刻结算，② 把它拉起的 WebView2 子进程一起带走**。
   *
   * ② 靠 `terminate()`：宿主的 terminate 是「杀进程树」——Windows 上走 Job/`taskkill /T /F`，
   * 不是杀单个 pwsh。不调它的话，上次那种「pwsh 没了、三个 msedgewebview2 还在」的孤儿
   * 会继续占着管道，下一次卡片的 `done` 也照样结算不了。
   */
  async function awaitDialogDone(handle, what) {
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(`${what}执行失败：${error?.message ?? error}`)
    } finally {
      try {
        handle.terminate?.()
      } catch {
        // 已经退出/已经被杀了：终止是幂等的，收不掉也不影响结果
      }
    }
    return outcome
  }

  return {
    /**
     * 选行弹窗（审批用）：上方只读详情，下方逐行勾选。
     *
     * 这是 ssh 审批**唯一**的界面（C-10）：宿主内置的问题弹窗不再参与，子代理与根会话
     * 都落到这张卡上。关窗口按「一行都不选」处理；卡片不自动关闭（没有自超时，只能人工关）。
     * 选项与详情走临时文件：命令里的引号、换行、`$` 都不用转义。
     */
    async selectRows({ detail, rows = [], options = [], workDir = '', eyebrow = '', signal } = {}) {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-select-'))
      const optionsFile = join(dir, 'options.json')
      const detailFile = join(dir, 'detail.txt')
      const answerFile = join(dir, 'answer.json')
      const rowsFile = join(dir, 'rows.json')
      try {
        writeFileSync(optionsFile, JSON.stringify(Array.isArray(options) && options.length > 0 ? options : rows.map((row) => row.label)), 'utf8')
        // 每行自己的正文：弹窗把「勾选框 + 它的命令」画在一起，多行时才分得清。detail 只作兜底。
        writeFileSync(detailFile, String(detail ?? ''), 'utf8')
        writeFileSync(rowsFile, JSON.stringify(rows), 'utf8')
        const argv = [
          'pwsh',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-STA',
          '-File',
          `${scriptDir}\\dialog.ps1`,
          '-Mode',
          'select',
          '-OptionsFile',
          optionsFile,
          '-DetailFile',
          detailFile,
          '-RowsFile',
          rowsFile,
          '-OutFile',
          answerFile,
        ]
        // 抬头显示「工作目录」：弹窗在桌面上冒出来时，得让人知道是哪个项目在问。
        const projectDir = String(workDir ?? '').trim()
        if (projectDir !== '') {
          argv.push('-WorkDir', projectDir)
        }
        // 抬头按用途给；不给就由外壳用缺省的「SSH · 执行确认」。
        if (eyebrow !== '') argv.push('-Eyebrow', eyebrow)

        let handle
        try {
          handle = subprocess.spawn({
            argv,
            cwd,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 64 * 1024 },
              stderr: { maxBytes: 64 * 1024 },
            },
            graceMs: DIALOG_DRAIN_GRACE_MS,
            signal,
          })
        } catch (error) {
          throw new Error(`审批弹窗起不来：${error?.message ?? error}`)
        }

        const outcome = await awaitDialogDone(handle, '审批弹窗')
        const exitCode = outcome?.exitCode ?? null
        if (exitCode === 2) return { answered: false, selected: [] }
        if (exitCode !== 0) {
          let stderr = ''
          try {
            stderr = (handle.collected?.stderr?.readFrom?.(0)?.text ?? '').trim()
          } catch {
            stderr = ''
          }
          // 没有任何报错信息却非 0 退出：多半是窗口被系统/宿主收走（实测关闭窗口时可能拿到 1）。
          // 审批是要防呆的，这种情况按「没勾选」处理——宁可什么都不执行，也不要报错后让模型去猜。
          // 「点停止」走的也是这条路（D-26）：宿主强杀卡片进程 → 非 0 退出 + stderr 空 → 一行都不执行，
          // 所以停 = 跳过 = 不批准任何一行，绝不会变成「批准了某个意外结果」。
          if (stderr === '') return { answered: false, selected: [] }
          throw new Error(`审批弹窗异常退出（${exitCode}）：${stderr.slice(0, 300)}`)
        }

        let answer
        try {
          answer = JSON.parse(readFileSync(answerFile, 'utf8'))
        } catch (error) {
          throw new Error(`读不到审批弹窗的结果：${error?.message ?? error}`)
        }
        return {
          answered: answer?.answered === true,
          selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [],
        }
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // 临时目录清不掉不影响结果
        }
      }
    },
  }
}

/**
 * 管理动作集合（会话侧**只读**）。写入都在插件设置页：那里走 `store.updateHosts()`，
 * 是 hosts.json 的唯一写入口；会话侧不再有第二套写盘路径。
 */
export function createAdmin({ store }) {
  function listLines() {
    const lines = []
    for (const host of Object.values(store.hosts)) {
      const saved = store.vault.has(host.id)
        ? '密码已保存'
        : host.via === undefined
          ? '无密码'
          : '凭据已接入'
      const tags = host.tags.length === 0 ? '' : `  [${host.tags.join(', ')}]`
      lines.push(`${host.id}  ${host.user}@${host.address}:${host.port}  ${host.label}  ${saved}${tags}`)
    }
    for (const item of Object.values(store.wsl)) {
      lines.push(`wsl:${item.distro}  ${item.label}  （本机 WSL，不用密码）`)
    }
    return lines
  }

  return {
    async list() {
      await store.ensureLoaded()
      const lines = listLines()
      return {
        ok: true,
        action: 'list',
        message: lines.length === 0 ? '还没有配置任何主机或 WSL 发行版' : `共 ${lines.length} 个目标`,
        lines,
        warnings: [...store.warnings],
      }
    },
  }
}

/** 工具定义（JSON Schema 参数 / 结构化输出 + 中文渲染）。会话侧只读，写入在插件设置页。 */
export function createAdminTool(admin) {
  return {
    name: 'ssh_admin',
    description:
      '只读列出现有 SSH 主机与 WSL 发行版：action 只有 list。新增主机、改密码、改备注、删除主机、接入点导入都在**插件设置页「SSH 主机」**里做（浏览器页面），会话侧没有这些动作，也没有任何卡片。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list'],
          description: '要做的动作：只有 list（只读列出主机）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          lines: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        const lines = Array.isArray(value?.lines) ? value.lines : []
        const warnings = Array.isArray(value?.warnings) ? value.warnings : []
        const head = value?.ok === false ? `未执行：${value?.message ?? ''}` : `完成：${value?.message ?? ''}`
        return [
          {
            type: 'text',
            text: [head, ...lines.map((line) => `- ${line}`), ...warnings.map((line) => `⚠ ${line}`)].join('\n'),
          },
        ]
      },
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        if (action === 'list') return admin.list()
        return {
          ok: false,
          message: `不认识的 action「${action}」：会话侧只剩 list（只读列出主机）；新增 / 改密码 / 改备注 / 删除主机 / 接入点导入都在插件设置页「SSH 主机」里做`,
          lines: [],
        }
      } catch (error) {
        return { ok: false, action, message: String(error?.message ?? error), lines: [] }
      }
    },
  }
}
