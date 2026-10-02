import mqttPacket from 'mqtt-packet';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.mjs';

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

    const isValid = this.verifyCertChain(clientCert);
    console.log('ClientSessionInternal:handleAuth:isValid=<', isValid, '>');

    if (!isValid) {
      console.log('ClientSessionInternal:handleAuth:Invalid certificate chain');
      this.sendConnack(socket, MQTT_5_REASON_CODE_NOT_AUTHORIZED, true);
      return;
    }

    this.sendConnack(socket, MQTT_5_REASON_CODE_SUCCESS, false);
  }

  sendConnack(socket, reasonCode, endSocket) {
    const responsePacketObj = {
      cmd: 'connack',
      reasonCode,
      sessionPresent: false,
      properties: {}
    };
    const conPacket = mqttPacket.generate(responsePacketObj, MQTT_5_OPTION);
    console.log('ClientSessionInternal:sendConnack:conPacket=<', conPacket, '>');
    socket.write(conPacket);
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

  normalizeCertPem(rawCert) {
    if (!rawCert) return null;

    if (typeof rawCert === 'string') {
      const trimmed = rawCert.trim();
      if (!trimmed) return null;

      if (trimmed.includes('BEGIN CERTIFICATE')) {
        return trimmed;
      }

      try {
        const parsed = JSON.parse(trimmed);
        return this.normalizeCertPem(parsed);
      } catch {
        // ignore
      }

      const sanitized = trimmed
        .replace(/-----BEGIN CERTIFICATE-----/g, '')
        .replace(/-----END CERTIFICATE-----/g, '')
        .replace(/\s+/g, '');

      if (/^[A-Za-z0-9+/=]+$/.test(sanitized) && sanitized.length > 128) {
        const wrapped = sanitized.match(/.{1,64}/g).join('\n');
        return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
      }

      return null;
    }

    if (Array.isArray(rawCert)) {
      const pemList = rawCert
        .map((item) => this.normalizeCertPem(item))
        .filter(Boolean);

      return pemList.length > 0 ? pemList.join('\n') : null;
    }

    if (typeof rawCert === 'object') {
      if (typeof rawCert.cert === 'string') return this.normalizeCertPem(rawCert.cert);
      if (typeof rawCert.certificate === 'string') return this.normalizeCertPem(rawCert.certificate);
      if (Array.isArray(rawCert.certChain)) return this.normalizeCertPem(rawCert.certChain);
      if (Array.isArray(rawCert.chain)) return this.normalizeCertPem(rawCert.chain);
    }

    return null;
  }

  verifyCertChain(clientCert) {
    try {
      const certPem = this.normalizeCertPem(clientCert);
      if (!certPem) {
        console.log('ClientSessionInternal:verifyCertChain:clientCert is empty or invalid');
        return false;
      }

      const rootCert = config?.mqtt?.client?.caRoot;
      const trustedCert = config?.mqtt?.client?.caTrusted;
      if (!rootCert || !trustedCert) {
        console.log('ClientSessionInternal:verifyCertChain:missing CA configuration');
        return false;
      }

      const rootBuf = Buffer.isBuffer(rootCert) ? rootCert : Buffer.from(String(rootCert));
      const trustedBuf = Buffer.isBuffer(trustedCert) ? trustedCert : Buffer.from(String(trustedCert));

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtt-cert-'));
      const clientCertPath = path.join(tempDir, 'client.crt');
      const rootCertPath = path.join(tempDir, 'root-ca.crt');
      const trustedCertPath = path.join(tempDir, 'trusted-ca.pem');

      fs.writeFileSync(clientCertPath, certPem);
      fs.writeFileSync(rootCertPath, rootBuf);
      fs.writeFileSync(trustedCertPath, trustedBuf);

      try {
        execFileSync(
          'openssl',
          [
            'verify',
            '-verbose',
            '-purpose',
            'sslclient',
            '-CAfile',
            rootCertPath,
            '-untrusted',
            trustedCertPath,
            clientCertPath
          ],
          { stdio: 'pipe' }
        );
      } catch (error) {
        const stderr = error?.stderr ? error.stderr.toString() : error.message;
        console.log('ClientSessionInternal:verifyCertChain:openssl verify failed:', stderr);
        return false;
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      return true;
    } catch (error) {
      console.error('ClientSessionInternal:verifyCertChain:error=', error);
      return false;
    }
  }
}