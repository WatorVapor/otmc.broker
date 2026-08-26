import net from 'net';
import fs from 'fs';
import { ClientSession } from './client_session.mjs';
const SOCKET_PATH = '/tmp/mqtt/mqtt.sock';
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}
const server = net.createServer((socket) => {
  const clientSession = new ClientSession(socket);
  socket.on('data', (chunk) => {
    clientSession.parse(chunk);
  });

  socket.on('close', () => {
    if (socket.clientId) {
      clientSession.delete(socket.clientId)
      console.log(`[Disconnect] 客户端已断开: ${socket.clientId}`);
    }
  });

  socket.on('error', (err) => {
    console.error(`[Error] Socket 错误 (${socket.clientId || 'unknown'}):`, err.message);
  });
});


// 监听 Unix Socket 文件路径
server.listen(SOCKET_PATH, () => {
  console.log(`MQTT Broker 已启动，监听 Unix Socket: ${SOCKET_PATH}`);  
  // 赋予 socket 文件可读写权限，避免其他进程连接时权限不足
  fs.chmodSync(SOCKET_PATH, '0777');
});

// 优雅退出：进程关闭时自动清理 socket 文件
const cleanup = () => {
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
