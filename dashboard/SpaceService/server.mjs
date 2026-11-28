// server.mjs — unix-socket bootstrap for the Space certificate signing API.
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';

import { createApp, DEFAULT_TEMP_DIR } from './app.mjs';

const SOCKET_PATH = `${DEFAULT_TEMP_DIR}/space.api.sock`;

// 清理可能存在的旧 socket 文件
await fs.rm(SOCKET_PATH, { force: true }).catch(() => {});

const app = createApp();

const server = createServer(app);

server.listen(SOCKET_PATH, () => {
  console.log(`sign-api ready on unix socket: ${SOCKET_PATH}`);
  // 设置 socket 文件权限（可选，根据需要调整）
  fs.chmod(SOCKET_PATH, 0o777).catch(console.error);
});
