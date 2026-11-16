import type { CardPayload } from '../types'

/** 开发态样例：提权审批（两个按钮 + 理由 + 命令，禁键盘）。 */
export const approvalFixture: CardPayload = {
  eyebrow: 'Write · 提权审批',
  titleHtml: '<span class="card__title-path">C:\\work\\dsh-plugins</span>',
  armMs: 1000,
  closeMs: 600000,
  keyboard: 'none',
  // 说明走 comment、渲染成框内第一行 `# 说明`（B-31），不再单独占一个 note 块：
  // 说明和命令待在一起才读得顺，而复制时它又不会进剪贴板（B-32）。
  body: [
    {
      kind: 'code',
      command:
        '$ Set-Content -LiteralPath "C:\\work\\dsh-plugins\\.session-files\\tmp\\answer.json" -Value \'{"ok":true}\' -Encoding utf8',
      lang: 'sh',
      comment: '把这次的审批结果写进插件的会话数据目录，方便下一轮继续用（写入路径限定在 .session-files 下）。',
    },
  ],
  buttons: [
    { label: '拒绝', action: 'rejected', kind: 'default' },
    { label: '允许一次', action: 'allowed-once', kind: 'primary' },
  ],
}
