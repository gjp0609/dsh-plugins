/**
 * 包装与切片（纯函数，单测覆盖；不联网）。
 *
 * 为什么需要它：这类主机的每条 exec 通道，服务端都会在 **stdout 最前面**加一段固定前缀
 * （实测 122 字节，换 shell 也去不掉）。对 `ssh_run` 里的普通命令，那只是结果开头多点东西；
 * 但对搬运（`tar -cf -` / `cat`）是**字节流污染**——不切掉，目标端收到的文件就多了一段垃圾，
 * 字节数也对不上。
 *
 * 两条路径各有一套包装：
 *
 * - **读字节流**（搬运、预检）：`printf '<起始>'; <命令>; printf '<结束>'`，
 *   接收侧只保留两个标记之间的字节（`createMarkerStripper` / `stripMarkedText`）；
 * - **跑一条命令**（`ssh_run`）：`wrapExecCommand` 用子 shell 包住原命令，**把退出码写进 stdout 里的
 *   一段标记**带回来（这类接入点的 exec 通道不回 exit-status，实测恒为 0），并把 stderr 并进 stdout
 *   （它也不给 stderr 通道，不合并就永久丢失）。接收侧先 `stripMarkedText` 切一刀，再用
 *   `parseExecOutput` 取走那段退出码标记。
 *
 * 标记本身用 ASCII，且**故意不写产品名**：命令文本会出现在超时类错误信息里
 * （`pool/exec.mjs` 的 `命令超时（…）：<命令首行>`），那是对用户可见的——
 * 标记里带产品名等于把它漏到错误文案里。
 *
 * 代价（如实记）：标记是固定串，被读的**内容里**恰好出现完整结束标记时会被提前截断。
 * 二进制 tar 流里这串字符出现的概率可以忽略，而且出现时还有落地字节数回执兜底
 * （`parseWroteBytes` 与发送字节数不一致就报「传输被截断」）。
 */
import { Transform } from 'node:stream'

export const MARK_BEGIN = '@@DSH_B@@'
export const MARK_END = '@@DSH_E@@'

/** 前缀丢弃上限：实测 122 字节，给到 4 KB 是为了「对端根本不是这类通道」时尽快失败。 */
const MAX_PREAMBLE_BYTES = 4096

const BEGIN_BYTES = Buffer.from(MARK_BEGIN, 'ascii')
const END_BYTES = Buffer.from(MARK_END, 'ascii')

/**
 * 把一条读取类命令包上标记。
 * @param command - 原命令（可以多行；`;` 与换行都是语句分隔，拼接不会把脚本粘坏）
 */
export function wrapReadCommand(command) {
  const text = String(command ?? '')
  return `printf '${MARK_BEGIN}'; ${text}; printf '${MARK_END}'`
}

/**
 * 把一条「跑完就结束」的命令包上标记，**并把退出码从 stdout 里带回来**（`ssh_run` 用）。
 *
 * 这条通道的两个实测事实决定了包装形状：
 * - **exit-status 不可信**：通道回的退出码恒为 0（`false` 也报 0），不能用它判成败。
 *   所以在子 shell 后面紧跟 `__dsh_rc=$?`，把真实退出码写成 `\n@@DSH_RC=<n>@@\n` 混在 stdout 里，
 *   读侧（`parseExecOutput`）再从切片里取出来当退出码；
 * - **没有 stderr 通道**：命令的报错文本若不走 `2>&1` 并进 stdout，就永久丢失（实测只看到 stdout）。
 *   合并之后 `ssh_run` 的 `stderr` 字段会是空的——那不是丢，是并入 stdout 了。
 *
 * 另外三个要点：
 * - **子 shell 包住原命令**：`cd`、变量、`set -e` 都关在 `( … )` 里，不会漏到外层；
 *   原始退出码就是子 shell 的退出码，紧接着取 `$?` 才是「原命令的退出码」；
 * - **多行命令的右括号另起一行**：末行可能是 `# 注释`，同一行拼 `)` 会被注释吃掉变成语法错误；
 * - **结束标记 `@@DSH_E@@` 仍放最后**：读侧仍按它切，通道在它之前关＝这次输出不完整。
 *
 * 变量名用 `__dsh_rc` 不是洁癖：它在子 shell **外面**，原命令写的 `rc` 之类的变量泄漏不出来，
 * 因此不会互相覆盖。
 * @param command - 原命令（多行脚本、引号、`&&`、`|` 都原样可用）
 */
