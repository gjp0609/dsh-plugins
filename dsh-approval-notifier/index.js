/**
 * dsh-approval-notifier —— Host 半边（唯一逻辑所在）。
 *
 * 作用：提权审批请求先照常交给浏览器（卡片照旧出现）；若 delayMs 内没人应答，
 * 就在本机弹出一个 Windows 原生置顶窗口，用鼠标批准/拒绝。两侧谁先答谁生效。
 *
 * 关键约束（改动前先看插件 README.md）：
 * - 只用 Node 内置模块：profile 安装的插件解析不到 DSH 自带的 `@deepseek-ai/*` 包，
 *   声明这类依赖还会触发版本兼容检查，因此一律不引用；
 * - 弹窗永不自动接受、也永不自动拒绝：到点只关窗，请求继续等浏览器；
 * - 任何异常路径都不得静默放行：出问题时把决定权原样交回下游（浏览器）；
 * - 请求被取消、浏览器先答、插件被卸载时，一律终止弹窗进程，不留孤儿。
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 需要的 Host 服务：拉起弹窗进程。 */
export const inject = ['subprocess']

/** 本插件在公共父目录（`<DSH_HOME>/plugin-data`）下的子目录名。 */
const PLUGIN_DIR_NAME = 'approval-notifier'
/** 单条日志文件上限，超过后滚动为 `<name>.1`（覆盖旧的）。 */
const LOG_MAX_BYTES = 1024 * 1024
/** 按 callId 反查 tool/call 时最多回溯的会话事件条数（尾部有限回溯，不做全量扫描）。 */
const TOOL_CALL_LOOKBACK = 500
/**
 * 「参数取不到摘要、退回显示 JSON」这条兜底路径的最大字符数，超出即截断并显式标注。
 * 只用于兜底 JSON：命令 / 路径 / 参数的摘要正文一律完整进载荷，**不截断**（C-08）。
 */
const COMMAND_MAX_CHARS = 6000
/** 并发弹窗的层叠档位数。 */
const POPUP_SLOTS = 5
/**
 * 弹窗用 stdout 交回结果的标记前缀。
 * 宿主给弹窗进程的是受限令牌（Low 完整性），只能写"授权根目录"（当前工作区 + 本会话私有 temp），
 * 而插件的 dataDir 在 `DSH_HOME` 下通常不在其中 —— 结果文件往往写不出去。
 * stdout 管道由宿主创建并在收集，不受沙箱文件权限影响，所以它是这条路上的可靠通道。
 */
const RESULT_MARKER = '@@DSH-APPROVAL-NOTIFIER-RESULT@@'

const CONFIG_DEFAULTS = Object.freeze({
  /** 总开关；false 时不注册任何监听。 */
  enabled: true,
  /** 浏览器优先的等待时长（毫秒）：先让浏览器卡片出现，超时才弹窗。0 = 立即弹窗。 */
  delayMs: 10000,
  /** 弹窗出现后按钮保持禁用的时长（毫秒），防止误点。 */
  armDelayMs: 1000,
  /** 弹窗自动关闭的时长（毫秒）；只关窗、不做任何决定。0 = 永不自动关闭。 */
  windowCloseAfterMs: 600000,
  /** 窗口无决定关闭后，再过多久重新弹一次；0 = 不再提醒。 */
  renotifyMs: 0,
  /** 弹窗是否播放提示音。 */
  sound: true,
  /** 为 true 时把插件自身的写入失败等诊断打到宿主控制台。 */
  debug: false,
  /** 拉起弹窗的可执行文件：pwsh（PowerShell 7）或 powershell（Windows PowerShell 5.1）。 */
  shell: 'pwsh',
  /** 数据目录；null 表示默认 `<DSH_HOME>/plugin-data/approval-notifier`。 */
  dataDir: null,
})

