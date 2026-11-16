#!/usr/bin/env node
/**
 * partialLines 桩测试（tests/probe-partial.mjs）
 *
 * 钉住探针里「露了半截」的算法（shared/ui-card/debug/probe.js 的 measureLines）：
 *   - 修前几何：9 行 × 20px、盒 136、上下内边距 8/8 → overflow 按 padding box 裁，
 *     第 7 行从内容盒下沿起露出 8px，partialLines 必须是 1；
 *   - 修后几何：内边距挪到裁剪盒之外，盒 120、内边距 0 → 第 7 行整行在盒外，partialLines 必须是 0。
 * 两种几何的 visible/total 都必须是 6/9（计数口径没变，DECISIONS D-32 / D-33）。
 *
 * 直接取 probe.js 里 `#region line-geometry` 之间的代码跑，测的是产品里那份实现，
 * 不是在这里另抄一份。
 *
 * 跑法：node tests/probe-partial.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const probePath = join(here, '..', 'shared', 'ui-card', 'debug', 'probe.js')
const source = readFileSync(probePath, 'utf8')

const start = source.indexOf('// #region line-geometry')
const end = source.indexOf('// #endregion line-geometry')
if (start < 0 || end < 0 || end <= start) {
  console.error('FAIL 找不到 probe.js 里的 line-geometry 区块（两份实现必须留这一对标记）')
  process.exit(1)
}
const snippet = source.slice(start, end)
const { mergeLines, measureLines } = new Function(`${snippet}\nreturn { mergeLines, measureLines }`)()

/** 造 count 行、pitch 20 的矩形（高度 = 行高；真实 getClientRects 也是这样）。 */
const rectsFrom = (firstTop, count = 9, pitch = 20) =>
  Array.from({ length: count }, (_, index) => ({
    top: firstTop + index * pitch,
    bottom: firstTop + index * pitch + pitch,
    height: pitch,
  }))

let failed = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  const shown = ok ? JSON.stringify(actual) : `${JSON.stringify(actual)}（应为 ${JSON.stringify(expected)}）`
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}：${shown}`)
  if (!ok) failed++
}

// 修前：盒 136 = 8 + 6×20 + 8，scrollHeight 196 = 8 + 9×20 + 8。
// 内容盒下沿 128，第 7 行从 128 开始、到盒底 136 露 8px —— 这就是「像被切掉上半截」的那一行。
const before = measureLines(mergeLines(rectsFrom(8)), 0, 8, 8, 136, 196)
check('修前 visible', before.visible, 6)
check('修前 total', before.total, 9)
check('修前 partialLines', before.partial, 1)

// 修后：内边距在 .card-code 上，裁剪盒 120、内边距 0，scrollHeight 180。
// 第 7 行从 120 开始，正好在盒外（零面积相交），partialLines 为 0。
const after = measureLines(mergeLines(rectsFrom(0)), 0, 0, 0, 120, 180)
check('修后 visible', after.visible, 6)
check('修后 total', after.total, 9)
check('修后 partialLines', after.partial, 0)

// 归并与排序是顺序无关的（getClientRects 返回的是文档顺序，不是视觉顺序）。
const fragments = [0, 10, 20, 30].map((left) => ({ top: 40, bottom: 60, height: 20, left }))
check('同一行的分片乱序仍归并成一行', mergeLines([fragments[2], fragments[0], fragments[3], fragments[1]]).length, 1)

if (failed > 0) {
  console.error(`\n失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n全部通过')
