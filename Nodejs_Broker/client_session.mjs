const gClients = new Map();

class ClientSession {
  constructor(socket) {
    this.socket = socket;
    this.subscriptions = new Set();
  }
  handlePacket(socket, packet) {
    switch (packet.cmd) {
      case 'connect':
        this.handleConnect(socket, packet);
        break;
      case 'publish':
        this.handlePublish(socket, packet);
        break;
      case 'subscribe':
        this.handleSubscribe(socket, packet);
        break;
      case 'pingreq':
        this.handlePingreq(socket);
        break;
      case 'disconnect':
        socket.end();
        break;
      default:
        console.log('未处理的包类型:', packet.cmd);
    }
  }

  handleConnect(socket, packet) {
    const clientId = packet.clientId || `client_${Math.random().toString(16).substring(2, 10)}`;
    socket.clientId = clientId;

    gClients.set(clientId, this);

    console.log(`[Connect] 客户端已连接: ${clientId}`);

    const connackPacket = mqttPacket.generate({
      cmd: 'connack',
      returnCode: 0,
      sessionPresent: false
    });
    socket.write(connackPacket);
  }

  handleSubscribe(socket, packet) {
    const granted = [];

    packet.subscriptions.forEach((sub) => {
      this.addSubscription(sub.topic);
      granted.push(sub.qos || 0);
      console.log(`[Subscribe] ${socket.clientId} 订阅了: ${sub.topic}`);
    });

    const subackPacket = mqttPacket.generate({
      cmd: 'suback',
      messageId: packet.messageId,
      granted
    });
    socket.write(subackPacket);
  }

  handlePublish(socket, packet) {
    const { topic, payload } = packet;
    console.log(`[Publish] 来自 ${socket.clientId} -> 主题 [${topic}]: ${payload.toString()}`);

    gClients.forEach((client, clientId) => {
      if (client.hasSubscription(topic)) {
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

  handlePingreq(socket) {
    const pingrespPacket = mqttPacket.generate({
      cmd: 'pingresp'
    });
    socket.write(pingrespPacket);
  } 

  addSubscription(topic) {
    this.subscriptions.add(topic);
  }

  removeSubscription(topic) {
    this.subscriptions.delete(topic);
  }

  hasSubscription(topic) {
    return this.subscriptions.has(topic);
  }
}

export { ClientSession };

