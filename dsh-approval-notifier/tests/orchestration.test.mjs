/**
 * dsh-approval-notifier 的 Host 编排桩测试。
 *
 * 用假的 ctx / subprocess 驱动真实的 `../index.js`，**不需要 DSH、不需要重启、不弹任何窗口**：
 *
 *   node tests/orchestration.test.mjs
 *
 * 覆盖：
 *   A 浏览器先答 → 不弹窗，原样返回
 *   B 无人答 → 弹窗给出决定 → 返回该决定
 *   C 请求被取消 → 立即终止弹窗并返回 'cancelled'
 *   D 弹窗点 X（不决定）→ 继续等浏览器
 *   E 弹窗起不来 → 回落到浏览器
 *   F 下游结算与弹窗同时 → 终止弹窗（不留孤儿窗口）
 *   G 参数只进弹窗、不进日志；临时文件清理干净
 *   H 下游抛错 → 原样上抛（不吞、不放行）
 *   I 插件卸载 → 终止仍在运行的弹窗
 *   J/K/L/M 配置文件：自动生成、优先于 patch、非法值回落、dataDir 不可被文件改写
 *   N 结果文件写不出去（受限令牌下的常态）→ 决定走 stdout 标记行
 *   O stdout 里的噪声、半行、无标记行都不能影响解析
 *   P 两条通道都没有结果 → 继续等浏览器，绝不放行
 *   Q 插件与弹窗脚本的结果标记必须一致（跨语言约定）；显示窗口只在共享外壳里、入口不再引用原生卡
 *   R slot：依次审批时每个弹窗都回到右下角（不再越弹越高）
 *   S slot：同时在场的弹窗互相错开，关掉即归还
 *   T 弹窗脚本自己实测在场次序（宿主计数不是唯一来源）
 *   U 超过 400 字符的多行命令完整进载荷（不截断、不补省略号、末行完整）
 *   V 兜底 JSON 路径超过 6000 字符时截断并显式标注「已截断」
 *   W 6000 字符上限只作用于兜底 JSON，命令摘要不受它影响
 *   X 长路径（file_path 摘要）同样完整进载荷
 *   Y 桌面卡先答 → 请求 signal 被 abort（网页里那条提示随之撤掉）
 *   Z 下游（浏览器）先答 → 同样 abort，且不碰工具自己的 signal
 *   AA 外部 abort → 结果仍是 cancelled，原因不被我们覆盖、我们只 abort 一次
 *   AB 弹窗没给出决定 → 不 abort（网页还要能回答），直到请求真正结束
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const SENTINEL = 'SUPER-SECRET-TOKEN'
/** 插件根目录（用于跨语言一致性检查）。 */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** 测试用的临时目录放系统临时区，不污染仓库。 */
const ROOT = join(tmpdir(), 'dsh-approval-notifier-tests')
rmSync(ROOT, { recursive: true, force: true })

let failed = 0
function check(name, condition, detail = '') {
  if (!condition) failed += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  → ${detail}`}`)
}

/** 造一个最小可用的 ctx + subprocess 桩。 */
function buildHarness(dir, options = {}) {
  mkdirSync(join(dir, 'logs'), { recursive: true })
  const handlers = new Map()
  const disposers = []
  const spawns = []
  const gateway = { hasLiveClient: () => options.liveClient !== false }
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
    get(name) {
      return name === 'typertGateway' ? gateway : undefined
    },
    subprocess: {
      spawn(spec) {
        if (options.spawnThrows === true) throw new Error('桩：spawn 失败')
        const outFile = spec.argv[spec.argv.indexOf('-OutFile') + 1]
        const payloadFile = spec.argv[spec.argv.indexOf('-PayloadFile') + 1]
        let resolveDone
        const handle = {
          terminated: false,
          done: new Promise((resolve) => {
            resolveDone = resolve
          }),
          collected: {
            stdout: {
              readFrom: () => ({
                text: typeof options.stdoutText === 'function' ? options.stdoutText() : options.stdoutText ?? '桩 stdout',
                nextOffset: 0,
                lossy: false,
              }),
            },
            stderr: { readFrom: () => ({ text: options.stderrText ?? '', nextOffset: 0, lossy: false }) },
          },
        }
        handle.terminate = () => {
          if (handle.terminated) return
          handle.terminated = true
          resolveDone({ exitCode: null, signal: 'SIGTERM' })
        }
        const record = { spec, handle, payloadFile, outFile, spawnedAt: Date.now() }
        record.finish = (kind) => {
          if (kind !== null) {
            const temp = `${outFile}.tmp`
            writeFileSync(temp, JSON.stringify({ kind, at: new Date().toISOString() }), 'utf8')
            renameSync(temp, outFile)
          }
          resolveDone({ exitCode: 0, signal: null })
        }
        spawns.push(record)
        // 插件会在请求结束时删掉临时文件，所以在这里先把 payload 抓下来供断言。
        try {
          record.payloadText = readFileSync(payloadFile, 'utf8')
        } catch {
          record.payloadText = null
        }
        options.onSpawn?.(record)
        return handle
      },
    },
  }
  return { ctx, handlers, disposers, spawns, dir }
}

