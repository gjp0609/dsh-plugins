/**
 * 卡片子进程的生命周期（D-26）：宿主进程退出/被杀/崩掉，都必须
 * ① 让 `selectRows` 立刻结算（不等 stdout/stderr 关闭），② 收掉它拉起的整棵进程树。
 *
 * 现场（2026-10-29 15:27）：卡片宿主 pwsh 没了、只剩 3 个 msedgewebview2 孤儿，
 * 它们继承着 stdout/stderr 管道，`close` 永远不来 —— 只等 stdio 的写法会让这次调用永不 settle。
 * 这里的假 subprocess 复刻宿主的结算语义：**done 在「目标进程退出」后按 graceMs 结算**，
 * 与管道是否关闭无关；`terminate()` 才是「杀整棵树」。
 *
 * 运行：node --test tests/dialog.test.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { createDialogRunner } from '../lib/admin.mjs'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/** 永不关闭的「已收集输出」：真实现里它就是被孤儿进程占住的管道。 */
function openCollector(text) {
  const reader = new EventEmitter()
  reader.readFrom = () => ({ text })
  return reader
}

/**
 * 假 `ctx.subprocess`。
 * @param exitCode - 目标进程的退出码（取消/崩溃时是 1；用户答完是 0）
 * @param exitDelayMs - 「目标进程退出」发生在多少毫秒之后
 * @param answer - 给了就当作 pwsh 在退出前把结果写进了 `-OutFile`
 */
function fakeSubprocess({ exitCode = 1, exitDelayMs = 20, answer, stdout = '', stderr = '' } = {}) {
  const spawns = []
  return {
    spawns,
    spawn(spec) {
      const record = { spec, terminated: 0, waitedForExit: 0, done: null }
      spawns.push(record)
      const outFile = spec.argv[spec.argv.indexOf('-OutFile') + 1]
      if (answer !== undefined) writeFileSync(outFile, JSON.stringify(answer), 'utf8')
      const done = new Promise((resolve) => {
        let timer
        const finish = () => {
          if (timer !== undefined) clearTimeout(timer)
          resolve({ exitCode, signal: null })
        }
        // 取消路径：宿主的 abort 会杀掉整棵树，done 照样会结算（非 0 退出、stderr 空）。
        if (spec.signal !== undefined) {
          if (spec.signal.aborted) finish()
          else spec.signal.addEventListener('abort', finish, { once: true })
        }
        // 正常退出：只有目标进程退出，管道仍然被 WebView2 子进程占着（不 close）。
        timer = setTimeout(finish, exitDelayMs)
      })
      record.done = done
      return {
        done,
        terminate() {
          record.terminated += 1
        },
        terminateForHostExit() {
          record.terminated += 1
        },
        // `waitForExit()` 等的是「整棵进程树空了」，不是「目标进程退出」：孤儿还在时它永远不返回。
        // 所以卡片这条路径一次都不该调它（调了就是又一种「只能重启宿主」）。
        waitForExit() {
          record.waitedForExit += 1
          return new Promise(() => {})
        },
        collected: { stdout: openCollector(stdout), stderr: openCollector(stderr) },
      }
    },
  }
}

function makeRunner(subprocess) {
  return createDialogRunner({ subprocess, scriptDir: 'C:\\scripts', cwd: 'C:\\work' })
}

async function withDeadline(promise, ms, message) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

await test('卡片退出但 stdio 没关（WebView2 孤儿占着管道）→ selectRows 立刻结算，按跳过处理', async () => {
  // 宿主进程崩了：非 0 退出、stderr 空、管道永不 close。
  const subprocess = fakeSubprocess({ exitCode: 1, exitDelayMs: 30 })
  const dialog = makeRunner(subprocess)
  const startedAt = Date.now()
  const result = await withDeadline(dialog.selectRows({ rows: [{ label: '192.168.1.11:22 · Web 1' }] }), 1500, '卡片进程退出后 selectRows 没有结算')
  const elapsed = Date.now() - startedAt

  assert.deepEqual(result, { answered: false, selected: [] }, '宿主没了＝没勾选，一行都不执行')
  assert.ok(elapsed < 1500, `必须跟着进程退出结算，实际 ${elapsed}ms`)
  assert.ok(subprocess.spawns[0].spec.graceMs <= 1000, '退出后的排空窗口必须很短，不能是原来的 20s')
  assert.equal(subprocess.spawns[0].terminated >= 1, true, '卡片结束后要收掉整棵进程树（不留 WebView2 孤儿）')
  assert.equal(subprocess.spawns[0].waitedForExit, 0, '不许把「等整棵树空了」当成「进程已退出」（孤儿在时它永远不返回）')
})

await test('用户答完（退出码 0）：正常读回勾选结果，并同样收掉整棵树', async () => {
  const subprocess = fakeSubprocess({
    exitCode: 0,
    exitDelayMs: 20,
    answer: { answered: true, selected: ['192.168.1.11:22 · Web 1'] },
  })
  const dialog = makeRunner(subprocess)
  const result = await withDeadline(dialog.selectRows({ rows: [{ label: '192.168.1.11:22 · Web 1' }] }), 1500, '答完之后没有结算')
  assert.deepEqual(result, { answered: true, selected: ['192.168.1.11:22 · Web 1'] })
  assert.equal(subprocess.spawns[0].terminated >= 1, true, '正常结束也要收树')
  // 卡片自超时整条链已删（2026-11-10 用户「这个功能不需要」）：参数、透传、兜底超时都不许回来。
  // 删后的后果是 SSH 卡片永不自动关闭，只能人工关——所以这里同时钉住「不传超时」这一半。
  const argv = subprocess.spawns[0].spec.argv
  for (const flag of ['-AutoCloseMs', '-TimeoutMs', '-CloseMs']) {
    assert.equal(argv.includes(flag), false, `argv 里不该再有 ${flag}（卡片不自动关）`)
  }
  const dialogSource = readFileSync(new URL('../scripts/dialog.ps1', import.meta.url), 'utf8')
  assert.equal(dialogSource.includes('AutoCloseMs'), false, 'dialog.ps1 里还留着 AutoCloseMs：删干净，不留「传了不生效」')
})

await test('取消：signal 传到卡片子进程，abort 后立刻按跳过结算，并收掉整棵树', async () => {
  const subprocess = fakeSubprocess({ exitCode: 1, exitDelayMs: 60000 }) // 不 abort 就永远不退出
  const dialog = makeRunner(subprocess)
  const controller = new AbortController()
  const pending = dialog.selectRows({ rows: [{ label: 'Web 1' }], signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  const result = await withDeadline(pending, 1500, '点停止之后卡片没有结算')
  assert.equal(subprocess.spawns[0].spec.signal, controller.signal, 'signal 必须原样交给子进程（杀的是整棵树）')
  assert.deepEqual(result, { answered: false, selected: [] })
  assert.equal(subprocess.spawns[0].terminated >= 1, true)
})

await test('会话侧只剩一张卡：执行器没有 confirm / askForm（B-47）', async () => {
  const runner = makeRunner(fakeSubprocess())
  assert.deepEqual(Object.keys(runner).sort(), ['selectRows'], '只留勾选卡——那张卡就是执行与复制的审批')
  assert.equal(runner.confirm, undefined, '确认卡随「删除主机」一起删了')
  assert.equal(runner.askForm, undefined, '表单卡随「新增主机 / 改密码」一起删了')
})

console.log(`\n${passed} 项通过`)
