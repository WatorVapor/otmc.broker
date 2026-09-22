import { createCluster } from 'redis';
import http from 'node:http';
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

// 读取 Redis 中的 MQTT Broker 节点信息，并生成 HAProxy 的后端配置
const backEndsOfHaproxyOrignal =  await readAllMqttBrokerNodesFromRedis();
// 将后端配置按 nodeId 的前缀进行映射，方便后续查找 8 Bytes Prefix NodeId will be used to identify the backend server in HAProxy
const backEndsOfHaproxyPrefixMap = {};
for (const nodeId in backEndsOfHaproxyOrignal) {
  const prefix = nodeId.slice(0, BYTES_PREFIX_NODE_ID);
  if (backEndsOfHaproxyPrefixMap[prefix]) {
    console.log('dynamic-backend: Warning: prefix:=<', prefix, '> already exists in backEndsOfHaproxyPrefixMap, overwriting with nodeId:=<', nodeId, '>');
  }
  backEndsOfHaproxyPrefixMap[prefix] = Object.assign({nodeId:nodeId}, backEndsOfHaproxyOrignal[nodeId]);
}
console.log('dynamic-backend: backEndsOfHaproxyPrefixMap:=<', backEndsOfHaproxyPrefixMap, '>');

const createHAProxyBackendConfig = (backEndsOfHaproxyPrefixMap) => {
  const backEnds = {};
  for (const prefix in backEndsOfHaproxyPrefixMap) {
    const backend = backEndsOfHaproxyPrefixMap[prefix];
    const backendName = `mqtt_backend_${backend.nodeId}`;
    backEnds[backendName] = {
      server: {
        host: backend.host,
        port: backend.port
      }
    };
  }
  return backEnds;
}

const backEnds = createHAProxyBackendConfig(backEndsOfHaproxyPrefixMap);
console.log('dynamic-backend: backEnds:=<', backEnds, '>');


import net from 'node:net';

// ============ 配置区 ============
const SOCKET_PATH = '/var/run/haproxy/admin.sock'; // HAProxy stats socket 路径
const COMMAND_TIMEOUT_MS = 5000;

// 期望的 Backend 配置
// - defaults：继承的 defaults 块名称（必须在 haproxy.cfg 中存在）
// - mode：http 或 tcp，若 defaults 中未指定 mode 则必填
// - servers：服务器列表
const DESIRED_BACKENDS = [
    {
        name: 'backend_app',
        defaults: 'mydefaults',
        mode: 'http',
        servers: [
            { name: 'app1', address: '10.0.1.1:8080', check: true },
            { name: 'app2', address: '10.0.1.2:8080', check: true }
        ]
    },
    {
        name: 'backend_api',
        defaults: 'mydefaults',
        mode: 'http',
        servers: [
            { name: 'api1', address: '10.0.2.1:9090', check: true }
        ]
    }
];

// ============ 核心通信函数 ============

/**
 * 通过 Unix Socket 执行 HAProxy Runtime API 命令
 * @param {string} command - 要执行的 Runtime API 命令
 * @returns {Promise<string>} - 命令执行结果
 */
function executeRuntimeCommand(command) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(SOCKET_PATH, () => {
            client.write(`${command}\n`);
        });

        let data = '';
        client.setEncoding('utf8');
        client.on('data', (chunk) => {
            data += chunk;
        });

        client.on('end', () => {
            resolve(data.trim());
        });

        client.on('error', (err) => {
            reject(err);
        });

        client.setTimeout(COMMAND_TIMEOUT_MS, () => {
            client.destroy();
            reject(new Error(`Command timed out: ${command}`));
        });
    });
}

// ============ Backend 操作封装 ============

/**
 * 获取当前所有 Backend 的名称列表
 */
async function listCurrentBackends() {
    const result = await executeRuntimeCommand('show backend');
    console.log('listCurrentBackends: result:=<', result, '>');
    const lines = result.split('\n');
    const backends = [];
    for (const line of lines) {
        const match = line.match(/mqtt_backend_(\S+)/);
        if (match) backends.push(match[1]);
    }
    return backends;
}

/**
 * 动态添加一个 Backend 及其服务器
 */
async function addBackend(backend) {
    const { name, defaults, mode, servers } = backend;

    // 1) 开启实验模式并添加 Backend
    //    注意：experimental-mode 只在当前连接有效，所以每条命令都带上
    const addBackendCmd =
        `experimental-mode on; add backend ${name} from ${defaults} mode ${mode}`;
    console.log(`[ADD]     ${addBackendCmd}`);
    await executeRuntimeCommand(addBackendCmd);

    // 2) 添加服务器
    for (const server of servers) {
        let cmd = `add server ${name}/${server.name} ${server.address}`;
        if (server.check) cmd += ' check';
        console.log(`[ADD]     ${cmd}`);
        await executeRuntimeCommand(cmd);
    }

    // 3) 发布 Backend，使其开始接收流量
    const publishCmd = `publish backend ${name}`;
    console.log(`[PUBLISH] ${publishCmd}`);
    await executeRuntimeCommand(publishCmd);
}

/**
 * 删除一个 Backend
 */
async function deleteBackend(name) {
    const cmd = `experimental-mode on; del backend ${name}`;
    console.log(`[DELETE]  ${cmd}`);
    await executeRuntimeCommand(cmd);
}

/**
 * 替换一个已存在的 Backend（先下线、删除，再重新创建）
 */
async function replaceBackend(backend) {
    const { name } = backend;
    console.log(`\n[REPLACE] Backend [${name}] 已存在，正在替换...`);

    // 先下线，停止接收新流量
    try {
        await executeRuntimeCommand(`unpublish backend ${name}`);
        console.log(`[UNPUB]   unpublish backend ${name}`);
    } catch (err) {
        console.warn(`[WARN]    unpublish 失败（忽略继续）: ${err.message}`);
    }

    // 删除旧 Backend
    await deleteBackend(name);

    // 重新添加
    await addBackend(backend);
}

// ============ 主同步逻辑 ============

async function syncBackends() {
    console.log('正在获取当前 Backend 列表...');
    const currentBackends = await listCurrentBackends();
    console.log('当前 Backend:', currentBackends);
/*
    const desiredNames = new Set(DESIRED_BACKENDS.map((b) => b.name));

    // 1) 处理期望列表中的每个 Backend
    for (const desired of DESIRED_BACKENDS) {
        if (!currentBackends.includes(desired.name)) {
            console.log(`\n[+] 发现新的 Backend: ${desired.name}，正在添加...`);
            await addBackend(desired);
        } else {
            // 如果存在：可选策略
            //   - 跳过：默认，适合只做增量
            //   - 替换：调用 replaceBackend(desired)
            console.log(`\n[=] Backend [${desired.name}] 已存在，跳过。`);
            // await replaceBackend(desired); // 若需要强制覆盖，取消注释
        }
    }

    // 2) 删除不再需要的旧 Backend
    const toDelete = currentBackends.filter((n) => !desiredNames.has(n));

    if (toDelete.length > 0) {
        console.log(`\n[-] 需要删除的旧 Backend: ${toDelete.join(', ')}`);
        for (const name of toDelete) {
            await deleteBackend(name);
        }
    } else {
        console.log('\n没有需要删除的旧 Backend。');
    }
*/
    console.log('\n✅ Backend 同步完成。');
}

// ============ 执行 ============
try {
    await syncBackends();
} catch (err) {
    console.error('同步过程中发生错误:', err.message);
    process.exit(1);
}
