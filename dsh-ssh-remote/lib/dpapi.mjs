/**
 * DPAPI 的 Node 侧封装：把 scripts/protect.ps1 / unprotect.ps1 当成两个黑盒调用。
 *
 * 约定（与 .ps1 一致）：
 * - 明文只走 stdin / stdout，永远不出现在命令行参数、环境变量或文件里；
 * - 熵固定 `dsh-ssh-remote/v1`，CurrentUser 范围；换用户或换机器解不开（这是设计意图）。
 */
import { join } from 'node:path'

const PS = ['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/** 收集模式上限：vault 明文是几 KB 的 JSON，2 MB 足够且能兜住异常写入。 */
const STDOUT_LIMIT = 2 * 1024 * 1024
const STDERR_LIMIT = 64 * 1024

export class DpapiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DpapiError'
  }
}

/**
 * @param subprocess - `ctx.subprocess`（宿主服务，插件里直接可用）
 * @param scriptDir - `scripts/` 目录的绝对路径
 * @param cwd - 子进程工作目录（用插件目录即可）
 */
export function createDpapi({ subprocess, scriptDir, cwd }) {
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
    throw new DpapiError('拿不到 subprocess 服务，无法调用 DPAPI 脚本')
  }

  /** 跑一个脚本，返回 stdout 文本；非零退出或超时都抛 DpapiError。 */
  async function run(script, args, { stdin, timeoutMs, signal } = {}) {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', forwardAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error('DPAPI 脚本超时')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    let handle
    try {
      handle = subprocess.spawn({
        argv: [...PS, join(scriptDir, script), ...args],
        cwd,
        stdio: {
          stdin: stdin === undefined ? 'ignore' : { data: stdin },
          stdout: { maxBytes: STDOUT_LIMIT },
          stderr: { maxBytes: STDERR_LIMIT },
        },
        graceMs: Math.max(1000, Math.min(timeoutMs, 20000)),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      throw new DpapiError(`${script} 起不来：${error?.message ?? error}`)
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
    } catch (error) {
      throw new DpapiError(`${script} 执行失败：${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', forwardAbort)
    }

    const stderr = readCollected(handle.collected?.stderr).trim()
    if (outcome?.exitCode !== 0) {
      throw new DpapiError(`${script} 退出码 ${outcome?.exitCode ?? '未知'}${stderr === '' ? '' : `：${stderr.slice(0, 800)}`}`)
    }
    return readCollected(handle.collected?.stdout)
  }

  return {
    /** 加密 `text` 并写入 `path`（脚本内部用临时文件 + 替换）。 */
    async protect(path, text, options = {}) {
      await run('protect.ps1', ['-Path', path], {
        stdin: text,
        timeoutMs: options.timeoutMs ?? 20000,
        signal: options.signal,
      })
    },
    /** 解密 `path`，返回明文。 */
    async unprotect(path, options = {}) {
      return run('unprotect.ps1', ['-Path', path], {
        timeoutMs: options.timeoutMs ?? 20000,
        signal: options.signal,
      })
    },
  }
}
