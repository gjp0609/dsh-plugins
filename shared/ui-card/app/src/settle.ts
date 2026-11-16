/**
 * 报高前的「布局稳定」判据（D-46）。纯逻辑、不碰 DOM、不碰定时器 —— `tests/settle.mjs` 直接拿它跑假样本。
 *
 * 为什么要有它：宿主只认页面发的**第一条**高度（D-45），所以那一条必须已经是最终值。
 * 而页面在首个被动 effect 里就量高，那时布局未必已经稳定（字体激活、附注条/页脚行盒建立、
 * 代码块折行都可能落在首帧之后）。2026-11-12 的偶发 271 就是「第一条比最终矮 20px」，
 * 20–40ms 后页面自己又量到 291（`resize`），但宿主已经按 271 建完窗了。
 *
 * 判据（两条同时满足才报）：
 *   ① `document.fonts.ready` 已 resolve；
 *   ② 连续两次采样到的样本完全一致（高度与 scrollHeight 都相等）。
 * 只发**一条**消息，不是「先报一个粗的、稳了再补一条」——补第二条就是「两次改窗口」。
 *
 * **采样时钟不在这里，而且不许是 `requestAnimationFrame`**（2026-11-15 真机 30/30 全落兜底换来的）：
 * 宿主是「拿到 ready 才 ShowWindow」，在那之前窗口不可见，WebView2 基本不产帧，rAF 回调会被饿死
 * （真机 trace：页面脚本 t≈2327ms 才等到第一帧，而宿主的 ready 预算只有 2000ms）。
 * 把判定挂在 rAF 上等于把「等布局稳定」绑成「等窗口可见」——锁死。驱动 tick 的必须是定时器
 * （`setTimeout`，见 `MEASURE_SAMPLE_INTERVAL_MS`），判定逻辑本身与时钟无关：它只看样本与时间戳。
 *
 * 预算：一直不一致时最多等到 `MEASURE_SETTLE_BUDGET_MS`（500ms），到点按**最后一次**量到的报，
 * 并把两次不一致的高度带回去（宿主写 `measure-unstable` 埋点）。
 * 不许无限等、不许 sleep 一个固定时长：等的依据是「布局自己不动了」，不是「大概够了」。
 */

/** 等布局自己稳定的硬预算（毫秒）。超过就按最后一次报，并留一条取证。 */
export const MEASURE_SETTLE_BUDGET_MS = 500

/**
 * 采样间隔（毫秒）。用 `setTimeout` 排下一次采样，**不用 `requestAnimationFrame`**（见文件头）。
 * 16ms ≈ 一帧的节奏，不是「等 16ms 就够」——一致性仍由两个样本本身判定。
 */
export const MEASURE_SAMPLE_INTERVAL_MS = 16

/** 一帧量到的样本：报出去的高度 + `#root.scrollHeight`（后者能发现「内容比盒子高」这种不稳）。 */
export type MeasureSample = { height: number; scroll: number }

/** 预算到点时带回去的取证：哪两次高度不一样、字体到底有没有到位、采样了几次。 */
export type MeasureUnstable = {
  /** 最早一次「变了之后离开」的那个高度（第一次发现不一致时，前一帧的高度）。 */
  first: number
  /** 最后真的报出去的高度。 */
  last: number
  reason: 'budget'
  /** 预算到点时字体是否已就绪；false 说明是「字体一直没来」触发的兜底。 */
  fontsReady: boolean
  /** 采样次数（字段名沿用 frames：埋点格式已定，别改键名）。 */
  frames: number
}

/** 状态机：每采一次调一次 `nextMeasureDecision`，就地更新。 */
export type MeasureState = {
  startedAt: number
  previous: MeasureSample | null
  /** 第一次量到的高度（还没观察到任何变化时，`unstable.first` 用它）。 */
  firstHeight: number
  /** 第一次发现「与前一帧不一致」时，前一帧的高度。 */
  changedFrom: number | null
  frames: number
}

export type MeasureDecision =
  | { action: 'wait' }
  | { action: 'post'; height: number; unstable: MeasureUnstable | null }

export function createMeasureState(startedAt: number): MeasureState {
  return { startedAt, previous: null, firstHeight: 0, changedFrom: null, frames: 0 }
}

const sameSample = (a: MeasureSample, b: MeasureSample): boolean => a.height === b.height && a.scroll === b.scroll

/**
 * 这一次采样要不要报高。就地更新 `state`（调用方按顺序一次一次调，不并发）。
 *
 * 与时钟无关：调用方传 `now`，本函数不自己取时间（所以换成 `setTimeout`、rAF、甚至测试里的假时钟，
 * 判定行为完全一致——`tests/settle.mjs` 就是拿假时间戳跑的）。
 *
 * @param state      createMeasureState 建的状态
 * @param sample     这一次量到的样本
 * @param now        当前时间戳（与 state.startedAt 同源，由调用方取；本函数自己不取时间）
 * @param fontsReady `document.fonts.ready` 是否已 resolve
 * @param budgetMs   硬预算，默认 MEASURE_SETTLE_BUDGET_MS
 */
export function nextMeasureDecision(
  state: MeasureState,
  sample: MeasureSample,
  now: number,
  fontsReady: boolean,
  budgetMs: number = MEASURE_SETTLE_BUDGET_MS,
): MeasureDecision {
  state.frames += 1

  // 第一帧只记下来：没有「上一帧」就谈不上「两帧一致」。
  if (state.previous === null) {
    state.previous = sample
    state.firstHeight = sample.height
    return { action: 'wait' }
  }

  const previous = state.previous
  const stable = sameSample(previous, sample)
  if (!stable && state.changedFrom === null) state.changedFrom = previous.height
  state.previous = sample

  // ① 字体到位 ② 与前一次采样完全一致 —— 两个都满足才算稳定，只报这一次。
  if (fontsReady && stable) return { action: 'post', height: sample.height, unstable: null }

  // 预算到点：按最后一次报，把「哪两次不一样」带回去（宿主写 measure-unstable）。
  // 排在稳定判定之后：同一帧里既稳定又超预算时，按「稳定」报，不留无意义的埋点。
  if (now - state.startedAt >= budgetMs) {
    return {
      action: 'post',
      height: sample.height,
      unstable: {
        first: state.changedFrom ?? state.firstHeight,
        last: sample.height,
        reason: 'budget',
        fontsReady,
        frames: state.frames,
      },
    }
  }

  return { action: 'wait' }
}
