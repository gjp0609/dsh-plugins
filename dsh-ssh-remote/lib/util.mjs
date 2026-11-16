/**
 * 小工具函数：JSON 读写、哈希、时间。全部同步——这些文件都很小（几 KB）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 读 JSON；文件不存在返回 `{ found: false }`，内容坏掉则抛带路径的错误。 */
export function readJsonFile(path) {
  if (!existsSync(path)) return { found: false }
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`读不了 ${path}：${error?.message ?? error}`)
  }
  // 空文件不能当成"合法的空配置"：那是别人正在原地重写的半秒窗口，
  // 当成空配置会让内存里的 hosts 变成 {}，紧接着任何一次管理写入就把主机全丢了。
  if (text.trim() === '') throw new Error(`${path} 是空文件（可能是另一个程序正在写它），这次先按读取失败处理`)
  try {
    return { found: true, value: JSON.parse(text) }
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：${error?.message ?? error}`)
  }
}

/** 原子写 JSON：先写同目录临时文件再 rename，避免写一半留下坏文件。 */
export function writeJsonAtomic(path, value) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 临时文件清不掉不影响主流程
    }
    throw error
  }
}

/** 备份现有文件到 `<path>.bak`；源不存在时什么都不做。 */
export function backupFile(path) {
  if (!existsSync(path)) return false
  copyFileSync(path, `${path}.bak`)
  return true
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

/** 取对象里的数组，非数组给空数组。 */
export function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** 取对象里的字符串，非字符串给 undefined。 */
export function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * 并发受限的 map（结果保持输入顺序）：`worker` 自己负责吞掉单条失败。
 *
 * 用在「一次要问服务端好几台资产」的地方（拉账号）：串行太慢，全部并发又是在打接入点。
 */
export async function mapLimited(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
