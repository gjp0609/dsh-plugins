import type { CardPayload } from './types'
import { approvalFixture } from './fixtures/approval'
import { selectFixture } from './fixtures/select'

/** 开发态样例（`npm run dev` 时用 `?fixture=approval|select` 切）。 */
const fixtures: Record<string, CardPayload> = {
  approval: approvalFixture,
  select: selectFixture,
}

export const fixtureNames = Object.keys(fixtures)

/**
 * 载荷只有一个来源：正式路径读页面里的 `#dsh-payload`（宿主只替换那个标签），
 * 开发态读 `?fixture=` 选中的样例。
 */
export function readPayload(): CardPayload {
  const name = new URLSearchParams(window.location.search).get('fixture')
  if (name) {
    const fixture = fixtures[name]
    if (!fixture) {
      return {
        eyebrow: '开发态样例',
        body: [{ kind: 'note', text: `没有这个样例：${name}。可选：${fixtureNames.join(' / ')}` }],
      }
    }
    return fixture
  }

  const node = document.getElementById('dsh-payload')
  const raw = (node?.textContent ?? '').trim()
  if (!raw) return { eyebrow: '开发态样例', body: [{ kind: 'note', text: '（没有载荷）', muted: true }] }
  try {
    return JSON.parse(raw) as CardPayload
  } catch {
    return { eyebrow: '开发态样例', body: [{ kind: 'note', text: '载荷不是合法 JSON' }] }
  }
}
