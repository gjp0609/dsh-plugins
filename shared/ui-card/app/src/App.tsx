import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Button, Checkbox, Flex, Typography, theme } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import type { CardButton, CardPayload } from './types'
import { contentHeight, isEmbedded, onHostMessage, postToHost } from './bridge'
import type { HostMessage } from './bridge'
import { CodeText } from './CodeText'
import { commentSource } from './highlight'
import { codeLang } from './codeLang'
import { CodeTools } from './CodeTools'
import { commandOnly } from './commandText'
import { MEASURE_SAMPLE_INTERVAL_MS, createMeasureState, nextMeasureDecision } from './settle'

const { Text } = Typography

type Phase = 'measure' | 'fill'

/** 折叠态显示几行（B-28 默认值：6 行，超出才出「展开」）。 */
const FOLD_LINES = 6
/**
 * 代码行高（px）。写死不是为了好看：折叠高度要精确等于「6 行」，
 * 就必须让 1 行 = 一个整数像素，否则第 7 行会露出半行。
 * 代价是每行比 antd 的 1.5714 倍行高（约 19.64px）高 0.36px，整卡高 1~4px。
 */
const CODE_LINE_HEIGHT = 20
/**
 * 代码框的上下内边距合计。**它在 `.card-code` 外层上，不在裁剪盒上**：
 * `overflow` 是按 padding box 裁的，内边距若留在裁剪盒上，折叠时第 7 行会从
 * 底部内边距里露出半截（2026-10-30 实测露 5px，像渲染坏了）。见 DECISIONS D-33。
 */
const CODE_PADDING_Y = 8
/**
 * 代码框右侧内边距（B-29）：右上角 6px 偏移 + 两个 20px 按钮 + 4px 间隔 ≈ 50px，
 * 但按钮只在悬停时出现、且绝对定位不占布局，所以正文只留 28px——悬停时按钮会盖到字符，
 * 这是 B-29「绝对定位、不占布局」已接受的偏差（D-32 / D-33，计数 chip 已按用户要求删除，D-34）。
 *
 * **它加在裁剪盒（`.card-code-body`）自己身上，不加在外层 `.card-code` 上**（2026-10-30 用户真机反馈）：
 * 滚动条画在滚动容器自己的内边缘，padding 留在外层时滚动条就停在 content box 边、离代码框右边框
 * 还差 28px（实测约 27px 空白）。挪进来以后滚动条贴住右边框（0px），文字仍有 28px 避让按钮。
 * 上下内边距不能这么挪（D-33：会从底部内边距里露出下一行半截），所以只挪右侧这一档。
 */
const CODE_PADDING_RIGHT = 28
/**
 * 折叠高度：6 行 + 露出下一行的这一小截。
 * 用户的原话是「超出可用范围时一般是下一行稍微露出一点，能看出来还有」——所以折叠态不是
 * 精确裁在行边界上，而是故意多露 10px；同时折叠态 `overflow-y: auto`，滚轮能滚到底（D-34）。
 * `partialLines` 因此在折叠态是 1（不再是 D-33 要求的 0），展开态仍为 0。
 */
const FOLD_PEEK_Y = 10
/**
 * 折叠高度：正文代码框。裁剪盒是里面那一层，没有内边距，所以就是 6 行 + 露出的 10px。
 * （行内命令框的裁剪盒同样没有内边距，两个数相同，仍分开写以表达各自的位置。）
 */
const FOLD_BODY_MAX = FOLD_LINES * CODE_LINE_HEIGHT + FOLD_PEEK_Y
/** 折叠高度：行内命令框（内边距在外层容器上，自己不加）。 */
const FOLD_ROW_MAX = FOLD_LINES * CODE_LINE_HEIGHT + FOLD_PEEK_Y

/**
 * 代码高亮配色 = **IDEA Light** 的调色板（B-30）。
 *
 * 为什么写十六进制：这几档在 antd 的色板里没有对应档位（"注释灰"和 "colorTextTertiary" 不是
 * 一回事），按 B-20 的例外条款写死、并在注释里标出处。两种语言（shellscript / powershell）
 * 共用这一份，所以注释一定灰、字符串一定绿。
 *
 * 色值以**用户在 IDEA 里实测取值**为准（2026-10-30，D-34）：禁止从截图取色——截图的
 * ClearType 子像素抗锯齿会混出假色（之前取到过 `#2C8365` / `#069BA7`、以及把命令色读成
 * `#0073BF` 这类偏色）。命令（cmdlet 与外部命令）与数字**同一色** `#1750EB`——用户口径是
 * 「命令 `#1750EB`，数字算命令」（D-34）。
 */
