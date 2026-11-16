import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 产物是**一个** HTML：JS 与 CSS 全部内联进去，PowerShell 直接把它当模板用。
// 运行时零构建，也不存在 file:// 加载 ES module 被 CORS 拦的问题。
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // WebView2 是常青 Chromium，不必为老浏览器降级。
    target: 'chrome110',
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    reportCompressedSize: false,
  },
})