/** 取非空字符串，否则 null（日志里统一用 null 表示"没有"）。 */
function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 按类型宽松归一配置：非法值回落默认并记一条说明，绝不因为配置烂而崩或放行。 */
function normalizeConfig(raw) {
  const settings = { ...CONFIG_DEFAULTS }
  const notes = []
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  for (const key of ['enabled', 'sound', 'debug']) {
    const value = source[key]
    if (value === undefined) continue
    if (typeof value === 'boolean') settings[key] = value
    else notes.push(`${key}=${JSON.stringify(value)} 不是布尔值，已回落默认 ${CONFIG_DEFAULTS[key]}`)
  }
  for (const key of ['delayMs', 'armDelayMs', 'windowCloseAfterMs', 'renotifyMs']) {
    const value = source[key]
    if (value === undefined) continue
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) settings[key] = Math.floor(value)
    else notes.push(`${key}=${JSON.stringify(value)} 不是非负数字，已回落默认 ${CONFIG_DEFAULTS[key]}`)
  }
  for (const key of ['shell', 'dataDir']) {
    const value = textOrNull(source[key])
    if (value !== null) settings[key] = value
  }
  return { settings, notes }
}

/**
 * 解析数据目录：默认 `DSH_HOME/plugin-data/approval-notifier`，可用 `config.dataDir` 覆盖。
 * 家目录下只多 `plugin-data` 一个目录，本仓库后续插件各自建子目录。
 */
function resolveDataDir(settings) {
  if (settings.dataDir !== null) return settings.dataDir
  const home = textOrNull(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(home, 'plugin-data', PLUGIN_DIR_NAME)
}

/** 用户平时改的配置文件（放在数据目录里，不进 git、不碰 profile 文件）。 */
const CONFIG_FILE_NAME = 'config.json'
/** 可以在 config.json 里改的键：下一次审批请求即生效，不需要重启。 */
const TUNABLE_KEYS = ['delayMs', 'armDelayMs', 'windowCloseAfterMs', 'renotifyMs', 'sound', 'shell']

/**
 * 首次运行时生成一份带说明的默认配置。
 * 只在文件不存在时创建一次；之后**绝不改写**用户的文件（写坏值只会回落默认并记日志）。
 */
function ensureConfigFile(log, configFile, values) {
  try {
    if (existsSync(configFile)) return
    mkdirSync(dirname(configFile), { recursive: true })
    const document = {
      _readme: '这是 dsh-approval-notifier 的配置：改完保存即生效，下一次审批请求就按新值走，不需要重启 DSH。dataDir / enabled / debug 不在这里改（它们在 profile 的 cordis.patch.yml 里）。',
      _help: {
        delayMs: '浏览器优先的等待毫秒数：先让浏览器卡片照常出现，超过这个时间才弹窗。0 = 立刻弹窗。',
        armDelayMs: '弹窗出现后按钮保持禁用的毫秒数，用来防止误点。',
        windowCloseAfterMs: '弹窗自动关闭的毫秒数：只关窗，不会自动接受、也不会自动拒绝。0 = 永不自动关闭。',
        renotifyMs: '窗口自行关闭后，再过多少毫秒重新弹一次；0 = 不再提醒。',
        sound: '弹窗是否播放提示音（true / false）。',
        shell: '拉起弹窗的可执行文件：pwsh（PowerShell 7）或 powershell（Windows PowerShell 5.1）。',
      },
      ...values,
    }
    writeFileSync(configFile, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    log({ event: 'plugin', phase: 'config-created', configFile })
  } catch (error) {
    log({ event: 'plugin', phase: 'config-create-failed', configFile, error: String(error?.message ?? error) })
  }
}

/**
 * 造一个"每次审批请求现取"的配置解析器。
 * 优先级：`config.json`（用户平时改的）> patch 行（profile 的 `cordis.patch.yml`）。
 * `dataDir` / `enabled` / `debug` 只认 patch 行（改它们要重启），避免自指与歧义。
 * 文件缺失、读不动或内容写坏，都只回落默认值并记一条说明，绝不抛给事件链。
 */
function createSettingsResolver({ patchConfig, patchSettings, dataDir, log }) {
  const configFile = join(dataDir, CONFIG_FILE_NAME)
  let lastStamp = null
  let lastSettings = patchSettings
  let loggedNotes = null
  return () => {
    let stamp
    let raw
    try {
      const info = statSync(configFile)
      stamp = `${info.mtimeMs}:${info.size}`
      raw = readFileSync(configFile, 'utf8')
    } catch {
      lastStamp = null
      return patchSettings
    }
    if (stamp === lastStamp) return lastSettings
    const notes = []
    const fileValues = {}
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of TUNABLE_KEYS) {
          if (Object.hasOwn(parsed, key)) fileValues[key] = parsed[key]
        }
      } else {
        notes.push('config.json 顶层不是对象，已忽略整份文件')
      }
    } catch (error) {
      notes.push(`config.json 解析失败（${error?.message ?? error}），已忽略整份文件`)
    }
    const normalized = normalizeConfig({ ...patchConfig, ...fileValues })
    const allNotes = [...notes, ...normalized.notes]
    lastStamp = stamp
    lastSettings = normalized.settings
    const signature = allNotes.join('|')
    if (allNotes.length > 0 && signature !== loggedNotes) {
      loggedNotes = signature
      log({ event: 'plugin', phase: 'config-notes', configFile, notes: allNotes })
    }
    return normalized.settings
  }
}

