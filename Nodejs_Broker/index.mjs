import net from 'net';
import fs from 'fs';
import mqttPacket from 'mqtt-packet';
const SOCKET_PATH = '/tmp/mqtt.sock';
const clients = new Map();
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}
const server = net.createServer((socket) => {
  const parser = mqttPacket.parser();

  parser.on('packet', (packet) => {
    handlePacket(socket, packet);
  });

  socket.on('data', (chunk) => {
    parser.parse(chunk);
  });

  socket.on('close', () => {
    if (socket.clientId) {
      clients.delete(socket.clientId);
      console.log(`[Disconnect] 客户端已断开: ${socket.clientId}`);
    }
  });

  socket.on('error', (err) => {
    console.error(`[Error] Socket 错误 (${socket.clientId || 'unknown'}):`, err.message);
  });
});

function handlePacket(socket, packet) {
  switch (packet.cmd) {
    case 'connect':
      handleConnect(socket, packet);
      break;
    case 'publish':
      handlePublish(socket, packet);
      break;
    case 'subscribe':
      handleSubscribe(socket, packet);
      break;
    case 'pingreq':
      handlePingreq(socket);
      break;
    case 'disconnect':
      socket.end();
      break;
    default:
      console.log('未处理的包类型:', packet.cmd);
  }
}

function handleConnect(socket, packet) {
  const clientId = packet.clientId || `client_${Math.random().toString(16).substring(2, 10)}`;
  socket.clientId = clientId;

  clients.set(clientId, {
    socket,
    subscriptions: new Set()
  });

  console.log(`[Connect] 客户端已连接: ${clientId}`);

  const connackPacket = mqttPacket.generate({
    cmd: 'connack',
    returnCode: 0,
    sessionPresent: false
  });
  socket.write(connackPacket);
}

function handleSubscribe(socket, packet) {
  const client = clients.get(socket.clientId);
  const granted = [];

  if (client) {
    packet.subscriptions.forEach((sub) => {
      client.subscriptions.add(sub.topic);
      granted.push(sub.qos || 0);
      console.log(`[Subscribe] ${socket.clientId} 订阅了: ${sub.topic}`);
    });
  }

  const subackPacket = mqttPacket.generate({
    cmd: 'suback',
    messageId: packet.messageId,
    granted
  });
  socket.write(subackPacket);
}

function handlePublish(socket, packet) {
  const { topic, payload } = packet;
  console.log(`[Publish] 来自 ${socket.clientId} -> 主题 [${topic}]: ${payload.toString()}`);

  clients.forEach((client, clientId) => {
    if (client.subscriptions.has(topic)) {
      const pubPacket = mqttPacket.generate({
        cmd: 'publish',
        topic,
        payload,
        qos: 0,
        retain: false,
        dup: false
      });
      client.socket.write(pubPacket);
      console.log(`  └─> 转发给: ${clientId}`);
    }
  });
}

function handlePingreq(socket) {
  const pingrespPacket = mqttPacket.generate({
    cmd: 'pingresp'
  });
  socket.write(pingrespPacket);
}

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
