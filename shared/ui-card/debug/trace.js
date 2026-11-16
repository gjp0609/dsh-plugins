/**
 * 量高时间线（shared/ui-card/debug/trace.js）
 *
 * 只由 `debug\render.ps1 -Probe` 注入到文档 <head>，**不在产物里**（dist/index.html 半行都不碰）。
 * 它跑在页面脚本之前，所以能看见「页面自己量高的那一刻」：
 *
 *   messages：包住 window.chrome.webview.postMessage，每次发消息时记下 type/height/当时的 #root 高度。
 *             包装**同步**装在文档开始处，不等 rAF——第一版放在 rAF 里，ready 比第一帧还早，
 *             结果每条记录都是 resize、`ready` 一条都没记到（2026-11-12 踩过，别改回去）。
 *   frames  ：每帧记一次分块高度（#root / 代码框 / 附注条 / 页脚顶），只用来找「哪一块什么时候变的」。
 *
 * 只读几何（getBoundingClientRect），不改 DOM、不发消息、不影响布局。
 * 一次性：window.__dshTrace 只建一个，重复注入不会叠出两份。
 */
(() => {
  if (window.__dshTrace) return
  const trace = { t0: 0, frames: [], messages: [], wrapped: false }
  window.__dshTrace = trace

  const round = (value) => Math.round(value * 100) / 100
  const rectHeight = (element) => (element ? round(element.getBoundingClientRect().height) : null)
  const rootElement = () => document.getElementById('root')
  const codeElement = () => document.querySelector('[data-part="code"]') || document.querySelector('[data-part="row-code"]')
  const shellElement = () => {
    const body = codeElement()
    return body ? body.closest('.card-code') || body.parentElement : null
  }
  // 附注条（`超时 20s` 那一行）= 代码框里最后一个既不是 data-part、也不是工具组的子节点。
  const stripElement = () => {
    const shell = shellElement()
    if (!shell) return null
    const children = Array.from(shell.children).filter(
      (node) => !node.hasAttribute('data-part') && !node.classList.contains('card-code-tools'),
    )
    return children.length > 0 ? children[children.length - 1] : null
  }
  const footerTop = () => {
    const root = rootElement()
    const card = root ? root.firstElementChild : null
    const footer = card ? card.lastElementChild : null
    return footer ? round(footer.getBoundingClientRect().top) : null
  }
  const phase = () => document.documentElement.dataset.phase || null

  const capture = () => ({
    t: Math.round(performance.now()),
    root: rectHeight(rootElement()),
    code: rectHeight(codeElement()),
    strip: rectHeight(stripElement()),
    footerTop: footerTop(),
    phase: phase(),
  })

  // window.chrome.webview 在文档开始时通常已经挂上；万一没有，微任务里再试（不能等 rAF：
  // 页面的 ready 在首个被动 effect 里就发了，比第一帧早）。最多试 200 次，之后放弃并在 trace 里留痕。
  const wrap = (attempt = 0) => {
    if (trace.wrapped) return
    const bridge = window.chrome && window.chrome.webview
    if (!bridge || typeof bridge.postMessage !== 'function') {
      if (attempt < 200) queueMicrotask(() => wrap(attempt + 1))
      else trace.wrapFailed = true
      return
    }
    const original = bridge.postMessage.bind(bridge)
    bridge.postMessage = (message) => {
      if (trace.messages.length < 40) {
        const snapshot = capture()
        trace.messages.push({
          t: snapshot.t,
          type: message && message.type,
          height: message && message.height,
          rootHeight: snapshot.root,
          code: snapshot.code,
          strip: snapshot.strip,
          phase: snapshot.phase,
        })
      }
      return original(message)
    }
    trace.wrapped = true
  }
  wrap()

  trace.t0 = round(performance.now())
  let ticks = 0
  const tick = () => {
    if (trace.frames.length < 400) trace.frames.push(capture())
    if (++ticks < 400) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()
