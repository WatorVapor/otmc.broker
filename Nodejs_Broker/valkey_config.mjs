import { GlideClient, GlideClusterClient, Logger } from "@valkey/valkey-glide";

import { createCluster } from 'redis';
import * as fs from 'fs';

import { config } from './config.mjs';
console.log('Valkey config:<', config.redis, '>');
class KeyValConfig {
  constructor() {
    this.valkeyConfig = config.valkey;
    this.redisConfig = config.redis;
  }
  async setup() {
    const cluster = createCluster({
      rootNodes: this.redisConfig.rootNodes,
      defaults: this.redisConfig.defaults
    });
    console.log('Redis cluster initialized:', cluster);
    cluster.on('error', (err) => console.error('Redis Cluster Error', err));
    await cluster.connect();
    console.log('Redis cluster connected successfully.');
  }
  getValkeyConfig() {
    return this.valkeyConfig;
  }
}

export { KeyValConfig };
