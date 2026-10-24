import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { serveIPC } from 'vite-plugin-serve-ipc'
import Components from 'unplugin-vue-components/vite'
import { AntdvNextResolver } from '@antdv-next/auto-import-resolver'
import { dirname,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))


// 末尾スラッシュを削除するカスタムプラグイン
const trailingSlashFix: Plugin = {
  name: 'trailing-slash-fix',
  // enforce: 'pre' を指定して、Viteの他のプラグインより先に実行されるようにする
  enforce: 'pre',
  configureServer(server) {
    // server.middlewares に直接追加されたミドルウェアは、
    // Viteの内部ミドルウェアより「前」に実行される（Pre-internal）
    server.middlewares.use((req, _res, next) => {
      // 修正対象のURLパターン:
      //  - /@vite/... で始まり、末尾が /
      //  - /@id/... で始まり、末尾が /
      if (req.url && /^\/@(vite|id)\/.+\/$/.test(req.url)) {
        // 末尾のスラッシュを削除
        req.url = req.url.replace(/\/$/, '')
      }
      next()
    })
  },
}

const unixSocketOption = {
  // 在 Unix 系统下监听此 Socket 文件
  path: '/var/run/otmc/dashboard.sock', 
  // 如果需要兼容 Windows，可以改为对象形式：
  // path: { unix: '/tmp/antdv-dev.sock', windows: '\\\\.\\pipe\\antdv-dev' }
}

export default defineConfig({
  plugins: [
    vue(),
    trailingSlashFix,
    serveIPC(unixSocketOption),
    Components({
      resolvers: [AntdvNextResolver()],
      dts: 'src/components.d.ts', // 自动生成组件类型声明（可选）
    }),
  ],
  server: {
    allowedHosts: ['.wator.xyz'],
    host: '0.0.0.0',
    port: 5173,
    hmr: {
      protocol: 'wss',          // 强制使用 wss 协议
      host: 'otmc-dashboard.wator.xyz', // 你的外部访问域名
      clientPort: 443,        // 你的 Nginx 监听端口
      path: '/__vite_hmr', // ← 指定 HMR WebSocket 的子路径
    },    
  },
  build: {
    rollupOptions: {
      input: {
        main:                 resolve(__dirname, 'index.html'),
        setup:                resolve(__dirname, 'setup/index.html'),
        'setup/edge':         resolve(__dirname, 'setup/edge/index.html'),
        'setup/leader':       resolve(__dirname, 'setup/leader/index.html'),
        'setup/follower':     resolve(__dirname, 'setup/follower/index.html'),
      },
    },
  },  
})

