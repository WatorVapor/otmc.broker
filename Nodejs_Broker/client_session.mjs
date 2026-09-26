import mqttPacket from 'mqtt-packet';
import crypto from 'node:crypto';

const gClients = new Map();
const pendingChallenges = new Map();

const MQTT_5_OPTION = {
  protocolVersion: 5 
};
const MQTT_5_REASON_CODE_CONTINUE_AUTH = 0x18


class ClientSession {
  constructor(socket) {
    this.socket = socket;
    this.internal = new ClientSessionInternal();
    this.parser = mqttPacket.parser();

    this.parser.on('packet', (packet) => {
      this.handlePacket(socket, packet);
    });

  }
  handlePacket(socket, packet) {
    switch (packet.cmd) {
      case 'connect':
        this.internal.handleConnect(socket, packet, this);
        break;
      case 'publish':
        this.internal.handlePublish(socket, packet);
        break;
      case 'subscribe':
        this.internal.handleSubscribe(socket, packet);
        break;
      case 'pingreq':
        this.internal.handlePingreq(socket);
        break;
      case 'disconnect':
        socket.end();
        break;
      default:
        console.log('未处理的包类型:', packet.cmd);
    }
  }
  parse(chunk) {
    try {
      this.parser.parse(chunk);
    } catch (error) {
      console.log('Raw data (hex):', chunk.slice(0, 10).toString('hex'));
      console.error('解析 MQTT 包时出错:', error);
    }
  }
  delete(clientId) {
    gClients.delete(clientId);
  }
}
export { ClientSession,gClients };

class ClientSessionInternal {
  constructor() {
    this.subscriptions = new Set();
  }
  handleConnect(socket, packet,client) {
    console.log('ClientSessionInternal:handleConnect:packet=<',packet,'>');
    const clientId = packet.clientId || `client_${Math.random().toString(16).substring(2, 10)}`;
    socket.clientId = clientId;
    gClients.set(clientId, client);
    console.log('ClientSessionInternal:handleConnect:clientId=<',clientId,'>');
    if(packet && packet.properties && packet.properties.userProperties) {
      console.log('ClientSessionInternal:handleConnect:packet.properties.userProperties=<',packet.properties.userProperties,'>');
    }
    const challenge = crypto.randomBytes(32);
    pendingChallenges.set(clientId, challenge);
    console.log('ClientSessionInternal:handleConnect:challenge=<',challenge.toString('base64'),'>');
    const responsePacketObj = {
      cmd: 'auth',
      reasonCode: MQTT_5_REASON_CODE_CONTINUE_AUTH,
      properties: { 
        authenticationMethod: 'certchain', 
        authenticationData: challenge.toString('base64')
      }
    };

    console.log('ClientSessionInternal:handleConnect:responsePacketObj=<',responsePacketObj,'>');
    const authPacket = mqttPacket.generate(responsePacketObj,MQTT_5_OPTION);
    console.log('ClientSessionInternal:handleConnect:authPacket=<',authPacket,'>');
    socket.write(authPacket);
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
    },MQTT_5_OPTION);
    socket.write(subackPacket);
  }

  handlePublish(socket, packet) {
    const { topic, payload } = packet;
    console.log(`[Publish] 来自 ${socket.clientId} -> 主题 [${topic}]: ${payload.toString()}`);

    gClients.forEach((client, clientId) => {
      if (client.internal.hasSubscription(topic)) {
        const pubPacket = mqttPacket.generate({
          cmd: 'publish',
          topic,
          payload,
          qos: 0,
          retain: false,
          dup: false
        },MQTT_5_OPTION);
        client.socket.write(pubPacket);
        console.log(`  └─> 转发给: ${clientId}`);
      }
    });
  }

  handlePingreq(socket) {
    const pingrespPacket = mqttPacket.generate({
      cmd: 'pingresp'
    },MQTT_5_OPTION);
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