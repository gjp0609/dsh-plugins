import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import 'antd/dist/reset.css'
import App from './App'
import { readPayload } from './payload'
import './styles.css'

// 挂载失败时把原因写进页面：空白卡等于没有信息，而一张写着「渲染失败：…」的图，
// 比翻 CDP 控制台快得多。
function reportCrash(reason: unknown): void {
  const root = document.getElementById('root')
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  if (root) {
    root.textContent = `渲染失败：${text}`
    root.setAttribute('data-crash', '1')
  }
}

window.addEventListener('error', (event) => reportCrash(event.error ?? event.message))
window.addEventListener('unhandledrejection', (event) => reportCrash(event.reason))

// 一律用 antd 的默认视觉：只保留桌面该有的字号与紧凑间距。
try {
  createRoot(document.getElementById('root')!).render(
    <ConfigProvider
      locale={zhCN}
      theme={{
        cssVar: true,
        token: {
          // 用户定过：整卡用等距更纱黑体 SC（英文名 Sarasa Mono SC），正文与代码都走它。
          fontFamily: "'等距更纱黑体 SC', 'Sarasa Mono SC', 'Cascadia Mono', Consolas, monospace",
          fontFamilyCode: "'等距更纱黑体 SC', 'Sarasa Mono SC', 'Cascadia Mono', Consolas, monospace",
          fontSize: 14,
          borderRadius: 6,
          controlHeight: 32,
        },
      }}
    >
      <App payload={readPayload()} />
    </ConfigProvider>,
  )
} catch (error) {
  reportCrash(error)
}