const IDEA_LIGHT = {
  foreground: '#080808',
  /** 注释：灰（IDEA Light 的 line comment） */
  comment: '#8C8C8C',
  /** 字符串：绿 */
  string: '#067D17',
  /** 关键字（`for` / `in` / `do` / `if` / `param`）：蓝，**加粗**（加粗在 highlight.ts 里加） */
  keyword: '#0033B3',
  /** 数字、常量：与命令同色（「数字算命令」） */
  constant: '#1750EB',
  /** 命令 / 函数：cmdlet 与外部命令同色，且与数字同色（`uname` / `ls` / `Get-ChildItem` …） */
  function: '#1750EB',
  /** 变量：用户 2026-10-30 选定「方案 B（社区扩展版）」后新增的一档（D-34） */
  variable: '#248F8F',
  /** 类型名（`[string]` / `[int]`）：同上，方案 B 新增 */
  type: '#7A7A43',
  /** 操作符（`-f` / `>` / `|` / `*` 这类）：同上，方案 B 新增 */
  operator: '#871094',
  /** 变量 / 参数：与正文同色，IDEA 里参数不单独上色 */
  parameter: '#080808',
  /** 标点：跟随正文 */
  punctuation: '#080808',
  /** 链接（shell 里的 URL 之类） */
  link: '#0033B3',
} as const

