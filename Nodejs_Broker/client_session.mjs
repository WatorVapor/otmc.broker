import mqttPacket from 'mqtt-packet';
import crypto from 'node:crypto';
import { ClientCertificate } from './client_certificate_.mjs';
import { ClientCollector } from './client_collect.mjs';
import { ClientAcl } from './client_acl.mjs';
import { ClientTopic } from './client_topics.mjs';

const MQTT_5_OPTION = {
  protocolVersion: 5
};
const MQTT_5_REASON_CODE_CONTINUE_AUTH = 0x18;
const MQTT_5_REASON_CODE_SUCCESS = 0x00;
const MQTT_5_REASON_CODE_NOT_AUTHORIZED = 0x87;
const MQTT_5_GRANTED_CODE_NOT_AUTHORIZED = 0x87;

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
    this.collect = new ClientCollector();
    this.topics = new ClientTopic();
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
      console.log('ClientSessionInternal:handleSubscribe:sub=<', sub, '>');
      const allowed = [];
      this.acl.getAcl(socket.clientId).forEach((aclEntry) => {
        console.log('ClientSessionInternal:handleSubscribe:aclEntry=<', aclEntry, '>');
        if (aclEntry.action === 'all' || aclEntry.action === 'read') {
          allowed.push(aclEntry.topic);
        }
      });
      console.log('ClientSessionInternal:handleSubscribe:allowed=<', allowed, '>');

      let grantedQos = null;
      for (const allowedTopic of allowed) {
        if (matchTopic(sub.topic, allowedTopic)) {
          grantedQos = sub.qos || 0;
          console.log(`[Subscribe] ${socket.clientId} 订阅了: ${sub.topic}`);
          this.topics.addSubscription(sub.topic,socket.clientId);
          break;
        }
      }

      if (grantedQos !== null) {
        granted.push(grantedQos);
      } else {
        // 被拒绝：每个订阅都必须有一个返回码
        granted.push( MQTT_5_GRANTED_CODE_NOT_AUTHORIZED);
        console.log(`[Subscribe] ${socket.clientId} 被拒绝订阅: ${sub.topic}`);
      }
    });

    console.log('ClientSessionInternal:handleSubscribe:granted=<', granted, '>');

    const subackPacket = mqttPacket.generate({
      cmd: 'suback',
      messageId: packet.messageId,
      granted
    }, MQTT_5_OPTION);

    socket.write(subackPacket);
  }


  handlePublish(socket, packet) {
    const { topic, payload, qos, messageId } = packet;
    console.log(`[Publish] 来自 ${socket.clientId} -> 主题 [${topic}] qos=${qos} mid=${messageId}: ${payload.toString()}`);

    const allowed = [];
    this.acl.getAcl(socket.clientId).forEach((aclEntry) => {
      console.log('ClientSessionInternal:handlePublish:aclEntry=<', aclEntry, '>');
      if (aclEntry.action === 'all' || aclEntry.action === 'write') {
        allowed.push(aclEntry.topic);
      }
    });
    console.log('ClientSessionInternal:handlePublish:allowed=<', allowed, '>');

    // 授权判定
    let ok = false;
    for (const allowedTopic of allowed) {
      if (matchTopic(topic, allowedTopic)) { ok = true; break; }
    }

    if (ok) {
      console.log(`[Publish] ${socket.clientId} 发布到: ${topic}`);
      this.forwardMessage(topic, payload);

      if (qos === 1) {
        this.sendPuback(socket, { messageId, reasonCode: MQTT_5_REASON_CODE_SUCCESS });
      } else if (qos === 2) {
        this.sendPubrec(socket, { messageId, reasonCode: MQTT_5_REASON_CODE_SUCCESS });
      }
      // qos === 0：什么都不回
      return;
    }

    console.log(`[Publish] ${socket.clientId} 被拒绝发布到: ${topic}`);

    if (qos === 1) {
      this.sendPuback(socket, { messageId, reasonCode: MQTT_5_REASON_CODE_NOT_AUTHORIZED });
    } else if (qos === 2) {
      this.sendPubrec(socket, { messageId, reasonCode: MQTT_5_REASON_CODE_NOT_AUTHORIZED });
    }
    // qos === 0：静默丢弃，不要回任何包
  }

  sendPuback(socket, { messageId, reasonCode = MQTT_5_REASON_CODE_SUCCESS }) {
    if (messageId == null) {
      console.warn('sendPuback: 缺少 messageId，跳过（QoS 0 不应调用）');
      return;
    }
    const pubAckObj = { cmd: 'puback', messageId, reasonCode };
    console.log('ClientSessionInternal:sendPuback:pubAckObj=<', pubAckObj, '>');
    socket.write(mqttPacket.generate(pubAckObj, MQTT_5_OPTION));
  }

  sendPubrec(socket, { messageId, reasonCode = MQTT_5_REASON_CODE_SUCCESS }) {
    if (messageId == null) return;
    const pubRecObj = { cmd: 'pubrec', messageId, reasonCode };
    socket.write(mqttPacket.generate(pubRecObj, MQTT_5_OPTION));
  }
  
  forwardMessage(topic, payload) {
    console.log(`[Forward] 转发消息到主题: ${topic}, 负载: ${payload.toString()}`);
    const clientIds = this.topics.getSubscriptions(topic);
    console.log('ClientSessionInternal:forwardMessage:clientIds=<', clientIds, '>');
    for(const targetClientId of clientIds) {
      const targetClient = this.collect.getClient(targetClientId);
      console.log('ClientSessionInternal:forwardMessage:targetClient=<', targetClient, '>');
      if(!targetClient || !targetClient.socket) {
        console.log(`[Error] 无法找到客户端 ${clientId} 的连接`);
        continue;
      }
      const forwardMsg = {
        cmd: 'publish',
        topic,
        payload,
        qos: 0,
        retain: false,
        dup: false
      };
      console.log('ClientSessionInternal:forwardMessage:forwardMsg=<', forwardMsg, '>');
      const pubPacket = mqttPacket.generate(forwardMsg, MQTT_5_OPTION);
      targetClient.socket.write(pubPacket);
      console.log(`└─> 转发给: ${targetClientId}`);
    }
  }


  handlePingreq(socket) {
    const pingrespPacket = mqttPacket.generate({
      cmd: 'pingresp'
    }, MQTT_5_OPTION);
    socket.write(pingrespPacket);
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

const matchTopic = (topic, aclTopic) => {
  const topicLevels = topic.split('/');
  const aclLevels = aclTopic.split('/');

  for (let i = 0; i < aclLevels.length; i++) {
    if (aclLevels[i] === '#') {
      return true;
    }
    if (aclLevels[i] === '+') {
      continue;
    }
    if (topicLevels[i] !== aclLevels[i]) {
      return false;
    }
  }

  return topicLevels.length === aclLevels.length;
};