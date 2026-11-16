/**
 * ssh_copy 单测：假端点 io + 真 StateStore（假 DPAPI）+ 假卡片。
 *
 * 这里不模拟 shell，只模拟「预检怎么答」和「字节流进得来出得去」，
 * 因为搬运逻辑的决策全在预检结果与两端退出码上；真正的 shell 脚本内容用字符串断言覆盖。
 *
 * 运行：node dsh-ssh-remote/tests/copy.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  assertPath,
  buildProbeCommand,
  buildSinkCommand,
  buildSourceCommand,
  CopyError,
  createCopyTool,
  describeAction,
  formatBytes,
  isEarlyClose,
  itemsToRows,
  joinPath,
  normalizeItems,
  parseProbe,
  relayBytes,
  shQuote,
  splitPath,
} from '../lib/copy.mjs'
import { createPaths, StateStore } from '../lib/store.mjs'
import { wrapScript, wrapScriptKeepStdin } from '../lib/wsl.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/** 取到抛出的错误（没抛就算失败）。 */
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

const HOSTS = {
  hosts: {
    web1: { address: '192.168.1.11', user: 'deploy', label: 'Web 1' },
    web2: { address: '192.168.1.12', user: 'deploy', label: 'Web 2' },
  },
  wsl: { Debian: { label: '本机 Debian' } },
}

/** 审批只在工具调用里闭环：exec 里的 agent/callId 由宿主给，卡片的返回也走同一次调用。 */
const EXEC = { agent: { id: 'agent-1' }, callId: 'call-1' }

function keyOf(target) {
  return target.kind === 'wsl' ? `wsl:${target.distro}` : target.id
}

/** 把虚拟文件系统里的一条记录变成预检脚本会打印的那几行。 */
function probeStdout(entry) {
  if (entry === undefined || entry.type === 'missing') return 'type=missing\n'
  if (entry.type === 'dir') return `type=dir\nentries=${entry.entries ?? 0}\n`
  if (entry.type === 'link') return 'type=link\n'
  return `type=file\nsize=${entry.size ?? 0}\n`
}

/**
 * 假端点 io：
 * - `runText` 只认预检脚本（首行 `p='...'`），按 entries 表作答；
 * - `openMany` 按命令猜角色（`cat `/`tar -cf -` 是源，`cat >`/`tar -xf -` 是目标），
 *   源给出 `srcData` 这条可读流，目标把收到的字节攒进 `collected`。
 */
function fakeIo({ entries = {}, srcData = Buffer.from('hello'), srcExit = 0, dstExit = 0, srcStderr = '', dstStderr = '', events = [] } = {}) {
  const opens = []
  const collected = []
  const releases = []

  const io = {
    async runText(target, command) {
      const match = /^p='(.*)'$/m.exec(command)
      if (match === null) throw new Error(`预检命令里找不到 p=：${command.slice(0, 40)}`)
      const lookup = `${keyOf(target)}:${match[1]}`
      events.push({ kind: 'probe', lookup })
      return { exitCode: 0, stdout: probeStdout(entries[lookup]), stderr: '', ms: 1 }
    },

    async openMany(target, commands) {
      events.push({ kind: 'open', target: keyOf(target), count: commands.length })
      return commands.map((command) => {
        const isSource = command.startsWith('cat ') || command.includes('tar -cf -')
        opens.push({ target: keyOf(target), command, role: isSource ? 'src' : 'dst' })
        if (isSource) {
          return {
            stdout: Readable.from([srcData]),
            stdin: null,
            done: Promise.resolve({ exitCode: srcExit, signalName: null, stderr: srcStderr }),
            kill() {},
            release() {
              releases.push('src')
            },
          }
        }
        return {
          stdout: null,
          stdin: new Writable({
            write(chunk, _encoding, done) {
              collected.push(Buffer.from(chunk))
              done()
            },
          }),
          done: Promise.resolve({ exitCode: dstExit, signalName: null, stderr: dstStderr }),
          kill() {},
          release() {
            releases.push('dst')
          },
        }
      })
    },
  }

  return { io, opens, collected, releases, events }
}