/** 造一条含 tool/call 的假会话，用来验证参数反查。
 *  `argumentsText` 直接替换整个参数 JSON；`command` 只替换其中的 command 字段（两者都省略时用默认短命令）。 */
function fakeRequest({ signal = undefined, argumentsText = undefined, command = undefined } = {}) {
  const args = argumentsText ?? JSON.stringify({ command: command ?? `echo ${SENTINEL}`, description: '桩命令' })
  const toolCall = { type: 'tool/call', data: { name: 'pwsh', callId: 'call-1', arguments: args } }
  const session = {
    seq: 3,
    header: { cwd: 'C:\\work\\dsh-plugins' },
    eventAt: (seq) => (seq === 2 ? toolCall : { type: 'turn/start' }),
  }
  return {
    agent: { id: 'session-test', session },
    toolName: 'pwsh',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: 桩测试',
    displayReason: { zh: '允许本次操作使用 danger-full-access 权限：桩测试' },
    ...(signal ? { signal } : {}),
  }
}

async function runCase(name, config, next, onSpawn, extra = {}) {
  const dir = join(ROOT, name.slice(0, 6))
  const harness = buildHarness(dir, { onSpawn, ...extra })
  apply(harness.ctx, { ...config, dataDir: dir })
  extra.beforeRequest?.(harness, dir)
  const handler = harness.handlers.get('approval/request')
  const controller = extra.controller ?? null
  const req = fakeRequest({ ...(extra.request ?? {}), ...(controller ? { signal: controller.signal } : {}) })
  let returned = null
  let error = null
  // 把 req 交给用例：signal 断言要看的就是这个对象（插件会把它的 signal 换成融合信号）。
  extra.onRequestStart?.(req)
  try {
    returned = await handler(req, next)
  } catch (caught) {
    error = caught
  }
  const logFile = join(dir, 'logs', 'notifier.log')
  const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  return { returned, error, harness, logText, dir }
}

/** 造一条长度精确为 `length` 的多行命令（末行是固定标记），用于验证"命令不被截断"。 */
function longCommand(length) {
  const tail = 'Write-Output "末行完整-LAST-LINE"'
  return `echo ${'A'.repeat(length - tail.length - 1 - 'echo '.length)}\n${tail}`
}

const never = () => new Promise(() => {})
const after = (ms, value) => () => new Promise((resolve) => setTimeout(() => resolve(value), ms))

// A 浏览器先答：应当完全不弹窗
{
  const { returned, harness } = await runCase('A-browser-first', { delayMs: 60 }, after(10, 'allowed-once'), undefined)
  check('A 返回浏览器的决定', returned === 'allowed-once', String(returned))
  check('A 没有拉起弹窗', harness.spawns.length === 0, `spawns=${harness.spawns.length}`)
}

