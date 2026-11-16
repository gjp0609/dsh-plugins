/**
 * ssh_run 单测：假 pool / 假 WSL / 真 StateStore（假 DPAPI）+ 假卡片。
 *
 * 重点验证设计的硬约束：未勾选不执行、空选择全跳过、一行=命令×主机组、
 * 卡片行数上限、预连接早于弹卡、输出截断、审计不落输出内容。
 *
 * 运行：node dsh-ssh-remote/tests/run.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunTool, normalizeSteps, resolveStepTargets, stepsToRows, trimOutput } from '../lib/run.mjs'
import { askApproval, buildApprovalQuestion, resolveWorkDir } from '../lib/approval.mjs'
import { StateStore, createPaths } from '../lib/store.mjs'
import { normalizeHostsDocument } from '../lib/hosts.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

async function caughtAsync(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('本该抛错但没有抛')
}

function fakeDpapi() {
  return {
    async protect(path, text) {
      writeFileSync(path, Buffer.from(text, 'utf8').toString('base64'), 'utf8')
    },
    async unprotect(path) {
      return Buffer.from(readFileSync(path, 'utf8'), 'base64').toString('utf8')
    },
  }
}

const HOSTS = {  hosts: {
    web1: { address: '192.168.1.11', user: 'deploy', label: 'Web 1' },
    web2: { address: '192.168.1.12', user: 'deploy', label: 'Web 2' },
  },
  wsl: { Debian: { label: '本机 Debian' } },
}

/** 审批只在工具调用里闭环：exec 里的 agent/callId 由宿主给，卡片的返回也走同一次调用。 */
const EXEC = { agent: { id: 'agent-1' }, callId: 'call-1' }

/**
 * 假桌面卡：**就是正式路径**（`cardApprovalChannel(dialog)` → `dialog.selectRows`）。
 *
 * C-10 之后 ssh 的审批只有这一条路，所以测试的默认通道也是它。
 * `pick(rows)` 决定勾第几行；卡片只拿得到 rows，断言也就只看得到 label / text / why / meta。
 */
function fakeDialog({ pick = () => [], events = [] } = {}) {
  return {
    async selectRows(options) {
      events.push({ kind: 'ask', rows: options.rows, workDir: options.workDir })
      const indices = pick(options.rows)
      return { answered: true, selected: indices.map((index) => options.rows[index].label) }
    },
  }
}

/** 宿主内置问题弹窗的假实现：C-10 之后一次都不该被调用，用它来证明「有 channel 也走卡片」。 */
function fakeHostChannel(calls) {
  return {
    get(name) {
      if (name !== 'userQuestions') return undefined
      return {
        async ask({ questions }) {
          calls.push(questions[0])
          const question = questions[0]
          return { answers: [{ id: question.id, selected: [question.options[0].label] }] }
        },
      }
    },
  }
}

async function setup({ pick, events = [], hosts = HOSTS, settings = {}, dialog, wsl: wslOverride, pool: poolOverride } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-run-'))
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify(hosts), 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  await store.ensureLoaded()
  Object.assign(store.settings, settings)

  const calls = { connect: [], run: [], wsl: [] }
  const pool = poolOverride ?? {
    status: () => [],
    connect: async (host) => {
      calls.connect.push(host.id)
      events.push({ kind: 'connect', host: host.id })
      return { hostId: host.id }
    },
    run: async (host, command, options) => {
      calls.run.push({ host: host.id, command, options })
      return { exitCode: 0, stdout: `ran ${command} on ${host.id}`, stderr: '', ms: 7 }
    },
  }
  const wsl = {
    run: async (distro, command, options) => {
      calls.wsl.push({ distro, command, options })
      return { exitCode: 0, stdout: `wsl ${distro}: ${command}`, stderr: '', ms: 9 }
    },
  }
  const audit = { records: [], record(entry) { this.records.push(entry) }, prune: () => 0 }

  const tool = createRunTool({ store, pool, wsl: wslOverride ?? wsl, audit, dialog: dialog ?? fakeDialog({ pick, events }) })
  return { dir, paths, store, tool, calls, audit, events }
}

