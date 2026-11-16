/**
 * 配置：定位唯一的 allow.json，做 mtime+size 热更、全局/项目段合并与诊断上报。
 *
 * 只负责「文件 → 规则」；规则长什么样、怎么匹配在 match.mjs。
 * 文件不存在不是错误（等于没有规则）；读不了 / 坏 JSON / 坏规则都 fail-closed 并写诊断。
 *
 * 安全边界：配置只放在 `<dataDir>/allow.json`，**绝不读取工作区里的任何配置文件**。
 * 工作区是模型可写（write/edit 不需要审批）的，配置放进去等于让被审查方给自己发通行证。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { compileDocument } from './match.mjs'

/** 本插件在 `<DSH_HOME>/plugin-data` 下的目录名。 */
const PLUGIN_DIR_NAME = 'approval-allow'
/** 唯一配置文件名。 */
const CONFIG_FILE_NAME = 'allow.json'
/** 项目标识里可读段的最大长度。 */
const PROJECT_SLUG_MAX = 60

/** 没有规则时的空数组。 */
const EMPTY_RULES = Object.freeze([])
/** 没有项目段时的空对象（null 原型）。 */
const EMPTY_PROJECTS = Object.freeze(Object.create(null))
/** 文件不存在时的空结果。 */
const EMPTY = Object.freeze({ stamp: null, rules: EMPTY_RULES, projects: EMPTY_PROJECTS })

/** 取非空字符串，否则 null。 */
function textOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 错误转一行可读文本。 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 解析数据目录：默认 `DSH_HOME/plugin-data/approval-allow`，可用 patch 行的 `dataDir` 覆盖。
 * 与 dsh-approval-notifier 同一套约定，但代码独立，不 import 别的插件。
 */
export function resolveDataDir(config) {
  const override = textOrNull(config?.dataDir)
  if (override !== null) return override
  const home = textOrNull(process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(home, 'plugin-data', PLUGIN_DIR_NAME)
}

/**
 * 规范化项目路径，只用来算标识：
 * - 反斜杠换正斜杠、折叠重复分隔符、去掉末尾分隔符；
 * - 统一小写（Windows 路径不区分大小写，同一路径的两种写法必须得到同一个标识）；
 * - 不解析符号链接、不 stat（只依赖会话给出的绝对路径）。
 */
function canonicalProjectPath(projectRoot) {
  let value = projectRoot.trim().replace(/\\/g, '/')
  const unc = value.startsWith('//')
  value = value.replace(/\/{2,}/g, '/')
  if (unc) value = `/${value}`
  if (value.length > 1) value = value.replace(/\/+$/, '')
  return value.toLowerCase()
}

/** 可读段：非字母数字折叠成 `-`，截到 60；全是符号时退成 `root`。 */
function projectSlug(canonical) {
  let slug = canonical.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > PROJECT_SLUG_MAX) slug = slug.slice(0, PROJECT_SLUG_MAX).replace(/-+$/g, '')
  return slug === '' ? 'root' : slug
}

/**
 * 项目标识：`<可读 slug>-<sha1(规范化小写路径) 前 8 位>`。
 *
 * - 同一路径永远同一标识（大小写、分隔符写法不同也一样）；
 * - 不同路径靠 8 位哈希区分；slug 只负责可读与人工核对；
 * - 项目根不是绝对路径时返回 null（不拿 process.cwd() 猜）。
 *
 * @param {string|null} projectRoot 会话当前工作目录（绝对路径）
 * @returns {string|null}
 */
export function projectIdFor(projectRoot) {
  const root = textOrNull(projectRoot)
  if (root === null || !isAbsolute(root)) return null
  const canonical = canonicalProjectPath(root)
  const hash = createHash('sha1').update(canonical, 'utf8').digest('hex').slice(0, 8)
  return `${projectSlug(canonical)}-${hash}`
}

/**
 * 造一个按需热更的配置仓库。
 *
 * - 每次 snapshot() 只 stat 一个 allow.json，`mtimeMs:size` 没变就复用上次编译结果；
 * - 变了就重读重编译，不装 watcher、不需要重启；
 * - 同一个 stamp 只上报一次诊断，避免每次审批都刷日志；
 * - 项目规则从同一文件的 `projects.<项目标识>` 取，工作区里的同名文件连 stat 都不做。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（allow.json、流水、诊断的唯一落点）
 * @param {(entry: object) => void} [options.reportDiagnostic] 诊断接收者（本模块不写文件）
 * @param {() => number} [options.now] 时钟（测试用）
 */
export function createConfigStore({ dataDir, reportDiagnostic = () => {}, now = Date.now }) {
  const globalPath = join(dataDir, CONFIG_FILE_NAME)
  const cache = new Map()

  function report(source, file, ruleId, error) {
    try {
      reportDiagnostic({
        ts: new Date(now()).toISOString(),
        source,
        file,
        ruleId,
        error,
      })
    } catch {
      // 诊断写不出去不能影响审批
    }
  }

  function cacheFailure(path, stamp, error) {
    const entry = Object.freeze({ stamp, rules: EMPTY_RULES, projects: EMPTY_PROJECTS })
    cache.set(path, entry)
    report('config', path, null, error)
    return entry
  }

  function loadFile(path) {
    let info
    try {
      info = statSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        cache.delete(path)
        return EMPTY
      }
      const stamp = `stat:${error?.code ?? describeError(error)}`
      const cached = cache.get(path)
      if (cached !== undefined && cached.stamp === stamp) return cached
      return cacheFailure(path, stamp, `无法读取文件状态: ${describeError(error)}`)
    }
    const stamp = `${info.mtimeMs}:${info.size}`
    const cached = cache.get(path)
    if (cached !== undefined && cached.stamp === stamp) return cached
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      return cacheFailure(path, stamp, `读取失败: ${describeError(error)}`)
    }
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      return cacheFailure(path, stamp, `JSON 解析失败: ${describeError(error)}`)
    }
    const { rules, errors, projects } = compileDocument(raw)
    const entry = Object.freeze({ stamp, rules: Object.freeze(rules), projects })
    cache.set(path, entry)
    for (const item of errors) report('config', path, item.ruleId, item.error)
    return entry
  }

  /**
   * 取当前生效的规则：全局规则 ∪ 该项目段。deny 先判由 decide() 保证，这里只做并集。
   * @param {string|null} projectRoot 会话工作目录；null 表示只用全局规则
   */
  function snapshot(projectRoot) {
    const entry = loadFile(globalPath)
    const projectId = projectIdFor(projectRoot)
    const projectRules =
      projectId === null ? EMPTY_RULES : (entry.projects[projectId] ?? EMPTY_RULES)
    return {
      rules:
        projectRules.length === 0 ? entry.rules : [...entry.rules, ...projectRules],
      globalPath,
      projectId,
    }
  }

  return { snapshot, globalPath }
}