// B 无人应答：弹窗给出决定
{
  const { returned, harness, logText } = await runCase(
    'B-popup-decides',
    { delayMs: 20, armDelayMs: 0, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish('rejected'), 40),
  )
  check('B 返回弹窗的决定', returned === 'rejected', String(returned))
  check('B 只拉起一个弹窗', harness.spawns.length === 1, `spawns=${harness.spawns.length}`)
  const payload = JSON.parse(harness.spawns[0].payloadText)
  check('B payload 带上了命令原文', payload.command.includes(SENTINEL), payload.command.slice(0, 60))
  check('B 命令块只留一行摘要，不再附带完整 JSON', !payload.command.includes('完整参数') && !payload.command.includes('\n'), payload.command.slice(0, 60))
  check('B 命令块不再自己拼 shell 提示符（代码块已经是命令框）', !payload.command.startsWith('$'), payload.command.slice(0, 60))
  check('B payload 带上了工作区', payload.meta.includes('dsh-plugins'), payload.meta)
  check('B payload 不再带会话 id（人眼分不出来）', !payload.meta.includes('session-test'), payload.meta)
  check('B payload 带上工作区标题', payload.metaCaption === '工作区', String(payload.metaCaption))
  check('B 参数未写入日志（敏感串不外泄）', !logText.includes(SENTINEL))
  check('B 日志记录了 argumentsFound', logText.includes('"argumentsFound":true'))
}

// C 请求被取消：立即终止弹窗
{
  const controller = new AbortController()
  const { returned, harness } = await runCase(
    'C-aborted',
    { delayMs: 20, windowCloseAfterMs: 5000 },
    never,
    () => setTimeout(() => controller.abort(), 40),
    { controller },
  )
  check('C 返回 cancelled', returned === 'cancelled', String(returned))
  check('C 弹窗进程被终止', harness.spawns[0]?.handle.terminated === true)
}

// D 点 X（不决定）：继续等浏览器
{
  const { returned, harness } = await runCase(
    'D-popup-closed',
    { delayMs: 20, renotifyMs: 0, windowCloseAfterMs: 5000 },
    after(150, 'allowed-once'),
    ({ finish }) => setTimeout(() => finish('closed'), 30),
  )
  check('D 关窗后仍拿到浏览器的决定', returned === 'allowed-once', String(returned))
  check('D 只弹过一次窗（renotify=0）', harness.spawns.length === 1, `spawns=${harness.spawns.length}`)
}

// E 弹窗起不来：回落到浏览器
{
  const { returned, harness } = await runCase('E-spawn-fails', { delayMs: 20 }, after(80, 'allowed-once'), undefined, { spawnThrows: true })
  check('E 起不来时回落到浏览器', returned === 'allowed-once', String(returned))
  check('E 没有留下弹窗记录', harness.spawns.length === 0)
}

// F 下游先结算：终止弹窗
{
  const { returned, harness } = await runCase('F-race', { delayMs: 0, windowCloseAfterMs: 5000 }, () => Promise.resolve('rejected'), undefined)
  check('F 返回浏览器/上游的决定', returned === 'rejected', String(returned))
  check('F 已拉起的弹窗被终止', harness.spawns[0]?.handle.terminated === true)
}

// G 临时文件清理
{
  const { harness, dir } = await runCase(
    'G-cleanup',
    { delayMs: 20, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish('allowed-once'), 40),
  )
  const leftover = harness.spawns.filter(({ payloadFile, outFile }) => existsSync(payloadFile) || existsSync(outFile))
  check('G 入参与结果临时文件都已清理', leftover.length === 0, `leftover=${leftover.length}`)
  check('G 日志文件仍保留', existsSync(join(dir, 'logs', 'notifier.log')))
}

// H 下游抛错：原样上抛
{
  const boom = new Error('桩：下游失败')
  const { returned, error } = await runCase('H-downstream-error', { delayMs: 20 }, () => Promise.reject(boom), undefined)
  check('H 原样上抛下游错误', error === boom, String(error?.message))
  check('H 没有伪造决定', returned === null, String(returned))
}

// I 插件卸载：终止仍在运行的弹窗
{
  const dir = join(ROOT, 'I-unload')
  const harness = buildHarness(dir, { onSpawn: () => {} })
  apply(harness.ctx, { delayMs: 20, windowCloseAfterMs: 60000, dataDir: dir })
  const pending = harness.handlers.get('approval/request')(fakeRequest(), never)
  void pending
  await new Promise((resolve) => setTimeout(resolve, 80))
  check('I 卸载前弹窗在运行', harness.spawns.length === 1 && harness.spawns[0].handle.terminated === false)
  for (const dispose of harness.disposers) dispose()
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('I 卸载后弹窗被终止', harness.spawns[0]?.handle.terminated === true)
}