/** 造一个"绝不会抛"的 JSONL 追加器；写入失败只可能在 debug 时打到控制台。 */
function createLogger(logFile, debug) {
  let directoryReady = false
  return (record) => {
    try {
      if (!directoryReady) {
        mkdirSync(dirname(logFile), { recursive: true })
        directoryReady = true
      }
      try {
        if (statSync(logFile).size > LOG_MAX_BYTES) renameSync(logFile, `${logFile}.1`)
      } catch {
        // 文件不存在或已被移走：继续追加即可
      }
      appendFileSync(logFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch (error) {
      if (debug) {
        try {
          console.warn('[approval-notifier] 日志写入失败:', error?.message ?? error)
        } catch {
          // 控制台不可用也忽略
        }
      }
    }
  }
}

/**
 * 按 callId 反查本次调用的 `tool/call` 事件，取回模型产出的原始参数。
 * 与 `@deepseek-ai/dsh-user-approval` 读 `approval/policy` 同一手法：尾部有限回溯。
 * 参数内容只用于弹窗展示，**不写入日志**（可能含敏感串）。
 * 注意：`Session.eventAt` 已被官方标注 deprecated，但仍被官方插件使用；这里全程容错，
 * 将来若被移除，退化为"弹窗不显示参数"，不影响审批本身。
 */
function findToolCall(req) {
  const callId = textOrNull(req?.callId)
  if (callId === null) return { found: false, probe: 'no-callId' }
  try {
    const session = req?.agent?.session
    if (session === undefined || session === null) return { found: false, probe: 'no-session' }
    const seqEnd = typeof session.seq === 'number' ? session.seq : 0
    for (let seq = seqEnd - 1, seen = 0; seq >= 0 && seen < TOOL_CALL_LOOKBACK; seq -= 1, seen += 1) {
      const event = session.eventAt(seq)
      if (event?.type !== 'tool/call') continue
      if (event.data?.callId !== callId) continue
      const args = event.data.arguments
      return {
        found: typeof args === 'string' && args !== '',
        argumentsText: typeof args === 'string' ? args : null,
        toolCallName: textOrNull(event.data.name),
        toolCallSeq: seq,
        argumentsLength: typeof args === 'string' ? args.length : 0,
      }
    }
    return { found: false, probe: `not-in-tail-${TOOL_CALL_LOOKBACK}` }
  } catch (error) {
    return { found: false, probe: `lookup-threw:${error?.message ?? error}` }
  }
}

/** 从参数 JSON 里挑一段最有信息量的摘要（命令/路径），其余原样格式化。 */
function describeArguments(argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText === '') return { summary: null, pretty: null }
  let parsed
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    return { summary: null, pretty: argumentsText }
  }
  if (parsed === null || typeof parsed !== 'object') return { summary: null, pretty: String(parsed) }
  const candidates = ['command', 'file_path', 'path', 'pattern', 'url', 'argv']
  let summary = null
  for (const key of candidates) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') {
      summary = value.trim()
      break
    }
    if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
      summary = value.join(' ')
      break
    }
  }
  let pretty
  try {
    pretty = JSON.stringify(parsed, null, 2)
  } catch {
    pretty = argumentsText
  }
  return { summary, pretty }
}

/** 命令块文本：摘要正文（命令 / 路径 / 参数原文）**完整**进载荷，一个字都不截
 *  （`PREFERENCES.md` C-08：卡上的命令就是业务层的原文；截断会造成「看到 400 字、执行另一条」）。
 *  不自己拼 "$" 之类的 shell 提示符：代码块本身已经框成「命令」了，再加提示符是重复；
 *  而且 Write/Read 这类工具的摘要其实是路径，前面挂个 "$" 只会让人误以为要跑命令。
 *  完整 JSON 不显示：它与摘要重复，而且往往上千字符，会把真正要看的那一行挤走。
 *  只有参数里没有可提取摘要的工具（如纯参数型调用）才退回显示 JSON —— 否则卡片上什么都没有；
 *  这条兜底路径可能极大（例如 Write 的整份文件内容），所以保留 6000 字符上限，但**截断必须显式标注**。 */
