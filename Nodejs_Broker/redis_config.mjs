import { createCluster } from 'redis';
import * as fs from 'fs';

import { config } from './config.mjs';
import { gClients } from './client_session.mjs';


console.log('Redis config:', config.redis);
console.log('config.mqtt:=<', config.mqtt, '>');
const KEY_STORE_ENDPOINTS_KEY = 'otmc:broker:store:endpoints';
const KEY_STORE_ENDPOINTS_TTL_SECONDS = 3600;
const KEY_STORE_ENDPOINTS_UPDATE_NEXT_MS = 10000;
class RedisConfig {
  constructor() {
    this.valkeyConfig = config.valkey;
    this.redisConfig = config.redis;
    this.clientCounter = gClients.size;
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
  }
  async updateStoreEndpoints(newEndpoint) {
    let storeEndPoints = await this.cluster.get(KEY_STORE_ENDPOINTS_KEY);
    if (!storeEndPoints) {
      storeEndPoints = JSON.stringify([]);
    }
    newEndpoint.clientCounter = gClients.size;
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
  getConfig() {

  }
}

export { RedisConfig };