async function setup({ pick = () => [], entries = {}, settings = {}, dialog, ...rest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-copy-'))
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify(HOSTS), 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  await store.ensureLoaded()
  Object.assign(store.settings, settings)

  const events = []
  const fake = fakeIo({ entries, events, ...rest })
  const asks = []
  // 假桌面卡：C-10 之后这是搬运审批的唯一路径。
  // `pick(rows)` 决定勾第几项；卡片只拿得到 rows，断言也就只看得到 rows。
  const card = dialog ?? {
    async selectRows(options) {
      asks.push(options)
      const indices = pick(options.rows)
      return { answered: true, selected: indices.map((index) => options.rows[index].label) }
    },
  }
  const audit = { records: [], record(entry) { this.records.push(entry) }, prune: () => 0 }
  const tool = createCopyTool({ store, io: fake.io, audit, dialog: card })
  return { dir, paths, store, tool, audit, asks, fake, events }
}

/** 一条最常见的搬运项：web1 上的文件 → WSL。 */
function fileItem(overrides = {}) {
  return {
    from: { target: 'web1', path: '/srv/app.tar' },
    to: { target: 'wsl:Debian', path: '/home/me/app.tar' },
    why: '把发布包送到本机 WSL 里验证',
    ...overrides,
  }
}

const BASIC_ENTRIES = {
  'web1:/srv/app.tar': { type: 'file', size: 5 },
  'wsl:Debian:/home/me/app.tar': { type: 'missing' },
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

await test('shQuote：单引号按 POSIX 规则转义', () => {
  assert.equal(shQuote('/a/b'), "'/a/b'")
  assert.equal(shQuote("/a b'c"), "'/a b'\\''c'")
})

await test('assertPath：只收绝对路径，拒绝根目录与 .. 段', () => {
  assert.equal(assertPath('/a/b', '拔'), '/a/b')
  assert.throws(() => assertPath('rel/b', '源'), /绝对路径/)
  assert.throws(() => assertPath('', '源'), /不能为空/)
  assert.throws(() => assertPath('/', '源'), /根目录/)
  assert.throws(() => assertPath('/a/../b', '源'), /不能含 \.\./)
  assert.throws(() => assertPath('/a\nb', '源'), /换行/)
})

await test('splitPath / joinPath：父目录与末段', () => {
  assert.deepEqual(splitPath('/a/b'), { parent: '/a', name: 'b' })
  assert.deepEqual(splitPath('/a'), { parent: '/', name: 'a' })
  assert.deepEqual(splitPath('/a/b/'), { parent: '/a', name: 'b' })
  assert.equal(joinPath('/x', 'y'), '/x/y')
  assert.equal(joinPath('/', 'y'), '/y')
  assert.equal(joinPath('/x/', 'y'), '/x/y')
})

await test('formatBytes：卡片上的体积', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GB')
  assert.equal(formatBytes(undefined), '未知大小')
})

await test('buildProbeCommand / parseProbe：一次往返问出类型、大小、项数', () => {
  const command = buildProbeCommand('/var/log/app.log', { maxEntries: 42 })
  assert.match(command, /^p='\/var\/log\/app\.log'$/m)
  assert.match(command, /head -n 42/)
  assert.match(command, /find "\$p" -mindepth 1/)

  assert.deepEqual(parseProbe('type=dir\nentries=12\n'), { type: 'dir', entries: 12, size: null })
  assert.deepEqual(parseProbe('type=file\nsize=99\n'), { type: 'file', entries: null, size: 99 })
  assert.equal(parseProbe('type=missing\n').type, 'missing')
  assert.equal(parseProbe('type=weird\n').type, 'missing')
  assert.equal(parseProbe('').type, 'missing')
})

await test('buildSourceCommand：目录走 tar 流，文件走 cat', () => {
  assert.equal(buildSourceCommand({ type: 'file' }, '/a/b.txt'), "cat '/a/b.txt'")
  assert.equal(buildSourceCommand({ type: 'dir' }, '/a/data'), "tar -cf - -C '/a' -- 'data'")
})

await test('buildSinkCommand（文件）：先写临时名、再替换；不覆盖时带 exit 3 守卫', () => {
  const safe = buildSinkCommand({ finalPath: '/t/x.txt', sourceName: 'x.txt', info: { type: 'file' }, overwrite: false, token: 'abc' })
  // 不再依赖 set -e：每个失败分支自己清理，避免失败时把临时文件留在目标目录里
  assert.doesNotMatch(safe, /set -e/)
  assert.match(safe, /mkdir -p '\/t' \|\| exit 1/)
  assert.match(safe, /cat > '\/t\/x\.txt\.dsh-copy-abc' \|\| \{ rm -f '\/t\/x\.txt\.dsh-copy-abc'; exit 1; \}/)
  assert.match(safe, /mv -f '\/t\/x\.txt\.dsh-copy-abc' '\/t\/x\.txt'/)
  assert.match(safe, /exit 3/)
  assert.match(safe, /rm -f '\/t\/x\.txt\.dsh-copy-abc'; exit 3/)
  // 不覆盖时目标本来就不存在，不该再多一次删除动作
  assert.doesNotMatch(safe, /rm -rf '\/t\/x\.txt'/)

  const over = buildSinkCommand({ finalPath: '/t/x.txt', sourceName: 'x.txt', info: { type: 'file' }, overwrite: true, token: 'abc' })
  assert.doesNotMatch(over, /exit 3/)
  assert.match(over, /rm -rf '\/t\/x\.txt'/)
  // 顺序很重要：先把新数据收完，才动旧文件。
  assert.ok(over.indexOf('cat > ') < over.indexOf("rm -rf '/t/x.txt'"))
})

await test('isEarlyClose：只认真正的提前关流，AbortError 不算', () => {
  // Node 的 pipeline 中止时抛 AbortError；把它认成「对端早关」就会把自家超时洗成成功（真机踩过）。
  assert.equal(isEarlyClose(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), false)
  assert.equal(isEarlyClose(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })), true)
  assert.equal(isEarlyClose(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true)
  assert.equal(isEarlyClose(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true)
  // 这些不是提前关流，别吞掉。
  assert.equal(isEarlyClose(null), false)
  assert.equal(isEarlyClose(new Error('connect ECONNREFUSED')), false)
  assert.equal(isEarlyClose(Object.assign(new Error('boom'), { code: 'ENOSPC' })), false)
})

await test('relayBytes：空闲看门狗到点抛自己的超时，而不是包装后的 AbortError', async () => {
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
    final(_done) {
      // 故意不完成：模拟远端关通道后挂起、pipeline 永远等不到 finish
    },
  })
  const error = await caughtAsync(relayBytes({ source: Readable.from([Buffer.from('x')]), sink, idleMs: 120 }))
  assert.ok(error instanceof CopyError, `应当是 CopyError，实际是 ${error?.name}`)
  assert.equal(error.code, 'timeout')
  assert.match(error.message, /没有数据流动/)
  assert.equal(isEarlyClose(error), false, '自家的超时不能被判成对端早关')
})