function buildCommandText(settings, lookup) {
  if (lookup.found !== true) return `（未能在会话日志里反查到这次调用的参数：${lookup.probe ?? 'unknown'}）`
  const { summary, pretty } = describeArguments(lookup.argumentsText)
  if (summary === null) {
    const text = `--- 参数（JSON）---\n${pretty ?? ''}`
    return text.length > COMMAND_MAX_CHARS ? `${text.slice(0, COMMAND_MAX_CHARS)}\n…（已截断）` : text
  }
  return summary
}

/** 无可连接页面时不必等浏览器，直接弹窗；取不到该服务时按"有页面"处理（保持保守等待）。 */
function detectLiveClient(ctx) {
  try {
    const gateway = ctx.get?.('typertGateway')
    if (gateway === undefined || gateway === null) return undefined
    if (typeof gateway.hasLiveClient !== 'function') return undefined
    return gateway.hasLiveClient() === true
  } catch {
    return undefined
  }
}

/** 把监听器的返回值整理成可读摘要。 */
function summarizeOutcome(outcome) {
  if (typeof outcome === 'string') return outcome
  if (outcome !== null && typeof outcome === 'object' && Array.isArray(outcome.answers)) {
    return {
      answers: outcome.answers.map((answer) => ({
        id: answer?.id ?? null,
        selectedCount: Array.isArray(answer?.selected) ? answer.selected.length : 0,
        hasCustom: typeof answer?.custom === 'string',
      })),
    }
  }
  return null
}

/** 永不 reject 的下游结算包装：既能在竞速里判断胜负，又避免未处理拒绝。 */
function settleDownstream(next) {
  return (async () => {
    try {
      return { ok: true, value: await next() }
    } catch (error) {
      return { ok: false, error }
    }
  })()
}

/** 只解析一次的 abort 承诺（无 signal 时永不结算）。 */
function abortPromise(signal) {
  if (signal === undefined || signal === null) return new Promise(() => {})
  if (signal.aborted) return Promise.resolve('aborted')
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
}

/**
 * 定时器承诺；abort 时提前结算。
 * 定时器登记在 `timers` 里，由插件卸载时统一清理（不用 unref：unref 会让
 * "只等这一个定时器"的场景直接不触发）。
 */
function waitFor(milliseconds, signal, timers) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('aborted')
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      timers.delete(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const timer = setTimeout(() => finish('elapsed'), milliseconds)
    timers.add(timer)
    const onAbort = () => finish('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 读取弹窗写回的结果文件；读不到（被终止、写失败）返回 null。 */
function readPopupResult(outFile) {
  try {
    const raw = readFileSync(outFile, 'utf8')
    const parsed = JSON.parse(raw)
    const kind = textOrNull(parsed?.kind)
    return kind === null ? null : { kind, detail: textOrNull(parsed?.detail), at: textOrNull(parsed?.at) }
  } catch {
    return null
  }
}

/**
 * 从收集到的 stdout 里解析弹窗用标记行交回的结果；没有标记行或全是坏行时返回 null。
 * 只认最后一条成功的标记行，正文里的其他输出（诊断行等）一律忽略。
 */
function readPopupStdoutResult(handle) {
  try {
    const chunk = handle?.collected?.stdout?.readFrom?.(0)
    const text = typeof chunk?.text === 'string' ? chunk.text : ''
    if (text === '') return null
    let found = null
    for (const line of text.split(/\r?\n/)) {
      const index = line.indexOf(RESULT_MARKER)
      if (index === -1) continue
      try {
        const parsed = JSON.parse(line.slice(index + RESULT_MARKER.length).trim())
        const kind = textOrNull(parsed?.kind)
        if (kind !== null) found = { kind, detail: textOrNull(parsed?.detail), at: textOrNull(parsed?.at) }
      } catch {
        // 半行或被截断的行：跳过，继续找下一行
      }
    }
    return found
  } catch {
    return null
  }
}

/**
 * 取弹窗的最终结果：结果文件优先（不受限环境下的老通道），其次 stdout 标记行（受限令牌下的主通道）。
 * 子进程退出与管道排空之间可能有极短的时间窗，标记行缺失时做一次有界重读，避免白丢一次决定。
 */
async function readPopupDecision(runtime, handle, resultFile) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const fromFile = readPopupResult(resultFile)
    if (fromFile !== null) return { result: fromFile, channel: 'file' }
    const fromStdout = readPopupStdoutResult(handle)
    if (fromStdout !== null) return { result: fromStdout, channel: 'stdout' }
    await waitFor(attempt === 0 ? 25 : 50, undefined, runtime.timers)
  }
  return { result: null, channel: null }
}