export function wrapExecCommand(command) {
  const text = String(command ?? '')
  const body = text.includes('\n') ? `( ${text}\n)` : `( ${text} )`
  return `printf '${MARK_BEGIN}'; ${body} 2>&1; __dsh_rc=$?; printf '\\n@@DSH_RC=%s@@\\n' "$__dsh_rc"; printf '${MARK_END}'`
}

/**
 * 从切片后的 stdout 里取走退出码标记，同时把它从可见文本里剔干净（`ssh_run` 用）。
 *
 * - **取最后一个**：命令输出里可能恰好出现同名串（`echo '@@DSH_RC=1@@'`），我们打印的那个一定在最后；
 * - **连前后那两个换行一起删**：包装在标记前补 `\n`、在标记后补 `\n`，只删标记本身会让命令输出
 *   多出一个空行；一起删掉，stdout 与命令自己打出来的字节一致；
 * - **解析不到返回 `null`**：交给调用方退回通道给的 code（那是「未验」路径，见 DECISIONS D-40）。
 * @returns `{ stdout, exitCode }`；`exitCode` 是数字或 `null`
 */
export function parseExecOutput(text) {
  const value = String(text ?? '')
  const matches = [...value.matchAll(/\n@@DSH_RC=(\d+)@@\n/g)]
  if (matches.length === 0) return { stdout: value, exitCode: null }
  const last = matches[matches.length - 1]
  const stdout = value.slice(0, last.index) + value.slice(last.index + last[0].length)
  return { stdout, exitCode: Number(last[1]) }
}

/**
 * 文本切片（预检这类「输出是 key=value」、以及 `ssh_run` 的 stdout 用）。
 *
 * 起始标记找不到时**原样返回**：说明这条通道没有按约定包装（例如普通主机），
 * 或者对端在打印标记前就挂了；让调用方按原样解析，比悄悄返回空串更容易查。
 * 宁可结果里多一段前缀，也不要让一条普通命令莫名其妙报「通道没给标记」而失败。
 */
export function stripMarkedText(text) {
  const value = String(text ?? '')
  const begin = value.indexOf(MARK_BEGIN)
  if (begin < 0) return value
  const start = begin + MARK_BEGIN.length
  const end = value.indexOf(MARK_END, start)
  return end < 0 ? value.slice(start) : value.slice(start, end)
}

/**
 * 字节流切片（搬运用）：丢掉起始标记之前的一切，只透出两个标记之间的字节，结束标记之后一律丢弃。
 *
 * 三个必须有的行为：
 * - **跨块切分**：标记可能被 TCP/SSH 分块切成两半，所以要留 `标记长度-1` 字节等下一块；
 * - **起始标记没出现就报错**：字节流的完整性比「尽量给点东西」重要——宁可让这次搬运失败，
 *   也不要把服务端前缀当成文件内容写进目标端；
 * - **结束标记没等到**（命令被信号杀掉、通道提前关）：把手里留的字节交出去，
 *   由两端的退出码与落地字节数决定成败。
 */
export function createMarkerStripper({ maxPreambleBytes = MAX_PREAMBLE_BYTES } = {}) {
  let state = 'preamble'
  let pending = Buffer.alloc(0)

  const feed = (chunk) => {
    if (state === 'done') return Buffer.alloc(0)
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])

    if (state === 'preamble') {
      const index = pending.indexOf(BEGIN_BYTES)
      if (index < 0) {
        if (pending.length > maxPreambleBytes) {
          throw new Error(`读取通道没有给出数据起始标记（已丢弃 ${pending.length} 字节前缀），这次搬运没有继续`)
        }
        // 只留可能被切断的半个标记，其余都是服务端前缀。
        pending = pending.subarray(Math.max(0, pending.length - (BEGIN_BYTES.length - 1)))
        return Buffer.alloc(0)
      }
      pending = pending.subarray(index + BEGIN_BYTES.length)
      state = 'body'
    }

    const end = pending.indexOf(END_BYTES)
    if (end >= 0) {
      const output = pending.subarray(0, end)
      pending = Buffer.alloc(0)
      state = 'done'
      return output
    }
    // 结束标记可能被切在两次 data 之间：留 END_BYTES.length-1 字节。
    const cut = Math.max(0, pending.length - (END_BYTES.length - 1))
    const output = pending.subarray(0, cut)
    pending = pending.subarray(cut)
    return output
  }

  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        done(null, feed(Buffer.from(chunk)))
      } catch (error) {
        done(error)
      }
    },
    flush(done) {
      if (state === 'preamble') {
        done(new Error('读取通道没有给出数据起始标记，这次搬运没有继续'))
        return
      }
      const tail = state === 'body' ? pending : Buffer.alloc(0)
      pending = Buffer.alloc(0)
      done(null, tail)
    },
  })
}
