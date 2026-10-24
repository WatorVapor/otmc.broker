import { defineConfig, HtmlTagDescriptor, Plugin } from 'vite'
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


const CDN = 'https://cdn.jsdelivr.net/npm';

const importMap = {
  'vue': `${CDN}/vue@3.5.13/+esm`,
  'dayjs': `${CDN}/dayjs@1.11.10/+esm`,
  'antd': `${CDN}/antdv-next@1.7.0/+esm`,
  'mqtt': `${CDN}/mqtt@5.15.1/+esm`,
  'echarts': `${CDN}/echarts@6.1.0/+esm`,
} as const


const injectImportMap: Plugin = {
  name: 'inject-import-map',
  transformIndexHtml() {
    const tag: HtmlTagDescriptor = {
      tag: 'script',
      attrs: { type: 'importmap' },
      children: JSON.stringify({ imports: importMap }, null, 2),
      injectTo: 'head-prepend', // ⚠️ 关键：必须在任何 module script 之前
    }
    return [tag]
  },
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
    injectImportMap,
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
      //external: ['vue', 'antdv-next', 'dayjs','mqtt', 'echarts'],
      input: {
        main:                 resolve(__dirname, 'index.html'),
        setup:                resolve(__dirname, 'setup/index.html'),
        'setup/edge':         resolve(__dirname, 'setup/edge/index.html'),
        'setup/leader':       resolve(__dirname, 'setup/leader/index.html'),
        'setup/follower':     resolve(__dirname, 'setup/follower/index.html'),
      },
      output: {
        // 为外部依赖提供全局变量名，指向 CDN 上的 UMD 版本
        /*
        globals: {
          vue: 'Vue',
          'antdv-next': 'antd', // 关键：你的代码中 import 'antdv-next' 会被映射到全局的 antd 变量
          dayjs: 'dayjs'
        }
        */
      }      
    },
  },  
})