await test('buildSinkCommand（目录）：解包到临时目录，成功后才替换旧目录', () => {
  const script = buildSinkCommand({ finalPath: '/t/old', sourceName: 'old', info: { type: 'dir' }, overwrite: true, token: 'tok' })
  assert.match(script, /mkdir -p '\/t' '\/t\/\.dsh-ssh-copy-tok' \|\| exit 1/)
  assert.match(script, /tar -xf - -C '\/t\/\.dsh-ssh-copy-tok' \|\| \{ rm -rf '\/t\/\.dsh-ssh-copy-tok'; exit 1; \}/)
  assert.match(script, /mv '\/t\/\.dsh-ssh-copy-tok\/old' '\/t\/old'/)
  assert.match(script, /rm -rf '\/t\/\.dsh-ssh-copy-tok'$/)
  // 覆盖必须能回滚：旧目录先改名成备份，绝不能在 mv 之前 rm -rf 掉。
  assert.doesNotMatch(script, /rm -rf '\/t\/old'/)
  assert.ok(script.indexOf('tar -xf') < script.indexOf("mv '/t/old' '/t/.dsh-ssh-bak-tok'"))
  assert.ok(script.indexOf("mv '/t/old' '/t/.dsh-ssh-bak-tok'") < script.indexOf("mv '/t/.dsh-ssh-copy-tok/old' '/t/old'"))
  // 失败时要能把备份改回原名
  assert.match(script, /mv '\/t\/\.dsh-ssh-bak-tok' '\/t\/old' 2>\/dev\/null \|\| true/)
})

