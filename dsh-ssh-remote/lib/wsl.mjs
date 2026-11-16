/**
 * WSL 侧执行：一切都走 `wsl.exe`，不依赖 `\\wsl$`（P0 实测不可见），也不用 `\\wsl.localhost`。
 *
 * P0 已证明：插件（宿主 High 令牌）能起 `wsl.exe`，且二进制 stdout 能原样穿过管道。
 *
 * ## 为什么命令要先 base64 再传
 *
 * `wsl.exe` 会把命令行里的 `$` 当成 **Windows 环境变量**展开（它在 Windows 侧做，不认 shell 引号），
 * 而 Node 的 Windows 参数转义又和它叠加，导致 `"`、`\`、换行在往返中层层失效。实测（2026-10-22）：
 *
 * | 发出去 | 到 bash 手里 |
 * | :-- | :-- |
 * | `[ -d "$p" ]` | 变成 `[ -d "" ]`（`$p` 被展开成空）→ 永远为假 |
 * | `printf '...\n'` 里的 `\n` | 少一层反斜杠，打印出字面量 `n` |
 * | `echo A"double"B` | 引号消失，得到 `AdoubleB` |
 * | `'$HOME'`（单引号） | **照样被展开**成 `/root`——wsl.exe 不认引号 |
 *
 * 所以**不能**靠加反斜杠硬转义（三层转义互相打架）。改成把整段脚本 base64 编码，
 * 命令行里只留 `echo <base64>|base64 -d|sh`：字母数字加 `+/=`，没有任何会被改写的字符。
 * 已实测：双引号、`$p`、`$( )`、`printf '\n'` 全部原样生效。
 *
 * 代价：WSL 里要有 `base64`（coreutils/busybox 都有）。远端 SSH 不受此影响——SSH 协议本身传的是字符串。
 */
import { randomBytes } from 'node:crypto'

const PS_TIMEOUT_GRACE_MS = 10000

/**
 * 把脚本编码成「单行、无引号、无 `$`、无换行」的命令。
 * @param command - 任意 POSIX sh 脚本
 */
export function wrapScript(command) {
  const path = `/tmp/.dsh-ssh-${randomBytes(4).toString('hex')}.sh`
  // 清理放进脚本自己的 trap：包装命令行里**一个 `$` 都不能有**（wsl.exe 会拿 Windows 环境去展开），
  // 所以不能写 `r=$?; rm -f "$t"; exit $r` 这种。
  const script = `trap 'rm -f ${path}' EXIT\n${command}`
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  // 必须 `&& sh`：只写 `|sh` 时，发行版里没有 base64（或解码失败）会让 sh 拿到空脚本、
  // 以 0 退出——命令一条没跑，结果却是「✅ 退出码 0」，属于最糟的假成功。
  return `echo ${encoded}|base64 -d>${path} && sh ${path}`
}

/**
 * 同 {@link wrapScript}，但**把 stdin 留给数据用**（搬运的接收端要往 stdin 灌字节，
 * 而管道形式里 stdin 已经被 base64 占掉了）。
 *
 * 做法：先把脚本解码到一个临时文件，再 `sh <文件>`——这样 stdin 就是调用方给的那条管道。
 * 脚本首行自带 `trap ... EXIT` 自杀，成功失败都不留垃圾；解码失败就不执行（`&&`）。
 */
export function wrapScriptKeepStdin(command, token = randomBytes(4).toString('hex')) {
  const path = `/tmp/.dsh-ssh-${token}.sh`
  const script = `trap 'rm -f ${path}' EXIT\n${command}`
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  return `echo ${encoded}|base64 -d>${path} && sh ${path}`
}

/**
 * 不指定 workdir 时先 `cd "$HOME"`。
 *
 * 为什么需要：`wsl.exe` 的起始目录是**调用它的 Windows 进程 cwd** 翻译过来的
 * （插件目录 → `/mnt/r/...`），不是家目录。实测 `pwd` 会给出
 * `/mnt/r/Files/Workspace/Mine/dsh-plugins/dsh-ssh-remote`，与远端主机「从家目录开始」不一致。
 * `cd` 失败不拦（`$HOME` 缺失的极端情况），命令照跑。
 */
export function prependHomeDir(command) {
  return `cd "$HOME" 2>/dev/null || true\n${command}`
}

/** `cd` 失败就整条不跑：`--cd` 失败时 wsl.exe 只往 stderr 打一行警告，命令照样在继承目录里执行。 */
export function prependWorkdir(command, workdir) {
  const quoted = String(workdir).replace(/'/g, `'\\''`)
  return `cd -- '${quoted}' || exit 1\n${command}`
}

/**
 * @param subprocess - `ctx.subprocess`
 * @param cwd - 起 `wsl.exe` 时的 Windows 工作目录（插件目录即可）
 */
export function createWslRunner({ subprocess, cwd }) {
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
    throw new Error('拿不到 subprocess 服务，无法运行 WSL 命令')
  }

  /**
   * 在一个发行版里跑一条命令。
   * @param workdir - Linux 侧工作目录（翻译成 `wsl.exe --cd`，不拼进命令串，避免引号问题）
   */
  async function run(distro, command, { workdir, timeoutMs = 30000, signal, maxBytes = 16 * 1024 } = {}) {
    const argv = ['wsl.exe', '-d', distro]
    const hasWorkdir = workdir !== undefined && workdir !== null && String(workdir).trim() !== ''
    if (hasWorkdir) argv.push('--cd', String(workdir))
    // `--cd` 只是"建议"：目录不存在时 wsl.exe 打一行 ERROR 就继续在继承目录里跑命令
    // （实测：cd 到不存在的目录，两行命令都执行了）。所以脚本里再守一道，cd 失败就整条不跑。
    argv.push('--', 'sh', '-c', wrapScript(hasWorkdir ? prependWorkdir(command, workdir) : prependHomeDir(command)))

    const startedAt = Date.now()
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error('WSL 命令超时')), Math.max(1000, timeoutMs))
    // 命令在飞的时候超时必须能触发，所以不 unref。

    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes },
          stderr: { maxBytes },
        },
        graceMs: PS_TIMEOUT_GRACE_MS,
        env: { WSL_UTF8: '1' },
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      throw new Error(`wsl.exe 起不来（${distro}）：${error?.message ?? error}`)
    }

    const readCollected = (reader) => {
      try {
        return reader?.readFrom?.(0)?.text ?? ''
      } catch {
        return ''
      }
    }

    let outcome
    try {
      outcome = await handle.done
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', forwardAbort)
    }

    return {
      exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
      signalName: outcome?.signal ?? null,
      stdout: readCollected(handle.collected?.stdout),
      stderr: readCollected(handle.collected?.stderr),
      ms: Date.now() - startedAt,
      timedOut: controller.signal.aborted && timer !== null,
    }
  }

  /**
   * 打开一条 stdin/stdout 都是原始字节的通道（搬运中继用），命令由调用方拼。
   * 与 `run()` 的区别：`run()` 把输出当文本收集（会按 maxBytes 截断），这里一个字节都不动。
   * @param keepStdin - true 时 stdin 留给数据（脚本改走临时文件），供接收端灌字节
   */
  function openPipe(distro, command, { signal, keepStdin = false } = {}) {
    return subprocess.spawn({
      argv: ['wsl.exe', '-d', distro, '--', 'sh', '-c', keepStdin ? wrapScriptKeepStdin(prependHomeDir(command)) : wrapScript(prependHomeDir(command))],
      cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: PS_TIMEOUT_GRACE_MS,
      env: { WSL_UTF8: '1' },
      signal,
    })
  }

  return { run, openPipe }
}
