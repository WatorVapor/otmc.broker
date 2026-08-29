import * as fs from "fs";
import * as path from "path";
const caCert = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-root.crt"));
const clientCert = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-client.crt"));
const clientKey = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-client.key"));
const config = {
  mqtt: {
    host: 'mqtt-broker-local10001.wator.xyz',
    port: 18883,
  },
  valkey: {
    address: [
      {
        host: 'valkey-cluster-conoha-pdf-coltd.wator.xyz',
        port: 6379,
      },
      {
        host: 'valkey-cluster-conoha-wator.wator.xyz',
        port: 6379,
      },
      {
        host: 'valkey-cluster-conoha-ndhealth.wator.xyz',
        port: 6379,
      }
    ],
    useTLS: true,
    advancedConfiguration: {
      logLevel: 'trace',
      tlsAdvancedConfiguration: {
        insecure: true,
        verify_hostname: false, 
        verifyPeer: false,
        rootCertificates: caCert,
        cert: clientCert,
        key: clientKey,
      }
    }
  },
  redis: {
    rootNodes: [
      { socket: { host: 'valkey-cluster-conoha-pdf-coltd.wator.xyz', port: 6379 } },
      { socket: { host: 'valkey-cluster-conoha-wator.wator.xyz', port: 6379 } },
      { socket: { host: 'valkey-cluster-conoha-ndhealth.wator.xyz', port: 6379 } }
    ],
    defaults: {
        socket: {
            tls: true,                // 启用 TLS
            ca: caCert,               // CA 证书
            cert: clientCert,         // 客户端证书（mTLS）
            key: clientKey,           // 客户端私钥（mTLS）
            rejectUnauthorized: false // ⚠️ 仅用于测试：跳过证书验证
        }
    }
  },
};

export { config };
