import mqttPacket from 'mqtt-packet';
import crypto from 'node:crypto';
import { ClientCertificate } from './client_certificate_.mjs';

const gClients = new Map();
const pendingChallenges = new Map();

const MQTT_5_OPTION = {
  protocolVersion: 5
};
const MQTT_5_REASON_CODE_CONTINUE_AUTH = 0x18;
const MQTT_5_REASON_CODE_SUCCESS = 0x00;
const MQTT_5_REASON_CODE_NOT_AUTHORIZED = 0x87;

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
      case 'auth':
        this.internal.handleAuth(socket, packet, this);
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

export { ClientSession, gClients };

class ClientSessionInternal {
  constructor() {
    this.subscriptions = new Set();
  }

  handleConnect(socket, packet, client) {
    console.log('ClientSessionInternal:handleConnect:packet=<', packet, '>');
    const clientId = packet.clientId || `client_${Math.random().toString(16).substring(2, 10)}`;
    socket.clientId = clientId;
    gClients.set(clientId, client);
    console.log('ClientSessionInternal:handleConnect:clientId=<', clientId, '>');

    if (packet && packet.properties && packet.properties.userProperties) {
      console.log('ClientSessionInternal:handleConnect:packet.properties.userProperties=<', packet.properties.userProperties, '>');
    }

    const challenge = crypto.randomBytes(32);
    pendingChallenges.set(clientId, challenge);
    console.log('ClientSessionInternal:handleConnect:challenge=<', challenge.toString('base64'), '>');

    const responsePacketObj = {
      cmd: 'auth',
      reasonCode: MQTT_5_REASON_CODE_CONTINUE_AUTH,
      properties: {
        authenticationMethod: 'certchain',
        authenticationData: challenge.toString('base64')
      }
    };

    console.log('ClientSessionInternal:handleConnect:responsePacketObj=<', responsePacketObj, '>');
    const authPacket = mqttPacket.generate(responsePacketObj, MQTT_5_OPTION);
    console.log('ClientSessionInternal:handleConnect:authPacket=<', authPacket, '>');
    socket.write(authPacket);
  }

  handleAuth(socket, packet) {
    console.log('ClientSessionInternal:handleAuth:packet=<', packet, '>');

    const props = packet.properties || {};
    if (props.authenticationMethod !== 'certchain') {
      console.log('ClientSessionInternal:handleAuth:unsupported authenticationMethod:', props.authenticationMethod);
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED, true);
      return;
    }

    const rawAuthData = props.authenticationData;
    if (!rawAuthData) {
      console.log('ClientSessionInternal:handleAuth:missing authenticationData');
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED, true);
      return;
    }

    let authDataStr = '';
    if (Buffer.isBuffer(rawAuthData)) {
      authDataStr = rawAuthData.toString('utf8');
    } else if (typeof rawAuthData === 'string') {
      authDataStr = rawAuthData;
    } else {
      authDataStr = String(rawAuthData);
    }

    console.log('ClientSessionInternal:handleAuth:authData=<', authDataStr, '>');

    let authDataJson;
    try {
      authDataJson = JSON.parse(authDataStr);
    } catch (error) {
      console.log('ClientSessionInternal:handleAuth:invalid authData JSON:', error.message);
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED, true);
      return;
    }

    const clientCert =
      authDataJson.cert ||
      authDataJson.certificate ||
      authDataJson.chain ||
      authDataJson.certChain;

    console.log('ClientSessionInternal:handleAuth:clientCert=<', clientCert, '>');

    const cltCert = new ClientCertificate(clientCert);

    const isValid = cltCert.isValid();
    console.log('ClientSessionInternal:handleAuth:isValid=<', isValid, '>');

    if (!isValid) {
      console.log('ClientSessionInternal:handleAuth:Invalid certificate chain');
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED, true);
      return;
    }
    const pubKeyHash = cltCert.getPublicKeyHash();
    console.log('ClientSessionInternal:handleAuth:pubKeyHash=<', pubKeyHash, '>');

    this.sendConnack(socket, MQTT_5_REASON_CODE_SUCCESS, false);
  }

  sendConnack(socket, reasonCode, endSocket) {
    const connackPacketObj = {
      cmd: 'connack',
      reasonCode,
      sessionPresent: false,
      properties: {}
    };
    const connackPacket = mqttPacket.generate(connackPacketObj, MQTT_5_OPTION);
    console.log('ClientSessionInternal:sendConnack:connackPacket=<', connackPacket, '>');
    socket.write(connackPacket);
    if (endSocket) {
      socket.end();
    }
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
    }, MQTT_5_OPTION);

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
        }, MQTT_5_OPTION);

        client.socket.write(pubPacket);
        console.log(`  └─> 转发给: ${clientId}`);
      }
    });
  }

  handlePingreq(socket) {
    const pingrespPacket = mqttPacket.generate({
      cmd: 'pingresp'
    }, MQTT_5_OPTION);
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