/** 读取收集到的子进程输出，仅作为失败时的诊断线索（决定本身走结果文件或 stdout 标记行）。 */
function readCollected(handle) {
  const read = (reader) => {
    try {
      const chunk = reader?.readFrom?.(0)
      const text = typeof chunk?.text === 'string' ? chunk.text.trim() : ''
      return text === '' ? null : text.slice(0, 2000)
    } catch {
      return null
    }
  }
  return { stdout: read(handle?.collected?.stdout), stderr: read(handle?.collected?.stderr) }
}

/**
 * 起一个弹窗进程；返回 { done, cancel }。
 * `done` 结算为 { kind: 'allowed-once' | 'rejected' | 'no-decision' | 'spawn-failed', detail, ... }。
 * 无论走哪条路都会清掉临时文件；`cancel()` 用于浏览器先答或请求被取消时立刻终止进程。
 */
function startPopup(runtime, req, context, settings) {
  const { log, dataDir, scriptPath, activeHandles } = runtime
  const tmpDir = join(dataDir, 'tmp')
  const requestId = randomUUID()
  const payloadFile = join(tmpDir, `payload-${requestId}.json`)
  const resultFile = join(tmpDir, `result-${requestId}.json`)
  const state = { handle: null, cancelled: false }

  const done = (async () => {
    // slot 只用来错开"此刻还开着的"弹窗，用完归还。
    // 早先用单调自增：每个弹窗都比上一个高 44px，哪怕上一个早就关掉了 —— 于是"右下角"越弹越高。
    let slot = null
    try {
      // 竞速可能在 spawn 之前就判出胜负（浏览器先答 / 请求被取消）：
      // 这里先挡一次，避免"取消后才拉起进程"留下一个没人管的窗口。
      if (state.cancelled) return { kind: 'cancelled', detail: 'cancelled-before-spawn' }
      slot = runtime.livePopups % POPUP_SLOTS
      runtime.livePopups += 1
      mkdirSync(tmpDir, { recursive: true })
      const payload = {
        windowTitle: `DSH 审批请求 · ${context.toolName}`,
        metaCaption: context.metaCaption,
        meta: context.metaText,
        reasonCaption: '模型给出的理由（模型自己撰写，请以命令原文为准）：',
        reason: context.reasonText,
        commandCaption: '模型请求执行的内容（原文，只读）：',
        command: context.commandText,
        sound: settings.sound,
        armDelayMs: settings.armDelayMs,
        closeAfterMs: settings.windowCloseAfterMs,
        slot,
      }
      writeFileSync(payloadFile, JSON.stringify(payload, null, 2), 'utf8')
      let handle
      try {
        handle = runtime.ctx.subprocess.spawn({
          argv: [
            settings.shell,
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-PayloadFile',
            payloadFile,
            '-OutFile',
            resultFile,
          ],
          cwd: dirname(scriptPath),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
          graceMs: 5000,
        })
      } catch (error) {
        log({ event: 'approval/request', phase: 'popup-spawn-failed', requestId, error: String(error?.message ?? error) })
        return { kind: 'spawn-failed', detail: String(error?.message ?? error) }
      }
      state.handle = handle
      activeHandles.add(handle)
      log({ event: 'approval/request', phase: 'popup-spawned', requestId, slot, shell: settings.shell })
      let outcome = null
      try {
        outcome = await handle.done
      } catch (error) {
        log({ event: 'approval/request', phase: 'popup-done-failed', requestId, error: String(error?.message ?? error) })
      }
      const decision = await readPopupDecision(runtime, handle, resultFile)
      const result = decision.result
      const kind = result?.kind === 'allowed-once' || result?.kind === 'rejected' ? result.kind : 'no-decision'
      if (kind === 'no-decision') {
        const collected = readCollected(handle)
        log({
          event: 'approval/request',
          phase: 'popup-no-decision',
          requestId,
          resultKind: result?.kind ?? null,
          resultDetail: result?.detail ?? null,
          resultChannel: decision.channel,
          exitCode: outcome?.exitCode ?? null,
          signal: outcome?.signal ?? null,
          cancelled: state.cancelled,
          stderr: collected.stderr,
        })
      } else {
        log({ event: 'approval/request', phase: 'popup-decision', requestId, outcome: kind, channel: decision.channel })
      }
      return { kind, detail: result?.detail ?? null, channel: decision.channel }
    } catch (error) {
      log({ event: 'approval/request', phase: 'popup-failed', requestId, error: String(error?.message ?? error) })
      return { kind: 'spawn-failed', detail: String(error?.message ?? error) }
    } finally {
      if (slot !== null) runtime.livePopups = Math.max(0, runtime.livePopups - 1)
      if (state.handle !== null) activeHandles.delete(state.handle)
      try {
        rmSync(payloadFile, { force: true })
      } catch {
        // 清理失败不影响审批
      }
      try {
        rmSync(resultFile, { force: true })
      } catch {
        // 同上
      }
    }
  })()

  return {
    done,
    cancel() {
      state.cancelled = true
      try {
        state.handle?.terminate()
      } catch {
        // 已经退出时 terminate 可能抛错，忽略
      }
    },
  }
}

