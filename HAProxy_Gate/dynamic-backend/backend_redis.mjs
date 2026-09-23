import { createCluster } from 'redis';
import { config } from './config.mjs';
const KEY_STORE_ENDPOINTS_KEY = 'otmc:broker:store:endpoints';
const KEY_STORE_ENDPOINT_KEY = 'otmc:broker:store:endpoint';

const  BYTES_PREFIX_NODE_ID = 10; // 取前10个字节作为前缀

console.log('Redis config:=<', config.redis, '>');
const clusterConfig = {
  rootNodes: config.redis.rootNodes,
  defaults: config.redis.defaults
};

const cluster = createCluster(clusterConfig);
console.log('dynamic-backend: Redis cluster initialized cluster:=<', cluster, '>');
cluster.on('error', (err) => console.error('dynamic-backend: Redis Cluster Error', err));
await cluster.connect();


const readAllMqttBrokerNodesFromRedis = async () => {

  const storeEndPoints = await cluster.get(KEY_STORE_ENDPOINTS_KEY);
  console.log('readAllMqttBrokerNodesFromRedis: storeEndPoints:=<', storeEndPoints, '>');
  const storeEndPointsObj = storeEndPoints ? JSON.parse(storeEndPoints) : [];
  console.log('readAllMqttBrokerNodesFromRedis: storeEndPointsObj:=<', storeEndPointsObj, '>');

  const backEndsOfHaproxy = {};
  for (const endpoint of storeEndPointsObj) {
    const endpointKey = `${KEY_STORE_ENDPOINT_KEY}:${endpoint.nodeId}`;
    console.log('readAllMqttBrokerNodesFromRedis: endpointKey:=<', endpointKey, '>');
    const endpointValue = await cluster.get(endpointKey);
    console.log('readAllMqttBrokerNodesFromRedis: endpointValue:=<', endpointValue, '>');
    const endpointValueObj = endpointValue ? JSON.parse(endpointValue) : null;
    console.log('readAllMqttBrokerNodesFromRedis: endpointValueObj:=<', endpointValueObj, '>');
    if (endpointValueObj) {
      const backEndHPAProxy = {
        host: endpointValueObj.host,
        port: endpointValueObj.port
      };
      if (!backEndsOfHaproxy[endpointValueObj.nodeId]) {
        backEndsOfHaproxy[endpointValueObj.nodeId] = backEndHPAProxy;
      } else {
        console.log('readAllMqttBrokerNodesFromRedis: Backend for nodeId:=<', endpointValueObj.nodeId, '> already exists');
      }
    }
  }
  console.log('readAllMqttBrokerNodesFromRedis: backEndsOfHaproxy:=<', backEndsOfHaproxy, '>');
  return backEndsOfHaproxy;
}

class BackendInRedis {
  static async getAllBackends() {

    // 读取 Redis 中的 MQTT Broker 节点信息，并生成 HAProxy 的后端配置
    const backEndsOfHaproxyOrignal =  await readAllMqttBrokerNodesFromRedis();
    return backEndsOfHaproxyOrignal;
  }

}

export { BackendInRedis };