/** 从同一批 step 造出卡片问题（`stepsToRows` + `buildApprovalQuestion` 都是生产函数）。 */
function questionOf(steps) {
  return buildApprovalQuestion({ rows: stepsToRows(resolveStepTargets(normalizeSteps({ steps }), normalizeHostsDocument(HOSTS))) })
}

await test('normalizeSteps：缺 command / 缺 why / 空 hosts / 超行数都报清楚', () => {
  const errorOf = (fn) => {
    try {
      fn()
    } catch (error) {
      return error
    }
    throw new Error('本该抛错')
  }
  assert.match(errorOf(() => normalizeSteps({ steps: [{ command: 'x', why: 'y', hosts: [] }] })).message, /hosts 不能为空/)
  assert.match(errorOf(() => normalizeSteps({ steps: [{ command: 'x', hosts: ['web1'] }] })).message, /缺 why/)
  assert.match(errorOf(() => normalizeSteps({ steps: [{ why: 'y', hosts: ['web1'] }] })).message, /缺 command/)
  const many = Array.from({ length: 9 }, () => ({ command: 'x', why: 'y', hosts: ['web1'] }))
  assert.match(errorOf(() => normalizeSteps({ steps: many })).message, /最多 8 条/)
  const ok = normalizeSteps({ steps: [{ command: ' uname -a ', why: ' 看内核 ', hosts: ['web1'], cwd: '/tmp' }] })
  assert.equal(ok[0].command, 'uname -a')
  assert.equal(ok[0].why, '看内核')
  assert.equal(ok[0].cwd, '/tmp')
})

await test('resolveStepTargets：未知主机报可用清单；wsl: 前缀解析成发行版', () => {
  const state = normalizeHostsDocument(HOSTS)
  const [, wslStep] = resolveStepTargets(
    [
      { index: 0, command: 'a', why: 'w', hostNames: ['web1'] },
      { index: 1, command: 'b', why: 'w', hostNames: ['wsl:Debian'] },
    ],
    state,
  )
  assert.equal(wslStep.targets[0].kind, 'wsl')
  try {
    resolveStepTargets([{ index: 0, command: 'a', why: 'w', hostNames: ['nope'] }], state)
    throw new Error('本该抛错')
  } catch (error) {
    assert.match(error.message, /可用：web1、web2/)
  }
})

await test('trimOutput：短输出原样；超长只留尾部并标注', () => {
  assert.deepEqual(trimOutput('abc', 10), { text: 'abc', truncated: false })
  const trimmed = trimOutput('x'.repeat(100), 10)
  assert.equal(trimmed.truncated, true)
  assert.match(trimmed.text, /已截断/)
  assert.equal(trimmed.text.endsWith('x'.repeat(10)), true)
})

await test('未知目标：直接返回错误，不弹卡、不执行', async () => {
  const env = await setup()
  const result = await env.tool.execute({ steps: [{ command: 'ls', why: '看目录', hosts: ['ghost'] }] }, EXEC)
  assert.match(result.error, /没有配置主机「ghost」/)
  assert.equal(env.events.length, 0, '不该弹卡')
  assert.equal(env.calls.run.length, 0)
})

await test('全跳过（空选择）：一条都不执行', async () => {
  const env = await setup({ pick: () => [] })
  const result = await env.tool.execute(
    {
      steps: [
        { command: 'uname -a', why: '看内核', hosts: ['web1'] },
        { command: 'df -h', why: '看磁盘', hosts: ['web1'] },
      ],
    },
    EXEC,
  )
  assert.equal(result.approved, 0)
  assert.equal(result.skipped, 2)
  assert.deepEqual(result.results, [])
  assert.equal(env.calls.run.length, 0, '空选择必须一条都不跑')
})

