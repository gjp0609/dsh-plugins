/**
 * dsh-approval-allow 的自测：纯 node + assert。
 *
 * 不用 node:test：本机沙箱下 test runner 会 spawn EPERM。
 * 跑法：node dsh-approval-allow/tests/allow.test.mjs
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUDIT_FILE_NAME,
  CACHE_MAX,
  CACHE_TTL_MS,
  DIAGNOSTICS_FILE_NAME,
  createCallCache,
} from '../lib/audit.mjs'
import { projectIdFor } from '../lib/config.mjs'
import { compileDocument, decide, isAnchored } from '../lib/match.mjs'
import {
  assert,
  doc,
  mount,
  readJsonl,
  request,
  section,
  summary,
  test,
  withTemp,
  writeDoc,
} from './harness.mjs'

// ---------------------------------------------------------------------------
// 纯匹配语义
// ---------------------------------------------------------------------------

await test('锚定校验：不以 ^ 开头 / 不以 $ 结尾的规则作废', () => {
  const { rules, errors } = compileDocument(
    doc([
      { id: 'no-start', tool: 'pwsh', match: 'git status$' },
      { id: 'no-end', tool: 'pwsh', match: '^git status' },
      { id: 'ok', tool: 'pwsh', match: '^git status$' },
    ]),
  )
  assert.deepEqual(rules.map((rule) => rule.id), ['ok'])
  assert.equal(errors.length, 2)
  assert.equal(isAnchored('git status'), false)
  assert.equal(isAnchored('^git status$'), true)
})

await test("^git commit -m '.*'$ 匹配 git commit -m 'fix typo'", () => {
  const { rules } = compileDocument(
    doc([{ id: 'commit', tool: 'pwsh', match: "^git commit -m '.*'$" }]),
  )
  const outcome = decide(rules, { tool: 'pwsh', command: "git commit -m 'fix typo'" })
  assert.equal(outcome.kind, 'allow')
  assert.equal(outcome.rule.id, 'commit')
})

await test('全串匹配：同一规则不放过追加了别的命令的 git commit', () => {
  const { rules } = compileDocument(
    doc([{ id: 'commit', tool: 'pwsh', match: "^git commit -m '.*'$" }]),
  )
  assert.equal(decide(rules, { tool: 'pwsh', command: "git commit -m 'x' && rm -rf ~" }).kind, 'none')
  assert.equal(decide(rules, { tool: 'pwsh', command: "git commit -m 'x'\nrm -rf ~" }).kind, 'none')
})

await test('deny 优先：allow 与 deny 同时命中时照常问', () => {
  const { rules } = compileDocument(
    doc(
      [{ id: 'push-any', tool: 'pwsh', match: '^git push .*$' }],
      [{ id: 'push-force', tool: 'pwsh', match: '^git push .*--force.*$' }],
    ),
  )
  assert.equal(decide(rules, { tool: 'pwsh', command: 'git push origin main' }).kind, 'allow')
  const denied = decide(rules, { tool: 'pwsh', command: 'git push --force origin main' })
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.rule.id, 'push-force')
})

await test('工具过滤：*、数组、精确名字都按配置走', () => {
  const star = compileDocument(doc([{ id: 'star', tool: '*', match: '^echo hi$' }])).rules
  assert.equal(decide(star, { tool: 'pwsh', command: 'echo hi' }).kind, 'allow')
  assert.equal(decide(star, { tool: 'bash', command: 'echo hi' }).kind, 'allow')

  const both = compileDocument(doc([{ id: 'both', tool: ['pwsh', 'bash'], match: '^echo hi$' }])).rules
  assert.equal(decide(both, { tool: 'bash', command: 'echo hi' }).kind, 'allow')

  const bashOnly = compileDocument(doc([{ id: 'bash-only', tool: 'bash', match: '^echo hi$' }])).rules
  assert.equal(decide(bashOnly, { tool: 'pwsh', command: 'echo hi' }).kind, 'none')
  assert.equal(decide(bashOnly, { tool: 'bash', command: 'echo hi' }).kind, 'allow')
})

// ---------------------------------------------------------------------------
// 项目标识与单一配置文件（工作区外）
// ---------------------------------------------------------------------------

await test('项目标识：同路径稳定、大小写同标识、可读且截断、不同路径不撞', () => {
  const root = 'C:\\work\\dsh-plugins'
  const first = projectIdFor(root)
  assert.equal(projectIdFor(root), first)
  assert.equal(projectIdFor('c:\\work\\dsh-plugins'), first)
  assert.match(first, /^c-work-dsh-plugins-[0-9a-f]{8}$/)
  assert.equal(projectIdFor('relative\\path'), null)

  const longId = projectIdFor('C:\\' + 'abcdefghij'.repeat(10))
  assert.match(longId, /^c-[a-z0-9-]+-[0-9a-f]{8}$/)
  assert.ok(longId.slice(0, longId.length - 9).length <= 60, `longId=${longId}`)

  assert.notEqual(projectIdFor('C:\\a\\proj'), projectIdFor('C:\\b\\proj'))
})

await test('项目配置只在 dataDir\\allow.json；工作区里的 .dsh 与根 allow.json 都被忽略', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    mkdirSync(join(project, '.dsh'), { recursive: true })
    writeFileSync(
      join(project, '.dsh', 'approval-allow.json'),
      JSON.stringify(doc([{ id: 'sneaky-status', tool: 'pwsh', match: '^git status$' }])),
      'utf8',
    )
    writeFileSync(
      join(project, 'allow.json'),
      JSON.stringify(doc([{ id: 'sneaky-log', tool: 'pwsh', match: '^git log$' }])),
      'utf8',
    )
    const fake = mount({ dataDir, cwd: project })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.equal(await request(fake, { command: 'git log' }), 'downstream')
    assert.equal(existsSync(join(dataDir, DIAGNOSTICS_FILE_NAME)), false)
  })
})

await test('项目段并进同一个 allow.json，两个同名项目互不串线、不建子目录', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const firstProject = join(root, 'a', 'proj')
    const secondProject = join(root, 'b', 'proj')
    const firstId = projectIdFor(firstProject)
    const secondId = projectIdFor(secondProject)
    assert.notEqual(firstId, secondId)

    writeDoc(
      join(dataDir, 'allow.json'),
      doc([], [], {
        [firstId]: section([{ id: 'a-status', tool: 'pwsh', match: '^git status$' }]),
        [secondId]: section([{ id: 'b-log', tool: 'pwsh', match: '^git log$' }]),
      }),
    )

    const first = mount({ dataDir, cwd: firstProject })
    assert.equal(await request(first, { command: 'git status' }), 'allowed-once')
    assert.equal(await request(first, { command: 'git log' }), 'downstream')

    const second = mount({ dataDir, cwd: secondProject })
    assert.equal(await request(second, { command: 'git log' }), 'allowed-once')
    assert.equal(await request(second, { command: 'git status' }), 'downstream')

    assert.equal(existsSync(join(dataDir, 'projects')), false)
    assert.deepEqual(readdirSync(dataDir).sort(), ['allow.json', 'approvals.jsonl'])
  })
})

await test('projects 段异常：坏项只忽略自己，全局与合法项目项仍生效并写诊断', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    const other = join(root, 'other')
    const projectId = projectIdFor(project)
    const otherId = projectIdFor(other)
    writeDoc(
      join(dataDir, 'allow.json'),
      doc([{ id: 'g-log', tool: 'pwsh', match: '^git log$' }], [], {
        // 当前项目这一项有未知字段：整项忽略，但全局规则不受影响
        [projectId]: { allow: [{ id: 'p-status', tool: 'pwsh', match: '^git status$' }], footer: 1 },
        // 键根本不是项目标识：忽略并写诊断
        'not-a-project-id': { allow: [{ id: 'x', tool: 'pwsh', match: '^git status$' }] },
        // 另一个合法项目：照常生效
        [otherId]: section([{ id: 'o-status', tool: 'pwsh', match: '^git status$' }]),
      }),
    )

    const fake = mount({ dataDir, cwd: project })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.equal(await request(fake, { command: 'git log' }), 'allowed-once')

    const otherFake = mount({ dataDir, cwd: other })
    assert.equal(await request(otherFake, { command: 'git status' }), 'allowed-once')

    const diagnostics = readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8')
      .trim()
      .split('\n')
    assert.ok(diagnostics.some((line) => line.includes('未知字段')), diagnostics.join('\n'))
    assert.ok(diagnostics.some((line) => line.includes('不是项目标识')), diagnostics.join('\n'))
  })
})

await test('projects 不是对象 / 项目项不是对象：忽略坏的部分，不崩，全局仍生效', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    const projectId = projectIdFor(project)
    const fake = mount({ dataDir, cwd: project })

    writeDoc(
      join(dataDir, 'allow.json'),
      doc([{ id: 'g-status', tool: 'pwsh', match: '^git status$' }], [], []),
    )
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /projects 必须是对象/)

    writeDoc(
      join(dataDir, 'allow.json'),
      doc([{ id: 'g-status', tool: 'pwsh', match: '^git status$' }], [], {
        [projectId]: 'not-an-object',
      }),
    )
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /必须是对象（该项忽略）/)
  })
})

await test('项目段里的坏规则：只作废该条，兄弟规则仍生效', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    const projectId = projectIdFor(project)
    writeDoc(
      join(dataDir, 'allow.json'),
      doc([], [], {
        [projectId]: section([
          { id: 'broken', tool: 'pwsh', match: '^git (status$' },
          { id: 'ok', tool: 'pwsh', match: '^git status$' },
        ]),
      }),
    )
    const fake = mount({ dataDir, cwd: project })
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /正则编译失败/)
  })
})

// ---------------------------------------------------------------------------
// 端到端：挂载 + 两个事件 + 配置文件
// ---------------------------------------------------------------------------

await test('全局与项目段合并，项目 deny 优先', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    const projectId = projectIdFor(project)
    writeDoc(
      join(dataDir, 'allow.json'),
      doc(
        [{ id: 'g-status', tool: 'pwsh', match: '^git status$' }],
        [],
        {
          [projectId]: section(
            [{ id: 'p-pull', tool: 'pwsh', match: '^git pull( .*)?$' }],
            [{ id: 'p-pull-force', tool: 'pwsh', match: '^git pull --force( .*)?$' }],
          ),
        },
      ),
    )
    const fake = mount({ dataDir, cwd: project })
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    assert.equal(await request(fake, { command: 'git pull origin main' }), 'allowed-once')
    assert.equal(await request(fake, { command: 'git pull --force origin main' }), 'downstream')

    const denied = readJsonl(join(dataDir, AUDIT_FILE_NAME)).at(-1)
    assert.equal(denied.outcome, 'asked')
    assert.equal(denied.reason, 'deny-rule')
    assert.equal(denied.rule, 'p-pull-force')
  })
})

await test('坏 JSON：整份作废、fail-closed，并写 config-errors.log', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'allow.json'), '{"version": 1, "allow": [', 'utf8')
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.equal(await request(fake, { command: 'git log' }), 'downstream')
    const diagnostics = readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8')
      .trim()
      .split('\n')
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0], /JSON 解析失败/)
    assert.deepEqual(readdirSync(dataDir).sort(), [
      'allow.json',
      'approvals.jsonl',
      'config-errors.log',
    ])
  })
})

await test('坏正则：只作废该条，兄弟规则仍生效', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(
      join(dataDir, 'allow.json'),
      doc([
        { id: 'broken', tool: 'pwsh', match: '^git (status$' },
        { id: 'ok', tool: 'pwsh', match: '^git status$' },
      ]),
    )
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /正则编译失败/)
  })
})

await test('不锚定：只作废该条，兄弟规则仍生效（端到端）', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(
      join(dataDir, 'allow.json'),
      doc([
        { id: 'loose', tool: 'pwsh', match: 'git status' },
        { id: 'ok', tool: 'pwsh', match: '^git log$' },
      ]),
    )
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.equal(await request(fake, { command: 'git log' }), 'allowed-once')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /必须全串锚定/)
  })
})

await test('未知规则字段：只作废该条', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(
      join(dataDir, 'allow.json'),
      doc([
        { id: 'unknown', tool: 'pwsh', match: '^git status$', foo: 1 },
        { id: 'ok', tool: 'pwsh', match: '^git log$' },
      ]),
    )
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.equal(await request(fake, { command: 'git log' }), 'allowed-once')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /未知字段/)
  })
})

await test('version 不是 1：整份作废', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(join(dataDir, 'allow.json'), {
      version: 2,
      allow: [{ id: 'status', tool: 'pwsh', match: '^git status$' }],
    })
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.match(readFileSync(join(dataDir, DIAGNOSTICS_FILE_NAME), 'utf8'), /version 必须是 1/)
  })
})

await test('热更：改 mtime 后重读，新规则立即生效、旧规则失效', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const fake = mount({ dataDir })
    writeDoc(join(dataDir, 'allow.json'), doc([{ id: 'status', tool: 'pwsh', match: '^git status$' }]))
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')

    writeDoc(join(dataDir, 'allow.json'), doc([{ id: 'log', tool: 'pwsh', match: '^git log$' }]))
    assert.equal(await request(fake, { command: 'git log' }), 'allowed-once')
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
  })
})

await test('缓存命中：pre-execute 记下的命令用于审批，并写审计', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(join(dataDir, 'allow.json'), doc([{ id: 'status', tool: 'pwsh', match: '^git status$' }]))
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    const lines = readJsonl(join(dataDir, AUDIT_FILE_NAME))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].tool, 'pwsh')
    assert.equal(lines[0].command, 'git status')
    assert.equal(lines[0].outcome, 'auto-allowed')
    assert.equal(lines[0].rule, 'status')
    assert.equal(lines[0].reason, null)
    assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/)
  })
})

await test('缓存未命中：没经过 pre-execute 的审批走 next() 并记 asked', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const fake = mount({ dataDir })
    const outcome = await fake.fire('approval/request', {
      toolName: 'pwsh',
      callId: 'never-cached',
      agent: { session: {} },
    })
    assert.equal(outcome, 'downstream')
    const last = readJsonl(join(dataDir, AUDIT_FILE_NAME)).at(-1)
    assert.equal(last.outcome, 'asked')
    assert.equal(last.reason, 'cache-miss')
    assert.equal(last.command, null)
  })
})

await test('callId 缺失：走 next()，绝不猜命令', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const fake = mount({ dataDir })
    const outcome = await fake.fire('approval/request', { toolName: 'pwsh', agent: { session: {} } })
    assert.equal(outcome, 'downstream')
    const last = readJsonl(join(dataDir, AUDIT_FILE_NAME)).at(-1)
    assert.equal(last.reason, 'call-id-missing')
    assert.equal(last.tool, 'pwsh')
    assert.equal(last.command, null)
  })
})

await test('非 pwsh/bash：不缓存、不放行', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(join(dataDir, 'allow.json'), doc([{ id: 'any', tool: '*', match: '^git status$' }]))
    const fake = mount({ dataDir })
    await fake.fire('tools/pre-execute', {
      name: 'edit',
      arguments: { command: 'git status' },
      callId: 'edit-1',
    })
    assert.equal(
      await fake.fire('approval/request', {
        toolName: 'edit',
        callId: 'edit-1',
        agent: { session: {} },
      }),
      'downstream',
    )
    // 同一个 callId 换成 pwsh 也不能蹭到缓存
    assert.equal(
      await fake.fire('approval/request', {
        toolName: 'pwsh',
        callId: 'edit-1',
        agent: { session: {} },
      }),
      'downstream',
    )
    assert.equal(
      readJsonl(join(dataDir, AUDIT_FILE_NAME)).filter((line) => line.outcome === 'auto-allowed')
        .length,
      0,
    )
  })
})

await test('缓存：默认 256 / 10 分钟，TTL 过期与容量淘汰最旧', () => {
  assert.equal(CACHE_MAX, 256)
  assert.equal(CACHE_TTL_MS, 10 * 60 * 1000)

  let clock = 0
  const expiring = createCallCache({ max: 8, ttlMs: 100, now: () => clock })
  assert.equal(expiring.remember('a', { tool: 'pwsh', command: 'git status' }), true)
  clock = 101
  assert.equal(expiring.lookup('a'), null)

  const bounded = createCallCache({ max: 2, ttlMs: 1000, now: () => 0 })
  for (const id of ['a', 'b', 'c']) {
    bounded.remember(id, { tool: 'pwsh', command: 'echo hi' })
  }
  assert.equal(bounded.size, 2)
  assert.equal(bounded.lookup('a'), null)
  assert.equal(bounded.lookup('b')?.tool, 'pwsh')
  assert.equal(bounded.lookup('c')?.tool, 'pwsh')
})

await test('审计写失败不影响放行', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(join(dataDir, 'allow.json'), doc([{ id: 'status', tool: 'pwsh', match: '^git status$' }]))
    // 把流水文件的位置先占成目录：append 必失败，但配置照常读、审批照常放行。
    mkdirSync(join(dataDir, AUDIT_FILE_NAME))
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const fake = mount({ dataDir })
      assert.equal(await request(fake, { command: 'git status' }), 'allowed-once')
    } finally {
      console.warn = originalWarn
    }
  })
})

await test('审计字段稳定：每行六个键、一行一条', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(join(dataDir, 'allow.json'), doc([{ id: 'status', tool: 'pwsh', match: '^git status$' }]))
    const fake = mount({ dataDir })
    await request(fake, { command: 'git status' })
    await request(fake, { command: 'git log' })
    const lines = readJsonl(join(dataDir, AUDIT_FILE_NAME))
    assert.equal(lines.length, 2)
    for (const line of lines) {
      assert.deepEqual(Object.keys(line).sort(), ['command', 'outcome', 'reason', 'rule', 'tool', 'ts'])
    }
    assert.deepEqual(
      lines.map((line) => line.outcome),
      ['auto-allowed', 'asked'],
    )
    assert.equal(lines[1].reason, 'no-rule')
    assert.equal(lines[1].rule, null)
  })
})

await test('末行换行不放过：^git status$ 不匹配 "git status\\n"', () => {
  const { rules } = compileDocument(doc([{ id: 'status', tool: 'pwsh', match: '^git status$' }]))
  assert.equal(decide(rules, { tool: 'pwsh', command: 'git status\n' }).kind, 'none')
})

await test('项目根退回 session.header.cwd；都拿不到时只用全局', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    const project = join(root, 'project')
    const projectId = projectIdFor(project)
    writeDoc(
      join(dataDir, 'allow.json'),
      doc([{ id: 'g-status', tool: 'pwsh', match: '^git status$' }], [], {
        [projectId]: section([{ id: 'p-log', tool: 'pwsh', match: '^git log$' }]),
      }),
    )

    const viaHeader = mount({ dataDir, service: false })
    assert.equal(
      await request(viaHeader, { command: 'git log', session: { header: { cwd: project } } }),
      'allowed-once',
    )

    const globalOnly = mount({ dataDir, service: false })
    assert.equal(await request(globalOnly, { command: 'git log' }), 'downstream')
    assert.equal(await request(globalOnly, { command: 'git status' }), 'allowed-once')
  })
})

await test('空配置（只有 version）：合法但不放行，也不写诊断', async () => {
  await withTemp(async (root) => {
    const dataDir = join(root, 'data')
    writeDoc(join(dataDir, 'allow.json'), doc([]))
    const fake = mount({ dataDir })
    assert.equal(await request(fake, { command: 'git status' }), 'downstream')
    assert.equal(existsSync(join(dataDir, DIAGNOSTICS_FILE_NAME)), false)
  })
})

summary()
