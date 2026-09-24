import { createCluster } from 'redis';
import { config } from './config.mjs';
const TOPIC_ENDPOINT_UPDATE_KEY = 'otmc:broker:endpoint:update';

console.log('Redis config:=<', config.redis, '>');
const clusterConfig = {
  rootNodes: config.redis.rootNodes,
  defaults: config.redis.defaults
};

const cluster = createCluster(clusterConfig);
console.log('dynamic-backend: Redis cluster initialized cluster:=<', cluster, '>');
cluster.on('error', (err) => console.error('dynamic-backend: Redis Cluster Error', err));
await cluster.connect();



class PubSubRedis {

  static async registerBrokerUpdates(callback) {
    await PubSubRedis.register(TOPIC_ENDPOINT_UPDATE_KEY, callback);
  }

  static async register(topic, callback) {

    await cluster.subscribe(topic, (message) => {
      console.log(`dynamic-backend: Redis PubSub message received on topic [${topic}]:`, message);
      callback(message);
    });
    console.log(`dynamic-backend: Subscribed to Redis PubSub topic [${topic}]`);
  }

  static async publish(topic, message) {
    await cluster.publish(topic, message);
    console.log(`dynamic-backend: Published message to Redis PubSub topic [${topic}]:`, message);
  }


}

export { PubSubRedis };