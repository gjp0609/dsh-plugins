import type { CardPayload } from '../types'

/** 开发态样例：勾选执行（三行命令，每行一个勾选框 + 代码框）。 */
export const selectFixture: CardPayload = {
  eyebrow: 'SSH · 执行确认',
  titleHtml: '<span class="card__title-path">C:\\work\\dsh-plugins</span>',
  armMs: 1000,
  rows: [
    { label: '192.168.1.11', why: '看一下根分区还剩多少', text: 'df -h /', meta: '工作目录 /root · 超时 30s' },
    {
      label: '192.168.1.12',
      why: '确认服务没挂',
      text: 'systemctl status nginx --no-pager',
      meta: '工作目录 /root · 超时 30s',
    },
    {
      label: '192.168.1.14',
      why: '确认为什么 502',
      text: 'tail -n 50 /var/log/nginx/error.log',
      meta: '工作目录 /etc/nginx',
      warn: '覆盖',
    },
  ],
  buttons: [
    { label: '跳过', action: 'skip', kind: 'default' },
    { label: '提交', action: 'submit', kind: 'primary', requiresChecked: true, labelCount: '提交 {n} 项' },
  ],
}
