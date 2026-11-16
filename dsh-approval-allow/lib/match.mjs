/**
 * 匹配引擎：规则校验 + 全串锚定匹配。
 *
 * 纯函数：不读文件、不看时钟、不碰 DSH。文件解析在 config.mjs，事件挂在 index.js。
 *
 * 硬约束：`match` 必须以 `^` 开头、以 `$` 结尾；真正匹配时还要求命中区间覆盖整条命令
 * （见 fullMatch：JS 的 `$` 允许匹配末尾换行之前的位置，光看 `$` 不够）。
 */

/** tool 的通配符：命中任何工具名。 */
const TOOL_WILDCARD = '*'

/** 规则里认识的字段；`_` 开头的键按注释忽略。 */
const RULE_KEYS = ['id', 'tool', 'match', 'note']

/** 顶层认识的字段；`_` 开头的键按注释忽略。 */
const DOCUMENT_KEYS = ['version', 'deny', 'allow', 'projects']

/** 项目段认识的字段。 */
const PROJECT_KEYS = ['deny', 'allow']

/** 项目标识：slug（1~60 个 [a-z0-9-]）+ `-` + sha1 前 8 位。 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}-[0-9a-f]{8}$/

/** 没有项目段时的空对象（null 原型，避免 `__proto__` 之类的键意外命中）。 */
const EMPTY_PROJECTS = Object.freeze(Object.create(null))

/** 两个效果；deny 先判，所以同一命令同时命中时一定走「问」。 */
const EFFECTS = ['deny', 'allow']

/** 普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 列出不认识的键（`_` 开头的注释键不算）。 */
function unknownKeys(object, allowed) {
  return Object.keys(object).filter((key) => !key.startsWith('_') && !allowed.includes(key))
}

/** 规则里 id 的原始值，只用于把错误归到具体规则上。 */
function idOf(value) {
  const id = typeof value?.id === 'string' ? value.id.trim() : ''
  return id === '' ? null : id
}

/** 编译 tool 过滤：字符串、`*` 或非空字符串数组；空串/空数组/非字符串一律作废。 */
function compileToolFilter(value) {
  if (value === undefined) return { error: '缺少 tool（工具名、"*" 或字符串数组）' }
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) return { error: 'tool 不能是空数组' }
  const tools = []
  for (const item of list) {
    if (typeof item !== 'string') return { error: 'tool 必须是字符串或字符串数组' }
    const name = item.trim()
    if (name === '') return { error: 'tool 里不能有空字符串' }
    if (!tools.includes(name)) tools.push(name)
  }
  return { tools }
}

/** match 是否满足「以 ^ 开头、以 $ 结尾」。 */
export function isAnchored(pattern) {
  return (
    typeof pattern === 'string' &&
    pattern.length >= 2 &&
    pattern.startsWith('^') &&
    pattern.endsWith('$')
  )
}

/**
 * 编译一条规则。
 * @returns {{rule: object}|{error: {ruleId: string|null, error: string}}}
 */
function compileRule(raw, effect, index) {
  const label = `${effect}[${index}]`
  if (!isPlainObject(raw)) {
    return { error: { ruleId: null, error: `${label} 必须是对象` } }
  }
  const id = idOf(raw)
  const unknown = unknownKeys(raw, RULE_KEYS)
  if (unknown.length > 0) {
    return {
      error: { ruleId: id, error: `${label} 有未知字段 ${unknown.join(', ')}（整条规则作废）` },
    }
  }
  if (id === null) {
    return { error: { ruleId: null, error: `${label} 缺少 id（非空字符串）` } }
  }
  const tool = compileToolFilter(raw.tool)
  if (tool.error !== undefined) {
    return { error: { ruleId: id, error: `${label}(${id}) ${tool.error}` } }
  }
  if (typeof raw.match !== 'string' || raw.match === '') {
    return { error: { ruleId: id, error: `${label}(${id}) 缺少 match（非空字符串）` } }
  }
  if (!isAnchored(raw.match)) {
    return {
      error: { ruleId: id, error: `${label}(${id}) match 必须全串锚定：以 ^ 开头、以 $ 结尾` },
    }
  }
  let regex
  try {
    regex = new RegExp(raw.match)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { error: { ruleId: id, error: `${label}(${id}) 正则编译失败: ${message}` } }
  }
  const note = typeof raw.note === 'string' ? raw.note : null
  return {
    rule: Object.freeze({ id, tools: Object.freeze(tool.tools), match: raw.match, regex, note, effect }),
  }
}

/**
 * 编译一个项目段：只认 deny/allow 与 `_` 注释键。
 * 结构坏了（不是对象、未知键、deny/allow 不是数组）→ 返回 null（整项忽略）；
 * 单条规则坏了 → 只作废该条，返回其余规则。
 */
