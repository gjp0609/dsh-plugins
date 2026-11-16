/**
 * 页面 ↔ 宿主的唯一通道。宿主是 PowerShell 的 WebView2（window.chrome.webview）。
 *
 * 两阶段协议：
 *   页面 → 宿主  ready{height}   首次渲染完成（measure 阶段，不限高）；等布局稳定后才发，只发一条（D-46）
 *   宿主 → 页面  shown           窗口已按钳过的尺寸显示出来
 *   页面 → 宿主  resize{height}  只在 measure 阶段报（窗口还没定高）
 *   页面 → 宿主  decision / cancel / expired   终态，只发一次
 *   页面 → 宿主  copy{text}      复制一段文本：页面不是 secure context，拿不到异步剪贴板 API
 *   宿主 → 页面  copied{ok}      剪贴板写完（或失败）的回执；800ms 不到按失败显示
 *   页面 → 宿主  drag            按下标题：宿主 ReleaseCapture 后发 WM_NCLBUTTONDOWN/HTCAPTION，
 *                                进入系统移动循环（窗口自己挪，页面不参与）
 */
// 量高稳定判据的类型只在 ready 消息里用得到，从 settle.ts 引（值本身在 App.tsx 里兜）。
import type { MeasureUnstable } from './settle'

export type HostMessage =
  | {
      type: 'ready'
      height: number
      /**
       * 只在「等布局稳定的预算到点」时出现（D-46）：页面按最后一次量到的高度报，
       * 顺手把两次不一致的高度交上去，宿主只写一行 `measure-unstable` 埋点，不改变接管流程。
       */
      unstable?: MeasureUnstable
    }
  | { type: 'resize'; height: number }
  | {
      type: 'decision'
      value: string
      checked?: boolean[]
    }
  | { type: 'cancel' }
  | { type: 'expired' }
  | { type: 'copy'; text: string }
  | { type: 'drag' }

export type PageMessage = { type: 'shown' } | { type: 'copied'; ok: boolean }

interface WebViewHost {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

function host(): WebViewHost | null {
  const bridge = (window as unknown as { chrome?: { webview?: WebViewHost } }).chrome?.webview
  return bridge ?? null
}

/** 在 WebView2 里跑？浏览器里（npm run dev）没有宿主，开发态自己模拟 shown。 */
export function isEmbedded(): boolean {
  return host() !== null
}

export function postToHost(message: HostMessage): void {
  host()?.postMessage(message)
}

/** 返回退订函数：组件卸载时摘掉监听，避免热更新叠出多份。 */
export function onHostMessage(listener: (message: PageMessage) => void): () => void {
  const bridge = host()
  if (!bridge) return () => {}
  const handler = (event: { data: unknown }) => {
    const data = event.data as PageMessage | undefined
    if (data && typeof data === 'object' && typeof data.type === 'string') listener(data)
  }
  bridge.addEventListener('message', handler)
  return () => bridge.removeEventListener('message', handler)
}

/** 内容高度：measure 阶段用 documentElement，卡片是唯一子元素。 */
export function contentHeight(): number {
  const root = document.getElementById('root')
  const element = root ?? document.documentElement
  return Math.ceil(element.getBoundingClientRect().height)
}