await test('buildSinkCommand（文件）：覆盖时只在目标是目录时才清，文件靠原子 rename 替换', () => {
  const script = buildSinkCommand({ finalPath: '/t/f', sourceName: 'f', info: { type: 'file' }, overwrite: true, token: 'tok' })
  // `mv -f` 本身就是原子替换；先 rm 会留下一段"文件不存在"的窗口。
  assert.doesNotMatch(script, /rm -rf '\/t\/f'\n/)
  assert.match(script, /if \[ -d '\/t\/f' \]; then rm -rf '\/t\/f' \|\| \{ rm -f '[^']+'; exit 1; \}; fi/)
  assert.match(script, /mv -f '[^']+' '\/t\/f'/)
})

await test('buildSinkCommand（目录改名）：暂存路径用源的名字（真机踩过）', () => {
  const script = buildSinkCommand({ finalPath: '/t/renamed', sourceName: 'src', info: { type: 'dir' }, overwrite: false, token: 'tok' })
  // tar 归档里的条目叫 src，所以暂存路径必须是 .dsh-ssh-copy-tok/src
  assert.match(script, /mv '\/t\/\.dsh-ssh-copy-tok\/src' '\/t\/renamed'/)
  assert.doesNotMatch(script, /\.dsh-ssh-copy-tok\/renamed/)
})

await test('normalizeItems：缺 why、相对路径、同一位置、超行数都报清楚', () => {
  const errorOf = (fn) => {
    try {
      fn()
    } catch (error) {
      return error
    }
    throw new Error('本该抛错')
  }
  assert.match(errorOf(() => normalizeItems({ items: [] })).message, /非空数组/)
  assert.match(errorOf(() => normalizeItems({ items: [fileItem({ why: '  ' })] })).message, /缺 why/)
  assert.match(errorOf(() => normalizeItems({ items: [fileItem({ from: { target: 'web1', path: 'x' } })] })).message, /绝对路径/)
  assert.match(
    errorOf(() => normalizeItems({ items: [fileItem({ to: { target: 'web1', path: '/srv/app.tar' } })] })).message,
    /同一个位置/,
  )
  const many = Array.from({ length: 9 }, () => fileItem())
  assert.match(errorOf(() => normalizeItems({ items: many })).message, /最多 8 项/)

  const ok = normalizeItems({ items: [fileItem({ overwrite: true })] })
  assert.equal(ok[0].overwrite, true)
  assert.equal(ok[0].from.target, 'web1')
})

await test('describeAction：体积与覆盖标记放最前', () => {
  const plan = {
    src: { target: { kind: 'remote', id: 'web1' }, path: '/srv/app.tar' },
    dst: { target: { kind: 'wsl', distro: 'Debian' }, path: '/home/me/' },
    srcInfo: { type: 'file' },
    size: 2048,
    entries: null,
    entriesCapped: false,
    dstExists: true,
    overwrite: true,
    finalPath: '/home/me/app.tar',
  }
  const text = describeAction(plan)
  assert.match(text, /^\[文件 2\.0 KB · ⚠ 覆盖\]/)
  assert.match(text, /\/srv\/app\.tar → \/home\/me\/app\.tar$/)

  const dirPlan = { ...plan, srcInfo: { type: 'dir' }, entries: 5000, entriesCapped: true, dstExists: false, overwrite: false }
  assert.match(describeAction(dirPlan), /^\[目录 ≥5000 项\]/)
})

await test('搬运行：卡片正文两行 Source/Target 不带反引号，lang=text（不按命令高亮，D-37）', () => {
  const plan = {
    src: { target: { kind: 'remote', id: 'web1' }, path: '/srv/app.tar' },
    dst: { target: { kind: 'wsl', distro: 'Debian' }, path: '/home/me/' },
    srcInfo: { type: 'file' },
    size: 2048,
    entries: null,
    entriesCapped: false,
    dstExists: true,
    overwrite: true,
    finalPath: '/home/me/app.tar',
    why: '把发布包送到本机 WSL 里验证',
  }
  const [row] = itemsToRows([plan])
  assert.deepEqual(
    Object.keys(row).sort(),
    ['fields', 'head', 'lang', 'meta', 'target', 'text', 'why'],
    '行的字段集合（fields 与 text 同时存在，各行一条路用）',
  )
  assert.equal(row.why, '把发布包送到本机 WSL 里验证', '原因必须是原文，外壳自己拼 #')
  assert.equal(row.lang, 'text', '说明文字不按 shell 高亮')
  assert.equal(row.text, 'Source: /srv/app.tar\nTarget: /home/me/app.tar', '两行、不带中文前缀、不带反引号')
  assert.equal(row.text.includes('`'), false, '路径不带反引号')
  assert.doesNotMatch(row.text, /源：|目标：/, '卡片正文不用中文「源 / 目标」')
  assert.match(row.meta, /文件 2\.0 KB · ⚠ 覆盖/, '框底那条（体积/标志）不变')
  assert.deepEqual(
    row.fields.map((field) => `${field.label}=${field.value}`),
    ['源=`/srv/app.tar`', '目标=`/home/me/app.tar`'],
    '浏览器审批文案仍是中文 + 反引号（与卡片措辞不同、数据同源）',
  )
})

// ---------------------------------------------------------------------------
// WSL 命令传输（wsl.exe 会改写 `$` 与 `"`，所以脚本必须 base64）
// ---------------------------------------------------------------------------

await test('wrapScript：命令行里只剩 echo/base64/sh，脚本可无损还原', () => {
  const command = `p='/tmp/x y'\nif [ -d "$p" ]; then printf "type=dir\\nentries=%s\\n" "$n"; fi`
  const wrapped = wrapScript(command)

  const match = /^echo ([A-Za-z0-9+/=]+)\|base64 -d>(\S+) && sh (\S+)$/.exec(wrapped)
  assert.notEqual(match, null, `形状不对：${wrapped}`)
  assert.equal(wrapped.includes('"'), false, '命令行里不能出现双引号')
  assert.equal(wrapped.includes('$'), false, '命令行里不能出现 $（会被 wsl.exe 展开）')
  assert.equal(wrapped.includes('\n'), false, '命令行必须是单行')
  // 解码失败就不许执行：`|sh` 会让 sh 跑空脚本并以 0 退出（假成功）。
  assert.equal(match[2], match[3], '解码出的文件和执行的文件必须是同一个')
  const script = Buffer.from(match[1], 'base64').toString('utf8')
  assert.equal(script.startsWith(`trap 'rm -f ${match[2]}' EXIT\n`), true, '要能自己清理临时文件')
  assert.equal(script.endsWith(command), true)
})

await test('wrapScriptKeepStdin：stdin 留给数据，脚本走临时文件并自杀', () => {
  const wrapped = wrapScriptKeepStdin(`cat > '/tmp/x'`, 'tok1')
  const match = /^echo ([A-Za-z0-9+/=]+)\|base64 -d>\/tmp\/\.dsh-ssh-tok1\.sh && sh \/tmp\/\.dsh-ssh-tok1\.sh$/.exec(wrapped)
  assert.notEqual(match, null, `形状不对：${wrapped}`)
  assert.equal(wrapped.includes('"'), false)

  const script = Buffer.from(match[1], 'base64').toString('utf8')
  assert.equal(script.startsWith(`trap 'rm -f /tmp/.dsh-ssh-tok1.sh' EXIT\n`), true, '要能自己清理临时文件')
  assert.equal(script.endsWith(`cat > '/tmp/x'`), true)
})

// ---------------------------------------------------------------------------
// 端到端（假端点）
// ---------------------------------------------------------------------------

await test('C-10：搬运审批只走桌面卡片（工具连宿主 channel 都拿不到）', async () => {
  const opened = []
  const dialog = {
    async selectRows(options) {
      opened.push(options)
      return { answered: true, selected: [options.rows[0].label] }
    },
  }
  const binary = Buffer.from([0x00, 0x01, 0x02])
  const { tool, fake } = await setup({ dialog, entries: BASIC_ENTRIES, srcData: binary })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)

  assert.equal(opened.length, 1, '应当走桌面卡片一次')
  assert.equal(opened[0].title, undefined, '固定句标题不再传给桌面卡片（B-16）')
  assert.equal(opened[0].rows.length, 1)
  // 卡片上这一行是「说明文字」：原因原文（外壳拼成 `# …`）+ 两行 Source/Target，不按 shell 高亮。
  assert.equal(opened[0].rows[0].why, '把发布包送到本机 WSL 里验证')
  assert.equal(opened[0].rows[0].text, 'Source: /srv/app.tar\nTarget: /home/me/app.tar')
  assert.equal(opened[0].rows[0].lang, 'text')
  assert.equal(result.approved, 1)
  assert.equal(result.results[0].ok, true)
  assert.equal(Buffer.concat(fake.collected).equals(binary), true)
})

