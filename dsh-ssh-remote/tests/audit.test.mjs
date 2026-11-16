/**
 * 审计格式与改名完整性（D-30）。
 *
 * 两件事必须有断言守着：
 * - `phase` / `event` / `callId` 真的落进 JSONL——白名单漏一个，字段就会被静默丢掉，
 *   代码里看着「记了」，审计里却什么都没有；
 * - 旧名字一处都不剩——改名只改一半，下一个人就会对着两套名字改代码。
 *
 * 运行：node dsh-ssh-remote/tests/audit.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAudit, phaseEntry } from '../lib/audit.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

await test('审计：phase / event / callId 落盘，密码与输出正文被白名单挡掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-remote-audit-'))
  let tick = 0
  // 时间戳注入：两条记录差 1 秒，用来证明「相邻 ts 之差」这条路能算阶段耗时。
  const audit = createAudit({ dir, now: () => new Date(Date.UTC(2026, 9, 29, 1, 0, tick++)) })

  audit.record(phaseEntry({ kind: 'run', phase: 'approval', callId: 'call-9' }))
  audit.record({
    kind: 'run',
    event: 'result',
    phase: 'exec',
    callId: 'call-9',
    target: 'web1',
    command: 'ls',
    approved: true,
    exitCode: 0,
    ms: 12,
    // 下面两个键是故意塞进去的：白名单必须把它们扔掉。
    password: 'hunter2',
    stdout: 'secret output',
  })

  const files = readdirSync(dir).filter((name) => /^audit-\d{8}\.jsonl$/.test(name))
  assert.equal(files.length, 1, '一天一个文件')
  const raw = readFileSync(join(dir, files[0]), 'utf8')
  const entries = raw.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(entries.length, 2, '阶段事件与结果各一条（追加，不覆盖）')

  assert.equal(entries[0].event, 'enter')
  assert.equal(entries[0].phase, 'approval')
  assert.equal(entries[0].callId, 'call-9')
  assert.equal(entries[1].event, 'result')
  assert.equal(entries[1].phase, 'exec')
  assert.equal(entries[1].callId, 'call-9')
  assert.equal(entries[1].exitCode, 0, '既有字段一个都不许丢')
  assert.equal(typeof entries[0].ts, 'string')
  assert.ok(
    new Date(entries[1].ts).getTime() >= new Date(entries[0].ts).getTime(),
    'ts 有先后，相邻两条之差才能算「这个阶段停了多久」',
  )

  assert.equal(raw.includes('hunter2'), false, '密码绝不进审计')
  assert.equal(raw.includes('secret output'), false, '输出正文不进审计')
})

await test('审计：阶段只收 approval / connect / exec', () => {
  assert.throws(() => phaseEntry({ kind: 'run', phase: 'waiting', callId: 'x' }), /审计阶段只能是/)
  for (const phase of ['approval', 'connect', 'exec']) {
    assert.equal(phaseEntry({ kind: 'run', phase }).phase, phase)
  }
})

await test('改名：旧名字在源码与文档里一处不剩（防止只改一半）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = dirname(here)
  // 拆开拼：这条断言自己不能出现那个旧名字，否则它会永远匹配到自己。
  const oldName = ['native', 'Selector'].join('')
  const files = [
    ...readdirSync(join(root, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => join(root, 'lib', name)),
    ...readdirSync(join(root, 'scripts')).filter((name) => name.endsWith('.ps1')).map((name) => join(root, 'scripts', name)),
    ...readdirSync(here).filter((name) => name.endsWith('.mjs')).map((name) => join(here, name)),
    join(root, 'index.js'),
    join(root, 'README.md'),
  ]
  const hits = files.filter((file) => readFileSync(file, 'utf8').includes(oldName))
  assert.deepEqual(hits, [], `旧名字还留在：${hits.join('、')}`)

  // 反向确认：新名字确实在（否则「没命中」也可能只是整个函数被删了）。
  // 只认函数名，不认参数表：这条断言守的是「改名之后函数还在」，不是签名快照。
  // 2026-11-12 R-25 给通道加了第二个参数（卡片抬头那行的会话工作区），签名变了但不影响这条的语义。
  assert.match(readFileSync(join(root, 'lib', 'approval.mjs'), 'utf8'), /export function cardApprovalChannel\(/)
})

console.log(`\n结果：全部通过（${passed} 项）`)
