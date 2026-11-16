/**
 * 测试驱动：临时目录、配置写入、最小 Cordis 上下文、逐条打印。
 *
 * 只给 tests/allow.test.mjs 用；不是第二个测试入口。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../index.js'

let passed = 0

export async function test(name, fn) {
  try {
    await fn()
  } catch (error) {
    console.error(`not ok ${name}`)
    throw error
  }
  passed += 1
  console.log(`ok ${name}`)
}

export function summary() {
  console.log(`全部通过 ${passed} 项`)
}

/** 写一份配置文件，并把 mtime 单调往后推（热更按 mtime+size 判断）。 */
let mtimeSeq = 0
export function writeDoc(path, document) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  mtimeSeq += 1
  const stamp = new Date(Date.now() + mtimeSeq * 1000)
  utimesSync(path, stamp, stamp)
}

/** 一份最小合法配置；deny 在第二位只是为了和 schema 顺序一致。 */
export const doc = (allow, deny = [], projects = undefined) => {
  const document = { version: 1, deny, allow }
  if (projects !== undefined) document.projects = projects
  return document
}

/** 一个项目段：只放 deny/allow，不重复 version。 */
export const section = (allow, deny = []) => ({ deny, allow })

export function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export async function withTemp(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-approval-allow-'))
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 最小 Cordis 上下文：on / effect / get，够 apply 挂载与测试驱动。 */
function createFakeContext({ cwd = null, service = true } = {}) {
  const listeners = new Map()
  const ctx = {
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {}
    },
    effect(setup) {
      setup()
    },
    get(name) {
      if (service && name === 'workingDirectory' && typeof cwd === 'string') {
        return { get: () => cwd }
      }
      return undefined
    },
  }
  async function fire(name, payload) {
    const chain = listeners.get(name) ?? []
    const step = (index) =>
      Promise.resolve().then(() => {
        if (index >= chain.length) return 'downstream'
        return chain[index](payload, () => step(index + 1))
      })
    return step(0)
  }
  return { ctx, fire }
}

export function mount({ dataDir, cwd = null, service = true }) {
  const fake = createFakeContext({ cwd, service })
  apply(fake.ctx, { dataDir })
  return fake
}

let callSeq = 0
export async function request(fake, { tool = 'pwsh', command, callId, session } = {}) {
  const id = callId ?? `call-${++callSeq}`
  if (typeof command === 'string') {
    await fake.fire('tools/pre-execute', { name: tool, arguments: { command }, callId: id })
  }
  return fake.fire('approval/request', {
    toolName: tool,
    callId: id,
    agent: { session: session ?? {} },
  })
}

export { assert }
