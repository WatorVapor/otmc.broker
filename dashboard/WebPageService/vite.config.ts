import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { serveIPC } from 'vite-plugin-serve-ipc'

export default defineConfig({
  plugins: [
    vue(),
    serveIPC({
      // 在 Unix 系统下监听此 Socket 文件
      path: '/var/run/otmc/dashboard.sock', 
      // 如果需要兼容 Windows，可以改为对象形式：
      // path: { unix: '/tmp/antdv-dev.sock', windows: '\\\\.\\pipe\\antdv-dev' }
    }),
  ],
})