await test('R-25：搬运卡抬头那行同样取会话工作区，不是宿主进程 cwd', async () => {
  // run / copy / jms 三处都要同一口径：卡片上那行是「会话工作区」。
  const opened = []
  const dialog = {
    async selectRows(options) {
      opened.push(options)
      return { answered: true, selected: [] }
    },
  }
  const { tool } = await setup({ dialog, entries: BASIC_ENTRIES })
  const workDir = join(tmpdir(), 'example-ai-baojia-system')
  const exec = { agent: { id: 'agent-1', session: { header: { cwd: workDir } } }, callId: 'call-1' }
  await tool.execute({ items: [fileItem()] }, exec)
  assert.equal(opened[0].workDir, workDir)
  assert.notEqual(opened[0].workDir, process.cwd(), '不许再显示宿主进程的工作目录')
})
await test('搬运文件：目标端落地字节数对不上就报失败（两端 exit 0 也不行）', async () => {
  // 场景：中继提前关流、目标端只收到一部分，`cat` 收多少写多少、照样退出 0，
  // 两端 exit 0 —— 原来这条会被判成功。目标端的回执必须戳破它。
  const { tool } = await setup({
    pick: () => [0],
    entries: BASIC_ENTRIES,
    srcData: Buffer.from('hello'),
    dstStderr: 'dsh-ssh-wrote=0\n',
  })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)
  assert.equal(result.approved, 1)
  assert.equal(result.results[0].ok, false)
  assert.match(result.results[0].error, /只落地了 0 字节/)
})

