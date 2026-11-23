import * as fs from "fs";
import * as path from "path";
const caCertValKey = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-root.crt"));
const clientCertValKey = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-client.crt"));
const clientKeyValKey = fs.readFileSync(path.resolve( "/usr/local/etc/certs/valkey-cluster/valkey-client.key"));
const caRootMqttClient = fs.readFileSync(path.resolve( "/usr/local/etc/certs/client_cert/client-root.crt"));
const caTrustedMqttClient = fs.readFileSync(path.resolve( "/usr/local/etc/certs/client_cert/ca_inter_bundle.crt"));


import * as os from "os";
/**
 * 读取指定网络接口上的 IPv6 地址
 * @param {string} ifaceName 接口名，如 "tailscale0"
 * @param {"global"|"link-local"|"any"} scope 地址范围
 * @returns {string|undefined}
 */
function getIPv6Address(ifaceName, scope = "global") {
  const addrs = os.networkInterfaces()[ifaceName];
  if (!addrs) return undefined;

  const ipv6 = addrs.filter(
    (a) => (a.family === "IPv6" || a.family === 6) && !a.internal
  );

  switch (scope) {
    case "global":
      return ipv6.find((a) => !/^fe80:/i.test(a.address))?.address;
    case "link-local":
      return ipv6.find((a) => /^fe80:/i.test(a.address))?.address;
    case "any":
      return ipv6[0]?.address;
    default:
      return undefined;
  }
}

const tailscaleIPv6 = getIPv6Address("tailscale0");


const config = {
  mqtt: {
    host: tailscaleIPv6,
    port: 18883,
    client: {
      caRoot: caRootMqttClient,
      caTrusted: caTrustedMqttClient,
    }
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
        rootCertificates: caCertValKey,
        cert: clientCertValKey,
        key: clientKeyValKey,
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
            ca: caCertValKey,               // CA 证书
            cert: clientCertValKey,         // 客户端证书（mTLS）
            key: clientKeyValKey,           // 客户端私钥（mTLS）
            rejectUnauthorized: false // ⚠️ 仅用于测试：跳过证书验证
        }
    }
  },
};

export { config };