/**
 * 审批请求的入口：给这次请求装一个「我们也能结束」的 signal，再交给编排。
 *
 * 为什么要装：浏览器里的审批提示只跟请求 signal 的 abort 走 —— 宿主侧 abort 后网关会转发一帧
 * `cancel`，浏览器据此撤掉提示（`DECISIONS.md` D-03）。桌面卡先答时，那个早已投给浏览器的
 * 请求没有任何人会 abort，提示就永远挂在那里（它没有超时、也没有关闭按钮）。
 *
 * 为什么必须在 `next()` 之前换掉 `req.signal`：下游是在收到请求的那一刻就把 signal 记下来的
 * （网关把 request 投影给浏览器时带走的就是这个 signal），晚一步就换不到。
 * 为什么换掉不改变判定：`ApprovalService.decide` 在派发瀑布之前已经同步取走了原 signal，
 * 所以这个信号只决定「提示什么时候撤掉」，不参与「谁赢」的判定，也不会 abort 工具自己的 signal。
 */
async function handleApproval(runtime, req, next) {
  const own = new AbortController()
  const origin = req.signal
  req.signal = origin === undefined || origin === null ? own.signal : AbortSignal.any([origin, own.signal])
  try {
    return await decideApproval(runtime, req, next)
  } finally {
    // 三种出口（弹窗赢 / 下游赢 / 外部 abort）都在这里汇合；「弹窗没给出决定」的那条路
    // 还没返回（它要继续等浏览器），所以不会被误 abort。
    // 只 abort 一次：外部 abort 结束的是融合信号，这里补的只是我们自己的 controller。
    if (!own.signal.aborted) own.abort(new Error('approval already decided'))
  }
}

/**
 * 审批请求的完整编排。
 * 顺序：记日志 → 立刻 `next()` 交给浏览器 → 等 delayMs → 超时才弹窗 → 谁先答谁生效。
 * 返回闭集内的结果；下游失败时原样抛出（由 `ApprovalService` 归一为 'unavailable'）。
 */