await test('搬运文件：字节原样到达目标端，结果里报体积与耗时', async () => {
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x41])
  const { tool, fake, audit } = await setup({ pick: () => [0], entries: BASIC_ENTRIES, srcData: binary })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)

  assert.equal(result.error, undefined)
  assert.equal(result.approved, 1)
  assert.equal(result.skipped, 0)
  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].bytes, binary.length)
  assert.equal(result.results[0].kind, '文件')
  assert.equal(Buffer.concat(fake.collected).equals(binary), true)

  const sink = fake.opens.find((open) => open.role === 'dst')
  assert.match(sink.command, /cat > '\/home\/me\/app\.tar\.dsh-copy-[0-9a-f]+'/)
  assert.match(sink.command, /mv -f '.*' '\/home\/me\/app\.tar'/)

  // 阶段事件（D-30）也是审计记录：这里只针对「结果」那一条。
  const records = audit.records.filter((entry) => entry.event === 'result')
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, 'copy')
  assert.equal(records[0].bytes, binary.length)
  // 审计里不该出现文件内容或命令输出，只有路径
  assert.equal(JSON.stringify(records[0]).includes('hello'), false)
})

await test('审计阶段：搬运记 connect → approval → exec，结果带 exec 与 callId（D-30）', async () => {
  const { tool, audit } = await setup({ pick: () => [0], entries: BASIC_ENTRIES })
  await tool.execute({ items: [fileItem()] }, EXEC)
  assert.deepEqual(
    audit.records.map((record) => `${record.event}:${record.phase}`),
    ['enter:connect', 'enter:approval', 'enter:exec', 'result:exec'],
    '预检要先连上两端，所以 connect 落在 approval 之前',
  )
  assert.deepEqual([...new Set(audit.records.map((record) => record.phase))], ['connect', 'approval', 'exec'])
  assert.equal(audit.records.at(-1).bytes, Buffer.from('hello').length, '结果那一条照旧带字节数')
  for (const record of audit.records) assert.equal(record.callId, 'call-1', '同一次调用靠 callId 串起来')
})

await test('一项都不勾：一个通道都不开，全部记为跳过', async () => {
  const { tool, fake } = await setup({ pick: () => [], entries: BASIC_ENTRIES })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)
  assert.equal(result.approved, 0)
  assert.equal(result.skipped, 1)
  assert.deepEqual(result.results, [])
  assert.equal(fake.opens.length, 0)
})

