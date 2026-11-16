/**
 * 审批：把待执行的行变成一张多选卡，再把回来的标签映射回行号。
 *
 * 三条硬规则（来自设计 K-001 / K-008）：
 * - 审批与执行在同一次工具调用里闭环，绝不拆成「先提案、再执行」；
 * - 空选择（点「跳过」或一项不勾）＝ 全部跳过，绝不默认执行；
 * - 关卡片只是收起，工具会继续等——所以这里只 await，不做超时猜测。
 *
 * 卡只有一张：共享外壳的 WebView2 卡（C-10）。宿主内置的问题弹窗不再参与 ssh 的审批，
 * 它连兜底都不是——卡片起不来就让命令失败、重试即可（AGENTS §4）。
 */
import { targetLabel } from './hosts.mjs'

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳']

export class ApprovalUnavailableError extends Error {
  constructor(message = '当前会话没有可用的审批通道，已拒绝在没有人工确认的情况下执行') {
    super(message)
    this.name = 'ApprovalUnavailableError'
  }
}

export class ApprovalTooLargeError extends Error {
  constructor(count, maxRows) {
    super(`这次有 ${count} 行要审批，超过单卡上限 ${maxRows} 行；请拆成多次调用，每次不超过 ${maxRows} 行`)
    this.name = 'ApprovalTooLargeError'
    this.count = count
    this.maxRows = maxRows
  }
}

function short(text, limit) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/**
 * 围栏长度要超过正文里最长的反引号串。
 *
 * 用固定 ``` 时，命令里只要带一行 ``` 就能提前闭合围栏，后面的内容变成正文——
 * 卡上看起来多出一块「会执行」的命令，实际执行的仍是原始字符串（含围栏）。
 * 审批卡的全部价值就是「看到什么就是执行什么」，这里必须挡住。
 */
function fenceFor(text) {
  const runs = String(text ?? '').match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * 让标签不再以「（推荐）」/「(recommended)」结尾。
 *
 * DSH 的问答卡片有个约定：以该后缀结尾的选项会被**默认勾上**（后缀在显示时被剥掉）。
 * 主机名恰好叫「生产（推荐）」时，用户什么都没勾、直接提交就会执行那一行。
 * 插一个零宽空格：显示一模一样，约定不再命中。
 */
function deRecommend(label) {
  return String(label).replace(/([（(]\s*(?:推荐|recommended)\s*[)）])$/i, (suffix) =>
    suffix.replace(/([)）])$/, '\u200b$1'),
  )
}

/**
 * 构造审批卡。
 *
 * 正文**只用两种构造**：一行粗体定位（`**目标** · 附加信息`）+ 一块围栏代码。
 * 踩过的坑按顺序记录：
 * 1. 四列表格在窄弹窗里把长路径从中间折断，「目标」列还会重复写 `A → A`；
 * 2. 改成「每个字段一行」后更糟——Markdown 把单个换行当软换行，整块被压成一整行；
 * 3. 标题后面紧跟列表，块级元素各占一行，但每种构造都自带一套样式，
 *    卡里同时出现段落、列表、代码块、引用四种块，看上去像四张卡叠在一起。
 * 4. 只剩一种构造之后，单行卡片里那行标题又成了废话：选项行就写着
 *    `WSL(Debian)`，正文顶上的 `**WSL(Debian)**` 是把同一句念两遍。
 * 所以代码行现在只有两段：标题 + 代码块（原因作为首行注释），
 * 列表只留给搬运那类确实有「源/目标/原因」三段信息的行；
 * 只有一行且没有附加信息时，标题整行不出。
 *
 * @param rows - 一行＝一次可独立勾选的操作：
 *   - `target`：标题里的目标，例如 `Web 1 + Web 2`
 *   - `head`：选项那一行用的短名，通常是目标
 *   - `meta`：标题后的短信息，例如 `目录 5 项 · ⚠ 覆盖`
 *   - `fields`：正文的 `[{ label, value }]`，每项一行（值里可用反引号）
 *   - `code`：命令文本，用围栏代码块显示（与 fields 二选一）
 *   - `text` / `lang`：**桌面卡**框内的正文与高亮语言（例如搬运卡的 `Source: …` / `Target: …`
 *     配 `lang: 'text'`）；给了 `text` 就不再从 `fields` 拼卡片正文
 *   - `why`：原因；有 `code` 时写成代码块首行注释，否则桌面卡上写成框内第一行 `# 原因`
 * @param eyebrow - 桌面卡的抬头（如 `SSH · 导入主机`）；不给就用外壳的默认「SSH · 执行确认」
 * @param maxRows - 行数上限（默认 8）
 */
