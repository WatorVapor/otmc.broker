const mqtt = require('mqtt');
const fs = require('fs');

function connectWithMTLS() {
  let ca, cert, key;
  try {
    ca   = fs.readFileSync('./server_cert/server-root.crt');        // 验证服务器的 CA
    cert = fs.readFileSync('./client_cert/client.fullchain.crt');   // 客户端证书（含中间 CA 也行）
    key  = fs.readFileSync('./client_cert/client-space-leaf.key');  // 客户端私钥
  } catch (err) {
    console.error('证书文件读取失败:', err.message);
    process.exit(1);
  }

  const options = {
    clientId: 'client_mtls_' + Math.random().toString(16).substring(2, 10),
    reconnectPeriod: 0,          // 调试时禁用自动重连
    clean: true,

    // TLS 配置
    rejectUnauthorized: false, // 确保服务器证书有效

    ca: ca,
    cert: cert,
    key: key,
    // 临时绕过主机名检查（仅测试！）
    checkServerIdentity: (host, cert) => {
      // 可以在这里加自定义校验，返回 undefined 表示接受
      console.log('服务器证书:', cert);
      console.log('服务器主机名:', host);
      return undefined;
    },
  };

  const client = mqtt.connect('mqtts://mqtt-broker-local10001.wator.xyz:8443', options);

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
    console.error('连接错误:', err.message);
  });
}

connectWithMTLS();