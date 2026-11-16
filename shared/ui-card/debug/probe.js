/**
 * 代码框探针（shared/ui-card/debug/render.ps1 -Probe 用）
 *
 * 在页面里跑，返回一个 JSON 对象，由 render.ps1 写进 <名字>.measure.json 的 `probe` 字段。
 * 只读：`getBoundingClientRect()` + `getComputedStyle()`，**不截图、不取色**。
 * 取色器会把子像素抗锯齿混出来的颜色当成真色（`#067D17` 被读成 `#2C8365` 就是这么来的，
 * 见 DECISIONS D-31 附录 B.5），所以颜色只从计算样式读。
 *
 * 返回结构（与派活口径一致，多的字段是给「不占流 / 按钮几何」用的证据）：
 *   block   ：**可视代码框**（外层 .card-code，带内边距与底色）的几何 + 内边距 + （隐藏按钮组后的）offsetHeight
 *   body    ：**裁剪层**（[data-part="code"] / [data-part="row-code"]，限高 + overflow）的几何与滚动量
 *   buttons ：按钮组几何 / 默认显隐 / 按钮是否只有图标 / **count（= items 个数）** /
 *             每个按钮的尺寸与图标尺寸 / **top 与 right**（相对代码框上沿/右沿，折叠与展开都必须 6/6）
 *   gap     ：控件组相对代码框的 top/right 偏移（与 buttons.top/right 同源同值，T-01 按这个名字核）
 *   state   ：折叠态、渲染行数（visible/total/**partial**）、**overflowY**、**peekPx**
 *             （**行盒口径**：130 − 6×20 = 10，不是字形带）、whiteSpace、滚动宽
 *   colors  ：注释 / 字符串 / 关键字 / 数字 / 命令 / **变量 / 类型 / 操作符** / 裸参数 / 默认正文
 *             的计算色 + **fontWeight**（三类新色位是方案 B，D-34；载荷里没有该 token 就进 colorsMissing）
 *   trace   ：量高时间线（render.ps1 -Probe 会先注入 debug\trace.js 才有值，否则 null）：
 *             页面每次 postMessage 时的 #root 高度 + 界面高度变化的那几帧 —— 用来看「报 ready 那一刻多高」
 *   layout  ：量高复核：fill 态每一层盒子的 rect/scrollHeight/clientHeight（谁被裁），再把 data-phase
 *             临时切回 measure 量一遍**自然高度**；`underReportedPx = 自然高度 − 报出去的高度`
 *
 * 为什么 block 与 body 分开量：折叠态的内边距在 .card-code 上（DECISIONS D-33），
 * 裁剪盒自己没有内边距——「露半行」正是内边距留在裁剪盒上造成的。所以「盒子多高、留白多少」
 * 看 block，「内容排到哪、裁在哪」看 body；`state.partialLines` / `state.peekPx` 用 body 的裁剪几何算。
 *
 * 探针自己抛异常时返回 { error }，不让一次测量失败变成一次渲染失败。
 */
