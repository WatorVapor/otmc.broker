import mqttPacket from 'mqtt-packet';
import crypto from 'node:crypto';
import { ClientCertificate } from './client_certificate_.mjs';
import { ClientCollector } from './client_collect.mjs';
import { ClientAcl } from './client_acl.mjs';

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
        console.log('未处理的包类型packet.cmd:=<', packet.cmd, '>');
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
    this.internal.collect.removeClient(clientId);
    this.internal.collect.removeChallenge(clientId);
    this.internal.acl.removeAcl(clientId);
  }
}

export { ClientSession };

class ClientSessionInternal {
  constructor() {
    this.subscriptions = new Set();
    this.collect = new ClientCollector();
  }

  handleConnect(socket, packet, client) {
    console.log('ClientSessionInternal:handleConnect:packet=<', packet, '>');
    const fromClientId = packet.clientId || `client_${crypto.randomBytes(32).toString('base64')}`;
    const clientIdBroker = `${fromClientId}_broker_${crypto.randomBytes(8).toString('base64')}`;
    console.log('ClientSessionInternal:handleConnect:clientId=<', clientIdBroker, '>');
    socket.clientId = clientIdBroker;
    this.collect.addClient(clientIdBroker, client);


    if (packet && packet.properties && packet.properties.userProperties) {
      console.log('ClientSessionInternal:handleConnect:packet.properties.userProperties=<', packet.properties.userProperties, '>');
    }

    const challenge = crypto.randomBytes(32).toString('base64');
    console.log('ClientSessionInternal:handleConnect:challenge=<', challenge, '>');
    this.collect.addChallenge(clientIdBroker, challenge);

    const responsePacketObj = {
      cmd: 'auth',
      reasonCode: MQTT_5_REASON_CODE_CONTINUE_AUTH,
      properties: {
        authenticationMethod: 'certchain',
        authenticationData: challenge
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
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED);
      return;
    }

    const rawAuthData = props.authenticationData;
    if (!rawAuthData) {
      console.log('ClientSessionInternal:handleAuth:missing authenticationData');
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED);
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
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED);
      return;
    }
    console.log('ClientSessionInternal:handleAuth:authDataJson=<', authDataJson, '>');

    const clientCert =
      authDataJson.cert ||
      authDataJson.certificate ||
      authDataJson.chain ||
      authDataJson.certChain;

    console.log('ClientSessionInternal:handleAuth:clientCert=<', clientCert, '>');

    const cltCert = new ClientCertificate(clientCert,socket.clientId);

    const isValid = cltCert.isValid();
    console.log('ClientSessionInternal:handleAuth:isValid=<', isValid, '>');

    if (!isValid) {
      console.log('ClientSessionInternal:handleAuth:Invalid certificate chain');
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED);
      return;
    }

    const pubKeyHash = cltCert.getPublicKeyHash();
    console.log('ClientSessionInternal:handleAuth:pubKeyHash=<', pubKeyHash, '>');


    const challengeHash = cltCert.verifySignature(authDataJson.challenges);
    console.log('ClientSessionInternal:handleAuth:challengeHash=<', challengeHash, '>');
    if (challengeHash.length === 0) {
      console.log('ClientSessionInternal:handleAuth:Signature verification failed');
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED);
      return;
    }
    const aclConfig = getAclConfig(pubKeyHash,challengeHash);
    const properties = {
      userProperties: {
        acl: JSON.stringify(aclConfig)
      }
    };
    this.acl = new ClientAcl();
    this.acl.addAcl(socket.clientId, aclConfig);
    console.log('ClientSessionInternal:handleAuth:properties=<', properties, '>');
    this.sendConnack(socket, MQTT_5_REASON_CODE_SUCCESS, properties, false);
  }

  sendConnack(socket, reasonCode,properties = {}, endSocket = true) {
    const connackPacketObj = {
      cmd: 'connack',
      reasonCode,
      sessionPresent: false,
      properties: properties
    };
    console.log('ClientSessionInternal:sendConnack:connackPacketObj=<', connackPacketObj, '>');
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

    this.collect.getAllClients().forEach((client, clientId) => {
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


const getAclConfig = (pubKeyHash,challengeHash) => {
  console.log('ClientSessionInternal:getAclConfig:pubKeyHash=<', pubKeyHash, '>, challengeHash=<', challengeHash, '>');
  if (!pubKeyHash || !challengeHash) {
    console.log('ClientSessionInternal:getAclConfig:pubKeyHash or challengeHash is missing');
    return [];
  }
  const last3PublicKeyHash = pubKeyHash.slice(-3);
  console.log('ClientSessionInternal:getAclConfig:last3PublicKeyHash=<', last3PublicKeyHash, '>');

  const aclConfig = []
  const separator = '/';
  let current = '';
  for(const hash of last3PublicKeyHash) {
    current = current ? `${current}${separator}${hash}` : hash;
    const aclEntry = {
      topic: `${current}/#`,
      action: 'read'
    };
    if(challengeHash.has(hash)) {
      aclEntry.action = 'all';
    }
    console.log('ClientSessionInternal:getAclConfig:aclEntry=<', aclEntry, '>');
    aclConfig.push(aclEntry);
  }
  console.log('ClientSessionInternal:getAclConfig:aclConfig=<', aclConfig, '>');
  return aclConfig;
};

