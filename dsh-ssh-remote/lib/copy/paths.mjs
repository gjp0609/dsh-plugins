/**
 * `ssh_copy` 的路径与校验（纯函数，单测覆盖，不需要网络）。
 *
 * 从 `lib/copy.mjs` 的「纯函数：路径与命令拼装」那一段原样拆出：符号、注释、行为都不变。
 */

/**
 * 搬运失败。`code` 用来区分参数错、目标已存在、目标端失败、源端失败、超时、中断。
 *
 * 放在这里而不是 `items.mjs`：`assertPath` 是它最早的抛错方，路径校验必须用这个类；
 * 而 `parseEndpoint` 又要用 `assertPath`——类放在任何一边都会变成 `paths ↔ items` 互相 import。
 */
export class CopyError extends Error {
  /** @param code - `copy` | `args` | `exists` | `sink` | `source` | `timeout` | `aborted` */
  constructor(message, code = 'copy') {
    super(message)
    this.name = 'CopyError'
    this.code = code
  }
}

/** POSIX sh 单引号转义。路径里可能有空格、`$`、反引号，一律当字面量。 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 只允许绝对路径：省掉一整类「以 - 开头被当成选项」和「相对路径跑错目录」的问题。 */
export function assertPath(value, where) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new CopyError(`${where} 不能为空`, 'args')
  if (!text.startsWith('/')) throw new CopyError(`${where} 必须是绝对路径（以 / 开头）：${text}`, 'args')
  if (/[\u0000\n\r]/.test(text)) throw new CopyError(`${where} 含换行或 NUL，不接受`, 'args')
  if (text === '/') throw new CopyError(`${where} 不能是根目录 /`, 'args')
  if (text.split('/').includes('..')) throw new CopyError(`${where} 不能含 .. 段（先自己算好真实路径）：${text}`, 'args')
  // `.` 段会让末段名变成 `.`：暂存路径变成 `/dest/.dsh-ssh-copy-XXXX/.`，收尾的 mv 必然失败，
  // 报错还看不出所以然。口径和 `..` 一样：先自己算好真实路径。
  if (text.split('/').includes('.')) throw new CopyError(`${where} 不能含 . 段（去掉它再传）：${text}`, 'args')
  return text
}

/** 去掉尾部斜杠（根目录除外）。 */
export function stripTrailingSlash(path) {
  const text = String(path)
  if (text === '/') return '/'
  return text.replace(/\/+$/, '') || '/'
}

/** 拆成父目录与末段名。`/a/b` → `{ parent: '/a', name: 'b' }`。 */
export function splitPath(path) {
  const trimmed = stripTrailingSlash(path)
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return { parent: '/', name: trimmed.slice(1) }
  return { parent: trimmed.slice(0, index), name: trimmed.slice(index + 1) }
}

export function joinPath(directory, name) {
  const base = stripTrailingSlash(directory)
  return base === '/' ? `/${name}` : `${base}/${name}`
}

/** 人类可读的体积，卡片上比字节数好读。 */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知大小'
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}