// J 首次运行自动生成带说明的配置文件
{
  const { dir } = await runCase('J-config-created', { delayMs: 20 }, after(10, 'allowed-once'), undefined)
  const configFile = join(dir, 'config.json')
  check('J 自动生成了 config.json', existsSync(configFile))
  const doc = JSON.parse(readFileSync(configFile, 'utf8'))
  check('J 带 _readme 与 _help 说明', typeof doc._readme === 'string' && typeof doc._help?.delayMs === 'string')
  check('J 可调键都在文件里', ['delayMs', 'armDelayMs', 'windowCloseAfterMs', 'renotifyMs', 'sound', 'shell'].every((key) => key in doc))
  check('J 不再写已废弃的 showArguments', !('showArguments' in doc) && !('showArguments' in doc._help))
}

// K 配置文件优先于 patch 行（delayMs 由 5000 改成 0，应立刻弹窗）
{
  let startedAt = 0
  const { harness } = await runCase(
    'K-config-wins',
    { delayMs: 5000 },
    never,
    ({ finish }) => setTimeout(() => finish('allowed-once'), 30),
    {
      beforeRequest: (harness_, dir) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ delayMs: 0 }), 'utf8'),
      onRequestStart: () => {
        startedAt = Date.now()
      },
    },
  )
  const delay = harness.spawns[0]?.spawnedAt - startedAt
  check('K 文件里的 delayMs=0 立即生效', delay >= 0 && delay < 300, `弹窗延迟=${delay}ms`)
}

// L 文件里写非法值：回落默认、不抛、记一条 config-notes
{
  const { returned, logText } = await runCase(
    'L-config-invalid',
    { delayMs: 20 },
    never,
    ({ finish }) => setTimeout(() => finish('allowed-once'), 30),
    { beforeRequest: (harness_, dir) => writeFileSync(join(dir, 'config.json'), JSON.stringify({ delayMs: '十秒', sound: 1 }), 'utf8') },
  )
  check('L 非法值不影响审批', returned === 'allowed-once', String(returned))
  check('L 记下了配置说明', logText.includes('config-notes'), '')
}

// M 文件不能改写 dataDir（日志与临时文件仍在 patch 指定的目录）
{
  const { harness, dir } = await runCase(
    'M-datadir-fixed',
    { delayMs: 20 },
    never,
    ({ finish }) => setTimeout(() => finish('allowed-once'), 30),
    { beforeRequest: (harness_, dir_) => writeFileSync(join(dir_, 'config.json'), JSON.stringify({ dataDir: 'C:\\不存在的目录' }), 'utf8') },
  )
  check('M 临时文件仍在 patch 指定的数据目录', harness.spawns[0].payloadFile.startsWith(dir), harness.spawns[0].payloadFile)
}

// N 结果文件写不出去（宿主受限令牌下的常态）：决定走 stdout 标记行
{
  const { returned, harness, logText } = await runCase(
    'N-stdout-channel',
    { delayMs: 20, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish(null), 20),
    { stdoutText: '@@DSH-APPROVAL-NOTIFIER-RESULT@@ {"kind":"rejected","at":"2026-01-01T00:00:00.000Z"}' },
  )
  check('N stdout 通道也能决定', returned === 'rejected', String(returned))
  check('N 日志记下决定通道=stdout', logText.includes('"channel":"stdout"'), '')
  check('N 结果文件确实没写出来', existsSync(harness.spawns[0].outFile) === false, harness.spawns[0].outFile)
}

// O stdout 里的噪声、半行、无标记行都不能影响解析
{
  const { returned, logText } = await runCase(
    'O-stdout-noise',
    { delayMs: 20, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish(null), 20),
    {
      stdoutText: [
        'DSH-APPROVAL-DIAG {"stage":"shown","visibleAfter":true}',
        '@@DSH-APPROVAL-NOTIFIER-RESULT@@ {"kind":"all',
        '其他无关输出',
        '@@DSH-APPROVAL-NOTIFIER-RESULT@@ {"kind":"allowed-once","detail":"按钮"}',
      ].join('\n'),
    },
  )
  check('O 噪声与半行被忽略', returned === 'allowed-once', String(returned))
  check('O 记下了 detail', logText.includes('"detail":"按钮"'), '')
}

