/**
 * `ssh_copy` 的命令构造与对端回执解析（纯函数，单测覆盖，不需要网络）。
 *
 * 从 `lib/copy.mjs` 的「纯函数：路径与命令拼装」那一段原样拆出：只拼字符串、只读
 * `key=value` 输出，不碰连接与字节流——字节怎么走见 `transfer.mjs`。
 */
import { wrapReadCommand } from '../jms/stream.mjs'
import { joinPath, shQuote, splitPath, stripTrailingSlash } from './paths.mjs'

/**
 * 预检脚本：一次往返同时问出「是什么、多大、目录里有多少项」。
 * 目录项数用 `find | head | wc -l` 卡住上限，避免巨型目录把预检拖死。
 */
export function buildProbeCommand(path, { maxEntries = 5000 } = {}) {
  const quoted = shQuote(path)
  return [
    `p=${quoted}`,
    'if [ -d "$p" ]; then',
    `  n=$(find "$p" -mindepth 1 2>/dev/null | head -n ${maxEntries} | wc -l | tr -d " ")`,
    '  printf "type=dir\\nentries=%s\\n" "$n"',
    'elif [ -e "$p" ]; then',
    '  s=$(wc -c < "$p" 2>/dev/null | tr -d " ")',
    '  printf "type=file\\nsize=%s\\n" "${s:-0}"',
    'elif [ -L "$p" ]; then',
    '  printf "type=link\\n"',
    'else',
    '  printf "type=missing\\n"',
    'fi',
  ].join('\n')
}

/**
 * 从目标端的 stderr 里取「落地字节数」回执（`dsh-ssh-wrote=N`）。
 * 取最后一条：前面可能还有别的提示。取不到返回 null（老脚本/目录搬运没有这条）。
 */
export function parseWroteBytes(stderr) {
  const matches = [...String(stderr ?? '').matchAll(/dsh-ssh-wrote=(\d+)/g)]
  if (matches.length === 0) return null
  const value = Number(matches[matches.length - 1][1])
  return Number.isFinite(value) ? value : null
}

/** 解析预检脚本的 `key=value` 输出；认不出来就当不存在（宁可多问一次，不瞎猜）。 */
export function parseProbe(stdout) {
  const result = { type: 'missing', entries: null, size: null }
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /^(type|entries|size)=(.*)$/.exec(line.trim())
    if (match === null) continue
    if (match[1] === 'type') {
      if (['dir', 'file', 'link', 'missing'].includes(match[2])) result.type = match[2]
    } else {
      const number = Number(match[2])
      if (Number.isFinite(number)) result[match[1]] = number
    }
  }
  return result
}

/** 源端命令：目录打 tar 流，文件直接 cat。 */
export function buildSourceCommand(info, path, { mark = false } = {}) {
  const command = info.type === 'dir'
    ? (() => {
        const { parent, name } = splitPath(path)
        // 用 -C 父目录 + 相对名，避免 tar 对绝对路径打「Removing leading /」的警告。
        return `tar -cf - -C ${shQuote(parent)} -- ${shQuote(name)}`
      })()
    : `cat ${shQuote(path)}`
  // 经接入点的主机，stdout 前面会多一段服务端前缀；源端命令包标记，接收侧按标记切片
  // （见 lib/jms/stream.mjs）。普通主机一个字节都不变。
  return mark ? wrapReadCommand(command) : command
}

/**
 * 目标端脚本：从 stdin 收字节，先落到临时名，全部收完再换成正式名。
 *
 * 两条容易写错的地方（都踩过）：
 * - 目录的暂存路径必须用**源的名字**，不能用目标的名字：tar 归档里的条目就是源的 basename，
 *   若目标另起了名字（`src` → `src-dupe`），照目标名去 mv 必然 stat 失败。
 * - 每个失败分支都要自己清理临时文件/临时目录。原来靠 `set -e` + 末尾统一清理，
 *   结果失败时直接退出，垃圾就留在目标目录里了；现在显式 `|| { 清理; exit 1; }`。
 *
 * @param sourceName - 源路径的 basename（目录用它拼暂存路径）
 */
