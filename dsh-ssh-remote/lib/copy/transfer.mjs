/**
 * `ssh_copy` 的传输：中继字节、等两端退出码、预检一个端点。
 *
 * 从 `lib/copy.mjs` 的「传输」那一段原样拆出：第 1 条设计决定（流怎么走）与
 * 「提前关流不等于失败」的证据都在下面的注释里。这里会碰网络/端点 I/O，
 * 纯字符串构造在 `commands.mjs`，条目解析在 `items.mjs`。
 */
import { randomBytes } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { tailText } from '../endpoint.mjs'
import { resolveTarget, targetLabel } from '../hosts.mjs'
import { isJmsHost } from '../jms/hosts.mjs'
import { createMarkerStripper, stripMarkedText, wrapReadCommand } from '../jms/stream.mjs'
import { buildProbeCommand, buildSinkCommand, buildSourceCommand, parseProbe, parseWroteBytes } from './commands.mjs'
import { CopyError, formatBytes, joinPath, splitPath } from './paths.mjs'

/**
 * 等命令退出码的上限：流已经结束之后，对端正常几百毫秒就退。
 * 曾经给到 5 分钟，结果遇到「字节全落地、退出确认不来」时表现为整个工具调用卡死几分钟；
 * 现在 30 秒就收工，并且这段等待可以被中断信号打断。
 */
const EXIT_GRACE_MS = 30_000
/** 清理临时名时最多容忍多少字节的 stderr（只用来拼错误信息）。 */
const STDERR_LIMIT = 1024

// ===========================================================================
// 传输
// ===========================================================================

function settle(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
}

function withDeadline(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new CopyError(message, 'timeout')), Math.max(1000, ms))
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ])
}

/** 让中断信号能打断一段本来只等对端的等待（否则点了停止也要等满超时）。 */
function raceAbort(promise, signal) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new CopyError('搬运被中断', 'aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CopyError('搬运被中断', 'aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * 目标端提前关流造成的报错（我们还在写）。`abort`、`premature close` 都归这一类。
 *
 * 只认出「这是提前关流」，**不代表可以当成功**：调用方还必须确认两端退出码都是 0，
 * 而且不是用户主动中断——这两条判断留在 transferItem 里，免得这个函数越界。
 */
export function isEarlyClose(error) {
  if (error === null || error === undefined) return false
  // 不认 AbortError：Node 的 pipeline 在中止时抛的就是它，认了会把「自家空闲超时 / 用户中断」
  // 一起洗成「对端早关」。真正的提前关流会带下面这些 errno。
  const code = String(error.code ?? '')
  if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET' || code === 'EPIPE') return true
  return /premature close/i.test(String(error.message ?? ''))
}

/**
 * 把源流灌进目标流，顺带计数与空闲看门狗。
 *
 * 注意空闲超时用的是 `stepTimeoutMs`（默认 30 秒没有字节流动就中止）而不是总时长：
 * 大文件在 800 kB/s 的链路上要跑很久，按总时长卡会误杀正在正常推进的传输。
 */
export async function relayBytes({ source, sink, idleMs, signal, onBytes, marker = false }) {
  const controller = new AbortController()
  const abortWith = (error) => {
    if (!controller.signal.aborted) controller.abort(error)
  }
  const forwardAbort = () => abortWith(new CopyError('搬运被中断', 'aborted'))
  if (signal !== undefined) {
    if (signal.aborted) forwardAbort()
    else signal.addEventListener('abort', forwardAbort, { once: true })
  }

  let timer = null
  const arm = () => {
    if (idleMs <= 0) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      abortWith(new CopyError(`超过 ${Math.round(idleMs / 1000)} 秒没有数据流动，已中止（连接会重建）`, 'timeout'))
    }, idleMs)
  }
  arm()

  const counter = new Transform({
    transform(chunk, _encoding, done) {
      onBytes?.(chunk.length)
      arm()
      done(null, chunk)
    },
  })

  try {
    // 源端是「经接入点导入」的主机时，stdout 前面有服务端前缀、末尾有我们包的结束标记：
    // 切片器放在计数之前，于是 `bytes` 就是真正的载荷字节数，与目标端的落地回执同口径。
    const stages = marker ? [source, createMarkerStripper(), counter, sink] : [source, counter, sink]
    await pipeline(...stages, { signal: controller.signal })
  } catch (error) {
    // 自己 abort 时 pipeline 抛的是 Node 包装的 AbortError，真正的原因只在 error.cause 里。
    // 必须在这里换回来：否则调用方看到的是「operation was aborted」，分不清是空闲超时、
    // 用户中断，还是对端提前关流。（原来这段检查写在 finally 之后，pipeline 抛错时永远走不到。）
    if (controller.signal.aborted) {
      throw controller.signal.reason instanceof Error ? controller.signal.reason : new CopyError('搬运被中断', 'aborted')
    }
    throw error
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (signal !== undefined) signal.removeEventListener('abort', forwardAbort)
  }
}