await test('只勾第一行：只执行那一行（多主机各自一条结果）', async () => {
  const env = await setup({ pick: () => [0] })
  const result = await env.tool.execute(
    {
      steps: [
        { command: 'uname -a', why: '看内核', hosts: ['web1', 'web2'] },
        { command: 'df -h', why: '看磁盘', hosts: ['web1'] },
      ],
    },
    EXEC,
  )
  assert.equal(result.approved, 1)
  assert.equal(result.skipped, 1)
  assert.deepEqual(env.calls.run.map((call) => call.host), ['web1', 'web2'])
  assert.equal(env.calls.run[0].command, 'uname -a')
  assert.equal(result.results.length, 2)
  assert.ok(result.results.every((row) => row.ok && row.exitCode === 0))

  // 没勾的那一行要在返回里留痕迹，否则模型会以为整单都跑了。
  const rendered = env.tool.output.render({ steps: [{ command: 'a', why: 'x', hosts: ['web1', 'web2'] }, { command: 'df -h', why: '看磁盘', hosts: ['web1'] }] }, result)
  const text = rendered.map((part) => part.text).join('\n')
  assert.match(text, /未勾选，未执行/)
  assert.match(text, /第 2 条/)
})

await test('WSL 目标走 wsl.run，并把 cwd 传成 workdir', async () => {
  const env = await setup({ pick: () => [0] })
  const result = await env.tool.execute(
    { steps: [{ command: 'ls -la', why: '看目录', hosts: ['wsl:Debian'], cwd: '/home/me' }] },
    EXEC,
  )
  assert.equal(env.calls.wsl.length, 1)
  assert.equal(env.calls.wsl[0].distro, 'Debian')
  assert.equal(env.calls.wsl[0].options.workdir, '/home/me')
  assert.equal(result.results[0].target, 'WSL(Debian)')
})

await test('卡片：一行一条 step，勾选行只写主机，命令与原因在行内（B-15 / B-22 / B-23）', async () => {
  const env = await setup({ pick: () => [] })
  await env.tool.execute(
    {
      steps: [
        { command: 'uname -a', why: '看内核与架构', hosts: ['web1', 'web2'] },
        { command: 'df -h', why: '看磁盘余量', hosts: ['web1'], cwd: '/tmp' },
      ],
    },
    EXEC,
  )
  const ask = env.events.find((event) => event.kind === 'ask')
  assert.equal(ask.rows.length, 2, '两行 step 两行选项')
  // 选项行只表达「哪几台」：主机标签带地址与端口（B-22），不接命令首行（B-23）
  assert.equal(ask.rows[0].label, '192.168.1.11:22 · Web 1 + 192.168.1.12:22 · Web 2')
  assert.equal(ask.rows[1].label, '192.168.1.11:22 · Web 1')
  assert.equal(ask.rows[0].text, 'uname -a')
  assert.equal(ask.rows[0].why, '看内核与架构')
  assert.equal(ask.rows[0].meta, '', '没有 cwd/超时时不塞空附加信息')
  assert.equal(ask.rows[1].meta, '工作目录 /tmp')
})

await test('run 行仍按 sh 高亮：桌面卡行不带 lang（空 = sh），text 就是命令原文（D-37）', async () => {
  const env = await setup({ pick: () => [] })
  await env.tool.execute(
    { steps: [{ command: 'uname -a', why: '看内核', hosts: ['web1'] }] },
    EXEC,
  )
  const ask = env.events.find((event) => event.kind === 'ask')
  // 搬运卡的行给 lang='text'（说明文字），run 卡的行必须是真命令：lang 为空 → 页面按 sh 高亮。
  assert.equal(ask.rows[0].lang, '', 'lang 默认空，不跟着搬运行的 text 一起改成 text')
  assert.equal(ask.rows[0].text, 'uname -a', '命令原文一字不改（B-31 / C-08）')
  assert.equal(ask.rows[0].why, '看内核', '原因原文，外壳拼成 `# 原因` 第一行')
})

