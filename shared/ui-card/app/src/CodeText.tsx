import { Fragment, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { commentSource, highlight } from './highlight'

/** Shiki 的字重位掩码（FontStyle）：2 = 粗体（1 = 斜体，4 = 下划线）。 */
const FONT_STYLE_BOLD = 2

/**
 * 代码文本：认得出语言就逐段上色，否则原样输出纯文本（和换高亮之前长一模一样）。
 *
 * 一般 token 只给 `<span>` 设颜色，字体、字号、行高都不动；**唯一的例外是关键字加粗**：
 * 用户明确要求「关键词：加粗」＋IDEA 的关键字蓝（色值见 App.tsx 的 IDEA_LIGHT），加粗在 highlight.ts 里
 * 以 theme 规则的形式挂在 keyword.control 这一组 scope 上（token.fontStyle），这里只负责把它渲染成
 * `font-weight`（D-34）。
 * 高亮是同步的（见 highlight.ts），所以首次 render 里文字已经是最终宽度——宿主量高之前就定格了。
 *
 * `comment` 是这段代码的说明：它由 highlight() 拼成 `# 说明` 交给 shiki，与命令一起折行、滚动、折叠；
 * 这里既不拼 `#`、也不单独上色（`#` 只在 highlight.ts 的 commentSource 里生成，D-42）。
 */
export function CodeText({ code, lang, comment }: { code: string; lang?: string; comment?: string }) {
  const lines = useMemo(() => highlight(code, lang, comment), [code, lang, comment])

  // 认不出语言 / highlighter 起不来 / 分词失败：不开高亮，卡片照常弹。
  // 说明不能跟着丢，`#` 也不能丢：纯文本回退照样是「`# 说明` + 换行 + 命令」，
  // `#` 仍然由 commentSource 生成（不着色，但屏幕上与高亮那条路逐字一致）。
  if (lines === null) {
    const head = commentSource(comment)
    if (head === '') return <>{code}</>
    return (
      <>
        {head}
        {code === '' ? null : '\n'}
        {code}
      </>
    )
  }

  return (
    <>
      {lines.map((tokens, line) => (
        <Fragment key={line}>
          {/* 行与行之间补回换行符：Shiki 的 token 不含行尾换行，pre-wrap 靠它折行。 */}
          {line > 0 ? '\n' : null}
          {tokens.map((token, at) => {
            const style: CSSProperties = {
              color: token.color,
              // 只有 keyword 带 Bold 位；其余 token 的 fontStyle 是 None，落到 undefined（继承正文）。
              fontWeight: token.fontStyle && token.fontStyle & FONT_STYLE_BOLD ? 'bold' : undefined,
            }
            return (
              <span key={at} style={style}>
                {token.content}
              </span>
            )
          })}
        </Fragment>
      ))}
    </>
  )
}