/**
 * 搬一项。调用方必须保证：同一时刻只有一项在跑（否则交叉的两项会互相占满连接池槽位）。
 * @returns `{ bytes, ms }`；失败抛 CopyError
 */
export async function transferItem(plan, { io, settings, signal }) {
  const startedAt = Date.now()
  const token = randomBytes(6).toString('hex')
  // 只有**源端**要包标记：目标端是往 stdin 灌字节，服务端前缀只加在 stdout 上；
  // 目标端的落地回执（stderr 里的 `dsh-ssh-wrote=`）由解析侧容忍前缀，命令一个字节不用改。
  const markedSource = isJmsHost(plan.src.target)
  const srcCommand = buildSourceCommand(plan.srcInfo, plan.src.path, { mark: markedSource })
  const dstCommand = buildSinkCommand({
    finalPath: plan.finalPath,
    sourceName: splitPath(plan.src.path).name,
    info: plan.srcInfo,
    overwrite: plan.overwrite,
    token,
  })

  let handles = []
  try {
    const sameRemote = plan.src.target.kind === 'remote' && plan.dst.target.kind === 'remote' && plan.src.target.id === plan.dst.target.id
    if (sameRemote) {
      // 同一台机器：必须一次要齐两条通道，分两次会被自己的串行队列堵死。
      handles = await io.openMany(plan.src.target, [srcCommand, dstCommand], { signal })
    } else {
      // 顺序开而不是并行：如果目标端开失败，已经开好的源端通道还在 handles 里，
      // finally 能把它 kill + release；并行的话失败那一刻句柄已经飞了，busy 计数会永远漏一个。
      const sources = await io.openMany(plan.src.target, [srcCommand], { signal })
      handles = [sources[0]]
      // 接收端要往 stdin 灌字节：WSL 那边得把 stdin 让出来（脚本改走临时文件）。
      const sinks = await io.openMany(plan.dst.target, [dstCommand], { signal, keepStdin: true })
      handles = [sources[0], sinks[0]]
    }

    const [srcHandle, dstHandle] = handles
    if (srcHandle?.stdout === null || dstHandle?.stdin === null) {
      throw new CopyError('端点没有提供字节流（内部错误）', 'copy')
    }

    // 目标端通道我们只写不读，但 ssh2 的 Channel 要等可读半边流干才会发 'close'：
    // 远端 tar 读到归档末尾就退出并让服务端关通道，此时挂起的写永不回调、'finish' 也永不出现，
    // pipeline 会静默挂死（实测要等满 30 秒的空闲看门狗）。resume() 把可读半边放掉，事件才到得了。
    try {
      dstHandle.stdout?.resume?.()
    } catch {
      // 没有可读半边（例如某些本地管道）就无所谓
    }

    let bytes = 0
    let relayError = null
    try {
      await relayBytes({
        source: srcHandle.stdout,
        sink: dstHandle.stdin,
        idleMs: settings.stepTimeoutMs,
        signal,
        marker: markedSource,
        onBytes: (count) => {
          bytes += count
        },
      })
    } catch (error) {
      relayError = error
    }

    // 源端通道只读 stdout、用不到 stdin：显式送 EOF，免得服务端一直等一个不会来的关闭。
    try {
      srcHandle.stdin?.end?.()
    } catch {
      // 已经关了
    }

    let srcSettled = false
    let dstSettled = false
    const srcDone = settle(srcHandle.done).then((outcome) => {
      srcSettled = true
      return outcome
    })
    const dstDone = settle(dstHandle.done).then((outcome) => {
      dstSettled = true
      return outcome
    })

    let srcOutcome
    let dstOutcome
    try {
      ;[srcOutcome, dstOutcome] = await raceAbort(
        withDeadline(Promise.all([srcDone, dstDone]), EXIT_GRACE_MS, '等待对端确认结束超时'),
        signal,
      )
    } catch (error) {
      if (error instanceof CopyError && error.code === 'timeout') {
        // 字节可能已经全部落地、只是没等到退出确认。把「谁没确认」说清楚，别让人猜。
        throw new CopyError(
          `${error.message}：源端${srcSettled ? '已' : '未'}确认、目标端${dstSettled ? '已' : '未'}确认（已传 ${bytes} 字节）`,
          'timeout',
        )
      }
      throw error
    }

    // 先看目标端：它的退出码才说明文件到没到位。
    if (!dstOutcome.ok) throw new CopyError(`目标端失败：${tailText(dstOutcome.error?.message ?? dstOutcome.error, STDERR_LIMIT)}`, 'sink')
    const dstExit = dstOutcome.value?.exitCode
    if (dstExit !== 0) {
      const hint = dstExit === 3 ? '——目标已存在，未覆盖' : ''
      const detail = tailText(dstOutcome.value?.stderr ?? '', STDERR_LIMIT)
      throw new CopyError(
        `目标端写入失败（退出码 ${dstExit}）${hint}${detail === '' ? '' : `：${detail}`}`,
        dstExit === 3 ? 'exists' : 'sink',
      )
    }

    if (!srcOutcome.ok) throw new CopyError(`源端失败：${tailText(srcOutcome.error?.message ?? srcOutcome.error, STDERR_LIMIT)}`, 'source')
    const srcExit = srcOutcome.value?.exitCode
    if (srcExit !== 0) {
      const detail = tailText(srcOutcome.value?.stderr ?? '', STDERR_LIMIT)
      throw new CopyError(`源端读取失败（退出码 ${srcExit}）${detail === '' ? '' : `：${detail}`}`, 'source')
    }

    // 中继报错不一定是真失败：远端 tar 读完归档末尾就退出、**不等 stdin EOF**，
    // 目标端先关流，我们这边表现为「还在写就被关了」。只要两端退出码都是 0，字节就是完整送达的。
    // 但必须排除「自家的超时/中断」——那是本地的判断，不能因为对端退出码是 0 就洗成成功。
    const ownFailure = relayError instanceof CopyError && (relayError.code === 'timeout' || relayError.code === 'aborted')
    const earlyClose = !ownFailure && srcExit === 0 && dstExit === 0 && isEarlyClose(relayError)
    const userAborted = signal !== undefined && signal.aborted === true
    if (relayError !== null && (userAborted || !earlyClose)) {
      throw relayError instanceof CopyError ? relayError : new CopyError(`传输中断：${relayError?.message ?? relayError}`, 'copy')
    }

    // 最后一道闸：目标端报的落地字节数必须和我们发出去的一致。
    // 两端 exit 0 + 中继提前关流时，若目标端其实只收到一部分（cat 收多少写多少，照样退出 0），
    // 上面那些判断全都会放行——只有这个回执能戳破它。
    const wrote = parseWroteBytes(dstOutcome.value?.stderr)
    if (wrote !== null && wrote !== bytes) {
      throw new CopyError(`目标端只落地了 ${wrote} 字节，与发出的 ${bytes} 字节不一致（传输被截断）`, 'copy')
    }

    return { bytes, ms: Date.now() - startedAt }
  } finally {
    for (const handle of handles) {
      try {
        handle.kill()
      } catch {
        // 已经退了
      }
      try {
        handle.release()
      } catch {
        // 忽略
      }
    }
  }
}