async function decideApproval(runtime, req, next) {
  const { log } = runtime
  // 每次请求现取配置：改了 config.json 下一次审批就生效，不需要重启。
  const settings = runtime.resolveSettings()
  const startedAt = Date.now()
  const session = req?.agent?.session
  const sessionId = textOrNull(req?.agent?.id)
  const toolName = textOrNull(req?.toolName) ?? '未知工具'
  const displayReason = textOrNull(req?.displayReason?.zh) ?? textOrNull(req?.displayReason?.en)
  const reasonText = displayReason ?? textOrNull(req?.reason) ?? '(本次请求没有提供理由)'
  const cwd = textOrNull(session?.header?.cwd)
  const lookup = findToolCall(req)

  log({
    event: 'approval/request',
    phase: 'enter',
    toolName,
    callId: textOrNull(req?.callId),
    reason: textOrNull(req?.reason),
    displayReasonZh: textOrNull(req?.displayReason?.zh),
    agentId: sessionId,
    cwd,
    hasSignal: req?.signal !== undefined && req?.signal !== null,
    argumentsFound: lookup.found === true,
    argumentsLength: lookup.argumentsLength ?? 0,
    toolCallSeq: lookup.toolCallSeq ?? null,
    toolCallProbe: lookup.probe ?? null,
  })

  const context = {
    toolName,
    reasonText,
    commandText: buildCommandText(settings, lookup),
    metaText: cwd ?? '(未提供)',
    // 会话 id 人眼分不出来，工具名已经在标题与徽标里 —— 元信息只留工作目录。
    metaCaption: '工作区',
  }

  const downstream = settleDownstream(next)
  const aborted = abortPromise(req.signal)

  const finishDownstream = (settled) => {
    log({
      event: 'approval/request',
      phase: 'next-settled',
      elapsedMs: Date.now() - startedAt,
      source: 'downstream',
      outcome: settled.ok ? summarizeOutcome(settled.value) : null,
      error: settled.ok ? null : String(settled.error?.message ?? settled.error),
    })
    if (!settled.ok) throw settled.error
    return settled.value
  }
  const finishPopup = (decision, detail, channel) => {
    log({
      event: 'approval/request',
      phase: 'next-settled',
      elapsedMs: Date.now() - startedAt,
      source: 'popup',
      outcome: decision,
      detail,
      channel,
    })
    return decision
  }
  const finishAborted = () => {
    log({ event: 'approval/request', phase: 'next-settled', elapsedMs: Date.now() - startedAt, source: 'aborted', outcome: 'cancelled' })
    return 'cancelled'
  }

  // 编排只负责"谁赢了"，结算与日志统一在外面做，避免把下游的正常失败误记成编排故障。
  const orchestrate = async () => {
    // 1) 浏览器优先：先等 delayMs。没有已连接页面时不必白等，直接进入弹窗阶段。
    const liveClient = detectLiveClient(runtime.ctx)
    const delayMs = liveClient === false ? 0 : settings.delayMs
    if (delayMs > 0) {
      const first = await Promise.race([downstream.then(() => 'downstream'), aborted, waitFor(delayMs, req.signal, runtime.timers)])
      if (first === 'downstream') return { source: 'downstream', settled: await downstream }
      if (first === 'aborted') return { source: 'aborted' }
    }
    if (req.signal?.aborted) return { source: 'aborted' }

    // 2) 弹窗阶段：每次弹窗都与下游/取消竞速；窗口自己关了（X 或到点）就继续等浏览器。
    for (;;) {
      const popup = startPopup(runtime, req, context, settings)
      const raced = await Promise.race([
        popup.done.then((result) => ({ source: 'popup', result })),
        downstream.then((settled) => ({ source: 'downstream', settled })),
        aborted.then(() => ({ source: 'aborted' })),
      ])
      if (raced.source === 'downstream') {
        popup.cancel()
        return { source: 'downstream', settled: raced.settled }
      }
      if (raced.source === 'aborted') {
        popup.cancel()
        return { source: 'aborted' }
      }
      const result = raced.result
      if (result.kind === 'allowed-once' || result.kind === 'rejected') {
        return { source: 'popup', decision: result.kind, detail: result.detail, channel: result.channel }
      }
      if (result.kind === 'spawn-failed') {
        log({ event: 'approval/request', phase: 'popup-abandoned', elapsedMs: Date.now() - startedAt, detail: result.detail })
      }
      // 窗口没给出决定（点 X / 到点自动关闭 / 起不来）：默认不再提醒，一直等浏览器。
      if (!(settings.renotifyMs > 0)) {
        const settle = await Promise.race([
          downstream.then((settled) => ({ source: 'downstream', settled })),
          aborted.then(() => ({ source: 'aborted' })),
        ])
        return settle.source === 'downstream' ? { source: 'downstream', settled: settle.settled } : { source: 'aborted' }
      }
      const again = await Promise.race([
        downstream.then(() => 'downstream'),
        aborted,
        waitFor(settings.renotifyMs, req.signal, runtime.timers),
      ])
      if (again === 'downstream') return { source: 'downstream', settled: await downstream }
      if (again === 'aborted') return { source: 'aborted' }
      // 否则循环一次：再弹一个窗
    }
  }

  let plan
  try {
    plan = await orchestrate()
  } catch (error) {
    // 编排自身出问题：绝不静默放行，把决定权原样交回下游（浏览器）。
    log({ event: 'approval/request', phase: 'orchestration-failed', error: String(error?.message ?? error) })
    plan = { source: 'downstream', settled: await downstream }
  }

  if (plan.source === 'popup') return finishPopup(plan.decision, plan.detail, plan.channel)
  if (plan.source === 'aborted') return finishAborted()
  return finishDownstream(plan.settled)
}