await test('只勾一半：没勾的那项绝不执行', async () => {
  const entries = { ...BASIC_ENTRIES, 'web1:/srv/other.tar': { type: 'file', size: 5 }, 'wsl:Debian:/home/me/other.tar': { type: 'missing' } }
  const { tool, fake, asks } = await setup({ pick: () => [1], entries })
  const second = fileItem({ from: { target: 'web1', path: '/srv/other.tar' }, to: { target: 'wsl:Debian', path: '/home/me/other.tar' } })
  const result = await tool.execute({ items: [fileItem(), second] }, EXEC)

  assert.equal(asks.length, 1)
  assert.equal(result.approved, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].item, 1)
  assert.equal(fake.opens.length, 2) // 只开了一对通道
  assert.match(fake.opens[0].command, /other\.tar/)
})

await test('目标已存在且没写 overwrite：预检就整单失败，连卡都不弹', async () => {
  const entries = { 'web1:/srv/app.tar': { type: 'file', size: 5 }, 'wsl:Debian:/home/me/app.tar': { type: 'file', size: 1 } }
  const { tool, fake, asks } = await setup({ pick: () => [0], entries })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)

  assert.match(result.error, /目标已存在/)
  assert.match(result.error, /overwrite 设为 true/)
  assert.equal(asks.length, 0)
  assert.equal(fake.opens.length, 0)
})

await test('显式 overwrite：正文标出「⚠ 覆盖」，选项只写目标，允许执行', async () => {
  const entries = { 'web1:/srv/app.tar': { type: 'file', size: 5 }, 'wsl:Debian:/home/me/app.tar': { type: 'file', size: 1 } }
  const { tool, fake, asks } = await setup({ pick: () => [0], entries })
  const result = await tool.execute({ items: [fileItem({ overwrite: true })] }, EXEC)

  assert.equal(asks.length, 1)
  assert.equal(asks[0].rows[0].label, '192.168.1.11:22 · Web 1 → WSL(Debian)', '选项只写两台主机，带地址')
  assert.match(asks[0].rows[0].meta, /⚠ 覆盖/, '覆盖警告进行内附加信息')
  assert.equal(result.results[0].ok, true)
  assert.equal(fake.opens.length, 2)
})

await test('目标写成目录（结尾 /）：落到该目录下并沿用源的名字', async () => {
  const entries = {
    'web1:/srv/app.tar': { type: 'file', size: 5 },
    'wsl:Debian:/home/me/dest': { type: 'dir', entries: 2 },
    'wsl:Debian:/home/me/dest/app.tar': { type: 'missing' },
  }
  const { tool, fake } = await setup({ pick: () => [0], entries })
  const result = await tool.execute({ items: [fileItem({ to: { target: 'wsl:Debian', path: '/home/me/dest/' } })] }, EXEC)

  assert.equal(result.results[0].to, 'WSL(Debian):/home/me/dest/app.tar')
  const sink = fake.opens.find((open) => open.role === 'dst')
  assert.match(sink.command, /'\/home\/me\/dest\/app\.tar'/)
})

await test('目标路径本身是已存在的目录：同样落到目录里', async () => {
  const entries = {
    'web1:/srv/app.tar': { type: 'file', size: 5 },
    'wsl:Debian:/home/me/dest': { type: 'dir', entries: 0 },
    'wsl:Debian:/home/me/dest/app.tar': { type: 'missing' },
  }
  const { tool } = await setup({ pick: () => [0], entries })
  const result = await tool.execute({ items: [fileItem({ to: { target: 'wsl:Debian', path: '/home/me/dest' } })] }, EXEC)
  assert.equal(result.results[0].to, 'WSL(Debian):/home/me/dest/app.tar')
})

await test('搬运目录（顺便改名）：源打 tar 流、目标解包，暂存路径用源名', async () => {
  const entries = { 'web1:/data/logs': { type: 'dir', entries: 5 }, 'web1:/backup/logs-old': { type: 'missing' } }
  const { tool, fake, events } = await setup({ pick: () => [0], entries, srcData: Buffer.from('tarbytes') })
  const result = await tool.execute(
    { items: [{ from: { target: 'web1', path: '/data/logs' }, to: { target: 'web1', path: '/backup/logs-old' }, why: '本机备份' }] },
    EXEC,
  )

  assert.equal(result.results[0].ok, true)
  assert.equal(result.results[0].kind, '目录')
  // 同一台主机必须一次要齐两条通道，否则会被串行队列堵死
  assert.equal(events.filter((event) => event.kind === 'open').length, 1)
  assert.equal(events.find((event) => event.kind === 'open').count, 2)
  assert.match(fake.opens[0].command, /tar -cf - -C '\/data' -- 'logs'/)
  assert.match(fake.opens[1].command, /tar -xf - -C '\/backup\/\.dsh-ssh-copy-[0-9a-f]+'/)
  // tar 条目叫 logs，目标叫 logs-old：暂存路径必须是 .../logs
  assert.match(fake.opens[1].command, /mv '\/backup\/\.dsh-ssh-copy-[0-9a-f]+\/logs' '\/backup\/logs-old'/)
})