function compileProjectRules(id, entry, errors) {
  const label = `projects[${JSON.stringify(id)}]`
  if (!isPlainObject(entry)) {
    errors.push({ ruleId: null, error: `${label} 必须是对象（该项忽略）` })
    return null
  }
  const unknown = unknownKeys(entry, PROJECT_KEYS)
  if (unknown.length > 0) {
    errors.push({ ruleId: null, error: `${label} 有未知字段 ${unknown.join(', ')}（该项忽略）` })
    return null
  }
  for (const effect of EFFECTS) {
    if (entry[effect] !== undefined && !Array.isArray(entry[effect])) {
      errors.push({ ruleId: null, error: `${label}.${effect} 必须是数组（该项忽略）` })
      return null
    }
  }
  const rules = []
  for (const effect of EFFECTS) {
    const list = entry[effect] ?? []
    for (const [index, item] of list.entries()) {
      const compiled = compileRule(item, effect, index)
      if (compiled.error !== undefined) {
        errors.push({ ruleId: compiled.error.ruleId, error: `${label} ${compiled.error.error}` })
      } else {
        rules.push(compiled.rule)
      }
    }
  }
  return rules
}

/**
 * 编译可选的 projects 段：`{ "<项目标识>": { deny, allow } }`。
 * 整段不是对象 → 只忽略 projects，顶层规则照常生效；单个项目项坏了 → 只忽略该项。
 */
function compileProjects(value, errors) {
  if (value === undefined) return EMPTY_PROJECTS
  if (!isPlainObject(value)) {
    errors.push({ ruleId: null, error: 'projects 必须是对象（projects 段整段忽略）' })
    return EMPTY_PROJECTS
  }
  const projects = Object.create(null)
  for (const [id, entry] of Object.entries(value)) {
    if (!PROJECT_ID_PATTERN.test(id)) {
      errors.push({
        ruleId: null,
        error: `projects 里的键 ${JSON.stringify(id)} 不是项目标识（该项忽略）`,
      })
      continue
    }
    const rules = compileProjectRules(id, entry, errors)
    if (rules !== null) projects[id] = Object.freeze(rules)
  }
  return Object.freeze(projects)
}

/**
 * 编译一整份配置。
 *
 * 结构性错误（不是对象、version 不是 1、顶层 deny/allow 不是数组、未知顶层字段）
 * → 整份文件作废；projects 段坏 → 只忽略该段；单个项目项坏 → 只忽略该项；
 * 单条规则错误 → 只作废该条。所有错误都写进诊断，坏的部分绝不放行。
 *
 * @returns {{rules: object[], errors: {ruleId: string|null, error: string}[], projects: object}}
 */
export function compileDocument(raw) {
  if (!isPlainObject(raw)) {
    return {
      rules: [],
      errors: [{ ruleId: null, error: '文件内容必须是 JSON 对象' }],
      projects: EMPTY_PROJECTS,
    }
  }
  const unknown = unknownKeys(raw, DOCUMENT_KEYS)
  if (unknown.length > 0) {
    return {
      rules: [],
      errors: [{ ruleId: null, error: `未知的顶层字段 ${unknown.join(', ')}（整份文件作废）` }],
      projects: EMPTY_PROJECTS,
    }
  }
  if (raw.version !== 1) {
    return {
      rules: [],
      errors: [{ ruleId: null, error: `version 必须是 1（读到 ${JSON.stringify(raw.version)}）` }],
      projects: EMPTY_PROJECTS,
    }
  }
  for (const effect of EFFECTS) {
    if (raw[effect] !== undefined && !Array.isArray(raw[effect])) {
      return {
        rules: [],
        errors: [{ ruleId: null, error: `${effect} 必须是数组（整份文件作废）` }],
        projects: EMPTY_PROJECTS,
      }
    }
  }
  const rules = []
  const errors = []
  for (const effect of EFFECTS) {
    const list = raw[effect] ?? []
    for (const [index, item] of list.entries()) {
      const compiled = compileRule(item, effect, index)
      if (compiled.error !== undefined) errors.push(compiled.error)
      else rules.push(compiled.rule)
    }
  }
  const projects = compileProjects(raw.projects, errors)
  return { rules, errors, projects }
}

/**
 * 全串匹配：命中区间必须从 0 开始、覆盖整条命令。
 *
 * 只检查 `^`/`$` 不够：JS 里 `^git status$` 能匹配 "git status\n"（`$` 在末尾换行前也成立），
 * 那会让「规则看上去锚定了、实际留了个换行口子」。这里用长度校验把口子堵死。
 */
function fullMatch(regex, text) {
  const match = regex.exec(text)
  return match !== null && match.index === 0 && match[0].length === text.length
}

/** 一条规则是否命中（工具过滤 + 全串正则）。 */
export function ruleMatches(rule, tool, command) {
  if (!rule.tools.includes(TOOL_WILDCARD) && !rule.tools.includes(tool)) return false
  return fullMatch(rule.regex, command)
}

/**
 * 决策：deny 先判，其次 allow，都没有就是 none（照常问）。
 * @returns {{kind: 'deny'|'allow', rule: object}|{kind: 'none'}}
 */
export function decide(rules, { tool, command }) {
  if (typeof tool !== 'string' || tool === '') return { kind: 'none' }
  if (typeof command !== 'string' || command === '') return { kind: 'none' }
  for (const rule of rules) {
    if (rule.effect === 'deny' && ruleMatches(rule, tool, command)) return { kind: 'deny', rule }
  }
  for (const rule of rules) {
    if (rule.effect === 'allow' && ruleMatches(rule, tool, command)) return { kind: 'allow', rule }
  }
  return { kind: 'none' }
}