// P 两条通道都没有结果：继续等浏览器，绝不放行
// （浏览器答复刻意晚于弹窗的有界重读预算，这样 popup-no-decision 一定先写进日志）
{
  const { returned, logText } = await runCase(
    'P-no-channel',
    { delayMs: 20, windowCloseAfterMs: 1000 },
    after(600, 'allowed-once'),
    ({ finish }) => setTimeout(() => finish(null), 20),
    { stdoutText: 'DSH-APPROVAL-DIAG {"stage":"shown"}\n没有任何标记行' },
  )
  check('P 无结果时回落到浏览器', returned === 'allowed-once', String(returned))
  check(
    'P 记下 popup-no-decision 且通道为空',
    logText.includes('popup-no-decision') && logText.includes('"resultChannel":null'),
    '',
  )
}

// Q 弹窗脚本与插件的结果标记必须一致（跨语言约定：改一边忘另一边会静默失效）
{
  const jsSource = readFileSync(join(PLUGIN_ROOT, 'index.js'), 'utf8')
  const psSource = readFileSync(join(PLUGIN_ROOT, 'scripts', 'prompt.ps1'), 'utf8')
  // 渲染只有一条路径：外壳（仓库根 shared/ui-card）负责起窗口与「显式再 show 一次」。
  // 插件自己的 environment.ps1 只剩自检/验收用的能力，不再有第二套显示实现。
  const uiSource = readFileSync(join(PLUGIN_ROOT, 'scripts', 'ui', 'environment.ps1'), 'utf8')
  const cardAdapter = readFileSync(join(PLUGIN_ROOT, 'scripts', 'ui', 'card.ps1'), 'utf8')
  const shellDir = join(PLUGIN_ROOT, '..', 'shared', 'ui-card')
  const cardHost = readFileSync(join(shellDir, 'webview2.ps1'), 'utf8')
  const shellEnv = readFileSync(join(shellDir, 'environment.ps1'), 'utf8')
  const jsMarker = /RESULT_MARKER = '([^']+)'/.exec(jsSource)?.[1] ?? null
  const psMarker = /(@@DSH-APPROVAL-NOTIFIER-RESULT@@)/.exec(psSource)?.[1] ?? null
  check('Q 两端结果标记一致', jsMarker !== null && jsMarker === psMarker, `${jsMarker} / ${psMarker}`)
  check('Q 弹窗脚本把结果写进 stdout 并 flush', psSource.includes('[Console]::Out.WriteLine') && psSource.includes('[Console]::Out.Flush'))
  check(
    'Q 显示窗口的 Win32 调用只在共享外壳里（插件不再有第二套）',
    shellEnv.includes('ShowWindow') &&
      shellEnv.includes('SetWindowPos') &&
      cardHost.includes('Invoke-CardForceShow') &&
      cardAdapter.includes('Invoke-CardApproval') &&
      !uiSource.includes('ShowWindow') &&
      !uiSource.includes('SetWindowPos'),
  )
  // 退化路径已删除：入口不许再 dot-source 原生卡，插件目录里也不许有相关文件。
  check(
    'Q 入口不再引用原生卡（只剩卡片一条渲染路径）',
    !psSource.includes('native-card') && !existsSync(join(PLUGIN_ROOT, 'scripts', 'ui', 'native-card.ps1')),
  )
}

// R 依次审批（上一个已关掉）：每一次都应该回到右下角
//   早先的单调自增会让第 N 个弹窗高 N*44px，正是"不在右下角、往上了一点"的来源。
{
  const dir = join(ROOT, 'R-slot-sequential')
  const harness = buildHarness(dir, {})
  apply(harness.ctx, { delayMs: 0, armDelayMs: 0, windowCloseAfterMs: 5000, dataDir: dir })
  const handler = harness.handlers.get('approval/request')
  const slots = []
  for (let index = 0; index < 3; index += 1) {
    const pending = handler(fakeRequest(), never)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const spawned = harness.spawns.at(-1)
    slots.push(JSON.parse(spawned.payloadText).slot)
    spawned.finish('rejected')
    await pending
  }
  check('R 依次审批时 slot 恒为 0', slots.join(',') === '0,0,0', slots.join(','))
}