/** 预检一个端点：问出类型/大小/项数。 */
async function probePath(io, target, path, { timeoutMs, maxEntries }) {
  // 预检也是「读取类命令」：它的 stdout 会被按 `type=` / `size=` 逐行解析，
  // 服务端前缀一旦和第一行粘在一起就解析不出来，所以同样包标记、同样切片。
  const marked = isJmsHost(target)
  const command = buildProbeCommand(path, { maxEntries })
  const outcome = await io.runText(target, marked ? wrapReadCommand(command) : command, { timeoutMs })
  if (outcome.exitCode !== 0) {
    const detail = tailText(outcome.stderr ?? '', STDERR_LIMIT)
    throw new CopyError(`预检 ${targetLabel(target)}:${path} 失败（退出码 ${outcome.exitCode}）${detail === '' ? '' : `：${detail}`}`, 'copy')
  }
  return parseProbe(marked ? stripMarkedText(outcome.stdout) : outcome.stdout)
}

/**
 * 预检一项：确认源在、算出真正要写的路径、判断是否覆盖、检查体积上限。
 * 所有「还没开始搬就该知道」的坏消息都在这里报完，用户看到卡片时信息已经齐了。
 */
export async function preflight(item, { io, settings, state }) {
  const srcTarget = resolveTarget(item.from.target, state)
  const dstTarget = resolveTarget(item.to.target, state)
  const timeoutMs = settings.stepTimeoutMs
  const maxEntries = settings.walkMaxEntries

  const srcInfo = await probePath(io, srcTarget, item.from.path, { timeoutMs, maxEntries })
  if (srcInfo.type === 'missing') throw new CopyError(`源不存在：${targetLabel(srcTarget)}:${item.from.path}`, 'copy')
  if (srcInfo.type === 'link') throw new CopyError(`源是断链的软链接：${targetLabel(srcTarget)}:${item.from.path}`, 'copy')
  if (srcInfo.type === 'file' && srcInfo.size !== null && srcInfo.size > settings.copyMaxBytes) {
    throw new CopyError(
      `源文件 ${formatBytes(srcInfo.size)} 超过单次搬运上限 ${formatBytes(settings.copyMaxBytes)}；需要的话在 config.json 调大 copyMaxBytes`,
      'copy',
    )
  }

  // 目标写成目录（结尾带 / 或本身就是目录）时，真正的落点是「目录 + 源的名字」。
  let dstInfo = await probePath(io, dstTarget, item.to.path, { timeoutMs, maxEntries })
  let finalPath = item.to.path
  if (item.to.path.endsWith('/') || dstInfo.type === 'dir') {
    finalPath = joinPath(item.to.path, splitPath(item.from.path).name)
    if (finalPath !== item.to.path) {
      dstInfo = await probePath(io, dstTarget, finalPath, { timeoutMs, maxEntries })
    }
  }

  const dstExists = dstInfo.type !== 'missing'
  if (dstExists && !item.overwrite) {
    throw new CopyError(
      `目标已存在：${targetLabel(dstTarget)}:${finalPath}（确实要覆盖就把该项的 overwrite 设为 true）`,
      'exists',
    )
  }

  return {
    index: item.index,
    why: item.why,
    overwrite: item.overwrite,
    src: { target: srcTarget, path: item.from.path },
    dst: { target: dstTarget, path: item.to.path },
    srcInfo,
    dstInfo,
    dstExists,
    finalPath,
    size: srcInfo.size,
    entries: srcInfo.entries,
    entriesCapped: srcInfo.type === 'dir' && srcInfo.entries !== null && srcInfo.entries >= maxEntries,
  }
}
