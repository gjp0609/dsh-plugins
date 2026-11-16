/**
 * 执行一段（D-33）：`run`（一条命令，等退出码）、`channels` + `openChannel`（搬运用的
 * 字节流通道），以及两段纯函数 `wrapCommand` / `tailBytes`。
 *
 * 依赖显式传入：`pool` 提供串行队列、连接、设置与时钟；`entry` 是一条已就绪的连接。
 * 这里不认 `this`——`ConnectionPool.run/channels/openChannel` 只是把 `this` 传进来。
 */
import { EXIT_SETTLE_MS, PoolError, close, serial } from './lifecycle.mjs'
import { connectEntry } from './connect.mjs'
import { isJmsHost } from '../jms/hosts.mjs'
import { parseExecOutput, stripMarkedText, wrapExecCommand } from '../jms/stream.mjs'

/**
 * 把 cwd 拼到命令前面。
 *
 * 不能用 `cd '<cwd>' && <command>`：换行会终止 and-or 列表，`&&` 只保护**第一行**。
 * cwd 写错时，第 2..N 行照样执行，而且是在 `$HOME` 里——`pwd` + `rm -rf ./*` 这种
 * 多行命令就是灾难，而且退出码取最后一行，很可能还是 0（报成功）。
 *
 * 所以：`cd -- '<cwd>' || exit 1` + 换行 + 脚本。`--` 也顺手挡住 `cwd` 以 `-` 开头时
 * 被 `cd` 当成选项（`cd -` 是 OLDPWD、`cd --` 是 HOME）。
 */
