import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import { Button, theme } from 'antd'
import { CheckOutlined, CloseOutlined, CopyOutlined, RightOutlined } from '@ant-design/icons'
import { onHostMessage, postToHost } from './bridge'

/** 复制反馈（对勾 / 失败叉）停留的时长：只做「点到了」的即时反馈，不弹任何提示。 */
const COPIED_MS = 1200
/** 宿主回执的超时：800ms 没等到 `copied` 就按失败显示，不许永远停在「没反应」。 */
const COPY_ACK_TIMEOUT_MS = 800

/** 按钮边长（B-29）：20×20，图标 13px，两个按钮之间 4px。 */
const BUTTON_SIZE = 20
const ICON_SIZE = 13

export interface CodeToolsProps {
  /** 要复制的文本：整段命令原文，与折叠态显示几行无关（C-08：复制的必须是会执行的那条）。 */
  text: string
  /** 当前是否展开：决定那个 chevron 的朝向（折叠朝右、展开旋转 90° 朝下）。 */
  expanded: boolean
  /**
   * 是否给折叠按钮。**按钮恒显**（用户 2026-11-10：「溢出判定会变，那就默认都显示」），
   * 所以两处调用都传 `true`；是否溢出只决定折叠/展开要不要定高（T-09），不决定按钮出不出现。
   */
  canFold: boolean
  onToggle: () => void
}

type CopyFeedback = 'idle' | 'ok' | 'fail'

/**
 * 代码框右上角：两个图标按钮（折叠/展开、复制），**位置固定**在 6px/6px。
 *
 * 顺序是「折叠在左、复制贴最右」（用户 2026-10-30 真机反馈）：复制用得多，放最右顺手；
 * 整组仍是一个 20×20、间距 4px 的组，`top:6 right:6` 钉死，折叠态与展开态同一位置（B-39）。
 *
 * 位置为什么不跟任何东西走：上一版按钮靠旁边的计数 chip 定位（`right: calc(100% + 4px)`），
 * chip 宽度一变（`6/9` → `10/12`）按钮就整组平移；用户真机看到「展开折叠按钮位置会变化」。
 * 现在按钮组直接绝对定位在 `.card-code` 上（`top:6 right:6`），折叠态与展开态**同一个位置**，
 * 与内容、与是否存在别的控件都无关（D-34）。计数 chip 也已按用户要求整体删除。
 *
 * 展开指示只有一个 chevron（antd `RightOutlined`），不换图标：折叠朝右、展开 `rotate(90deg)` 朝下，
 * 旋转 120ms。这是 DSH 前端自己树形展开器的做法（它的图标集里没有 Up/Down 箭头），
 * 换图标会让人以为「展开」和「收起」是两个不同动作。无障碍名仍按折叠/展开写。
 *
 * 显隐仍是 B-29：默认 `opacity: 0` + `pointer-events: none`，鼠标进代码框才显形（规则在 styles.css）；
 * 绝对定位 → 静止态不占布局、不顶开内容；悬停显形时会盖住字符，所以按钮组自带不透明底色。
 *
 * 按钮只用图标、不写「复制 / 展开 / 收起」这些字（B-33）：文字按钮会把代码框右上角撑宽，
 * 而这几个动作的图标已经是通用语义。无障碍名放在 aria-label 里，不是可见文字。
 */