(() => {
  const result = { block: null, body: null, buttons: null, gap: null, state: null, colors: [], colorsMissing: [], trace: null, layout: null }

  try {
    const round = (value) => Math.round(value * 100) / 100
    const styleOf = (element) => getComputedStyle(element)
    const px = (value) => round(Number.parseFloat(value) || 0)

    // ---- 量高时间线（debug\trace.js 由 render.ps1 注入到 <head>，跑在页面脚本之前）----
    // 只压成「高度发生变化的帧」，否则每帧一条会把 measure.json 撑到几十 KB。
    try {
      const raw = window.__dshTrace
      if (raw) {
        const frames = []
        let last = null
        for (const frame of raw.frames || []) {
          const signature = [frame.root, frame.code, frame.strip, frame.footerTop, frame.phase].join('|')
          if (signature !== last) {
            frames.push(frame)
            last = signature
          }
        }
        result.trace = {
          t0: raw.t0,
          wrapped: raw.wrapped === true,
          wrapFailed: raw.wrapFailed === true,
          frames,
          messages: raw.messages || [],
        }
      }
    } catch (error) {
      result.trace = { error: String(error) }
    }

    // 正文代码框优先；勾选卡那种只有行内命令框的卡退到行内框（同一套控件与折叠）。
    // `body` 是**裁剪层**（限高 + overflow），`shell` 是外面那层可视代码框（内边距 + 底色）。
    const body = document.querySelector('[data-part="code"]') || document.querySelector('[data-part="row-code"]')
    if (!body) {
      result.error = '页面里找不到代码框（[data-part="code"] / [data-part="row-code"]）'
      return result
    }
    const shell = body.closest('.card-code') || body.parentElement
    const shellRect = shell.getBoundingClientRect()
    const bodyRect = body.getBoundingClientRect()

    // ---- 渲染行几何（纯函数，不碰 DOM）----
    // 折叠态是折行的，一条长命令会排成很多行；split('\n') 会把它当成 1 行。
    // 两条都是 2026-10-30 真机量出来的坑：
    //   ① **先排序再归并**。getClientRects() 的顺序跟着 DOM 走（外层 span 的分片会排在内层 token
    //      之后），只跟「上一行」比会凭空多出行来——实测 9 行报 11、3 行报 5（正好各多 2）；
    //   ② 判定「可见」要**整行都在内容盒里**（比较 bottom）。只比 top 会把只露出 5px 的那一行
    //      也算成可见——实测第 7 行露了 5px，被算成了整行。
    // 2026-10-30 起 app 侧的行数测量（measure.ts / countCodeLines）已随计数 chip 一起删除（D-34），
    // 这一段是**唯一**实现；桩测试 tests/probe-partial.mjs 直接取 `#region` 之间的代码跑。
    // #region line-geometry
    /** 同一行的多个矩形 top 会完全相等；容差只防亚像素抖动。 */
    const LINE_TOP_TOLERANCE = 2

    /** 把 getClientRects() 的结果归并成「渲染行」：顺序无关，先按 top 排序再合并。 */
    const mergeLines = (rects) => {
      const ordered = Array.from(rects)
        .filter((rect) => rect.height > 0)
        .sort((a, b) => a.top - b.top)
      const lines = []
      for (const rect of ordered) {
        const last = lines[lines.length - 1]
        if (last === undefined || Math.abs(rect.top - last.top) > LINE_TOP_TOLERANCE) {
          lines.push({ top: rect.top, bottom: rect.bottom })
        } else {
          last.top = Math.min(last.top, rect.top)
          last.bottom = Math.max(last.bottom, rect.bottom)
        }
      }
      return lines
    }

    /**
     * visible / total / partial / peek：
     *   - visible：**整行**落在内容盒内（半行被裁＝看不见，不能算）；
     *   - partial：与裁剪盒（padding box，overflow 就裁在这）有正面积相交、但没有整行落进
     *     内容盒的行——就是「只露出来一截的那种行」。折叠态**故意**露 10px（D-34），所以为 1；
     *     展开态不折行且可双向滚，为 0。
     *   - peek：折叠态最后一行**行盒**下方剩余的可视高度 = 内容盒高 − 完整可见行数 × 行距。
     *     口径说明：这是**行盒**口径（130 − 6×20 = 10），不是「可见字形带」——`getClientRects()`
     *     返回的行内盒比行高矮（实测底边只到 138，字形带量出来是 8），那是字体内容区，不是排版行框。
     *     行距取首末行 top 的平均间距（行高固定 20，折行不会变），不依赖某一行的小数位置。
     */
    const measureLines = (lines, boxTop, paddingTop, paddingBottom, clientHeight, scrollHeight) => {
      const contentTop = boxTop + paddingTop
      const contentHeight = clientHeight - paddingTop - paddingBottom
      const contentBottom = contentTop + contentHeight
      // overflow 按 padding box 裁：裁剪下沿是 boxTop + clientHeight（不含边框，卡片里没有边框）。
      const clipBottom = boxTop + clientHeight
      // 没有溢出时内容盒装得下全部行，不必逐行判（末行的下缘描边/降部可能压线，会误判成 3/5）。
      const clipped = scrollHeight - clientHeight > 1
      let visible = 0
      let partial = 0
      for (const line of lines) {
        const fullyVisible = !clipped || (line.top >= contentTop - 0.5 && line.bottom <= contentBottom + 0.5)
        if (fullyVisible) {
          visible++
        } else if (line.bottom > boxTop + 0.5 && line.top < clipBottom - 0.5) {
          partial++
        }
      }
      // 行距：首末行 top 的差 ÷ 间隔数；只有一行时无行距可言。
      const pitch = lines.length > 1 ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1) : 0
      // 行盒口径的「露出来多少」：完整行排完之后，内容盒底下剩下的那一条。
      // 展开态（不折叠/不裁）不报 peek，由调用方按 collapsed 记 0。
      const peek = clipped && pitch > 0 ? Math.max(0, contentHeight - visible * pitch) : 0
      // 保留两位小数（区间是纯函数，不能引用 region 外面的 round——桩测试只取这一段跑）。
      return { visible, total: lines.length, partial, peek: Math.round(peek * 100) / 100 }
    }
    // #endregion line-geometry

    const countLines = (element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const style = styleOf(element)
      const box = element.getBoundingClientRect()
      return measureLines(
        mergeLines(range.getClientRects()),
        box.top,
        px(style.paddingTop),
        px(style.paddingBottom),
        element.clientHeight,
        element.scrollHeight,
      )
    }

    const shellStyle = styleOf(shell)
    const bodyStyle = styleOf(body)
    // 有效右留白：正文真正能写到哪（正文右沿 = 可视代码框右沿 - 它的右内边距；
    // 行内命令框的右内边距在裁剪层自己身上，取两者更靠里的那个，两边都成立）。
    const shellContentRight = shellRect.right - px(shellStyle.paddingRight)
    const bodyContentRight = bodyRect.right - px(bodyStyle.paddingRight)
    const contentRight = round(Math.min(shellContentRight, bodyContentRight))

    result.block = {
      x: round(shellRect.left),
      y: round(shellRect.top),
      width: round(shellRect.width),
      height: round(shellRect.height),
      offsetHeight: shell.offsetHeight,
      // 有效右留白 = 盒右沿 - 正文右沿（正文右侧留出的那一截）。
      paddingRight: round(shellRect.right - contentRight),
      paddingLeft: px(shellStyle.paddingLeft),
      paddingTop: px(shellStyle.paddingTop),
      paddingBottom: px(shellStyle.paddingBottom),
      clientWidth: shell.clientWidth,
      clientHeight: shell.clientHeight,
      scrollWidth: shell.scrollWidth,
      scrollHeight: shell.scrollHeight,
    }

    result.body = {
      x: round(bodyRect.left),
      y: round(bodyRect.top),
      width: round(bodyRect.width),
      height: round(bodyRect.height),
      offsetHeight: body.offsetHeight,
      clientWidth: body.clientWidth,
      clientHeight: body.clientHeight,
      scrollWidth: body.scrollWidth,
      scrollHeight: body.scrollHeight,
      paddingTop: px(bodyStyle.paddingTop),
      paddingBottom: px(bodyStyle.paddingBottom),
      paddingLeft: px(bodyStyle.paddingLeft),
      paddingRight: px(bodyStyle.paddingRight),
      whiteSpace: bodyStyle.whiteSpace,
      overflow: bodyStyle.overflow,
    }

    // 按钮组（计数 chip 已按用户要求删除，D-34）：几何、显隐、每个按钮的尺寸。
    const tools = shell ? shell.querySelector('.card-code-tools') : null

    // 「不占流」的证据：把按钮组临时隐藏再量一次 offsetHeight。相等就说明它不参与排版。
    if (tools) {
      const previousDisplay = tools.style.display
      tools.style.display = 'none'
      result.block.offsetHeightWithoutTools = shell.offsetHeight
      tools.style.display = previousDisplay
      result.block.toolsDontAffectHeight = result.block.offsetHeightWithoutTools === result.block.offsetHeight
    }

    if (tools) {
      const toolsRect = tools.getBoundingClientRect()
      const toolsStyle = styleOf(tools)
      const buttonElements = Array.from(tools.querySelectorAll('button'))
      const textContentOf = (element) => (element.textContent || '').replace(/\s+/g, '')

      const items = buttonElements.map((button) => {
        const rect = button.getBoundingClientRect()
        const icon = button.querySelector('svg')
        const iconRect = icon ? icon.getBoundingClientRect() : null
        return {
          x: round(rect.left),
          y: round(rect.top),
          width: round(rect.width),
          height: round(rect.height),
          iconWidth: iconRect ? round(iconRect.width) : null,
          iconHeight: iconRect ? round(iconRect.height) : null,
          hasText: textContentOf(button) !== '',
        }
      })

      result.buttons = {
        x: round(toolsRect.left),
        y: round(toolsRect.top),
        width: round(toolsRect.width),
        height: round(toolsRect.height),
        // 相对代码框的上沿 / 右沿：折叠态与展开态都必须 6/6（用户真机看到过「按钮位置会变化」）。
        // 位置由 styles.css 钉死（absolute top:6 right:6），不跟任何内容或别的控件走（D-34）。
        top: round(toolsRect.top - shellRect.top),
        right: round(shellRect.right - toolsRect.right),
        // 显隐：默认 opacity 0 + pointer-events: none（B-29），悬停才显。
        opacity: toolsStyle.opacity,
        pointerEvents: toolsStyle.pointerEvents,
        // 只看按钮里有没有文字（图标按钮的文字为空，无障碍名在 aria-label）。
        hasText: items.some((item) => item.hasText),
        // 按钮个数：与 items.length 必须一致（曾经这里残留过 chip 时代的 count，报出 1 而实际 2 个）。
        count: items.length,
        gap: px(toolsStyle.columnGap || toolsStyle.gap),
        gapBetween: buttonElements.length > 1
          ? round(buttonElements[1].getBoundingClientRect().left - buttonElements[0].getBoundingClientRect().right)
          : null,
        items,
      }

      // 控件组相对代码框的偏移（T-01 的证据就是这两个数）：折叠态与展开态都必须 6/6。
      // 与 buttons.top/right 同源、同值；保留 `gap` 是因为断言与历史记录都按这个名字读。
      result.gap = {
        top: round(toolsRect.top - shellRect.top),
        right: round(shellRect.right - toolsRect.right),
      }
    }

    const lines = countLines(body)
    // 「露一点下一行」是折叠态专有的提示：只有折行 + 6 行的框才这么裁。展开态是正常滚动，
    // peek 一律记 0（否则展开一个长块也会报出 10，读数字的人会以为展开态也露了半行）。
    const collapsed = bodyStyle.whiteSpace === 'pre-wrap'
    result.state = {
      collapsed,
      visibleLines: lines.visible,
      totalLines: lines.total,
      // 与裁剪盒相交、但没有整行落进内容盒的行数：折叠态**故意**露 10px（D-34），所以是 1。
      partialLines: lines.partial,
      // 折叠态露出来多少：**行盒口径** = 内容盒高 130 − 6 个完整行 × 行距 20 = 10，展开态固定 0。
      // 不要按字形带（`getClientRects()` 的行内盒）读：那样量到 8，是字体内容区不是排版行框。
      peekPx: collapsed ? lines.peek : 0,
      whiteSpace: bodyStyle.whiteSpace,
      overflowY: bodyStyle.overflowY,
      overflow: bodyStyle.overflow,
      scrollWidth: body.scrollWidth,
      clientWidth: body.clientWidth,
    }

    // ---- 配色：按 token 变量名分类，颜色读计算样式 ----
    const spans = Array.from(body.querySelectorAll('span'))
    // 一个 span 就是一个语法 token（Shiki 按 token 切 span），所以「整段文字」才是它的身份。
    const tokenText = (span) => (span.textContent || '').replace(/\s+/g, ' ').trim()
    // 注释行是 App 单独渲染的（`# 说明`），文字以 # 开头；采样一律跳过，别把它当成命令里的裸参数。
    const isCommentSpan = (span) => tokenText(span).startsWith('#')
    const seenLabels = new Set()
    const push = (label, text, element) => {
      const trimmed = (text || '').replace(/\s+/g, ' ').trim()
      const style = styleOf(element)
      result.colors.push({
        label,
        text: trimmed.length > 40 ? trimmed.slice(0, 40) + '…' : trimmed,
        color: style.color,
        // 关键词必须加粗（用户要求「关键词：加粗 #0033B3」），其余类别必须 400——字重也是配色的一部分。
        fontWeight: style.fontWeight,
        // 变量名能让「这是哪一档」不靠猜；注释是直接写死的十六进制，所以这里可能是 rgb(...)。
        token: element.style.color || null,
      })
    }
    const pushOnce = (label, text, element) => {
      if (seenLabels.has(label)) return
      seenLabels.add(label)
      push(label, text, element)
    }

    for (const span of spans) {
      const text = tokenText(span)
      if (text === '') continue
      const token = span.style.color || ''
      if (isCommentSpan(span) || token.includes('comment')) pushOnce('comment', text, span)
      else if (token.includes('string')) pushOnce('string', text, span)
      else if (token.includes('keyword')) pushOnce('keyword', text, span)
      else if (token.includes('constant')) pushOnce('number', text, span)
      // 命令（cmdlet 与外部命令）走 --shiki-token-function：两种语言统一 #1750EB，与数字同色（D-34）。
      else if (token.includes('function')) pushOnce('command', text, span)
      // 方案 B 的三档（D-34）：变量 / 类型 / 操作符，各有自己的变量名，不能混进正文色统计。
      else if (token.includes('token-variable')) pushOnce('variable', text, span)
      else if (token.includes('token-type')) pushOnce('type', text, span)
      else if (token.includes('token-operator')) pushOnce('operator', text, span)
      else if (token.includes('foreground')) pushOnce('plain', text, span)
    }

    // 裸参数（B-30 的回归点）：这几个是历史上被涂成字符串色的东西，必须逐字找出来量。
    // 判据是「某个 token 整段文字正好是目标」，不是「某段文字里出现过目标」：
    // 注释里也有 `/`、`-`，按文本找会采到注释色（2026-10-30 实测三个 bare-arg 里有一个采成了 rgb(140,140,140)）。
    // 找不到就进 colorsMissing，不糊一个「差不多的」样本上去。
    // 数字不再当裸参数采样：用户要求数字是蓝色（#1750EB），数字由 number 类别单独量（D-34）。
    const tokenSpans = spans.filter((span) => !isCommentSpan(span) && tokenText(span) !== '')
    for (const target of ['-h', '/', '-type']) {
      const match = tokenSpans.find((span) => tokenText(span) === target)
      if (match) push('bare-arg', tokenText(match), match)
      else result.colorsMissing.push(target)
    }

    for (const label of ['comment', 'string', 'keyword', 'number', 'command', 'plain']) {
      if (!seenLabels.has(label)) result.colorsMissing.push(label)
    }
    if (!seenLabels.has('plain')) {
      // 没有独立的「正文」span 时，代码框自己的计算色就是默认正文色。
      const plainStyle = styleOf(body)
      result.colors.push({
        label: 'plain',
        text: (body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        color: plainStyle.color,
        fontWeight: plainStyle.fontWeight,
        token: null,
      })
    }
    // ---- 量高复核（R-24 收尾：271 / 291 两个稳定态差 20px 到底在哪一块）----
    //
    // 宿主只认页面**第一次**报的 ready.height，后面再变也不改窗口；所以只要「报的时候比最终布局矮」
    // 就会永久矮一截，内容被 flex 压缩裁掉（运行截图里 `超时 20s` 只剩上半截）。
    // 要分清两种原因，必须在页内**同时**量三样东西：
    //   ① 此刻（fill，窗口已定）每一层盒子的 rect / scrollHeight / clientHeight —— 谁被裁了；
    //   ② 把 html 的 data-phase 临时切回 measure（= 页面自己量高时的那套 CSS 规则：height:auto），
    //      再量一次同一串盒子 —— **自然高度**，也就是「现在重新量会报多少」；
    //   ③ contentHeight 报过的那个数（render.ps1 已经记在 result.contentHeight 里）。
    // ② == ③ → DOM 一直这么矮，问题在布局；② > ③ → 报早了，问题在时机。
    // 切换与切回在同一次任务里完成，中间不产生绘制、也不影响截图。
    const describeBlock = (element, label) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      const style = styleOf(element)
      return {
        label,
        tag: element.tagName.toLowerCase(),
        part: element.getAttribute('data-part'),
        cls: typeof element.className === 'string' ? element.className : '',
        top: round(rect.top),
        height: round(rect.height),
        bottom: round(rect.bottom),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        // > 0 = 这一层自己的内容放不下（被 overflow 裁了或被 flex 压扁了）。
        clipped: element.scrollHeight - element.clientHeight,
        style: {
          display: style.display,
          flex: style.flex,
          paddingTop: style.paddingTop,
          paddingBottom: style.paddingBottom,
          gap: style.gap,
          rowGap: style.rowGap,
          height: style.height,
          maxHeight: style.maxHeight,
          minHeight: style.minHeight,
          overflowY: style.overflowY,
          lineHeight: style.lineHeight,
          fontSize: style.fontSize,
        },
      }
    }
    // 从 #root 一路到底：每层的父子关系就是「谁把高度吃掉」的账本，不挑选择器，避免漏层。
    const chainTo = (element) => {
      const chain = []
      let node = element
      while (node && node !== document.body && node !== document.documentElement) {
        chain.unshift(node)
        node = node.parentElement
      }
      return chain
    }
    const layout = {
      phase: document.documentElement.dataset.phase || null,
      fonts: document.fonts ? document.fonts.status : 'n/a',
      viewport: { width: window.innerWidth, height: window.innerHeight },
      codeChain: [],
      headerChain: [],
      footerChain: [],
      fill: null,
      natural: null,
      error: null,
    }
    try {
      const root = document.getElementById('root')
      const strip = shell
        ? Array.from(shell.children).filter((node) => !node.hasAttribute('data-part') && !node.classList.contains('card-code-tools')).pop() || null
        : null
      const footer = root && root.firstElementChild ? root.firstElementChild.lastElementChild : null
      const primary = footer ? Array.from(footer.querySelectorAll('button')).pop() || null : null
      const card = root ? root.firstElementChild : null

      const samples = (phase) => {
        document.documentElement.dataset.phase = phase
        // 读一次几何就强制一次布局，切完必须立刻量，中间不许再改 DOM。
        const rootRect = root.getBoundingClientRect()
        return {
          rootHeight: round(rootRect.height),
          rootScrollHeight: root.scrollHeight,
          rootClientHeight: root.clientHeight,
          contentHeight: Math.ceil(rootRect.height),
          cards: card ? [describeBlock(card, 'card')] : [],
          header: [
            describeBlock(document.querySelector('[data-part="eyebrow"]'), 'eyebrow'),
            describeBlock(document.querySelector('[data-part="title"]'), 'title'),
          ].filter(Boolean),
          code: chainTo(strip).map((node, index) => {
            const label = index === 0 ? 'root' : node.className ? String(node.className).split(' ')[0] : node.tagName.toLowerCase()
            return describeBlock(node, node === strip ? 'meta-strip' : label)
          }),
          footer: chainTo(primary).map((node) => describeBlock(node, node === primary ? 'primary-button' : node.tagName.toLowerCase())),
          docScrollHeight: document.documentElement.scrollHeight,
          docClientHeight: document.documentElement.clientHeight,
        }
      }

      layout.fill = samples('fill')
      layout.natural = samples('measure')
      layout.codeChain = layout.fill.code
      layout.headerChain = layout.fill.header
      layout.footerChain = layout.fill.footer
      layout.cards = layout.fill.cards
      // 切回 fill：截图与后续量测必须还在原相位上。
      document.documentElement.dataset.phase = 'fill'
      // 账本：自然高度 − 报出去的高度 = 少报了多少；负数说明报多了（那是钳制或取整，另说）。
      layout.underReportedPx = layout.natural.contentHeight - layout.fill.contentHeight
    } catch (error) {
      layout.error = String((error && error.stack) || error)
      document.documentElement.dataset.phase = 'fill'
    }
    result.layout = layout
  } catch (error) {
    result.error = String((error && error.stack) || error)
  }

  return result
})()