/** 计数模板（`提交 {n} 项`）；没有模板就原样用标签。 */
function buttonLabel(button: CardButton, count: number): string {
  if (!button.labelCount) return button.label
  return button.labelCount.replace('{n}', String(count))
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export default function App({ payload }: { payload: CardPayload }) {
  const { token } = theme.useToken()
  const [phase, setPhase] = useState<Phase>('measure')
  const [shown, setShown] = useState(false)
  const [checked, setChecked] = useState<boolean[]>(() => (payload.rows ?? []).map(() => false))
  const [armed, setArmed] = useState(false)
  const [remainingMs, setRemainingMs] = useState(0)
  const decided = useRef(false)
  // 报过高没有：ready 只发一次（下面的报高循环靠它 + 局部 posted 双重收口）。
  const readySent = useRef(false)
  // 同一个事实的 state 版本：resize 观察器要等它变 true 才装，而 ref 变了不会触发重新跑 effect
  // （D-46 之后报高是异步的，挂在 mount 那一刻读 ref 会永远读到 false）。
  const [measurePosted, setMeasurePosted] = useState(false)

  // 每个代码框各自折叠（B-29）：键是 `body-<下标>` / `row-<下标>`。
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({})
  // 哪些框真的超出折叠高度（决定要不要出折叠按钮）：按真实溢出量算，见下面的 effect。
  // 同时也是「这个框固定高」的判据（T-09）：溢出过的框折叠/展开同高，没溢出的按内容自适应。
  const [overflowingKeys, setOverflowingKeys] = useState<Record<string, boolean>>({})
  const codeRefs = useRef<Record<string, HTMLElement | null>>({})
  /**
   * 折叠态量到的每个框高度（px），展开态拿它当 minHeight 兜底（D-44）。
   * 键与 expandedKeys / overflowingKeys / codeRefs **同一套**（`body-<下标>` / `row-<下标>`），
   * 并且**每个框各一份**：正文块与行内框的正文不同，共用一个值会把短框撑成别人的高度。
   */
  const foldedHeights = useRef<Record<string, number>>({})
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const rows = useMemo(() => payload.rows ?? [], [payload.rows])
  const body = useMemo(() => payload.body ?? [], [payload.body])
  const buttons = useMemo(() => payload.buttons ?? [], [payload.buttons])
  const primary = buttons.find((button) => button.kind === 'primary') ?? null
  const others = buttons.filter((button) => button.kind !== 'primary')
  // 整页禁键盘只属于「不可撤销、只认鼠标」的那种卡（keyboard: 'none'）。
  const keyboardLocked = payload.keyboard === 'none'
  const armMs = payload.armMs ?? 0
  const closeMs = payload.closeMs ?? 0

  const checkedCount = checked.filter(Boolean).length
  const rowsReady = !primary?.requiresChecked || checkedCount > 0
  const canDecide = armed && rowsReady

  const emit = useCallback((message: HostMessage) => {
    if (decided.current) return
    decided.current = true
    postToHost(message)
  }, [])

  const decide = useCallback(
    (value: string) => {
      if (decided.current) return
      const message: HostMessage = {
        type: 'decision',
        value,
        ...(rows.length > 0 ? { checked } : {}),
      }
      emit(message)
    },
    [checked, emit, rows.length],
  )

  // 折叠/展开只改框内的排版，**不动卡片高度、也不动代码框高度**（T-09，2026-10-30 用户真机反馈：
  // 「展开成一行后高度变矮，卡片高度不变，代码框变矮导致内容空了」；用户又明确「动态改卡片高度会让
  // 点击后位置变化，所以不做，改为代码框保持原高度，多出来的空白留在框里」）。
  // 所以这里只切一个布尔：高度由渲染时的 foldedBox / fixedBox 决定，与点击无关，
  // 也绝不重新量高、不报 resize（断言会查 toggleCode 里不许出现 postToHost/resize/contentHeight）。
  const toggleCode = useCallback((key: string) => {
    setExpandedKeys((current) => ({ ...current, [key]: current[key] !== true }))
  }, [])

  // 「折叠」按钮恒显（用户 2026-11-10：「溢出判定会变，那就默认都显示」）；下面量到的溢出
  // 只决定折叠/展开是不是定高（T-09），不再决定按钮出不出现。判据是真实溢出量
  // （scrollHeight > clientHeight），不是数换行符：一条 574 字符的单行命令折成 8 行，同样要能展开。
  // 按钮绝对定位、不占流，所以这个测量不会反过来改布局或卡片高度。
  //
  // 溢出结论同时是「固定框高」的依据（T-09），所以**展开态不许重新量**：展开后框里只有一行
  // （white-space: pre）且高度定死 130，溢出量必然是负的；拿它覆盖会把「这个块可折叠」这个结论
  // 自己清掉，框会在点开的一瞬间缩回去。展开期间沿用折叠态量到的值，折回去时再按真实内容量。
  useEffect(() => {
    const nextOverflow: Record<string, boolean> = {}
    let overflowChanged = false
    for (const [key, element] of Object.entries(codeRefs.current)) {
      if (!element) continue
      const over =
        expandedKeys[key] === true
          ? overflowingKeys[key] === true
          : element.scrollHeight - element.clientHeight > 1
      nextOverflow[key] = over
      if ((overflowingKeys[key] === true) !== over) overflowChanged = true
    }
    if (overflowChanged) setOverflowingKeys(nextOverflow)
  })

  // 折叠态把每个框的实测高度记下来（D-44），展开态用 minHeight 兜住，灰框**不许变矮**。
  //
  // 用户 2026-11-10 真机原话：「展开后怎么代码框（灰色的）下面有了空白（白色的）」「导致 代码框
  // （灰色的） 与 按钮 中间有空白（白色的）」「既然你给了默认高度（灰色的），那就不要收起来」。
  // 他否掉的是「展开后灰框变矮」，不是「保持代码框高度」：没溢出过的短框展开只关掉折行，行数
  // 变少 → 灰框自然高度跟着变小；而**卡片窗口高度不会跟着缩**（宿主只在需要时量高），
  // 于是灰框底边与按钮之间多出一条白。所以折叠时先记高，展开时拿它当地板。
  //
  // **只记折叠态**：展开态量到的是被 minHeight 兜过的高度，写回去会让折叠态也跟着变高（不可逆）。
  // 依赖 overflowingKeys 是因为它一变，框会从 maxHeight 换到 height，量到的值要重记。
  useLayoutEffect(() => {
    for (const [key, element] of Object.entries(codeRefs.current)) {
      if (!element || expandedKeys[key] === true) continue
      const height = element.offsetHeight
      if (height > 0) foldedHeights.current[key] = height
    }
  }, [body.length, expandedKeys, overflowingKeys, rows.length])

  // 这张卡不用键盘：谁也别留在焦点里，否则浏览器会画一圈焦点环。
  useEffect(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
  }, [])

  // measure / fill 只是 <html> 上的一个属性：尺寸规则在 styles.css，卡片自身跟着 phase 走。
  useEffect(() => {
    document.documentElement.dataset.phase = phase
  }, [phase])

  // 先订阅，再报 ready：shown 可能在 ready 之后立刻到，晚订阅就会丢掉它。
  //
  // **报高时机要有判据**（D-46）：宿主只认第一条高度，那条就必须是最终值。而页面是在首个被动
  // effect 里量高的，那时布局未必稳定（字体激活、附注条/页脚行盒建立、代码块折行都可能落在
  // 首帧之后）——2026-11-12 的偶发 271 就是「第一条比最终矮 20px」，20–40ms 后页面自己量到 291。
  // 所以改成：① 等 `document.fonts.ready`；② 连续两次采样完全一致才报；
  // 只发**一条** ready（不是「先报粗的、稳了再补」——补第二条就是两次改窗口）。
  //
  // **采样时钟必须是定时器，不能是 requestAnimationFrame**（2026-11-15 真机 30/30 全落兜底换来的）：
  // 宿主拿到 ready 才 ShowWindow，在那之前窗口不可见、WebView2 基本不产帧，rAF 会被饿死
  // （真机 trace：页面脚本 t≈2327ms 才等到第一帧，而宿主的 ready 预算只有 2000ms）。
  // rAF 一饿死，这条判据就成了死等。预算 500ms：一直不一致就按最后一次报，
  // 并把两次高度带回去（宿主写 measure-unstable 埋点）。
  useEffect(() => {
    const off = onHostMessage((message) => {
      if (message.type === 'shown') setShown(true)
    })
    if (!isEmbedded()) {
      // 浏览器里开发：没有宿主，自己把 shown 补上，否则按钮始终不可点。
      setShown(true)
      return off
    }

    const root = document.getElementById('root')
    const state = createMeasureState(performance.now())
    let fontsReady = typeof document.fonts === 'undefined'
    let timer = 0
    let posted = false

    const step = () => {
      if (posted) return
      const sample = { height: contentHeight(), scroll: root === null ? 0 : Math.ceil(root.scrollHeight) }
      const decision = nextMeasureDecision(state, sample, performance.now(), fontsReady)
      if (decision.action === 'wait') {
        timer = setTimeout(step, MEASURE_SAMPLE_INTERVAL_MS)
        return
      }
      posted = true
      readySent.current = true
      setMeasurePosted(true)
      postToHost({ type: 'ready', height: decision.height, ...(decision.unstable === null ? {} : { unstable: decision.unstable }) })
    }

    if (!fontsReady) {
      // 字体 promise 不该决定卡片死活：拿不到就当已就绪，别把卡片卡在这里。
      // 到点立刻再采一次（不必等下一个 16ms）：字体一到、两样本一致就马上报。
      document.fonts.ready.then(
        () => {
          fontsReady = true
          step()
        },
        () => {
          fontsReady = true
          step()
        },
      )
    }

    // 先同步采一次：万一定时器也被节流，至少有一个真样本，预算到点时不会「一次都没量过」。
    step()
    return () => {
      posted = true
      clearTimeout(timer)
      off()
    }
  }, [])

  // measure 阶段内容变化（换行、错误提示）报 resize；fill 阶段窗口已定，不再报。
  // 它只是**取证线**（宿主只认第一条高度，晚到的 resize 不改窗口）；装上来的时机由
  // `measurePosted` 触发重跑决定——报过高度之后才观察。
  useEffect(() => {
    if (phase !== 'measure' || !readySent.current) return
    const root = document.getElementById('root')
    if (!root) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => postToHost({ type: 'resize', height: contentHeight() }))
    })
    observer.observe(root)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [phase, measurePosted])

  // shown = 窗口真的出现在人面前：从这里开始切 fill、开始防误点计时。
  useEffect(() => {
    if (!shown) return
    setPhase('fill')
    if (armMs <= 0) {
      setArmed(true)
      return
    }
    const timer = setTimeout(() => setArmed(true), armMs)
    return () => clearTimeout(timer)
  }, [shown, armMs])

  // 到点自己关（宿主那边还有一条更宽的兜底线），只发一次 expired。
  useEffect(() => {
    if (!shown || closeMs <= 0) return
    const end = Date.now() + closeMs
    setRemainingMs(closeMs)
    const timer = setInterval(() => {
      const left = end - Date.now()
      if (left > 0) {
        setRemainingMs(left)
        return
      }
      setRemainingMs(0)
      emit({ type: 'expired' })
    }, 250)
    return () => clearInterval(timer)
  }, [shown, closeMs, emit])

  // keyboard none：只认鼠标的卡整页拦键盘。其余卡：Esc = 取消，Enter = 主按钮。
  useEffect(() => {
    if (keyboardLocked) {
      const block = (event: KeyboardEvent) => {
        event.preventDefault()
        event.stopPropagation()
      }
      window.addEventListener('keydown', block, true)
      return () => window.removeEventListener('keydown', block, true)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        emit({ type: 'cancel' })
        return
      }
      if (event.key !== 'Enter' || !primary || !canDecide) return
      event.preventDefault()
      decide(primary.action)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canDecide, decide, emit, keyboardLocked, primary])

  const statusText = [payload.status ?? '', closeMs > 0 && shown ? `剩余 ${formatCountdown(remainingMs)}` : '']
    .filter((part) => part !== '')
    .join(' · ')

  const mono = { fontFamily: token.fontFamilyCode, fontSize: 12.5, lineHeight: `${CODE_LINE_HEIGHT}px`, margin: 0 }

  // 代码框的排版只有两种状态（B-28），正文块与行内命令块共用下面这几个「盒子」：
  //   折叠 = 折行（默认观感，命令再长也不藏半行）+ 限高「6 行 + 露 10px」+ 能上下滚（D-34）；
  //   展开 = 不折行 + 双向滚动（B-28）。
  // 高度分两档（T-09，用户 2026-10-30 真机定）：
  //   - **溢出过**的框：折叠态与展开态**同高**（定高 = 6 行 + 露出的 10px）。展开后整条命令只剩一行，
  //     框里就有大片空白——用户原话「代码框空着比下面空白色好一点」；反过来若让框缩回一行高，
  //     卡片下方会凭空多出一块空白，而且「动态改卡片高度会让点击后位置变化」，用户明确不做。
  //   - **没溢出**的短框：两种状态都按内容自适应（按钮恒显，但展开也只是不再折行、不定高——
  //     给它套 expandedBox 就等于把每条 1–3 行的短命令都撑成 130 的空框）。
  // 两种都用 overflow 裁剪，不出现 line-clamp / text-overflow（那会画省略号，D-31）。
  const codeTextStyle: CSSProperties = {
    ...mono,
    // 正文默认色固定成 IDEA 的 #080808（探针 plain 类别量的就是它），不跟 antd 的 rgba(0,0,0,.88) 走。
    color: IDEA_LIGHT.foreground,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  }
  // 短框（没溢出过）的折叠态：**限高**——内容有多高就多高，超过 6 行才剪。
  const foldedBox = (max: number): CSSProperties => ({
    maxHeight: max,
    // 露出的是第 7 行的一小截（10px），所以 **纵向必须能滚**：滚轮到底看最后一行。
    overflowY: 'auto',
    // 横向不滚：折叠态是折行的，长命令已经被 pre-wrap 折开。
    overflowX: 'hidden',
  })
  // 溢出过的框：折叠态就用**定高**，与展开态一模一样（T-09：点击前后代码框不许变高变矮）。
  const fixedBox = (max: number): CSSProperties => ({
    height: max,
    overflowY: 'auto',
    overflowX: 'hidden',
  })
  // 展开态（**只给溢出过的框**）：不折行 + 双向滚动，高度与折叠态相同（定高），多出来的空白留在框内。
  const expandedBox = (max: number): CSSProperties => ({
    whiteSpace: 'pre',
    overflowWrap: 'normal',
    height: max,
    overflow: 'auto',
  })
  // 短框（没溢出过）的展开态：**不定高**，仍按内容自适应——只把折行关掉（B-28 的「展开 = 不折行」）。
  // 这里绝不能换成 expandedBox：它的 height 是写死的 6 行 + 露出的 10px，套到 1–3 行的短命令上就是
  // 一个 130px 的空框，还会把正文容器顶出滚动条（T-09 / 用户 2026-10-30：「不能用展开把短命令撑成空框」）。
  // maxHeight 由 foldedBox 带过来，所以短框以后变长也只被剪到同一档，不会撑破卡片。
  //
  // 和上面那条**不矛盾**：不定高，但有一个**下限**——折叠态量到的高度（D-44，见下面的 minHeight）。
  // 「按内容自适应」管的是「别把 1 行的短命令撑成 130 的空框」；minHeight 管的是「关掉折行后
  // 行数变少、灰框不许跟着变矮」。两者都成立时，短框展开前后一样高。
  /**
   * 当前正在排版哪个代码框（渲染期游标，不是状态）：`expandedShortBox(max)` 保持单参数，
   * 由每个框在拼样式之前把它指向自己的键（`body-<下标>` / `row-<下标>`）。
   * 它是本次 render 的局部变量——不跨渲染保留、不触发重渲染、也不进 React 状态。
   */
  let layoutKey: string | null = null
  const expandedShortBox = (max: number): CSSProperties => {
    // 先落到局部常量：`layoutKey` 是渲染期写的 `let`，收窄成 string 再拿去索引才不会有 null。
    const boxKey = layoutKey
    const folded = boxKey === null ? undefined : foldedHeights.current[boxKey]
    return {
      ...foldedBox(max),
      whiteSpace: 'pre',
      overflowWrap: 'normal',
      overflow: 'auto',
      // 为什么必须有这一项：折叠态记了「这个框本来多高」，展开后不许比它矮——
      // 用户 2026-11-10 原话「既然你给了默认高度（灰色的），那就不要收起来」。
      // 前提是**卡片窗口高度不会跟着缩**（宿主只在需要时量高）：框自己缩了，灰框底边与按钮
      // 之间就露出一块白，比框里多几点空白难看得多。没量到（还没挂上/还没渲染过）就不加这一项，
      // 退回纯内容自适应。
      ...(folded === undefined ? {} : { minHeight: folded }),
    }
  }

  // 高亮配色（B-30）：**IDEA Light** 的调色板，不是「跟随界面色」。
  // 以前这 14 个变量全指向 antd token，等于没有主题——注释和参数一样灰、字符串和正文一样黑，
  // 命令里最该分清的几类东西分不开。这里把有语义的几档钉成 IDEA Light 的固定色，
  // 色值是**用户在 IDEA 里实测取值**（D-34，禁止截图取色）；只有 inserted/deleted/changed 三档仍走 token，
  // 它们表达的是「增/删/改」，本来就没有编辑器主题语义。
  // `--shiki-background` 不给：底色由代码框自己给（colorFillTertiary，B-12），高亮不碰背景。
  // 变量定义在卡片根节点上，正文代码块与行内命令块一起继承。
  const codeColors = {
    '--shiki-foreground': IDEA_LIGHT.foreground,
    '--shiki-token-comment': IDEA_LIGHT.comment,
    '--shiki-token-string': IDEA_LIGHT.string,
    '--shiki-token-string-expression': IDEA_LIGHT.string,
    '--shiki-token-keyword': IDEA_LIGHT.keyword,
    '--shiki-token-constant': IDEA_LIGHT.constant,
    '--shiki-token-function': IDEA_LIGHT.function,
    // 方案 B（社区扩展版，D-34）：这三档 `--shiki-token-*` 没有内置变量名，由 highlight.ts 的覆盖规则接过来。
    '--shiki-token-variable': IDEA_LIGHT.variable,
    '--shiki-token-type': IDEA_LIGHT.type,
    '--shiki-token-operator': IDEA_LIGHT.operator,
    '--shiki-token-parameter': IDEA_LIGHT.parameter,
    '--shiki-token-punctuation': IDEA_LIGHT.punctuation,
    '--shiki-token-link': IDEA_LIGHT.link,
    '--shiki-token-inserted': token.colorSuccessText,
    '--shiki-token-deleted': token.colorErrorText,
    '--shiki-token-changed': token.colorWarningText,
    // 滚动条两档也走 token：styles.css 里只写 var(--dsh-scroll-*)，
    // 静态 CSS 拿不到 token，就把值定义在卡片根节点上（同样不写裸色值，B-20）。
    '--dsh-scroll-thumb': token.colorFillSecondary,
    '--dsh-scroll-thumb-hover': token.colorFill,
  } as CSSProperties

  return (
    <Flex
      vertical
      gap={10}
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        padding: 16,
        height: phase === 'fill' ? '100%' : undefined,
        // 窗口本身没有边框，卡片自己描一圈，贴着白底时才分得清边界。
        // 描边用橙色系（B-26）：灰色的边界在这一堆窗口里不容易辨认。
        // 颜色来源：@ant-design/colors 不在 app 的依赖里（只允许 antd/react/vite/shiki，card-shell.ps1 守着），
        // 所以取 antd 的 token.colorWarning（warning 一档是橙色系）；不写裸色值，也不改成粗线——
        // 这一轮只换颜色，粗细仍是 1px（同样见 DECISIONS D-27）。
        border: `1px solid ${token.colorWarning}`,
        ...codeColors,
      }}
    >
      {/* 无边框窗口没有系统关闭按钮：✕ 只发 cancel，不带决定。 */}
      <Button
        type="text"
        size="small"
        tabIndex={-1}
        aria-label="关闭"
        icon={<CloseOutlined />}
        onClick={() => emit({ type: 'cancel' })}
        style={{ position: 'absolute', top: 14, right: 12 }}
      />

      {/* 拖动区 = eyebrow（用户口中的「标题」，屏上长这样：`域 · 动作`），
          **不是** titleHtml（用户口中的「工作目录」，屏上是一个盘符路径）。用户 2026-11-10 真机原话：
          「我发现怎么是 工作路径那一行能拖动。。。」「我要的是 标题拖动」——他的「标题」就是 eyebrow，
          上一版错绑在 titleHtml 上，所以他按住拖的是工作目录那一行。
          按下只发一条 drag 给宿主：宿主 ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION 进系统移动循环，
          窗口自己挪——页面不挪窗口、不做 hit-test、**也不做改大小**。preventDefault 必须有：否则按下
          会变成选字；cursor: grab 只是告诉人「这里能拖」，不参与行为。
          eyebrow 为空就没有拖动区，**不退回路径行**（用户明确不要路径行能拖）。 */}
      {payload.eyebrow ? (
        <Text
          data-part="eyebrow"
          type="secondary"
          style={{ cursor: 'grab', userSelect: 'none' }}
          onPointerDown={(event) => {
            event.preventDefault()
            postToHost({ type: 'drag' })
          }}
        >
          {payload.eyebrow}
        </Text>
      ) : null}

      {/* 标题只放路径 / 主机标签（B-16）：没有就什么都不渲染，不退回抬头、也不写固定句。
          纯展示——这里**不能**拖：用户要的是拖抬头那一行，2026-11-10 真机撞到的正是「工作路径那一行
          能拖动」，所以这一行不许再有 onPointerDown / cursor: grab（tests/card-shell.ps1 反向守着）。 */}
      {payload.titleHtml ? (
        <span
          data-part="title"
          style={{ fontWeight: 600 }}
          dangerouslySetInnerHTML={{ __html: payload.titleHtml }}
        />
      ) : null}

      <Flex
        ref={bodyRef}
        vertical
        gap={10}
        style={{ flex: 1, minHeight: 0, overflowY: phase === 'fill' ? 'auto' : 'visible' }}
      >
        {body.map((block, index) => {
          const key = `body-${index}`
          // 这个框自己的折叠高度要用它自己的键（D-44）：拼样式前把渲染游标指过来。
          layoutKey = key
          if (block.kind !== 'code') {
            return (
              <Text data-part="note" key={key} type={block.muted ? 'secondary' : undefined} style={{ whiteSpace: 'pre-wrap' }}>
                {block.text}
              </Text>
            )
          }
          const expanded = expandedKeys[key] === true
          // 溢出过 → 定高（折叠/展开同高，T-09）；没溢出 → 折叠按内容、展开用不到（没有按钮）。
          const overflows = overflowingKeys[key] === true
          // 外层这层 div 承担三件事：给右上角控件当定位父级（绝对定位 → 不占布局）、
          // minWidth:0 让长命令在窄卡里还能折行/横向滚动，以及**内边距 + 底色**。
          // 上下内边距必须在外层：overflow 按 padding box 裁，内边距留在 <pre> 上时折叠态会从
          // 底部内边距里露出下一行的半截（DECISIONS D-33）。<pre> 只负责限高与裁剪。
          // 右侧 28px 反过来——放在 <pre> 自己的 padding 里，滚动条才会贴住右边框（见 CODE_PADDING_RIGHT）。
          return (
            <div
              key={key}
              className="card-code"
              style={{
                position: 'relative',
                minWidth: 0,
                padding: `${CODE_PADDING_Y}px 0 ${CODE_PADDING_Y}px 10px`,
                background: token.colorFillTertiary,
                borderRadius: token.borderRadius,
              }}
            >
              <pre
                data-part="code"
                data-expanded={expanded ? 'true' : 'false'}
                className="card-code-body"
                ref={(element) => {
                  codeRefs.current[key] = element
                }}
                style={{
                  ...codeTextStyle,
                  // 右侧避让工具栏的那 28px 在裁剪盒里（不是外层）：滚动条因此落在
                  // 代码框右边框上（用户 2026-10-30 反馈「滚动条离右边框 27px 空白」）。
                  paddingRight: CODE_PADDING_RIGHT,
                  ...(expanded
                    ? overflows
                      ? expandedBox(FOLD_BODY_MAX)
                      : expandedShortBox(FOLD_BODY_MAX)
                    : overflows
                      ? fixedBox(FOLD_BODY_MAX)
                      : foldedBox(FOLD_BODY_MAX)),
                }}
              >
                {/* 说明是代码框的一部分，但**不在这里手写**：交给 CodeText → highlight()，由它把
                    `#` 前缀拼进 shiki 的输入（`# 说明` + 换行 + 命令），与命令进同一条行流
                    （一起折行、一起滚动、一起折叠，R-17 / D-42）。`App.tsx` 里不许出现注释前缀字面量
                    ——`#` 只在 highlight.ts 的 commentSource 里生成（tests/card-shell.ps1 守着）。
                    高亮在首次 render 里同步完成（见 CodeText.tsx）：宿主量到的高度已经是最终高度。 */}
                <CodeText code={block.command} lang={codeLang(block.lang)} comment={block.comment} />
              </pre>
              <CodeTools
                text={commandOnly(block.command)}
                expanded={expanded}
                // 折叠按钮**恒显示**（用户 2026-11-10：「溢出判定会变，那就默认都显示，简单处理 又不影响功能」）。
                // 溢出判定仍保留：它决定这个框折叠/展开是不是定高（T-09），只是不再决定按钮出不出现。
                canFold
                onToggle={() => toggleCode(key)}
              />
            </div>
          )
        })}

        {/* 行距用留白，不再描分隔线（B-17）：行内已经有代码框，框本身就是分隔。
            几行仍是「一组选项」，所以间距由 gap 8 管，正文块之间继续用外层容器的 gap。 */}
        <Flex vertical gap={8}>
          {rows.map((row, index) => {
            const rowKey = `row-${index}`
            // 与正文块同一条口径：用这个行内框自己的键取折叠高度（D-44）。
            layoutKey = rowKey
            const rowExpanded = expandedKeys[rowKey] === true
            // 与正文块同一条口径：溢出过 → 折叠/展开都定高；没溢出 → 展开也不定高（只关掉折行）。
            const rowOverflows = overflowingKeys[rowKey] === true
            return (
            <Flex
              key={index}
              align="flex-start"
              gap={8}
              onClick={() => setChecked((current) => current.map((value, at) => (at === index ? !value : value)))}
              style={{
                padding: '6px 10px',
                borderRadius: token.borderRadius,
                cursor: 'pointer',
                // 选中底色用主色浅底而不是灰：行内命令块本身是灰底，同色会糊成一片。
                background: checked[index] ? token.colorPrimaryBg : undefined,
              }}
            >
              <Checkbox
                tabIndex={-1}
                checked={checked[index] ?? false}
                onChange={(event) =>
                  setChecked((current) => current.map((value, at) => (at === index ? event.target.checked : value)))
                }
              />
              {/* checkbox 占左侧一列，右边这一列才是「主机 + 代码框」；代码框铺满这一列的宽度。 */}
              <Flex vertical gap={4} style={{ minWidth: 0, flex: 1 }}>
                <Flex align="center" gap={8} justify="space-between">
                  <Text>{row.label}</Text>
                  {/* 「覆盖」这类警告跟 cwd/超时不是一回事（B-15）：留在主机那一行，不塞进框底。 */}
                  {row.warn ? (
                    <Text style={{ color: token.colorWarning, fontSize: token.fontSizeSM }}>⚠ {row.warn}</Text>
                  ) : null}
                </Flex>
                {row.why || row.text || row.meta ? (
                  // 这个灰底容器就是「整个行内框」，和正文代码块一样挂 `card-code`（用户 2026-10-30 反馈
                  // 「为何复制按钮在代码行而不是最上面」「鼠标放注释行没显示复制按钮」）：
                  // 只有把 `.card-code` 放在**含注释行/meta 条的整框**上，CodeTools 的 `top:6 right:6`
                  // 才是相对灰底框的边界，`.card-code:hover .card-code-tools` 也才会被注释行触发。
                  // 两套框因此共用同一条定位父级规则：`position:relative` 的 `.card-code` + 绝对定位的
                  // `.card-code-tools`（CSS 在 styles.css，`.card-code` 只有这一条规则）。
                  <Flex
                    vertical
                    gap={0}
                    className="card-code"
                    style={{
                      position: 'relative',
                      minWidth: 0,
                      background: token.colorFillTertiary,
                      borderRadius: token.borderRadius,
                      // 附注条要铺到圆角处（B-18）：圆角仍由外层管，内层不加圆角，靠裁切收边。
                      overflow: 'hidden',
                    }}
                  >
                    {row.why || row.text ? (
                      <Flex vertical gap={4} style={{ padding: '4px 8px' }}>
                        {row.text ? (
                          // 行内命令框与正文代码框同一套：说明（`why`）交给 CodeText → highlight()，
                          // 由它把 `#` 前缀拼进 shiki 的输入；这里不拼前缀、也不单独渲染一行（R-17 / D-42）。
                          // 行默认承载「一条要执行的命令」，所以缺省 lang 是 sh；
                          // **空字符串与全空白也算缺省**（D-38）：上游插件把「没有语言」传成 ''，
                          // 只写 `?? 'sh'` 拦不住（`??` 不拦空串），会一路退成纯文本。
                          // 归一化只有一处：见 codeLang.ts。
                          // 命令行特征会把其中的 pwsh 认回来（见 highlight.ts 的 detectLanguage）。
                          // 搬运卡这类**说明文字**给 lang='text'：逐字纯文本，不按 shell 涂色，
                          // 也不会把 `Source:` 这种行首当成命令名。
                          // 行内命令框与正文框同一套折叠/展开/复制（B-29）：一行一条命令，复制哪条最明确。
                          // 这一层只是**裁剪盒 + 滚动容器**（不是定位父级、也不再是 hover 容器）：
                          // 工具栏提升到外层整框后，按钮才会贴在灰底框右上角，与正文块完全同位置。
                          <div
                            data-part="row-code"
                            data-expanded={rowExpanded ? 'true' : 'false'}
                            className="card-code-body"
                            ref={(element) => {
                              codeRefs.current[rowKey] = element
                            }}
                            style={{
                              ...codeTextStyle,
                              minWidth: 0,
                              // 右侧让出工具栏那一截（B-29）：与正文代码框同一个数，行为才一致。
                              paddingRight: CODE_PADDING_RIGHT,
                              ...(rowExpanded
                                ? rowOverflows
                                  ? expandedBox(FOLD_ROW_MAX)
                                  : expandedShortBox(FOLD_ROW_MAX)
                                : rowOverflows
                                  ? fixedBox(FOLD_ROW_MAX)
                                  : foldedBox(FOLD_ROW_MAX)),
                            }}
                          >
                            <CodeText code={row.text} lang={codeLang(row.lang)} comment={row.why} />
                          </div>
                        ) : (
                          // 只剩说明、没有命令的行（上面的条件允许 `why` 有、`text` 没有）。
                          // 这里仍要单独渲染，因为说明的位置在「代码框」里：没有命令就没有裁剪盒、
                          // 也没有复制/折叠按钮可挂，CodeText 那条路走不到。所以它单独渲染、保持注释灰，
                          // 但 `#` 一样不能少——前缀仍从 commentSource 取（`#` 只在 highlight.ts 生成）。
                          // 不能因为没有命令就把说明弄丢。
                          <Text
                            style={{
                              ...mono,
                              color: IDEA_LIGHT.comment,
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {commentSource(row.why)}
                          </Text>
                        )}
                      </Flex>
                    ) : null}
                    {row.meta ? (
                      // 附注条靠深一档的底色区分，框里不再有 1px 分隔线（B-18）。
                      // 附注条底色：内置的 colorFillQuaternary 叠在命令区之上（≈#F0F0F0），
                      // 比命令区深一档又不抢视线。内置档位够用就不写死色值（PREFERENCES.md B-19）。
                      <div style={{ background: token.colorFillQuaternary, padding: '4px 8px' }}>
                        <Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                          {row.meta}
                        </Text>
                      </div>
                    ) : null}
                    {/* 工具栏是整框（含注释行与 meta 条）的最后一个子节点，绝对定位 → 不占布局；
                        行本身整行可点选，CodeTools 自带 stopPropagation，不会误触整行。 */}
                    {row.text ? (
                      <CodeTools
                        text={commandOnly(row.text)}
                        expanded={rowExpanded}
                        // 与正文代码框同一条口径：按钮恒显示，溢出判定只决定折叠/展开是否定高（T-09）。
                        canFold
                        onToggle={() => toggleCode(rowKey)}
                      />
                    ) : null}
                  </Flex>
                ) : null}
              </Flex>
            </Flex>
            )
          })}
        </Flex>
      </Flex>

      <Flex justify="space-between" align="center" gap={12}>
        <Text type="secondary">{statusText}</Text>
        <Flex gap={8}>
          {others.map((button) => (
            <Button key={button.action} type="default" tabIndex={-1} onClick={() => decide(button.action)}>
              {buttonLabel(button, checkedCount)}
            </Button>
          ))}
          {primary ? (
            <Button type="primary" tabIndex={-1} disabled={!canDecide} onClick={() => decide(primary.action)}>
              {buttonLabel(primary, checkedCount)}
            </Button>
          ) : null}
        </Flex>
      </Flex>
    </Flex>
  )
}