export function wrapCommand(command, cwd) {
  if (cwd === undefined || cwd === null || String(cwd).trim() === '') return command
  const quoted = String(cwd).replace(/'/g, `'\\''`)
  return `cd -- '${quoted}' || exit 1\n${command}`
}

/** 只保留尾部 `limit` 字节（超长输出对模型没价值，头部的意义更小）。 */
export function tailBytes(buffer, limit) {
  if (buffer.length <= limit) return buffer
  const cut = buffer.subarray(buffer.length - limit)
  // 按字节切会把多字节字符切一半，结果里出现 U+FFFD（"中文" 变成 "�文"）。
  // 往前跳过 UTF-8 续字节，落到字符边界上。
  let start = 0
  while (start < cut.length && start < 4 && (cut[start] & 0xc0) === 0x80) start += 1
  return cut.subarray(start)
}

/**
 * 定退出码：**接入点回的通道退出码不可信**（实测恒为 0，`false` 也报 0）。
 *
 * 所以先看 stdout 里 `@@DSH_RC=` 带回来的那个（`parseExecOutput`）；只有它解析不到时
 * 才退回通道给的 `code`。两个都没有 → `null`，交给 `dropped` 判断（D-26）。
 * @param parsedExitCode - stdout 里带回的退出码（`number | null`）
 * @param channelExitCode - 通道 exit-status 给的退出码（`number | null`）
 */
export function resolveExitCode(parsedExitCode, channelExitCode) {
  if (typeof parsedExitCode === 'number') return parsedExitCode
  return typeof channelExitCode === 'number' ? channelExitCode : null
}

/**
 * 在远端执行一条命令，返回 `{ exitCode, signalName, dropped, stdout, stderr, ms }`。
 *
 * `dropped === true` 表示通道在给出退出码之前就关了（链路断了），`exitCode` 因此是 `null`；
 * 调用方必须把它当成「命令可能没执行完」而不是「命令以某个退出码失败」（D-26）。
 *
 * 带内部来源标记的主机（`isJmsHost`）：命令多包一层标记（`2>&1` 合并 stderr、退出码写进 stdout），
 * stdout 切掉服务端前缀与那段退出码标记，退出码取标记里的值（这条通道的 exit-status 恒为 0，不可信）；
 * 普通主机的命令与输出一个字节都不动。
 */
export async function runCommand(pool, host, command, { cwd, timeoutMs, signal } = {}) {
  return await serial(pool, host.id, async () => {
    const entry = await connectEntry(pool, host, { signal })
    const startedAt = pool.now()
    const limit = pool.getSettings().outputBytesPerStep
    // 带内部来源标记的主机：每条通道的 stdout 前面都有服务端前缀，而且**只有 stdout**——
    // 退出码也要靠命令自己写进 stdout（`2>&1` 顺带把 stderr 并进来）。命令包一层标记、
    // 输出切一刀再去掉退出码标记，用户（和模型）看到的就跟普通主机一样了。
    // 普通主机走的分支一个字节都不变。
    const viaExec = isJmsHost(host)

    // 执行期间算「忙」：否则空闲回收/LRU 淘汰会把正在跑命令的连接当空闲关掉，
    // 命令中途被杀、输出只剩一半（idleTimeoutMs 可配到 10s，比命令超时还短）。
    entry.busy = (entry.busy ?? 0) + 1
    try {
      return await new Promise((resolve, reject) => {
      let settled = false
      const chunks = { stdout: [], stderr: [] }
      const bytes = { stdout: 0, stderr: 0 }
      // 真实总量（bytes 会被裁剪重置，用它判断有没有截断）
      const totals = { stdout: 0, stderr: 0 }
      let timer = null

      const cleanup = () => {
        if (timer !== null) clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      }

      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup()
        // 超时/中断会让这条会话状态不可信：连连接一起废掉，下次重连。
        close(pool, host.id)
        reject(error)
      }

      const onAbort = () => fail(new PoolError('命令被中断', 'aborted'))

      if (timeoutMs !== undefined && timeoutMs !== null) {
        // 故意不 unref：命令在飞的时候，这个超时必须能正常触发。
        timer = setTimeout(() => {
          fail(new PoolError(`命令超时（${timeoutMs}ms）：${command.split('\n')[0].slice(0, 80)}`, 'timeout'))
        }, Math.max(1000, timeoutMs))
      }

      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      let stream
      try {
        entry.client.exec(viaExec ? wrapExecCommand(wrapCommand(command, cwd)) : wrapCommand(command, cwd), (error, nextStream) => {
          if (error !== undefined && error !== null) {
            fail(new PoolError(`执行失败：${error?.message ?? error}`, 'exec'))
            return
          }
          stream = nextStream
          stream.on('data', (chunk) => {
            chunks.stdout.push(chunk)
            bytes.stdout += chunk.length
            totals.stdout += chunk.length
            if (bytes.stdout > limit * 4) {
              const joined = Buffer.concat(chunks.stdout.map((item) => Buffer.from(item)))
              chunks.stdout = [tailBytes(joined, limit * 2)]
              bytes.stdout = chunks.stdout[0].length
            }
          })
          stream.stderr.on('data', (chunk) => {
            chunks.stderr.push(chunk)
            bytes.stderr += chunk.length
            totals.stderr += chunk.length
            if (bytes.stderr > limit * 4) {
              const joined = Buffer.concat(chunks.stderr.map((item) => Buffer.from(item)))
              chunks.stderr = [tailBytes(joined, limit * 2)]
              bytes.stderr = chunks.stderr[0].length
            }
          })
          const finish = (code, signalName) => {
            if (settled) return
            settled = true
            cleanup()
            entry.lastUsed = pool.now()
            // 先切片、再按上限裁：标记在输出最前面，先裁会把起始标记裁掉、切片退化成「原样返回」，
            // 前缀又回来了。stderr 不切：前缀只加在 stdout 上，切了反而会吃掉真实报错；
            // 接入点连 stderr 通道都不给，命令里的报错已经在包装时 `2>&1` 并进 stdout 了。
            const rawStdout = Buffer.concat(chunks.stdout.map((item) => Buffer.from(item)))
            // 接入点：先切服务端前缀，再把 stdout 里带回的退出码标记取走（并从可见文本里剔干净）。
            // 两件事都在裁剪之前做完——标记在头部与尾部，先裁就取不到、也剔不净。
            const parsed = viaExec
              ? parseExecOutput(stripMarkedText(rawStdout.toString('utf8')))
              : { stdout: rawStdout, exitCode: null }
            const stdout = tailBytes(
              typeof parsed.stdout === 'string' ? Buffer.from(parsed.stdout, 'utf8') : parsed.stdout,
              limit,
            )
            const stderr = tailBytes(Buffer.concat(chunks.stderr.map((item) => Buffer.from(item))), limit)
            // 超上限必须留标记：静默只留尾部会让模型以为拿到的是完整输出，
            // 而丢掉的那部分往往正好是开头的报错行。
            const stdoutText = stdout.toString('utf8')
            const stderrText = stderr.toString('utf8')
            const stdoutTruncated = totals.stdout > limit
            const stderrTruncated = totals.stderr > limit
            // 退出码以 stdout 带回的标记为准：这条通道的 exit-status 恒为 0，不可信。
            const exitCode = resolveExitCode(parsed.exitCode, typeof code === 'number' ? code : null)
            const remoteSignal = signalName ?? null
            // 既没有退出码、也没有退出信号：服务端没给任何结论就把通道关了＝链路断了
            // （断网、远端重启、中间设备掐连接）。这与「命令自己失败」必须分开报（D-26），
            // 否则结果里只剩「退出码 无」，读的人会当成命令失败然后去重试 rm/mv。
            // 远端进程被信号杀掉时 signalName 有值，走的是另一条既有分支，不算断链。
            const dropped = exitCode === null && remoteSignal === null
            if (dropped) {
              // 链路已经不可信：留着这条连接，下一条命令只会在死连接上再失败一次。
              close(pool, host.id)
            }
            resolve({
              exitCode,
              signalName: remoteSignal,
              dropped,
              stdout: stdoutTruncated ? `…（输出过大，只保留了尾部）\n${stdoutText}` : stdoutText,
              stderr: stderrTruncated ? `…（输出过大，只保留了尾部）\n${stderrText}` : stderrText,
              stdoutBytes: bytes.stdout,
              stderrBytes: bytes.stderr,
              truncated: stdoutTruncated || stderrTruncated,
              ms: pool.now() - startedAt,
            })
          }
          stream.on('close', (code, signalName) => finish(code, signalName))
          // 与 openChannel 同样的兜底：有的服务端只发 exit-status、不发通道 close。
          stream.on('exit', (code, signalName) => {
            setTimeout(() => finish(code, signalName), EXIT_SETTLE_MS)
          })
        })
      } catch (error) {
        fail(new PoolError(`执行失败：${error?.message ?? error}`, 'exec'))
      }
      })
    } finally {
      entry.busy = Math.max(0, (entry.busy ?? 1) - 1)
    }
  })
}

/**
 * 打开 `commands.length` 条字节流通道（搬运用），**一次占一个串行槽位**。
 *
 * 为什么要一次要齐：`serial()` 按主机排队，如果分两次调用取通道，第二次永远排不上
 * （第一次的槽位被流自己占着）。所以同一台主机的源与目标是同一台时必须走这里。
 *
 * 返回的句柄：`{ stdout, stdin, done, kill, release }`。
 * `done` 解析成 `{ exitCode, signalName, stderr }`；**用完必须 `release()`**，
 * 否则这条连接永远算「忙」，空闲淘汰不会回收它。
 */
export async function openChannels(pool, host, commands, { cwd, signal } = {}) {
  return await serial(pool, host.id, async () => {
    const entry = await connectEntry(pool, host, { signal })
    // 一条通道算一个占用：这样每个句柄的 release 都能各自减一，不会互相抵消。
    entry.busy = (entry.busy ?? 0) + commands.length

    const opened = []
    try {
      for (const command of commands) {
        opened.push(await openChannel(pool, entry, wrapCommand(command, cwd), { signal }))
      }
    } catch (error) {
      // 已经开出来的通道还没包 release，所以这里一次性把本次申请的份数全还回去。
      entry.busy = Math.max(0, entry.busy - commands.length)
      for (const handle of opened) handle.kill()
      throw error
    }

    // 通道全部开好了：把槽位让出去（SSH 本来就能多路复用），但 busy 计数留着。
    for (const handle of opened) {
      const releaseOne = handle.release
      let released = false
      handle.release = () => {
        if (released) return
        released = true
        entry.busy = Math.max(0, entry.busy - 1)
        entry.lastUsed = pool.now()
        releaseOne()
      }
    }
    return opened
  })
}

/** 在已连接的 entry 上开一条 exec 通道（内部用，不做排队）。 */
export async function openChannel(pool, entry, command, { signal } = {}) {
  return await new Promise((resolve, reject) => {
    let settled = false
    const chunks = []
    let size = 0

    const onAbort = () => {
      if (settled) return
      settled = true
      reject(new PoolError('开通道被中断', 'aborted'))
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      entry.client.exec(command, (error, stream) => {
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        if (settled) {
          try {
            stream?.close()
          } catch {
            // 忽略
          }
          return
        }
        settled = true
        if (error !== undefined && error !== null) {
          reject(new PoolError(`开通道失败：${error?.message ?? error}`, 'exec'))
          return
        }

        stream.stderr.on('data', (chunk) => {
          if (size >= 4096) return
          chunks.push(chunk)
          size += chunk.length
        })

        const done = new Promise((resolveDone) => {
          let settled = false
          const finish = (settledBy, code, signalName, errorText) => {
            if (settled) return
            settled = true
            entry.lastUsed = pool.now()
            resolveDone({
              exitCode: typeof code === 'number' && errorText === null ? code : null,
              signalName: signalName ?? null,
              stderr: errorText ?? tailBytes(Buffer.concat(chunks), 4096).toString('utf8'),
              settledBy,
            })
          }
          stream.on('close', (code, signalName) => finish('close', code, signalName, null))
          // 有的服务端进程明明退出了，通道 close 却迟迟不来（实测 macOS 上是搬运用的
          // 「保持 stdin」通道）。exit-status 已经足够判断成败，所以收到 exit 后再等一会儿
          // 收尾 stderr 就照样结算；close 若在这之前到，仍以 close 的结论为准。
          stream.on('exit', (code, signalName) => {
            setTimeout(() => finish('exit', code, signalName, null), EXIT_SETTLE_MS)
          })
          stream.on('error', (streamError) => {
            finish('error', null, null, `通道错误：${streamError?.message ?? streamError}`)
          })
        })

        resolve({
          stdout: stream,
          // ssh2 的 Channel 本身是双工：写它就是写对端 stdin。
          stdin: stream,
          done,
          kill() {
            try {
              stream.close()
            } catch {
              // 已经关了
            }
          },
          release() {},
        })
      })
    } catch (error) {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      reject(new PoolError(`开通道失败：${error?.message ?? error}`, 'exec'))
    }
  })
}
