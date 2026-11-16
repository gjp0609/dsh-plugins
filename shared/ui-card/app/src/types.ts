/** 卡片载荷：PowerShell 只产这份 JSON，页面是唯一的渲染源。 */
export interface CardButton {
  label: string
  /** 决定时原样回传，宿主据此分派（例如 allowed-once / rejected / skipped）。 */
  action: string
  /** 只有 primary 与 default 两种；老载荷里的 none / outline 一律按 default 渲染。 */
  kind?: 'primary' | 'default' | 'none' | 'outline'
  /** 有可选行时用：至少选一行才可点。 */
  requiresChecked?: boolean
  /** 计数模板，含 {n}；缺省不显示计数。 */
  labelCount?: string
}

export interface NoteBlock {
  kind: 'note'
  text: string
  muted?: boolean
}

export interface CodeBlock {
  kind: 'code'
  command: string
  /** 语言标记：`sh` 族 / `powershell` 族会走高亮，认不出来的一律纯文本（见 highlight.ts）。 */
  lang?: string
  /**
   * 这条命令的说明（B-31）：渲染成框内第一行 `# 原因`，与多选卡的行内命令框同一个形态。
   * 说明必须留在框里、但**不进剪贴板**（B-32）：复制出去的是命令本体。
   */
  comment?: string
}

export type CardBlock = NoteBlock | CodeBlock

/** 一行可选行（checkbox）：一行就是一个执行单位。 */
export interface CardRow {
  /** 目标标签（主机名），与 checkbox 同一行。 */
  label: string
  /** 为什么执行这条：渲染成代码框第一行注释（`# …`）。 */
  why?: string
  /** 命令原文：代码框主体。说明文字（搬运卡的 `Source:` / `Target:`）也走这个字段。 */
  text?: string
  /**
   * 高亮语言：缺省按 `sh` 高亮（`ssh_run` 的行就是一条真命令）；
   * 搬运卡这类说明文字给 `text`，表示**不渲染高亮**，按纯文本原样显示（见 highlight.ts 的 detectLanguage：
   * 认不出的语言一律纯文本）。
   */
  lang?: string
  /** cwd / 超时这类附加信息：代码框底部那一条。 */
  meta?: string
  /** 「覆盖」这类警告：渲染在主机那一行右侧（带 ⚠ 前缀）。 */
  warn?: string
}

/** 卡片只有两种形态：可勾列表（`rows`）与只读正文 + 按钮（`body` + `buttons`）。 */
export interface CardPayload {
  eyebrow?: string
  /** 已由 PowerShell 转义的标题片段（路径 / 主机标签）；没有就不渲染标题行。 */
  titleHtml?: string
  status?: string
  body?: CardBlock[]
  rows?: CardRow[]
  buttons?: CardButton[]
  /** 防误点毫秒数：窗口显示后（shown）这么久以内，按钮不可点。 */
  armMs?: number
  /** 自动到点毫秒数：>0 时页脚显示倒计时，到点发 expired。 */
  closeMs?: number
  /** 整块禁用键盘（只认鼠标的卡）。 */
  keyboard?: 'default' | 'none'
}