await test('源端读取失败（退出码非 0）：结果里说清是源端', async () => {
  const { tool } = await setup({ pick: () => [0], entries: BASIC_ENTRIES, srcExit: 5, srcStderr: 'cat: 权限不够' })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)
  assert.equal(result.results[0].ok, false)
  assert.match(result.results[0].error, /源端读取失败（退出码 5）/)
  assert.match(result.results[0].error, /权限不够/)
})

await test('目标端守卫触发（退出码 3）：报「目标已存在，未覆盖」', async () => {
  const { tool } = await setup({ pick: () => [0], entries: BASIC_ENTRIES, dstExit: 3, dstStderr: 'dsh-ssh-remote: 目标已存在' })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)
  assert.equal(result.results[0].ok, false)
  assert.match(result.results[0].error, /目标端写入失败（退出码 3）/)
  assert.match(result.results[0].error, /未覆盖/)
})

await test('源不存在 / 源是断链：都在预检阶段报出来', async () => {
  const missing = await setup({ pick: () => [0], entries: { 'wsl:Debian:/home/me/app.tar': { type: 'missing' } } })
  const one = await missing.tool.execute({ items: [fileItem()] }, EXEC)
  assert.match(one.error, /源不存在：192\.168\.1\.11:22 · Web 1:\/srv\/app\.tar/)

  const broken = await setup({ pick: () => [0], entries: { 'web1:/srv/app.tar': { type: 'link' } } })
  const two = await broken.tool.execute({ items: [fileItem()] }, EXEC)
  assert.match(two.error, /断链的软链接/)
})

await test('体积超过 copyMaxBytes：预检拒绝，不弹卡', async () => {
  const entries = { 'web1:/srv/app.tar': { type: 'file', size: 4096 }, 'wsl:Debian:/home/me/app.tar': { type: 'missing' } }
  const { tool, asks } = await setup({ pick: () => [0], entries, settings: { copyMaxBytes: 1024 } })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)
  assert.match(result.error, /超过单次搬运上限 1\.0 KB/)
  assert.equal(asks.length, 0)
})

await test('多项里只要有一项预检失败：整单不动，错误一次列全', async () => {
  const entries = { ...BASIC_ENTRIES, 'web1:/srv/none.tar': { type: 'missing' } }
  const broken = fileItem({ from: { target: 'web1', path: '/srv/none.tar' }, to: { target: 'web1', path: '/srv/x.tar' } })
  const { tool, fake, asks } = await setup({ pick: () => [0, 1], entries })
  const result = await tool.execute({ items: [fileItem(), broken] }, EXEC)
  assert.match(result.error, /第 2 项：源不存在/)
  assert.equal(asks.length, 0)
  assert.equal(fake.opens.length, 0)
})

await test('未知主机：预检前就报可用清单', async () => {
  const { tool } = await setup({ pick: () => [0], entries: BASIC_ENTRIES })
  const result = await tool.execute({ items: [fileItem({ from: { target: 'nope', path: '/a' } })] }, EXEC)
  assert.match(result.error, /没有配置主机「nope」/)
  assert.match(result.error, /web1、web2/)
})

await test('没有卡片构建器：拒绝执行，绝不无确认地搬东西（C-10）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-copy-'))
  const paths = createPaths(dir)
  writeFileSync(paths.hostsJson, JSON.stringify(HOSTS), 'utf8')
  const store = new StateStore({ paths, dpapi: fakeDpapi() })
  await store.ensureLoaded()
  const fake = fakeIo({ entries: BASIC_ENTRIES })
  const tool = createCopyTool({ store, io: fake.io, audit: { record() {}, prune: () => 0 } })
  const result = await tool.execute({ items: [fileItem()] }, EXEC)
  assert.match(result.error, /没有可用的审批卡片/)
  assert.equal(fake.opens.length, 0)
})

console.log(`\n${passed} 项通过`)