export function buildApprovalQuestion({ id = 'approve', header, question, intro, rows, maxRows = 8, note, eyebrow = '' }) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('没有需要审批的内容')
  if (rows.length > maxRows) throw new ApprovalTooLargeError(rows.length, maxRows)

  const mark = (index) => CIRCLED[index] ?? `(${index + 1})`

  // 选项那一行只表达「哪一台 / 哪一项」（B-23）：它紧贴在正文下面，正文里已经有命令、路径与原因。
  // 以前重名时退回 `目标 · 命令首行`，长命令被 `short()` 截成看不懂的半句，还把主机名挤掉了；
  // 现在一律只写目标，重名就加 ① ② ③——编号的职责是让勾选映射回行号，正文块标题同步带编号。
  const heads = rows.map((row) => row.head ?? row.target)
  const baseLabels = heads.map((head) => short(head, 56))
  const needMark = new Set(baseLabels).size !== baseLabels.length
  const options = baseLabels.map((label, index) => ({
    label: needMark ? `${mark(index)} ${deRecommend(label)}` : deRecommend(label),
  }))

  // 桌面卡片用纯文本版本：去掉 Markdown 记号，也不重复那行目标（勾选框上已经写了）。
  const plain = []
  const blocks = rows.map((row, index) => {
    const meta = typeof row.meta === 'string' ? row.meta : ''
    // 只有一行时，选项那一行已经写着目标了，正文再顶一行 `**WSL(Debian)**`
    // 是把同一句话念两遍——去掉；带附加信息（`工作目录 /tmp`、`⚠ 覆盖`）时
    // 保留，但那段信息才是有用的部分。需要 ①② 时标题也必须带编号，
    // 否则人只能数块对位，近似主机名下很容易勾错行。
    const showHead = rows.length > 1 || meta !== '' || needMark
    const heading = needMark ? `${mark(index)} ${row.target}` : row.target
    const lines = []
    if (showHead) {
      // 标题与后面的块之间必须空一行：紧贴着写，列表会被并进标题那段里。
      lines.push(meta === '' ? `**${heading}**` : `**${heading}** · ${meta}`, '')
    }

    if (row.code !== undefined) {
      // 整行只用两种构造：一行粗体定位 + 一块命令。
      // 原因写成代码块的注释——它不是执行内容，但必须和执行内容待在一起，
      // 复制命令时顺带带走上下文，也不会多出一种带圆点的列表项。
      // `\r` 也要折叠：CommonMark 把单独的 CR 当换行，留着它能让围栏提前闭合，
      // 于是卡上多出一块「看起来会执行、实际不在命令里」的伪造内容。
      const why = String(row.why ?? '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
      const code = String(row.code)
      // 围栏长度必须超过正文里最长的反引号串：命令里带 ``` 就能提前闭合围栏、
      // 在卡上伪造出另一块内容，而真正执行的仍是原始字符串——显示 ≠ 执行。
      const fence = fenceFor(code)
      lines.push(`${fence}sh`, why === '' ? code : `# ${why}`, code, fence)
      plain.push({ why, text: code, meta })
      return lines.join('\n')
    }

    const plainLines = []
    for (const field of row.fields ?? []) {
      lines.push(`- ${field.label}：${field.value}`)
      plainLines.push(`${field.label}：${field.value}`)
    }
    if (row.why !== undefined && row.why !== '') {
      lines.push(`- 原因：${row.why}`)
      plainLines.push(`原因：${row.why}`)
    }
    // 行自带卡片正文（`text` + `lang`）时照抄：搬运卡的两行 `Source:` / `Target:` 是**说明文字**，
    // 不是命令，必须不带反引号、也不按 shell 高亮（D-37）。没有 `text` 的行仍从 `fields` 拼
    // （`源：…`），两份措辞不同但行数据只有一份。
    if (row.text !== undefined) {
      plain.push({ why: String(row.why ?? ''), text: String(row.text), meta, lang: String(row.lang ?? '') })
    } else {
      // 没有正文的行（例如批量导入的多选卡：标题已经写完是哪台，正文只会重复）也要把 `lang` 带下去：
      // 它是行协议的一部分，外壳按「键在不在」决定高亮方式；正文为空时外壳不画代码框。
      plain.push({ why: '', text: plainLines.join('\n'), meta, lang: String(row.lang ?? '') })
    }
    return lines.join('\n')
  })

  const parts = []
  if (typeof intro === 'string' && intro !== '') parts.push(intro, '')
  parts.push(blocks.join('\n\n'))
  // 默认不追加脚注：每多一种块（引用、段落）就多一套自带样式，
  // 「不勾＝不执行」这类规则放进 question 那行就够了。
  if (typeof note === 'string' && note !== '') parts.push('', note)

  return {
    id,
    header: header ?? '需要确认',
    question: question ?? '勾选要执行的行',
    eyebrow,
    detail: parts.join('\n'),
    // 每行自己的那段正文（与 options 一一对应）：桌面卡片要把「勾选框」和「它的命令」放在一起，
    // 不能把 N 行合成一大坨文字——多行时分不清哪段属于哪一行。
    rowDetails: blocks,
    rowPlain: plain,
    multiSelect: true,
    options,
  }
}

