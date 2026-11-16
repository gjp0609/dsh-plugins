/**
 * WSL runner 单测：不起真 `wsl.exe`，只看它拼出来的 argv 与脚本。
 *
 * 覆盖两件真机踩出来的事：
 * - 脚本必须整体 base64（`wsl.exe` 会展开 `$`，引号挡不住，见 K-014）；
 * - 不传 workdir 时先 `cd "$HOME"`，否则起点是插件目录翻译出来的 `/mnt/...`。
 *
 * 运行：node dsh-ssh-remote/tests/wsl.test.mjs
 */
import assert from 'node:assert/strict'
import { createWslRunner, prependHomeDir, prependWorkdir, wrapScript, wrapScriptKeepStdin } from '../lib/wsl.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/** 假 subprocess：记下每次 spawn 的参数，立即成功返回。 */
function fakeSubprocess() {
  const calls = []
  return {
    calls,
    spawn(options) {
      calls.push(options)
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: 'out' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
        stdin: null,
        stdout: null,
        stderr: null,
        terminate() {},
      }
    },
  }
}

/** 从 `t=<path>; echo <b64>|base64 -d>"$t" && sh "$t"` 这类命令行里把脚本还原出来。 */
function decodeScript(argv) {
  const command = argv[argv.length - 1]
  const match = /echo ([A-Za-z0-9+/=]+)\|base64 -d/.exec(command)
  assert.ok(match !== null, `命令行不是预期的 base64 形式：${command}`)
  // 解码与执行之间必须是 `&&`：否则 base64 失败时 sh 会跑一个空脚本并以 0 退出，
  // 命令一条没跑却报「✅ 退出码 0」。
  assert.match(command, /&& sh /, `解码与执行之间必须是 &&：${command}`)
  // 脚本首行是自清理的 trap（包装命令行里不能有 $，所以清理只能放在脚本里）。
  return Buffer.from(match[1], 'base64')
    .toString('utf8')
    .replace(/^trap 'rm -f [^']+' EXIT\n/, '')
}

await test('prependWorkdir：cd 失败就整条不跑', () => {
  // `wsl.exe --cd` 失败只打警告、命令照跑（实测），所以脚本里必须再守一道。
  assert.equal(prependWorkdir('pwd', '/srv/app'), `cd -- '/srv/app' || exit 1\npwd`)
  assert.equal(prependWorkdir('pwd', "/tmp/it's"), `cd -- '/tmp/it'\\''s' || exit 1\npwd`)
})

await test('prependHomeDir：cd 放在最前，原命令在后', () => {
  assert.equal(prependHomeDir('pwd'), 'cd "$HOME" 2>/dev/null || true\npwd')
})

await test('run：不传 workdir 时没有 --cd，脚本先 cd "$HOME"', async () => {
  const subprocess = fakeSubprocess()
  const wsl = createWslRunner({ subprocess, cwd: 'C:\\plugin' })
  await wsl.run('Debian', 'pwd')
  const argv = subprocess.calls[0].argv
  assert.ok(!argv.includes('--cd'), '没有 workdir 就不该传 --cd')
  assert.equal(decodeScript(argv), 'cd "$HOME" 2>/dev/null || true\npwd')
})

await test('run：传了 workdir 走 --cd，脚本里再守一道 cd（--cd 失败时命令不该继续跑）', async () => {
  const subprocess = fakeSubprocess()
  const wsl = createWslRunner({ subprocess, cwd: 'C:\\plugin' })
  await wsl.run('Debian', 'pwd', { workdir: '/srv/app' })
  const argv = subprocess.calls[0].argv
  const cdIndex = argv.indexOf('--cd')
  assert.ok(cdIndex >= 0)
  assert.equal(argv[cdIndex + 1], '/srv/app')
  assert.equal(decodeScript(argv), `cd -- '/srv/app' || exit 1\npwd`)
})

await test('openPipe：stdin 留给数据时脚本走临时文件，且同样从 $HOME 开始', async () => {
  const subprocess = fakeSubprocess()
  const wsl = createWslRunner({ subprocess, cwd: 'C:\\plugin' })
  wsl.openPipe('Debian', 'cat > /tmp/x', { keepStdin: true })
  const script = decodeScript(subprocess.calls[0].argv)
  // trap 已由 decodeScript 剥掉；这里只剩被包进来的原始脚本。
  assert.match(script, /cd "\$HOME" 2>\/dev\/null \|\| true\ncat > \/tmp\/x$/)
})

await test('wrapScript / wrapScriptKeepStdin：命令行里没有 $ 与引号', () => {
  const script = wrapScriptKeepStdin('echo "$HOME" 与 \'x\'')
  assert.ok(!script.includes('$'), '整个命令行不能出现 $（wsl.exe 会展开）')
  assert.ok(script.startsWith('echo '))
  const wrapped = wrapScript('echo hi')
  assert.match(wrapped, /^echo [A-Za-z0-9+/=]+\|base64 -d>\/tmp\/\.dsh-ssh-[0-9a-f]+\.sh && sh \/tmp\/\.dsh-ssh-[0-9a-f]+\.sh$/)
})

console.log(`结果：全部通过（${passed} 项）`)