// S 同时在场：错开一格；关掉之后归还，下一次又回到 0
{
  const dir = join(ROOT, 'S-slot-concurrent')
  const harness = buildHarness(dir, {})
  apply(harness.ctx, { delayMs: 0, armDelayMs: 0, windowCloseAfterMs: 5000, dataDir: dir })
  const handler = harness.handlers.get('approval/request')
  const first = handler(fakeRequest(), never)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = handler(fakeRequest(), never)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const concurrent = harness.spawns.map((record) => JSON.parse(record.payloadText).slot)
  check('S 同时在场的两个弹窗错开', concurrent.join(',') === '0,1', concurrent.join(','))
  harness.spawns.forEach((record) => record.finish('rejected'))
  await Promise.all([first, second])
  const third = handler(fakeRequest(), never)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const afterRelease = JSON.parse(harness.spawns[2].payloadText).slot
  check('S 关掉后归还，下一个回到 slot 0', afterRelease === 0, String(afterRelease))
  harness.spawns[2].finish('rejected')
  await third
}

// T 弹窗脚本自己实测在场次序：宿主计数不再是唯一来源（.ps1 改动无需重启即可生效）
{
  const jsSource = readFileSync(join(PLUGIN_ROOT, 'index.js'), 'utf8')
  const psSource = readFileSync(join(PLUGIN_ROOT, 'scripts', 'prompt.ps1'), 'utf8')
  check('T 宿主不再用单调自增的 slot 计数', !jsSource.includes('popupSlot'), '')
  check('T 弹窗脚本按在场登记自算次序', psSource.includes('Get-PopupSlot') && psSource.includes('popup-slot-'), '')
  check('T 弹窗脚本在退出时交还登记', psSource.includes('Remove-Item -LiteralPath $claimFile'), '')
  check('T 弹窗脚本把 slot 写进自检诊断', psSource.includes('slotRank          = $slotInfo.Rank'), '')
}

// U 超过 400 字符的命令：原文完整进载荷
//   早先 `buildCommandText` 把摘要截到 400 字符 + `…`，卡上显示的命令因此**不是**将要执行的那条
//   （`PREFERENCES.md` C-08）。这里用一条 1200 字符的多行命令守住"长度一致、末尾无省略号、末行完整"。
{
  const command = longCommand(1200)
  const { harness } = await runCase(
    'U-long-command',
    { delayMs: 20, armDelayMs: 0, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish('rejected'), 40),
    { request: { command } },
  )
  const payload = JSON.parse(harness.spawns[0].payloadText)
  check('U 1200 字符命令的长度与原文一致', payload.command.length === command.length, `${payload.command.length} / ${command.length}`)
  check('U 命令末尾没有省略号', !payload.command.endsWith('…') && !payload.command.endsWith('...'), payload.command.slice(-24))
  check('U 多行命令的末行完整保留', payload.command.endsWith('Write-Output "末行完整-LAST-LINE"'), payload.command.slice(-40))
}

// V 兜底 JSON 路径：超过 6000 字符时截断，但必须显式标注（这条不是"静默截断"）
{
  const argumentsText = JSON.stringify({ note: 'X'.repeat(7000) })
  const { harness } = await runCase(
    'V-json-fallback',
    { delayMs: 20, armDelayMs: 0, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish('rejected'), 40),
    { request: { argumentsText } },
  )
  const payload = JSON.parse(harness.spawns[0].payloadText)
  check('V 兜底路径仍是 JSON 块', payload.command.startsWith('--- 参数（JSON）---\n'), payload.command.slice(0, 24))
  check('V 截断处带「已截断」标注', payload.command.endsWith('…（已截断）'), payload.command.slice(-24))
  check(
    'V 截断长度等于 6000 字符 + 标注',
    payload.command.length === 6000 + '\n…（已截断）'.length,
    String(payload.command.length),
  )
}

// W 6000 字符上限只给兜底 JSON：命令摘要再长也不许截
{
  const command = longCommand(7000)
  const { harness } = await runCase(
    'W-long-command',
    { delayMs: 20, armDelayMs: 0, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish('rejected'), 40),
    { request: { command } },
  )
  const payload = JSON.parse(harness.spawns[0].payloadText)
  check('W 7000 字符命令不受 COMMAND_MAX_CHARS 影响', payload.command.length === 7000 && payload.command === command, String(payload.command.length))
}