export function CodeTools({ text, expanded, canFold, onToggle }: CodeToolsProps) {
  const { token } = theme.useToken()
  const [feedback, setFeedback] = useState<CopyFeedback>('idle')
  // 这一次点击还在等宿主回执：没有它就说明回执不是给这次点击的（页面里每段代码各有一套按钮）。
  const pending = useRef(false)
  const ackTimer = useRef<number | null>(null)
  const resetTimer = useRef<number | null>(null)

  const clearTimers = useCallback(() => {
    if (ackTimer.current !== null) {
      window.clearTimeout(ackTimer.current)
      ackTimer.current = null
    }
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current)
      resetTimer.current = null
    }
  }, [])

  const showFeedback = useCallback(
    (ok: boolean) => {
      setFeedback(ok ? 'ok' : 'fail')
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setFeedback('idle'), COPIED_MS)
    },
    [],
  )

  // 宿主写完剪贴板会回 `copied`（成功/失败都必须回）：页面只认自己发出去、还在等的那一次。
  useEffect(() => {
    return onHostMessage((message) => {
      if (message.type !== 'copied' || !pending.current) return
      pending.current = false
      if (ackTimer.current !== null) {
        window.clearTimeout(ackTimer.current)
        ackTimer.current = null
      }
      showFeedback(message.ok === true)
    })
  }, [showFeedback])

  useEffect(() => {
    return () => {
      clearTimers()
      pending.current = false
    }
  }, [clearTimers])

  /**
   * 复制**只能走宿主**：卡片是 `NavigateToString` 出来的，origin 是 `about:blank`，
   * 不是 secure context，异步剪贴板 API 在这里根本不存在（`undefined`）。旧代码
   * `if (!clipboard) return` 就是「点了没反应、也确实没复制」的根因（D-34）。宿主在 STA 线程上
   * `Set-Clipboard`，写完回 `{type:'copied', ok}`；800ms 没有回执按失败显示——失败不许静默。
   */
  const copy = useCallback(
    (event: MouseEvent) => {
      // 多选卡整行都可点（点一下 = 打勾 / 取消）：按钮上的点击不许冒泡成一次选择。
      event.stopPropagation()
      clearTimers()
      pending.current = true
      postToHost({ type: 'copy', text })
      ackTimer.current = window.setTimeout(() => {
        if (!pending.current) return
        pending.current = false
        ackTimer.current = null
        showFeedback(false)
      }, COPY_ACK_TIMEOUT_MS)
    },
    [clearTimers, showFeedback, text],
  )

  // 两个按钮同一套几何：antd 的 size 档位是 24/32，这里要 20，只能显式给。
  // 颜色不写死：图标继承 antd 的按钮字色，悬停底色也由 antd 的 token 给（B-20）。
  const buttonStyle: CSSProperties = {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    minWidth: BUTTON_SIZE,
    padding: 0,
    fontSize: ICON_SIZE,
    lineHeight: `${BUTTON_SIZE}px`,
    borderRadius: token.borderRadiusSM,
  }

  const copyIcon =
    feedback === 'ok' ? (
      <CheckOutlined />
    ) : feedback === 'fail' ? (
      // 失败态必须看得见（红叉）：只回一个「没反应」等于骗用户已经复制了。
      <CloseOutlined style={{ color: token.colorError }} />
    ) : (
      <CopyOutlined />
    )

  return (
    <div
      className="card-code-tools"
      data-part="code-tools"
      // 不透明底色（`colorFillTertiary` 是半透明的，压在字上会透出来）：
      // 与代码框白底叠出来的观感一致，又正好盖住下面的字符（B-20 取 token）。
      style={{ background: token.colorBgLayout }}
      onClick={(event) => event.stopPropagation()}
    >
      {/* 折叠在左：只有一个 chevron，折叠朝右、展开旋转 90° 朝下（不换图标）。 */}
      {canFold ? (
        <Button
          type="text"
          tabIndex={-1}
          aria-label={expanded ? '折叠代码' : '展开代码'}
          style={buttonStyle}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          icon={
            <RightOutlined
              style={{
                transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 120ms ease-in-out',
              }}
            />
          }
        />
      ) : null}
      {/* 复制贴最右：用得最多，也是这一组里唯一会变状态（对勾 / 红叉）的按钮。 */}
      <Button type="text" tabIndex={-1} aria-label="复制" style={buttonStyle} onClick={copy} icon={copyIcon} />
    </div>
  )
}
