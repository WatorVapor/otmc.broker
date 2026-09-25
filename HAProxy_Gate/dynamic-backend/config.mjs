import * as fs from "fs";
import * as path from "path";
const caCert = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-root.crt"));
const clientCert = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-client.crt"));
const clientKey = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-client.key"));
const config = {
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
  haproxy: {
    socketPath: '/var/run/haproxy/admin.sock',
    haproxyBackendPath: '/usr/local/etc/haproxy/backends',
    commandTimeoutMs: 5000
  }
};

export { config };