export function buildSinkCommand({ finalPath, sourceName, info, overwrite, token }) {
  const { parent } = splitPath(finalPath)
  const tag = `dsh-ssh-remote: 目标已存在，未覆盖（如确实要覆盖，把该项 overwrite 设为 true）`

  if (info.type === 'dir') {
    const tmpDir = joinPath(parent, `.dsh-ssh-copy-${token}`)
    const staged = joinPath(tmpDir, sourceName)
    const backup = joinPath(parent, `.dsh-ssh-bak-${token}`)
    const clean = `rm -rf ${shQuote(tmpDir)}`
    const finalQ = shQuote(finalPath)
    const lines = [`mkdir -p ${shQuote(parent)} ${shQuote(tmpDir)} || exit 1`]
    if (!overwrite) lines.push(`if [ -e ${finalQ} ]; then echo ${shQuote(tag)} >&2; ${clean}; exit 3; fi`)
    lines.push(`tar -xf - -C ${shQuote(tmpDir)} || { ${clean}; exit 1; }`)

    // 覆盖时的替换必须能回滚：绝不先 `rm -rf` 旧目录再 `mv`。
    // 那样 mv 一旦失败（跨设备、权限、并发改名），旧数据已经没了，而新数据也不在位。
    // 做法和一般工具一致：旧目录先改名成同目录下的备份（同一文件系统，rename 原子），
    // 新的搬到位之后才删备份；中途失败就把备份改回原名。
    if (overwrite) {
      lines.push(
        `if [ -e ${finalQ} ]; then mv ${finalQ} ${shQuote(backup)} || { ${clean}; exit 1; }; fi`,
        `if mv ${shQuote(staged)} ${finalQ}; then`,
        `  rm -rf ${shQuote(backup)}`,
        `else`,
        `  if [ -e ${shQuote(backup)} ]; then mv ${shQuote(backup)} ${finalQ} 2>/dev/null || true; fi`,
        `  ${clean}`,
        `  exit 1`,
        `fi`,
      )
      lines.push(clean)
      return lines.join('\n')
    }

    lines.push(`mv ${shQuote(staged)} ${finalQ} || { ${clean}; exit 1; }`)
    lines.push(clean)
    return lines.join('\n')
  }

  const tmpFile = `${stripTrailingSlash(finalPath)}.dsh-copy-${token}`
  const clean = `rm -f ${shQuote(tmpFile)}`
  const lines = [`mkdir -p ${shQuote(parent)} || exit 1`]
  if (!overwrite) lines.push(`if [ -e ${shQuote(finalPath)} ]; then echo ${shQuote(tag)} >&2; ${clean}; exit 3; fi`)
  lines.push(`cat > ${shQuote(tmpFile)} || { ${clean}; exit 1; }`)
  // 文件不需要先删：`mv -f` 在同一个文件系统上就是原子 rename。
  // 只有目标是个目录时才必须清掉（否则 mv 会把文件塞进那个目录里，而不是替换它）。
  if (overwrite) lines.push(`if [ -d ${shQuote(finalPath)} ]; then rm -rf ${shQuote(finalPath)} || { ${clean}; exit 1; }; fi`)
  lines.push(`mv -f ${shQuote(tmpFile)} ${shQuote(finalPath)} || { ${clean}; exit 1; }`)
  // 落地回执：两端都 exit 0 也可能是「中继提前关流、字节没写完」——`cat` 收得少照样成功。
  // 所以让目标端把真实大小报出来，由发送侧比对（目录不用，tar 解不完整会自己非 0）。
  lines.push(`printf 'dsh-ssh-wrote=%s\\n' "$(wc -c < ${shQuote(finalPath)})" >&2`)
  return lines.join('\n')
}
