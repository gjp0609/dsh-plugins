#!/usr/bin/env node
/**
 * 报高稳定判据的桩测试（tests/settle.mjs）
 *
 * 钉住 shared/ui-card/app/src/settle.ts 的判定（宿主只认第一条高度，那一条就必须是最终值，D-46）：
 *   ① 首帧不算稳定（没有「上一帧」可比）→ 不报；
 *   ② 连续两个 rAF 样本一致 → 报，且不带 unstable；
 *   ③ 中途变过、之后两帧一致 → 报**稳定后**的那个高度（不是最早那个）；
 *   ④ `document.fonts.ready` 没 resolve 前一律不报；
 *   ⑤ 预算到点还在变 → 按**最后一次**报，并把「哪两次不一样」带回去；
 *   ⑥ 字体一直不来也不能卡死卡片：预算到点照样报（unstable.fontsReady = false）；
 *   ⑦ 判定里不许出现固定等待（没有 setTimeout / sleep 这类东西）。
 *
 * 直接 import 产品里那份 .ts（node ≥ 22.18 能剥类型），不在这里另抄一份。
 *
 * 跑法：node tests/settle.mjs
 */
import { readFileSync } from 'node:fs'
import {
  MEASURE_SAMPLE_INTERVAL_MS,
  MEASURE_SETTLE_BUDGET_MS,
  createMeasureState,
  nextMeasureDecision,
} from '../shared/ui-card/app/src/settle.ts'

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  const shown = ok ? JSON.stringify(actual) : `${JSON.stringify(actual)}（应为 ${JSON.stringify(expected)}）`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}：${shown}`)
  if (!ok) failed++
}

/** 一帧样本；height 与 scroll 差 2（边框）与真机一致，比较的是「这一帧与上一帧是否一致」。 */
const sample = (height) => ({ height, scroll: height - 2 })
const at = (ms) => 1000 + ms

// ① 首帧：只记下来，不报。
{
  const state = createMeasureState(at(0))
  check('首帧不报（还没有上一帧可比）', nextMeasureDecision(state, sample(291), at(16), true), {
    action: 'wait',
  })
}

// ② 两帧一致 → 报，且没有 unstable。
{
  const state = createMeasureState(at(0))
  nextMeasureDecision(state, sample(291), at(0), true)
  check('两帧一致就报（不带 unstable）', nextMeasureDecision(state, sample(291), at(17), true), {
    action: 'post',
    height: 291,
    unstable: null,
  })
}

// ③ 先 271 再 291：变过就继续等，稳定后报 291 —— 这就是 2026-11-12 那次偶发 271 的形状。
{
  const state = createMeasureState(at(0))
  check('第一帧 271 → 等', nextMeasureDecision(state, sample(271), at(0), true), { action: 'wait' })
  check('第二帧变 291 → 继续等', nextMeasureDecision(state, sample(291), at(16), true), { action: 'wait' })
  check('第三帧还是 291 → 报 291', nextMeasureDecision(state, sample(291), at(32), true), {
    action: 'post',
    height: 291,
    unstable: null,
  })
}

// ④ 字体没就绪：即使两帧一致也不报（① 的硬条件）。
{
  const state = createMeasureState(at(0))
  nextMeasureDecision(state, sample(291), at(0), false)
  check('fonts.ready 没到 → 不报', nextMeasureDecision(state, sample(291), at(16), false), {
    action: 'wait',
  })
  check('字体到了、两帧仍一致 → 报', nextMeasureDecision(state, sample(291), at(32), true), {
    action: 'post',
    height: 291,
    unstable: null,
  })
}

// ⑤ 预算到点还在变：按最后一次报，并把两次高度带回去（宿主写 measure-unstable 埋点）。
{
  const state = createMeasureState(at(0))
  nextMeasureDecision(state, sample(271), at(0), true)
  nextMeasureDecision(state, sample(291), at(16), true)
  nextMeasureDecision(state, sample(311), at(32), true)
  const decision = nextMeasureDecision(state, sample(331), at(MEASURE_SETTLE_BUDGET_MS), true)
  check('预算到点：报最后一次', [decision.action, decision.height], ['post', 331])
  check('预算到点：first 是最早变化前的那个高度', decision.unstable?.first, 271)
  check('预算到点：last 是最后报的', decision.unstable?.last, 331)
  check('预算到点：reason', decision.unstable?.reason, 'budget')
  check('预算到点：字体已就绪', decision.unstable?.fontsReady, true)
}

// ⑥ 字体一直不来：预算到点照样报（不许把卡片卡死在这里）。
{
  const state = createMeasureState(at(0))
  nextMeasureDecision(state, sample(291), at(0), false)
  const decision = nextMeasureDecision(state, sample(291), at(MEASURE_SETTLE_BUDGET_MS), false)
  check('字体一直没来：预算到点照样报', [decision.action, decision.height], ['post', 291])
  check('字体一直没来：埋点里标明 fontsReady=false', decision.unstable?.fontsReady, false)
}

// ⑦ 判据里不许有固定等待：等的依据是「两帧一致」，不是「大概够了」。
{
  check('预算是个正数常量', MEASURE_SETTLE_BUDGET_MS > 0, true)
  check('预算不超过宿主等 ready 的 2 秒', MEASURE_SETTLE_BUDGET_MS < 2000, true)
  check('采样间隔是个正数常量', MEASURE_SAMPLE_INTERVAL_MS > 0, true)
  check('采样间隔不超过 50ms（比一帧密，不能被节流成「等一秒」）', MEASURE_SAMPLE_INTERVAL_MS <= 50, true)
  check('采样间隔远小于预算（预算内至少采十几次）', MEASURE_SAMPLE_INTERVAL_MS * 10 < MEASURE_SETTLE_BUDGET_MS, true)
}

// ⑧ 判定与时钟无关：同一串样本，无论采样节奏被拉成什么样，结论都是同一个高度。
//    （2026-11-15 真机：rAF 在不可见窗口里饿死、采样换成 setTimeout；判据本身不许依赖 tick 源。）
{
  const state = createMeasureState(at(0))
  nextMeasureDecision(state, sample(291), at(0), true)
  check('采样间隔被拉长到 900ms，仍报同一高度', nextMeasureDecision(state, sample(291), at(900), true), {
    action: 'post',
    height: 291,
    unstable: null,
  })
  const late = createMeasureState(at(0))
  nextMeasureDecision(late, sample(291), at(0), true)
  check('同一串样本、另一种节奏，高度一致', nextMeasureDecision(late, sample(291), at(16), true)?.height, 291)
  const overBudget = createMeasureState(at(0))
  nextMeasureDecision(overBudget, sample(291), at(0), true)
  check('又稳定又超预算：按「稳定」报（不留无意义埋点）', nextMeasureDecision(overBudget, sample(291), at(5000), true), {
    action: 'post',
    height: 291,
    unstable: null,
  })
}

// ⑨ settle.ts 必须是纯逻辑：不取时间、不排定时器、不碰帧。
//    「判定挂在 rAF 上」正是真机 30/30 全落兜底的根因，见 D-46。
{
  const source = readFileSync(new URL('../shared/ui-card/app/src/settle.ts', import.meta.url), 'utf8')
  for (const forbidden of ['requestAnimationFrame(', 'setTimeout(', 'setInterval(', 'performance.now(', 'Date.now(']) {
    check(`settle.ts 里没有 ${forbidden}`, source.includes(forbidden), false)
  }
}

if (failed > 0) {
  console.error(`\n失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过')