/** 提问事件：只旁听日志、立刻委托，永不改变行为（问答弹窗按用户决定不做）。 */
function handleUserQuestions(runtime, req, next) {
  const startedAt = Date.now()
  runtime.log({
    event: 'user-questions/request',
    phase: 'enter',
    questionIds: Array.isArray(req?.questions) ? req.questions.map((question) => question?.id ?? null) : null,
    questionCount: Array.isArray(req?.questions) ? req.questions.length : 0,
    callId: textOrNull(req?.wait?.callId),
    timed: req?.wait?.timed === true,
    agentId: textOrNull(req?.agent?.id),
    hasSignal: req?.signal !== undefined && req?.signal !== null,
  })
  return (async () => {
    try {
      const outcome = await next()
      runtime.log({
        event: 'user-questions/request',
        phase: 'next-settled',
        elapsedMs: Date.now() - startedAt,
        outcome: summarizeOutcome(outcome),
      })
      return outcome
    } catch (error) {
      runtime.log({
        event: 'user-questions/request',
        phase: 'next-rejected',
        elapsedMs: Date.now() - startedAt,
        error: textOrNull(error?.message) ?? String(error),
      })
      throw error
    }
  })()
}

export function apply(ctx, config) {
  const patchConfig = config !== null && typeof config === 'object' ? config : {}
  const { settings: patchSettings, notes: patchNotes } = normalizeConfig(patchConfig)
  if (!patchSettings.enabled) return

  const dataDir = resolveDataDir(patchSettings)
  const logFile = join(dataDir, 'logs', 'notifier.log')
  const configFile = join(dataDir, CONFIG_FILE_NAME)
  const log = createLogger(logFile, patchSettings.debug)
  const scriptPath = fileURLToPath(new URL('./scripts/prompt.ps1', import.meta.url))
  const activeHandles = new Set()
  const timers = new Set()
  const lifetime = new AbortController()
  const resolveSettings = createSettingsResolver({ patchConfig, patchSettings, dataDir, log })
  const runtime = { ctx, patchConfig, patchSettings, dataDir, log, scriptPath, activeHandles, timers, resolveSettings, livePopups: 0 }

  ensureConfigFile(log, configFile, {
    delayMs: patchSettings.delayMs,
    armDelayMs: patchSettings.armDelayMs,
    windowCloseAfterMs: patchSettings.windowCloseAfterMs,
    renotifyMs: patchSettings.renotifyMs,
    sound: patchSettings.sound,
    shell: patchSettings.shell,
  })

  log({
    event: 'plugin',
    phase: 'activated',
    logFile,
    dataDir,
    configFile,
    scriptPath,
    scriptExists: existsSync(scriptPath),
    delayMs: patchSettings.delayMs,
    armDelayMs: patchSettings.armDelayMs,
    windowCloseAfterMs: patchSettings.windowCloseAfterMs,
    renotifyMs: patchSettings.renotifyMs,
    sound: patchSettings.sound,
    shell: patchSettings.shell,
    configNotes: patchNotes.length > 0 ? patchNotes : null,
  })

  // 卸载（或重载）时：终止所有仍在运行的弹窗进程、清掉定时器，不留孤儿。
  ctx.effect(() => {
    return () => {
      lifetime.abort(new Error('approval-notifier 已卸载'))
      for (const timer of timers) {
        clearTimeout(timer)
      }
      timers.clear()
      for (const handle of activeHandles) {
        try {
          handle.terminate()
        } catch {
          // 已退出时忽略
        }
      }
      activeHandles.clear()
    }
  }, 'approval-notifier: 弹窗进程与定时器清理')

  ctx.on(
    'approval/request',
    (req, next) => {
      if (lifetime.signal.aborted) return next()
      return handleApproval(runtime, req, next)
    },
    { prepend: true },
  )

  ctx.on('user-questions/request', (req, next) => handleUserQuestions(runtime, req, next), { prepend: true })
}
