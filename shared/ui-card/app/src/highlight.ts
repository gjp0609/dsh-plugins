// 代码高亮（K-012，决议见 DECISIONS D-29）：Shiki + JS 正则引擎 + css-variables 主题。
//
// 这个文件的形状由三条硬约束推出来：
//   ① 产物只有一个 HTML（vite-plugin-singlefile），不能有 .wasm 外链 → 用 JS 正则引擎，
//      不碰 oniguruma；只按子路径引 core / engine / 两种语法，不引 `shiki` 根入口
//      （根入口会把全部语法与主题的懒加载表一起带进来）。
//   ② 高度必须先定格再显示 → 用**同步** API（createHighlighterCoreSync + codeToTokens）：
//      高亮在首次 render 里就完成，宿主 measure 到的就是高亮后的高度，之后不会再变宽变高。
//   ③ 认不出语言、初始化失败、任何异常都不许影响卡片 → 一律返回 null，调用方按纯文本渲染。
import { createHighlighterCoreSync, createCssVariablesTheme } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import shellscript from 'shiki/langs/shellscript.mjs'
import powershell from 'shiki/langs/powershell.mjs'
import type { HighlighterCore, ThemedToken, ThemeRegistration } from 'shiki/core'

/** 一行里的一段带色文本（Shiki 的 token；颜色是 `var(--shiki-*)`，由卡片把变量指到 antd token）。 */
export type HighlightLine = ThemedToken[]

const CARD_THEME = 'dsh-card'

// shell 语法把**裸参数**也标成字符串：`echo xxxx…` 的 xxxx 是 `string.unquoted.argument.shell`，
// `for i in 1 2 3` 的字面量是 `string.unquoted.shell`，`wc -c` 的 `-c` 自己虽然叫
// `constant.other.option.dash.shell`，祖先仍是 `string.unquoted.argument.shell`。
// 而 css-variables 主题的规则是 `scope: ["string", …]` 这种前缀匹配（见 @shikijs/core 的
// createCssVariablesTheme），于是这些**不是字符串**的东西全被涂成字符串色——
// 「命令 + 参数」整行发绿就是这么来的（token 取证见 DECISIONS D-31 附录）。
// 只有**带引号**的字符串才像字符串：补一条更具体的规则（比 `string` 深一层，优先级更高）
// 把这两组拉回正文色。颜色仍写成 css 变量，highlight.ts 里不落任何裸色值（B-20）。
const BARE_ARGUMENT_SCOPES = ['string.unquoted', 'constant.other.option']

// 数字：用户要求「数字字面量必须是蓝」（数字色见 App.tsx 的 IDEA_LIGHT，D-34）。shell 语法把
// `echo 1 2 3` 的数字同时
// 标成 string.unquoted.argument（会被上面的裸参数规则拉回正文色），所以这里补一条更具体的规则
// 再拉回常量色；`for i in 1 2 3` 的数字根本没有 constant.numeric 这一层（只有 string.unquoted.shell），
// 那条由 highlight() 里按 token 文本兜底。
const NUMBER_SCOPES = ['constant.numeric']

// 操作符整组先拉回正文色：`=`（以及 PowerShell 参数前的 `-`）在语法里都是
// `keyword.operator.assignment`，染别的色会让 `-LiteralPath` 这类参数前缀变色；比较/算术同理留黑。
// 方案 B 只把用户点名的四个子 scope 染紫（见下面的 OPERATOR_PURPLE_SCOPES，排在后面覆盖）。
const OPERATOR_SCOPES = ['keyword.operator']

// 逻辑操作符（`-not`）：用户口径「仍算关键词」——颜色拉回 keyword，字重补 bold（D-34）。
const LOGICAL_OPERATOR_SCOPES = ['keyword.operator.logical']

// ── 方案 B（社区扩展版，用户 2026-10-30 选定）新增的三个色位 ──
// 变量（`$Test` / `$p` 的 p 段；`$` 本身是 punctuation，不动）。
const VARIABLE_SCOPES = ['variable.other']
// 类型名（`[string]` / `[int]`）。
const TYPE_SCOPES = ['storage.type']
// 操作符里**只有**这四个子 scope 上紫：`-f` / `>` / `|` / 其它运算符。
// 故意不含 `keyword.operator.assignment`（会让参数前缀变色）、不含 `.logical`（`-not` 仍算关键词）。
const OPERATOR_PURPLE_SCOPES = [
  'keyword.operator.other',
  'keyword.operator.string-format',
  'keyword.operator.redirect',
  'keyword.operator.pipe',
]

