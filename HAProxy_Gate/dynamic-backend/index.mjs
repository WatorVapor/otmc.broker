import { createCluster } from 'redis';
import { config } from './config.mjs';
console.log('Redis config:', config.redis);
console.log('config.mqtt:=<', config.mqtt, '>');
const clusterConfig = {
  rootNodes: config.redis.rootNodes,
  defaults: config.redis.defaults
};
const cluster = createCluster(clusterConfig);
console.log('RedisConfig: Redis cluster initialized:', cluster);

import fs from 'fs';
import { createHash, X509Certificate } from 'crypto';

const certPath = '/usr/local/etc/certs/internal_cert';
const certFile = 'internal-server.crt';
if (!fs.existsSync(`${certPath}/${certFile}`)) {
  console.error(`Error: Certificate file ${certPath}/${certFile} does not exist.`);
  process.exit(1);
}
const certContent = fs.readFileSync(`${certPath}/${certFile}`, 'utf8');
const certificate = new X509Certificate(certContent);
const publicKey = certificate.publicKey.export({ type: 'spki', format: 'pem' });
console.log(`Public key from ${certPath}/${certFile}:`, publicKey);

const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256Digest = createHash('sha256').update(publicKey).digest();
let value = BigInt(`0x${sha256Digest.toString('hex')}`);
let publicKeySha256Base58 = '';
while (value > 0n) {
  publicKeySha256Base58 = base58Alphabet[Number(value % 58n)] + publicKeySha256Base58;
  value /= 58n;
}
publicKeySha256Base58 = base58Alphabet[0].repeat(sha256Digest.findIndex((byte) => byte !== 0)) + publicKeySha256Base58;
console.log('Public key SHA-256 (Base58):', publicKeySha256Base58);