await test('卡片正文：只有「一行粗体定位 + 一块命令」两种构造（B-14 / B-15）', () => {
  const question = questionOf([
    { command: 'uname -a', why: '看内核与架构', hosts: ['web1', 'web2'] },
    { command: 'df -h', why: '看磁盘余量', hosts: ['web1'], cwd: '/tmp' },
  ])
  // 正文只有两种构造：一行粗体定位 + 一块命令（原因作为代码块首行注释）
  assert.match(question.detail, /\*\*192\.168\.1\.11:22 · Web 1 \+ 192\.168\.1\.12:22 · Web 2\*\*/)
  assert.match(question.detail, /```sh\n# 看内核与架构\nuname -a\n```/)
  assert.match(question.detail, /工作目录 \/tmp/)
  assert.doesNotMatch(question.detail, /^- 原因/m, '原因不再单起一个列表项')
  assert.doesNotMatch(question.detail, /^> /m, '默认不加引用脚注')
  assert.doesNotMatch(question.detail, /\| # \| 目标 \| 操作 \| 原因 \|/, '不再用表格')
  assert.doesNotMatch(question.detail, /共 \d+ 行/, '不再堆一句「共 N 行」')
  assert.deepEqual(Object.keys(question.options[0]).sort(), ['label'], '选项行只有 label：没有 description，也不往选项行塞原因')
})

await test('step 行里不再有「主机 · 命令首行」字段，选项里没有命令文本（B-23）', () => {
  const steps = resolveStepTargets(
    normalizeSteps({
      steps: [{ command: 'for u in https://download.docker.com/linux; do echo "$u"; done', why: '换源', hosts: ['web1'] }],
    }),
    normalizeHostsDocument(HOSTS),
  )
  const rows = stepsToRows(steps)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['code', 'head', 'meta', 'target', 'why'], '行字段里没有 label')
  assert.equal(rows[0].label, undefined, '不再产出「主机 · 命令首行」这种会被截断的拼接字段')
  assert.equal(rows[0].head, '192.168.1.11:22 · Web 1')
  assert.equal(rows[0].code, 'for u in https://download.docker.com/linux; do echo "$u"; done')
  const question = buildApprovalQuestion({ rows })
  assert.doesNotMatch(question.options.map((option) => option.label).join('\n'), /for u in/, '选项里不许出现命令')
})

await test('卡片：目标撞车时用 ①②③ 区分，不再把命令接到选项后面（B-23）', async () => {
  const env = await setup({ pick: () => [] })
  await env.tool.execute(
    {
      steps: [
        { command: 'uname -a', why: '看内核', hosts: ['web1'] },
        { command: 'df -h', why: '看磁盘', hosts: ['web1'] },
      ],
    },
    EXEC,
  )
  const ask = env.events.find((event) => event.kind === 'ask')
  assert.deepEqual(
    ask.rows.map((row) => row.label),
    ['① 192.168.1.11:22 · Web 1', '② 192.168.1.11:22 · Web 1'],
    '同主机的多行只剩主机 + 编号',
  )
  // 正文块标题同样带编号，否则人只能数块对位
  const detail = questionOf([
    { command: 'uname -a', why: '看内核', hosts: ['web1'] },
    { command: 'df -h', why: '看磁盘', hosts: ['web1'] },
  ]).detail
  assert.match(detail, /\*\*① 192\.168\.1\.11:22 · Web 1\*\*/)
  assert.match(detail, /\*\*② 192\.168\.1\.11:22 · Web 1\*\*/)
})

await test('超过 maxCardRows：返回错误让模型分批', async () => {
  const env = await setup({ settings: { maxCardRows: 2 } })
  const result = await env.tool.execute(
    {
      steps: [
        { command: 'a', why: 'w', hosts: ['web1'] },
        { command: 'b', why: 'w', hosts: ['web1'] },
        { command: 'c', why: 'w', hosts: ['web1'] },
      ],
    },
    EXEC,
  )
  assert.match(result.error, /最多 2 条/)
  assert.equal(env.events.length, 0)
})