// 关键词加粗：只命中 keyword.control.*（for/in/do/done/if/param …），不动操作符与类型名。
const BOLD_KEYWORD_SCOPES = ['keyword.control']

// 整段 token 都是数字（允许空格分隔的列表，如 `1 2 3`）才算数字字面量；
// 带引号的字符串 token 含引号，不会被误判成数字。
const NUMBER_TOKEN = /^\d+(?: \d+)*$/
const NUMBER_COLOR = 'var(--shiki-token-constant)'

function textInsteadOfString(base: ThemeRegistration): ThemeRegistration {
  return {
    ...base,
    tokenColors: [
      ...(base.tokenColors ?? []),
      { scope: BARE_ARGUMENT_SCOPES, settings: { foreground: 'var(--shiki-foreground)' } },
      { scope: NUMBER_SCOPES, settings: { foreground: NUMBER_COLOR } },
      { scope: OPERATOR_SCOPES, settings: { foreground: 'var(--shiki-foreground)' } },
      // 方案 B 的三条覆盖规则：颜色只写变量名（值在 App.tsx 的 codeColors 里），与
      // BARE_ARGUMENT_SCOPES 同一手法——highlight.ts 里不落裸色值（B-20 / D-34）。
      { scope: VARIABLE_SCOPES, settings: { foreground: 'var(--shiki-token-variable)' } },
      { scope: TYPE_SCOPES, settings: { foreground: 'var(--shiki-token-type)' } },
      { scope: OPERATOR_PURPLE_SCOPES, settings: { foreground: 'var(--shiki-token-operator)' } },
      // 逻辑操作符要排在 `keyword.operator` 之后：先把颜色从正文色拉回 keyword，再补加粗。
      { scope: LOGICAL_OPERATOR_SCOPES, settings: { foreground: 'var(--shiki-token-keyword)', fontStyle: 'bold' } },
      { scope: BOLD_KEYWORD_SCOPES, settings: { fontStyle: 'bold' } },
    ],
  }
}

// fontStyle: false —— 主题本身不带斜体/加粗（其它 scope 的高亮只改颜色，不改字重）；
// 唯一的例外是上面补的 keyword.control 加粗，它是在 `fontStyle: false` 之后追加的，不会被剥掉（D-34）。
const theme = textInsteadOfString(
  createCssVariablesTheme({ name: CARD_THEME, variablePrefix: '--shiki-', fontStyle: false }),
)


// 只认这两种语法：远程命令是 shellscript，本机命令行是 powershell。
const SHELL_LANGS = new Set(['sh', 'shell', 'bash', 'zsh', 'shellscript', 'console', 'shellsession'])
const PS_LANGS = new Set(['powershell', 'pwsh', 'ps1', 'ps', 'posh'])

