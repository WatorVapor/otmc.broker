import { createCluster } from 'redis';
import { config } from './config.mjs';
import { gClients } from './client_session.mjs';
import fs from 'fs';
import { createHash, X509Certificate } from 'crypto';


const KEY_STORE_ENDPOINTS_KEY = 'otmc:broker:store:endpoints';
const KEY_STORE_ENDPOINTS_TTL_SECONDS = 3600*24; // 24 hours
const KEY_STORE_ENDPOINTS_UPDATE_NEXT_MS = 100 * 1000;


const KEY_STORE_ENDPOINT_KEY = 'otmc:broker:store:endpoint';
const KEY_STORE_ENDPOINT_TTL_SECONDS = 60; // 10 seconds
const KEY_STORE_ENDPOINT_UPDATE_NEXT_MS = 10 * 1000;


const TOPIC_ENDPOINT_UPDATE_KEY = 'otmc:broker:endpoint:update';


class RedisConfig {
  constructor() {
    this.valkeyConfig = config.valkey;
    this.redisConfig = config.redis;
    this.clientCounter = gClients.size;
    const { publicKeySha256Base58, publicKey } = sha256PublicKey();
    this.nodeId = publicKeySha256Base58;
    this.publicKey = publicKey;
    this.nonce = 0;
  }
  async setup() {
    this.cluster = createCluster({
      rootNodes: this.redisConfig.rootNodes,
      defaults: this.redisConfig.defaults
    });
    console.log('RedisConfig: Redis cluster initialized:', this.cluster);
    this.cluster.on('error', (err) => console.error('RedisConfig: Redis Cluster Error', err));
    await this.cluster.connect();
    console.log('RedisConfig:setup Redis cluster connected successfully.');
    console.log('RedisConfig:setup config.mqtt:=<', config.mqtt, '>');
    await this.updateStoreEndpoints(config.mqtt);
    await this.updateStoreEndpointOfNode(config.mqtt);
  }
  async updateStoreEndpoints(newEndpoint) {
    let storeEndPoints = await this.cluster.get(KEY_STORE_ENDPOINTS_KEY);
    if (!storeEndPoints) {
      storeEndPoints = JSON.stringify([]);
    }
    newEndpoint.publicKey = this.publicKey;
    newEndpoint.nonce = this.nonce;
    newEndpoint.nodeId = this.nodeId;
    const storeEndPointsObj = JSON.parse(storeEndPoints);
    storeEndPointsObj.push(newEndpoint);

    const uniqueEndpoints = [
      ...new Map(
        storeEndPointsObj.map(endpoint => [
          `${endpoint.host}:${endpoint.port}`,
          endpoint
        ])
      ).values()
    ];
    const options = {
      EX: KEY_STORE_ENDPOINTS_TTL_SECONDS
    };
    console.log('RedisConfig: updateStoreEndpoints: uniqueEndpoints:=<', uniqueEndpoints, '>');
    await this.cluster.set(KEY_STORE_ENDPOINTS_KEY, JSON.stringify(uniqueEndpoints), options);

    setTimeout(async () => {
      await this.updateStoreEndpoints(newEndpoint);
    }, KEY_STORE_ENDPOINTS_UPDATE_NEXT_MS);

  }

  async updateStoreEndpointOfNode(newEndpoint) {
    const options = {
      EX: KEY_STORE_ENDPOINT_TTL_SECONDS
    };
    const newEndpoint2 = Object.assign({}, newEndpoint);
    newEndpoint2.clientCounter = gClients.size;
    newEndpoint2.publicKey = this.publicKey;
    newEndpoint2.nonce = this.nonce;
    const endpointKey = `${KEY_STORE_ENDPOINT_KEY}:${this.nodeId}`;
    await this.cluster.set(endpointKey, JSON.stringify(newEndpoint2), options);

    await this.cluster.publish(TOPIC_ENDPOINT_UPDATE_KEY, JSON.stringify({}));

    setTimeout(async () => {
      await this.updateStoreEndpointOfNode(newEndpoint);
    }, KEY_STORE_ENDPOINT_UPDATE_NEXT_MS);

  }


  getConfig() {

  }

}

export { RedisConfig };


const sha256PublicKey = () => {
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
  return { publicKeySha256Base58, publicKey};
}