await test('预连接发生在弹卡之前', async () => {
  const env = await setup({ pick: () => [0] })
  await env.tool.execute({ steps: [{ command: 'x', why: 'w', hosts: ['web1'] }] }, EXEC)
  const kinds = env.events.map((event) => event.kind)
  assert.deepEqual(kinds.slice(0, 2), ['connect', 'ask'], `实际顺序：${kinds.join(',')}`)
})

await test('输出按预算截断（每步与总量）', async () => {
  const env = await setup({ pick: () => [0], settings: { outputBytesPerStep: 8, outputBytesTotal: 12 } })
  const result = await env.tool.execute({ steps: [{ command: 'x', why: 'w', hosts: ['web1'] }] }, EXEC)
  assert.match(result.results[0].stdout, /已截断/)
})

await test('审计只记元信息：有字节数、没有输出正文', async () => {
  const env = await setup({ pick: () => [0] })
  await env.tool.execute({ steps: [{ command: 'uname -a', why: 'w', hosts: ['web1'] }] }, EXEC)
  // 阶段事件（D-30）也是审计记录：这条用例只针对「结果」那一条，阶段时间线另有用例。
  const records = env.audit.records.filter((entry) => entry.event === 'result')
  assert.equal(records.length, 1)
  const record = records[0]
  assert.equal(record.target, '192.168.1.11:22 · Web 1', '审计用标签（与卡片一致，含地址）')
  assert.equal(record.command, 'uname -a')
  assert.equal(record.approved, true)
  assert.equal(typeof record.stdoutBytes, 'number')
  assert.equal(record.stdout, undefined, '审计不该带输出正文')
})

await test('审计阶段：approval → connect → exec 逐条追加，callId 串起时间线（D-30）', async () => {
  const env = await setup({ pick: () => [0] })
  await env.tool.execute({ steps: [{ command: 'uname -a', why: 'w', hosts: ['web1'] }] }, EXEC)
  assert.deepEqual(
    env.audit.records.map((record) => `${record.event}:${record.phase}`),
    ['enter:approval', 'enter:connect', 'enter:exec', 'result:exec'],
    '进入每个阶段先留一条，跑完再落结果',
  )
  assert.deepEqual(
    [...new Set(env.audit.records.map((record) => record.phase))],
    ['approval', 'connect', 'exec'],
    '三个取值都要有落点',
  )
  for (const record of env.audit.records) {
    assert.equal(record.kind, 'run')
    assert.equal(record.callId, 'call-1', '同一次调用靠 callId 串起来，才能算出每段停了多久')
  }
})

await test('审计阶段：纯 WSL 调用没有 connect（不建连接）', async () => {
  const env = await setup({ pick: () => [0] })
  await env.tool.execute({ steps: [{ command: 'uname -r', why: 'w', hosts: ['wsl:Debian'] }] }, EXEC)
  assert.deepEqual(
    env.audit.records.map((record) => `${record.event}:${record.phase}`),
    ['enter:approval', 'enter:exec', 'result:exec'],
  )
})

await test('C-10：审批只走桌面卡片（工具连宿主 channel 都拿不到）', async () => {
  const opened = []
  const dialog = {
    async selectRows(options) {
      opened.push(options)
      return { answered: true, selected: [options.rows[0].label] }
    },
  }
  const { tool, calls } = await setup({ dialog })
  const result = await tool.execute(
    {
      steps: [
        { command: 'uname -a', why: '看内核', hosts: ['web1'] },
        { command: 'df -h', why: '看磁盘', hosts: ['web1'] },
      ],
    },
    EXEC,
  )
  assert.equal(opened.length, 1, '应当走桌面卡片一次')
  assert.equal(opened[0].title, undefined, '固定句标题不再传给桌面卡片（B-16）')
  assert.equal(opened[0].rows.length, 2, '每一行都要单独成一档')
  assert.match(opened[0].rows[0].text, /uname -a/)
  assert.match(opened[0].rows[0].why, /看内核/)
  assert.equal(result.results.length, 1, '只执行勾中的那一行')
  assert.equal(calls.run.length, 1)
  assert.equal(calls.run[0].command, 'uname -a', '执行的是被勾中的第一条，不是第二条')
})