// PowerShell 的强特征：变量赋值、Cmdlet-Noun、param 块。用来把「标成 sh 的 pwsh 命令」认回来
// （上游两个插件都把命令标成 sh，其中一家的命令其实是 pwsh）。三条都不命中就按 shell 处理。
const POWERSHELL_MARKERS: RegExp[] = [
  /^\s*\$[A-Za-z_]\w*\s*=/m,
  /\b[A-Z][A-Za-z0-9]+-[A-Z][A-Za-z0-9]+\b/,
  /^\s*(?:param\s*\(|#requires\b)/m,
]

// highlighter 只建一次：一次弹窗里有多段代码（正文块 + 每个命令行），语法与引擎都复用。
let highlighter: HighlighterCore | null = null
let broken = false

function getHighlighter(): HighlighterCore | null {
  if (highlighter !== null || broken) return highlighter
  try {
    highlighter = createHighlighterCoreSync({
      themes: [theme],
      langs: [shellscript, powershell],
      engine: createJavaScriptRegexEngine(),
    })
  } catch (error) {
    // 初始化失败是「不可重试的一次性故障」：记住它，后面每段代码都走纯文本，不再反复抛。
    broken = true
    console.warn('卡片代码高亮初始化失败，已退回纯文本：', error)
  }
  return highlighter
}

function detectLanguage(declared: string | undefined, code: string): 'shellscript' | 'powershell' | null {
  const name = (declared ?? '').trim().toLowerCase()
  if (PS_LANGS.has(name)) return 'powershell'
  // 认不出来的语言一律纯文本：不猜一个语法去涂色，涂错比不涂更难读。
  if (!SHELL_LANGS.has(name)) return null
  return POWERSHELL_MARKERS.some((marker) => marker.test(code)) ? 'powershell' : 'shellscript'
}

// 同一次弹窗里同一段代码会渲染两次（React 严格模式下更多），没必要重复分词。
const cache = new Map<string, HighlightLine[] | null>()

/**
 * 说明行前缀：**`#` 只在这里生成**。`App.tsx` 里不许出现 `'# '` 字面量（`tests/card-shell.ps1` 守着）。
 */
const COMMENT_PREFIX = '# '

/**
 * 说明 → 交给 shiki 的源码行：每行一个 `# `，多行说明就是多行 `# `。
 *
 * 用户 2026-11-10：「肯定要#号啊， 再说没有#你怎么让shiki渲染为注释的啊？你还有特殊处理？
 * 我不是说了他就作为标准内容放进去shiki自己会处理吗？你还特殊处理了？」
 * 上一版把说明单独做成「注释色 token」（textToken / commentLines）、还不拼 `#`，等于绕开 shiki
 * 自己上色：屏幕上少一个 `#`，说明也不算「代码内容」。现在它就是标准的那三行里的第一行。
 *
 * 空（或纯空白）说明按「没有说明」处理——载荷侧也是这么判的（空白说明不写 comment 键）。
 * 导出是给 CodeText 的纯文本回退用的：认不出语言时不着色，但 `#` 一样不能丢。
 */
export function commentSource(comment: string | undefined): string {
  if (comment === undefined) return ''
  // 换行统一成 \n，并丢掉首尾空行：说明末尾多一个换行不该在框里多出一行空白。
  const text = comment.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '')
  if (text.trim() === '') return ''
  return text.split('\n').map((line) => COMMENT_PREFIX + line).join('\n')
}

/**
 * 把一段代码分好词。返回 null = 按纯文本渲染（没有内容 / 语言认不出 / 高亮失败 / 拼不回原文）。
 * 纯同步函数：调用点拿到结果时高亮已经完成，不存在「先量高、后变色」的时间窗。
 *
 * 第三个参数 `comment` 是这段代码的说明：它由 `commentSource` 拼成 `# ` 开头的行，**和命令一起**
 * 交给 `codeToTokens`（`source = '# 说明\n' + 命令`）。颜色、折行、滚动、折叠因此全由同一条行流决定，
 * 而「拼回逐字等于 source」这条校验对**整段**成立——说明行也在里面，一个 `#` 都不例外。
 */
export function highlight(code: string, declared?: string, comment?: string): HighlightLine[] | null {
  // 换行统一成 \n：CRLF 在 WebView2 里本来也只按一次换行排版，拼回校验才有意义。
  const body = code.replace(/\r\n?/g, '\n')
  const head = commentSource(comment)
  // 没命令、也没说明：交给调用方按空内容处理。
  if (body === '' && head === '') return null

  const lang = detectLanguage(declared, body)
  // 认不出语言：整段退纯文本。`#` 由 CodeText 的 null 分支用 commentSource 补上（不着色，但要有 #）。
  if (lang === null) return null

  // 说明行在**前**、命令在后：屏幕上第一行就是 `# 说明`，与框里/复制前的那段原文一致。
  const source = head === '' ? body : (body === '' ? head : head + '\n' + body)

  // 缓存键必须带上说明：同一段命令配不同说明是不同的 source（说明已进 source，这里再显式带上
  // comment，防的是将来有人把说明挪出 source 又忘了改键）。
  const key = `${lang}\u0000${source}\u0000${comment ?? ''}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  let lines: HighlightLine[] | null = null
  try {
    const core = getHighlighter()
    if (core !== null) {
      const tokens = core.codeToTokens(source, { lang, theme: CARD_THEME }).tokens
      // 数字兜底（D-34）：`for i in 1 2 3` 的数字只有 string.unquoted.shell 这一层 scope，
      // 主题规则救不回来，按 token 文本把它拉回常量色。只改颜色、不改内容（下面的拼回校验照旧）。
      for (const line of tokens) {
        for (const token of line) {
          if (NUMBER_TOKEN.test(token.content.trim())) token.color = NUMBER_COLOR
        }
      }
      // 高亮只负责上色：拼回去必须与 source 逐字相同（**含 `#` 说明行**），否则宁可退回纯文本
      // （C-08：屏幕上的每一行都是原文，一个字都不许被改写）。
      const rebuilt = tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
      if (rebuilt === source) lines = tokens
    }
  } catch (error) {
    console.warn('卡片代码高亮失败，按纯文本渲染：', error)
  }

  // 一次弹窗的代码块数量是有限的；上限只是防止有人拿一张超长卡把缓存撑大。
  if (cache.size >= 64) cache.clear()
  cache.set(key, lines)
  return lines
}
