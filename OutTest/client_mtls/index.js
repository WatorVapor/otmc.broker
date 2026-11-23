import mqtt from 'mqtt';
import fs from 'fs';
import crypto from 'node:crypto';
import bs58 from 'bs58';

const CLIENT_ID_BYTE_LENGTH = 8;

const myClientId = `client_mtls_${crypto.randomBytes(CLIENT_ID_BYTE_LENGTH).toString('base64url')}`;


const parseSpaceInfo = (aclJsonStr) => {

  const parsedAcl = aclJsonStr ? JSON.parse(aclJsonStr) : null;
  console.log('parsedAcl=<', parsedAcl, '>');
  const topSpace = parsedAcl?.[0]?.topic.replace(/\/\+$/, '').replace(/\/#$/, ''); // 移除末尾的 "/+" 和 "/#"
  console.log('topSpace=<', topSpace, '>');
  const leafSpace = parsedAcl?.[parsedAcl.length - 1]?.topic.replace(/\/\+$/, '').replace(/\/#$/, ''); // 移除末尾的 "/+" 和 "/#"
  console.log('leafSpace=<', leafSpace, '>');

  const midSpace = parsedAcl?.[1]?.topic.replace(/\/\+$/, '').replace(/\/#$/, ''); // 移除末尾的 "/+" 和 "/#"
  console.log('midSpace=<', midSpace, '>');
  const depth = parsedAcl?.length;

  return {topSpace,leafSpace,midSpace};

}

const connectWithMTLS = () => {
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
    clientId: myClientId,
    protocolVersion: 5,
    clean: true,
    ca: ca,
    cert: cert,
    key: key,
    properties: {
      authenticationMethod:'certchain',
      authenticationData:cert,
    },
    debug: true,
  };

  const client = mqtt.connect('mqtts://mqtt-broker-local10001.wator.xyz:8883', options);
  client.handleAuth = (packet, callback) => handleAuth(packet, callback, key, cert);

  client.on('connect', (connack) => {
    console.log('✅ 已连接（TLS 客户端证书认证）');
    // console.log('connack=<', connack, '>');
    // console.log('connack.properties=<', connack.properties, '>');
    const acl = connack.properties?.userProperties?.acl;
    // console.log('connack.properties.userProperties.acl=<', acl, '>');
    const {topSpace,leafSpace,midSpace} = parseSpaceInfo(acl);

    if(false) {
      const subTopic1 = `${topSpace}/secure/topic`;
      console.log('subTopic1=<', subTopic1, '>');
      client.subscribe(subTopic1, (err) => {
        if (err) {
          console.log('订阅失败:', err);
        } else {
          console.log('已订阅 ', subTopic1);
        }
      });
    }
    if(false) {
      const subTopic2 = `${leafSpace}/secure/topic`;
      console.log('subTopic2=<', subTopic2, '>');
      client.subscribe(subTopic2, (err) => {
        if (err) {
          console.log('订阅失败:', err);
        } else {
          console.log('已订阅 ', subTopic2);
        }
      });
    }
    const subTopic3 = `${midSpace}/+/secure/topic`;
    console.log('subTopic3=<', subTopic3, '>');
    client.subscribe(subTopic3, (err) => {
      if (err) {
        console.log('订阅失败:', err);
      } else {
        console.log('已订阅 ', subTopic3);
      }
    });


    if(true) {
      const pubTopic1 = `${leafSpace}/secure/topic`;
      setTimeout(() => {
        client.publish(pubTopic1, `Hello from mTLS client ${myClientId}!`, (err) => {
          if (err) {
            console.error('发布消息失败:', err);
          } else {
            console.log('已发布消息到 ', pubTopic1);
          }
        });
      }, 2000);
    }

    if(false) {
      const pubTopic2 = `${topSpace}/secure/topic`;
      setTimeout(() => {
        client.publish(pubTopic2, `Hello from mTLS client ${myClientId}!`, (err) => {
          if (err) {
            console.error('发布消息失败:', err);
          } else {
            console.log('已发布消息到 ', pubTopic2);
          }
        });
      }, 2000);
    }


    
  });

  client.on('message', (topic, message) => {
    console.log(`收到消息：${topic} -> ${message.toString()}`);
  });

  client.on('error', (err) => {
    console.error('err:=<', err,'>');
  });
}


const handleAuth = (packet, callback,key,cert) => {
  console.log('connectWithMTLS:handleAuth:packet=<',packet,'>');
  const challenge = packet.properties?.authenticationData;
  if (!challenge) {
    console.error('AUTH 报文中缺少挑战数据');
    return callback(new Error('Missing challenge data'), null);
  }
  console.log('connectWithMTLS:handleAuth:challenge=<',challenge.toString(),'>');
  const challengeMsg = {
    challenge: challenge.toString(),
    timeStamp: (new Date()).toISOString()
  }
  console.log('connectWithMTLS:handleAuth:challengeMsg=<',challengeMsg,'>');

  // Create signature for challengeMsg
  const signature = crypto.createSign('SHA256');
  signature.update(JSON.stringify(challengeMsg));
  signature.end();
  const signedChallenge = signature.sign(key, 'base64');

  // 从私钥生成公钥
  const privateKey = crypto.createPrivateKey({
    key: key,
    format: 'pem'
  });

  const publicKey = crypto.createPublicKey(privateKey);
  console.log('connectWithMTLS:handleAuth:publicKey=<', publicKey.export({ type: 'spki', format: 'pem' }), '>');
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(pubKeyDer).digest('hex');
  const base58Hash = bs58.encode(Buffer.from(hash, 'hex'));
  console.log('connectWithMTLS:handleAuth:base58Hash=<',base58Hash,'>');  
  const challengedMsg = {
    "type": "client_auth",
    "challenges": [
      {
        "data": challengeMsg,
        "signature": signedChallenge,
        "algorithm": "SHA256",
        "keyAddress": base58Hash
      }
    ],
    "cert": cert.toString()

  };
  console.log('connectWithMTLS:challengedMsg:=<', challengedMsg, '>');

  // Send AUTH response with signature
  callback(null, {
    cmd: 'auth',
    reasonCode: 0x18, 
    properties: {
      authenticationMethod: 'certchain',
      authenticationData: JSON.stringify(challengedMsg)
    }
  });
}

connectWithMTLS();