await test('R-25：卡片抬头下面那行取会话工作区（exec.agent.session.header.cwd）', async () => {
  // 宿主进程的 cwd 与用户打开的项目无关（本机从 %USERPROFILE% 起），
  // 而这一行的用途就是「认出是哪个项目」（approval.mjs 的注释原文）。
  const opened = []
  const dialog = {
    async selectRows(options) {
      opened.push(options)
      return { answered: true, selected: [] }
    },
  }
  const { tool } = await setup({ dialog })
  const workDir = join(tmpdir(), 'example-ai-baojia-system')
  const exec = { agent: { id: 'agent-1', session: { header: { cwd: workDir } } }, callId: 'call-1' }
  await tool.execute({ steps: [{ command: 'pwd', why: '看目录', hosts: ['web1'] }] }, exec)
  assert.equal(opened.length, 1, '应当走桌面卡片一次')
  assert.equal(opened[0].workDir, workDir, '卡片那行必须是会话工作区')
  assert.notEqual(opened[0].workDir, process.cwd(), '不许再显示宿主进程的工作目录')
})

await test('R-25：没有会话（headless / SDK 直调）时退回宿主进程的工作目录', async () => {
  const opened = []
  const dialog = {
    async selectRows(options) {
      opened.push(options)
      return { answered: true, selected: [] }
    },
  }
  const { tool } = await setup({ dialog })
  await tool.execute({ steps: [{ command: 'pwd', why: '看目录', hosts: ['web1'] }] }, EXEC)
  assert.equal(opened[0].workDir, process.cwd(), '没有会话就没有工作区可显示，退回进程 cwd')
})

await test('R-25：resolveWorkDir 只认非空字符串（缺字段 / 空串 / 非字符串都退回进程 cwd）', () => {
  const cwd = 'C:\\work\\Example\\example-ai-baojia-system'
  assert.equal(resolveWorkDir({ agent: { session: { header: { cwd } } } }, '/fallback'), cwd)
  assert.equal(resolveWorkDir({ agent: { session: { header: { cwd: `  ${cwd}  ` } } } }, '/fallback'), cwd, '两侧空白要裁掉')
  assert.equal(resolveWorkDir({ agent: { session: { header: { cwd: '   ' } } } }, '/fallback'), '/fallback', '空串不是路径')
  assert.equal(resolveWorkDir({ agent: { session: {} } }, '/fallback'), '/fallback')
  assert.equal(resolveWorkDir({ agent: {} }, '/fallback'), '/fallback')
  assert.equal(resolveWorkDir(undefined, '/fallback'), '/fallback')
  assert.equal(resolveWorkDir({ agent: { session: { header: { cwd: 42 } } } }, '/fallback'), '/fallback', '非字符串不许当路径')
})

await test('C-10：卡片起不来就让命令失败，不静默切到宿主弹窗', async () => {
  const dialog = {
    async selectRows() {
      throw new Error('审批弹窗起不来：spawn EPERM')
    },
  }
  const { tool, calls } = await setup({ dialog })
  const result = await tool.execute({ steps: [{ command: 'x', why: 'w', hosts: ['web1'] }] }, EXEC)
  assert.match(result.error, /审批弹窗起不来/, '卡片的错误原样报给调用方')
  assert.equal(calls.run.length, 0, '没拿到人工确认就绝不执行')
})