/**
 * 卡片抬头下面那行（`workDir`）该显示什么：**当前会话的工作区**。
 *
 * 为什么要从 exec 里取：卡片在桌面上冒出来时没有会话上下文，这一行是用户唯一能认出
 * 「这是哪个项目」的线索。`process.cwd()` 是**宿主进程**的工作目录（本机从
 * `%USERPROFILE%` 起），跟用户打开的项目没关系——2026-11-12 用户原话：
 * 「这个路径也不对 不是工作目录的路径」。
 *
 * 取 `exec.agent.session.header.cwd`：`SessionHeader.cwd` 的定义就是「会话创建时的绝对
 * 工作目录」（@deepseek-ai/dsh-session 的 SessionHeader；`ToolExecutionInput.agent` 由
 * 宿主 agent loop 传入，见 @deepseek-ai/dsh-tools 的 ToolExecutionInput）。
 * 它与会话日志里那一行头部是同一个值，所以卡片显示的就是会话自己的工作区。
 *
 * 没有 session 时退回 `process.cwd()`：headless / SDK 直接调工具时没有会话，也就没有
 * 「工作区」可显示——这是**能力缺失**，不是兜底。
 *
 * @param exec - 工具执行上下文（`execute(args, exec)` 的第二个参数）
 * @param fallback - 测试用：默认宿主进程的工作目录
 * @returns 绝对路径；`exec` 里没有会话时是 `fallback`
 */
export function resolveWorkDir(exec, fallback = process.cwd()) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : fallback
}

/**
 * 卡片审批通道：把审批问题接到共享外壳的桌面卡片上，返回一个「问一次、拿回勾选行」的函数。
 *
 * 它不挑通道——C-10 之后 ssh 的审批只有桌面卡这一条路（宿主内置弹窗已删），
 * 所以没有卡片可用时返回 undefined，由 `askApproval` 直接拒绝执行。
 *
 * 详情原样进只读框，选项就是各行标签；返回勾选的行下标，关窗口＝一行都不选。
 * 没有 dialog（或它没有 selectRows）时返回 undefined——调用方就没有卡片可用了。
 *
 * `signal` 必须一路送到 `selectRows`（D-26）：卡片子进程不接取消信号时，宿主点「停止」
 * 只会让工具 body 一直挂着（宿主语义是「body 不 settle，取消不生效」），
 * 卡在屏幕上的窗口直到重启宿主才消失。传下去之后子进程被强杀，卡片按「跳过」结算。
 *
 * @param dialog - 桌面卡桥（`admin.mjs` 的 `selectRows`）
 * @param workDir - 抬头下面那行显示的项目路径；调用方一律传 `resolveWorkDir(exec)`（R-25）
 */
