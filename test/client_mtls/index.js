const mqtt = require('mqtt');
const fs = require('fs');

function connectWithMTLS() {
  let ca, cert, key;
  try {
    ca   = fs.readFileSync('./server_cert/server-root.crt');        // 验证服务器的 CA
    cert = fs.readFileSync('./client_cert/client.space.chain.crt');   // 客户端证书（含中间 CA）
    key  = fs.readFileSync('./client_cert/client-space-leaf.key');  // 客户端私钥
  } catch (err) {
    console.error('证书文件读取失败:', err.message);
    process.exit(1);
  }

  const options = {
    clientId: 'client_mtls_' + Math.random().toString(16).substring(2, 10),
    protocolVersion: 5,
    clean: true,
    ca: ca,
    cert: cert,
    key: key,
    properties: {
      userProperties:{
        cert:cert
      }
    }
  };

  const client = mqtt.connect('mqtts://mqtt-broker-local10001.wator.xyz:8883', options);

  client.on('connect', () => {
    console.log('✅ 已连接（TLS 客户端证书认证）');
    client.subscribe('secure/topic', (err) => {
      if (!err) {
        client.publish('secure/topic', 'Hello mqtt with mTLS');
      }
    });
  });

  client.on('message', (topic, message) => {
    console.log(`收到消息：${topic} -> ${message.toString()}`);
  });

  client.on('error', (err) => {
    console.error('err:=<', err,'>');
  });
}

connectWithMTLS();