await test('桌面卡片被关掉（未回答）＝ 一行都不执行', async () => {
  const dialog = { async selectRows() { return { answered: false, selected: [] } } }
  const { tool, calls } = await setup({ dialog })
  const result = await tool.execute({ steps: [{ command: 'x', why: 'y', hosts: ['web1'] }] }, EXEC)
  assert.equal(result.approved, 0)
  assert.equal(result.results.length, 0)
  assert.equal(calls.run.length, 0, '没勾选就绝不执行')
})

await test('askApproval：signal 原样交给卡片构建器（不吞在中间，D-26）', async () => {
  const controller = new AbortController()
  let received
  const answer = await askApproval({
    question: questionOf([{ command: 'x', why: 'w', hosts: ['web1'] }]),
    fallbackSelect: async (_question, options) => {
      received = options?.signal
      return []
    },
    signal: controller.signal,
  })
  assert.equal(received, controller.signal, 'signal 必须传到 fallbackSelect')
  assert.deepEqual(answer, { indices: [] }, '空选择＝全部跳过')
})

await test('取消（点停止）：signal 到 selectRows，卡片被杀后工具立刻按「跳过」结算（D-26）', async () => {
  const controller = new AbortController()
  const seen = []
  // 真卡片被强杀后的行为（admin.mjs）：pwsh 非 0 退出、stderr 空 → 按「没勾选」返回。
  // 这里只模拟这一步的结论：收到 abort 就结束，并且什么都不选。
  const dialog = {
    async selectRows(options) {
      seen.push(options)
      return await new Promise((resolve) => {
        if (options.signal === undefined) return // 没把信号传下来：永不 resolve（等于改前的死键）
        options.signal.addEventListener('abort', () => resolve({ answered: false, selected: [] }), { once: true })
      })
    },
  }
  const { tool, calls } = await setup({ dialog })
  const pending = tool.execute(
    { steps: [{ command: 'rm -rf /srv/x', why: '清理', hosts: ['web1'] }] },
    { ...EXEC, signal: controller.signal },
  )
  const abortTimer = setTimeout(() => controller.abort(), 20)
  let deadlineTimer
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('点停止之后工具没有 settle：取消信号被吞了')), 2000)
  })
  let result
  try {
    result = await Promise.race([pending, deadline])
  } finally {
    clearTimeout(abortTimer)
    clearTimeout(deadlineTimer)
  }
  assert.equal(seen.length, 1, '卡片应当被弹过一次')
  assert.equal(seen[0].signal, controller.signal, 'signal 必须原样传到 dialog.selectRows')
  assert.equal(result.approved, 0)
  assert.deepEqual(result.results, [])
  assert.equal(calls.run.length, 0, '停下＝一行都不执行')
})

await test('断链归因：没有退出码的 close → 「连接中断」+ dropped 标记（D-26）', async () => {
  // 真 pool 在「服务端没给退出码就关通道」时给 dropped: true（见 pool.test.mjs），
  // 这里只验工具层怎么把它写进结果：说清是链路断了，且不编一个「退出码 1」。
  const env = await setup({
    pick: () => [0],
    pool: {
      status: () => [],
      connect: async () => ({}),
      run: async () => ({ exitCode: null, signalName: null, dropped: true, stdout: '', stderr: '', ms: 42 }),
    },
  })
  const args = { steps: [{ command: 'rm -rf /srv/x', why: '清理', hosts: ['web1'] }] }
  const result = await env.tool.execute(args, EXEC)
  assert.equal(result.results.length, 1)
  const row = result.results[0]
  assert.equal(row.ok, false)
  assert.equal(row.dropped, true, '结果里要有一个明确标记')
  assert.equal(row.exitCode, null, '断链不编造退出码')
  assert.match(row.error, /与 192\.168\.1\.11:22 · Web 1 的连接中断（命令可能未执行完）/)
  // 阶段事件（D-30）在前，断链标记在「结果」那一条上。
  const droppedRecord = env.audit.records.find((entry) => entry.event === 'result')
  assert.equal(droppedRecord.dropped, true, '审计里也留痕')

  const text = env.tool.output.render(args, result).map((part) => part.text).join('\n')
  assert.match(text, /连接中断/, '结果文本要说清是链路断了')
  assert.match(text, /命令可能未执行完/, '要提醒命令可能只跑了一半')
  assert.doesNotMatch(text, /退出码 1/, '不许把它报成「命令自己失败」')
  assert.doesNotMatch(text, /退出码 无/, '也不许只剩一句「退出码 无」')
})