// X 长路径：摘要不只管命令，file_path 这类正文同样不截断
{
  const filePath = `C:\\work\\dsh-plugins\\${'deep-'.repeat(100)}file.txt`
  const { harness } = await runCase(
    'X-long-path',
    { delayMs: 20, armDelayMs: 0, windowCloseAfterMs: 1000 },
    never,
    ({ finish }) => setTimeout(() => finish('rejected'), 40),
    { request: { argumentsText: JSON.stringify({ file_path: filePath }) } },
  )
  const payload = JSON.parse(harness.spawns[0].payloadText)
  check('X 长路径完整进载荷', payload.command === filePath, `${payload.command.length} / ${filePath.length}`)
}

/** 统计「我们自己的 controller 被 abort 了几次」：只统计这层包裹期间创建的 AbortController。 */
function withAbortCounter() {
  const Real = globalThis.AbortController
  const aborts = []
  class CountingAbortController extends Real {
    abort(reason) {
      aborts.push(reason instanceof Error ? reason.message : String(reason))
      return super.abort(reason)
    }
  }
  globalThis.AbortController = CountingAbortController
  return {
    aborts,
    restore() {
      globalThis.AbortController = Real
    },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等日志里出现某个阶段：弹窗从拉起走到「无决定」的时序不固定，轮询比猜时间稳。 */
async function waitForLog(logFile, needle, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    if (text.includes(needle)) return true
    await sleep(10)
  }
  return false
}

// Y 桌面卡先答：请求 signal 必须被 abort，否则浏览器里那条提示永远挂着（D-03）
//   断言：返回值仍是弹窗的决定；决定产生**之前** signal 还是活的（否则浏览器通道会被提前掐断）；
//   决定之后 req.signal 与 next() 内部看到的 signal 都已 abort；
//   我们自己的 controller 只 abort 一次（reason 是固定串）。
{
  const nextSeen = { signal: null, abortEvents: 0, aliveBeforeDecision: null }
  let observed = null
  const counter = withAbortCounter()
  let outcome
  try {
    outcome = await runCase(
      'Y-popup-aborts',
      { delayMs: 20, armDelayMs: 0, windowCloseAfterMs: 2000 },
      () => {
        nextSeen.signal = observed.signal
        nextSeen.signal.addEventListener('abort', () => {
          nextSeen.abortEvents += 1
        })
        return never()
      },
      ({ finish }) =>
        setTimeout(() => {
          // 就在桌面卡写下决定的前一刻取样：此时网页那条提示还得能回答。
          nextSeen.aliveBeforeDecision = observed.signal.aborted === false
          finish('rejected')
        }, 40),
      { onRequestStart: (req) => { observed = req } },
    )
  } finally {
    counter.restore()
  }
  check('Y 桌面卡的决定仍是返回值', outcome.returned === 'rejected', String(outcome.returned))
  check('Y 决定产生之前 signal 仍是活的（没有提前 abort）', nextSeen.aliveBeforeDecision === true)
  check('Y 弹窗赢后请求 signal 已 abort', observed.signal.aborted === true)
  check('Y next() 里拿到的 signal 也已 abort', nextSeen.signal !== null && nextSeen.signal.aborted === true)
  check('Y abort 事件只触发一次', nextSeen.abortEvents === 1, String(nextSeen.abortEvents))
  check(
    'Y 自己的 controller 只 abort 一次（不重复）',
    counter.aborts.length === 1 && counter.aborts[0] === 'approval already decided',
    counter.aborts.join(','),
  )
}

// Z 下游（浏览器）先答：同样要 abort，但只 abort 融合信号，不碰工具自己的 signal
{
  const controller = new AbortController()
  const nextSeen = { signal: null, abortEvents: 0, aliveBeforeDecision: null }
  let observed = null
  const counter = withAbortCounter()
  let outcome
  try {
    outcome = await runCase(
      'Z-downstream-aborts',
      { delayMs: 60 },
      () => {
        nextSeen.signal = observed.signal
        nextSeen.signal.addEventListener('abort', () => {
          nextSeen.abortEvents += 1
        })
        return new Promise((resolve) =>
          setTimeout(() => {
            // 网页在写下决定的前一刻，signal 也必须是活的。
            nextSeen.aliveBeforeDecision = observed.signal.aborted === false
            resolve('allowed-once')
          }, 10),
        )
      },
      undefined,
      { controller, onRequestStart: (req) => { observed = req } },
    )
  } finally {
    counter.restore()
  }
  check('Z 返回浏览器的决定', outcome.returned === 'allowed-once', String(outcome.returned))
  check('Z 决定产生之前 signal 仍是活的（没有提前 abort）', nextSeen.aliveBeforeDecision === true)
  check('Z 下游赢后请求 signal 已 abort', observed.signal.aborted === true)
  check('Z next() 拿到的是融合信号（不是工具自己的）', nextSeen.signal === observed.signal && observed.signal !== controller.signal)
  check('Z abort 事件只触发一次', nextSeen.abortEvents === 1, String(nextSeen.abortEvents))
  check(
    'Z 自己的 controller 只 abort 一次（不重复）',
    counter.aborts.length === 1 && counter.aborts[0] === 'approval already decided',
    counter.aborts.join(','),
  )
  check('Z 工具自己的 signal 没有被 abort（命令照常执行）', controller.signal.aborted === false)
}

// AA 外部 abort：结果仍是 cancelled；融合信号保留外部原因（我们没提前/重复 abort，只补一次自己的）
{
  const reason = new Error('turn 已结束')
  const controller = new AbortController()
  const nextSeen = { signal: null, abortEvents: 0 }
  let observed = null
  const counter = withAbortCounter()
  let outcome
  try {
    outcome = await runCase(
      'AA-external-abort',
      { delayMs: 20, windowCloseAfterMs: 5000 },
      () => {
        nextSeen.signal = observed.signal
        nextSeen.signal.addEventListener('abort', () => {
          nextSeen.abortEvents += 1
        })
        return never()
      },
      () => setTimeout(() => controller.abort(reason), 40),
      { controller, onRequestStart: (req) => { observed = req } },
    )
  } finally {
    counter.restore()
  }
  check('AA 外部 abort 仍返回 cancelled', outcome.returned === 'cancelled', String(outcome.returned))
  check('AA 请求 signal 已 abort', observed.signal.aborted === true)
  check('AA 融合信号保留外部 abort 的原因（我们没提前覆盖）', observed.signal.reason === reason)
  check('AA abort 事件只触发一次', nextSeen.abortEvents === 1, String(nextSeen.abortEvents))
  check(
    'AA 自己的 controller 只 abort 一次（不重复）',
    counter.aborts.length === 1 && counter.aborts[0] === 'approval already decided',
    counter.aborts.join(','),
  )
}

// AB 弹窗没给出决定（点 X / 到点关窗 / 起不来）：此时绝不能 abort —— 网页还要能回答。
//   用 never() 的下游把请求停在「等浏览器」上，确认信号此刻仍然是活的，再外部取消收尾。
{
  const controller = new AbortController()
  const dir = join(ROOT, 'AB-no-decision')
  const counter = withAbortCounter()
  let settled = null
  let req = null
  const nextSeen = { signal: null, abortEvents: 0 }
  try {
    const harness = buildHarness(dir, { onSpawn: ({ finish }) => setTimeout(() => finish('closed'), 30) })
    apply(harness.ctx, { delayMs: 20, renotifyMs: 0, windowCloseAfterMs: 5000, dataDir: dir })
    const handler = harness.handlers.get('approval/request')
    req = fakeRequest({ signal: controller.signal })
    const pending = handler(req, () => {
      nextSeen.signal = req.signal
      nextSeen.signal.addEventListener('abort', () => {
        nextSeen.abortEvents += 1
      })
      return never()
    }).then((value) => {
      settled = value
    })

    const logged = await waitForLog(join(dir, 'logs', 'notifier.log'), 'popup-no-decision')
    check('AB 走到了 popup-no-decision 分支', logged === true)
    check('AB 弹窗没决定时请求 signal 未 abort（网页还要能回答）', req.signal.aborted === false)
    check('AB next() 的 signal 也未 abort', nextSeen.signal !== null && nextSeen.signal.aborted === false)
    check('AB 此时我们一次都没有 abort', counter.aborts.length === 0, counter.aborts.join(','))

    // 收尾：外部取消让挂着的等待结算；这一步发生在请求真正结束之后，不属于「弹窗无决定」分支。
    controller.abort(new Error('测试收尾'))
    await pending
  } finally {
    counter.restore()
  }
  check('AB 外部取消后仍返回 cancelled', settled === 'cancelled', String(settled))
  check('AB 收尾时才补一次 abort', counter.aborts.length === 1, counter.aborts.join(','))
}

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exitCode = failed === 0 ? 0 : 1
