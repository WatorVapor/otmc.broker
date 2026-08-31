import { createCluster } from 'redis';
import * as fs from 'fs';

import { config } from './config.mjs';
console.log('Redis config:', config.redis);
console.log('config.mqtt:=<', config.mqtt, '>');
const KEY_STORE_ENDPOINTS_KEY = 'otmc:store:endpoints';
class RedisConfig {
  constructor() {
    this.valkeyConfig = config.valkey;
    this.redisConfig = config.redis;
  }
  async setup() {
    const cluster = createCluster({
      rootNodes: this.redisConfig.rootNodes,
      defaults: this.redisConfig.defaults
    });
    console.log('RedisConfig: Redis cluster initialized:', cluster);
    cluster.on('error', (err) => console.error('RedisConfig: Redis Cluster Error', err));
    await cluster.connect();
    console.log('RedisConfig:setup Redis cluster connected successfully.');
    console.log('RedisConfig:setup config.mqtt:=<', config.mqtt, '>');
    let storeEndPoints = await cluster.get(KEY_STORE_ENDPOINTS_KEY);
    console.log('RedisConfig:setup Store endpoints:', storeEndPoints);
    if (!storeEndPoints) {
      storeEndPoints = JSON.stringify([]);
    }
    const storeEndPointsObj = JSON.parse(storeEndPoints);
    console.log('RedisConfig:setup Store endpoints object:', storeEndPointsObj);
    storeEndPointsObj.push(config.mqtt);

    const uniqueEndpoints = [
    ...new Map(
        storeEndPointsObj.map(endpoint => [
            `${endpoint.host}:${endpoint.port}`,
            endpoint
        ])
    ).values()
    ];
    console.log('RedisConfig:setup Unique endpoints:', uniqueEndpoints);
    await cluster.set(KEY_STORE_ENDPOINTS_KEY, JSON.stringify(uniqueEndpoints));
  }
  getConfig() {

  }
}

export { RedisConfig };