await test('没有卡片构建器：askApproval 直接抛错，不许去问宿主（C-10）', async () => {
  // askApproval 已经没有 ctx 参数了；这里故意再塞一个会记账的宿主 channel，
  // 万一以后有人把「没有卡片就问宿主」加回来，这条会立刻红。
  const channelAsks = []
  const error = await caughtAsync(
    askApproval({ ctx: fakeHostChannel(channelAsks), question: questionOf([{ command: 'x', why: 'w', hosts: ['web1'] }]) }),
  )
  assert.equal(error.name, 'ApprovalUnavailableError')
  assert.match(error.message, /没有可用的审批卡片/)
  assert.match(error.message, /请重试/, '要让人知道是重试就能解决')
  assert.equal(channelAsks.length, 0, '宿主内置问题弹窗一次都不该被调用')
})

await test('工具里没有卡片（dialog 缺 selectRows）：报错让用户重试，一行都不执行', async () => {
  // 这里只放一个不相关的弹窗能力：selectRows 缺失就是要报错，不许去问宿主。
  const env = await setup({ dialog: { confirm: async () => ({ confirmed: false }) } })
  const result = await env.tool.execute({ steps: [{ command: 'x', why: 'w', hosts: ['web1'] }] }, EXEC)
  assert.match(result.error, /没有可用的审批卡片/)
  assert.equal(env.calls.run.length, 0, '没有人工确认就绝不执行')
})

await test('卡片：单行且无附加信息时，正文不再重复「① 目标」那一行', async () => {
  const solo = buildApprovalQuestion({
    rows: [{ target: 'WSL(Debian)', head: 'WSL(Debian)', code: 'uname -r', why: '看内核' }],
  })
  assert.equal(solo.detail, '```sh\n# 看内核\nuname -r\n```', '正文里只剩代码块')
  assert.deepEqual(solo.options.map((option) => option.label), ['WSL(Debian)'])

  const withMeta = buildApprovalQuestion({
    rows: [{ target: 'WSL(Debian)', head: 'WSL(Debian)', meta: '工作目录 /tmp', code: 'pwd', why: 'w' }],
  })
  assert.match(withMeta.detail, /^\*\*WSL\(Debian\)\*\* · 工作目录 \/tmp\n\n```sh/, '有附加信息时保留标题，但不带编号')

  const multi = buildApprovalQuestion({
    rows: [
      { target: 'Web 1', head: 'Web 1', code: 'a', why: 'w' },
      { target: 'Web 2', head: 'Web 2', code: 'b', why: 'w' },
    ],
  })
  assert.match(multi.detail, /\*\*Web 1\*\*/, '多行时正文保留目标那一行')
  assert.deepEqual(multi.options.map((option) => option.label), ['Web 1', 'Web 2'], '标签不重名就不加编号')
})

await test('卡片：标签真的重名时才退回 ①②，正文块标题同步带编号', async () => {
  const question = buildApprovalQuestion({
    rows: [
      { target: 'Web 1', head: 'Web 1', code: 'a', why: 'w' },
      { target: 'Web 1', head: 'Web 1', code: 'b', why: 'w' },
    ],
  })
  assert.deepEqual(question.options.map((option) => option.label), ['① Web 1', '② Web 1'])
  assert.match(question.detail, /\*\*① Web 1\*\*/)
  assert.match(question.detail, /\*\*② Web 1\*\*/)
})

console.log(`\n结果：全部通过（${passed} 项）`)