export function cardApprovalChannel(dialog, workDir = process.cwd()) {
  if (dialog === undefined || dialog === null || typeof dialog.selectRows !== 'function') return undefined
  return async (question, { signal } = {}) => {
    const rows = question.options.map((option, index) => {
      const plain = question.rowPlain?.[index]
      return {
        label: option.label,
        why: String(plain?.why ?? ''),
        text: String(plain?.text ?? ''),
        // 附加信息（工作目录 / 超时 / ⚠ 覆盖）与勾选行分开：同一次审批在卡上必须看到同样的东西。
        meta: String(plain?.meta ?? ''),
        // 高亮语言：搬运卡的行是说明文字（`text` = 不渲染高亮），run 卡的行是真命令（空 = 按 sh）。
        lang: String(plain?.lang ?? ''),
      }
    })
    const result = await dialog.selectRows({
      rows,
      // 抬头：审批卡缺省由外壳给（「SSH · 执行确认」）；批量导入那类卡自己带一个（`question.eyebrow`）。
      eyebrow: String(question.eyebrow ?? ''),
      // 抬头下面那行：会话工作区（R-25）。调用方传 `resolveWorkDir(exec)` 的结果；
      // 直接构造通道时（测试）退回宿主进程的工作目录。
      workDir,
      // 取消信号不是可选装饰：没有它，「停止」在卡片挂住时就是死键（D-26）。
      signal,
    })
    if (result?.answered !== true) return []
    const indexByLabel = new Map(question.options.map((option, index) => [option.label, index]))
    const picked = new Set()
    for (const label of result.selected ?? []) {
      const index = indexByLabel.get(label)
      if (index !== undefined) picked.add(index)
    }
    return [...picked].sort((a, b) => a - b)
  }
}

/**
 * 弹卡等答案：**只有桌面卡这一条路**（C-10）。
 *
 * 这条是硬约束，不是「优先」：
 * - 卡片在 → 只走它（共享外壳的 WebView2 卡，勾选 / 确认 / 密码同一套界面）。它抛错就原样抛给
 *   调用方，不静默切到别的通道：换了通道，人还以为自己批准的是刚才那张卡。
 * - 卡片不在（没 dialog / 没有 `selectRows`）→ 直接抛 `ApprovalUnavailableError` 让人重试。
 *   没有第二张审批界面、也没有逐条 allow-once 的旁路——AGENTS §4：卡片起不来就让命令失败。
 * @param fallbackSelect - 桌面卡片：`(question, { signal }) => Promise<number[]>`，空数组＝一行都不选
 * @param signal - 本次工具调用的取消信号（`exec.signal`）：原样交给卡片，让它能被子进程强杀（D-26）
 * @returns `{ indices }`；为空表示全部跳过
 * @throws ApprovalUnavailableError - 没有卡片构建器时（拒绝执行，重试即可）
 */
export async function askApproval({ question, fallbackSelect, signal }) {
  if (typeof fallbackSelect !== 'function') {
    throw new ApprovalUnavailableError(
      '没有可用的审批卡片（dialog 的 selectRows 未就绪），已拒绝在没有人工确认的情况下执行；请重试',
    )
  }
  // 关窗口/点跳过＝空数组，与「不勾＝不执行」一致；这里只 await，不做超时猜测。
  // 取消也**不在这里抢答**：交给卡片，子进程被强杀后按「没勾选」结算（D-26），
  // 这里另起一条 abort 竞速只会让卡片窗口留在屏幕上没人收。
  return { indices: await fallbackSelect(question, { signal }) }
}

/** 卡片里用的目标名（remote 用标签，wsl 用 `WSL(Debian)`）。 */
export function labelsOf(targets) {
  return targets.map(targetLabel).join(' + ')
}
