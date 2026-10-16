// multi-bridge-server.js
const WebSocket = require('ws');
const mqtt = require('mqtt');
const url = require('url');

// ===== 配置：多个 MQTT 后端 =====
const BACKENDS = {
    'backend-a': {
        url: 'mqtt://127.0.0.1:1883',
        options: {
            clientId: 'bridge-a-' + Math.random().toString(16).slice(2, 8),
            clean: true,
            reconnectPeriod: 5000,
            // username: 'user_a', password: 'pass_a'
        }
    },
    'backend-b': {
        url: 'mqtt://192.168.1.100:1883',
        options: {
            clientId: 'bridge-b-' + Math.random().toString(16).slice(2, 8),
            clean: true,
            reconnectPeriod: 5000,
            // username: 'user_b', password: 'pass_b'
        }
    },
    'backend-c': {
        url: 'mqtts://remote.example.com:8883',  // TLS 后端
        options: {
            clientId: 'bridge-c-' + Math.random().toString(16).slice(2, 8),
            clean: true,
            reconnectPeriod: 5000,
            rejectUnauthorized: true,
            // ca: fs.readFileSync('ca.crt'),
            // cert: fs.readFileSync('client.crt'),
            // key: fs.readFileSync('client.key'),
        }
    }
};

// ===== 连接池：每个后端复用一条 MQTT 连接 =====
const pools = new Map();

function getBackendClient(backendId) {
    // 已存在且已连接，直接复用
    if (pools.has(backendId)) {
        const entry = pools.get(backendId);
        if (entry.client.connected || entry.client.reconnecting) {
            return entry.client;
        }
        // 连接已彻底断开，清理后重建
        entry.client.end(true);
        pools.delete(backendId);
    }

    // 校验后端是否存在
    const config = BACKENDS[backendId];
    if (!config) return null;

    // 创建新连接
    console.log(`[MQTT] creating connection to backend: ${backendId}`);
    const client = mqtt.connect(config.url, config.options);

    // 记录该连接被哪些 WebSocket 客户端引用
    const entry = { client, refCount: 0 };
    pools.set(backendId, entry);

    client.on('connect', () => console.log(`[MQTT] ${backendId} connected`));
    client.on('error', (err) => console.error(`[MQTT] ${backendId} error:`, err.message));
    client.on('reconnect', () => console.log(`[MQTT] ${backendId} reconnecting...`));
    client.on('close', () => {
        console.log(`[MQTT] ${backendId} closed`);
        // 延迟清理，避免重连期间被误删
        setTimeout(() => {
            const e = pools.get(backendId);
            if (e && !e.client.connected && e.refCount === 0) {
                e.client.end(true);
                pools.delete(backendId);
                console.log(`[MQTT] ${backendId} pool removed`);
            }
        }, 10000);
    });

    return client;
}

function releaseBackendClient(backendId) {
    const entry = pools.get(backendId);
    if (entry) {
        entry.refCount = Math.max(0, entry.refCount - 1);
        // 引用归零后不立即断开，保留连接供后续复用
        // 如需严格释放，可在这里判断 refCount === 0 时 end()
    }
}

// ===== WebSocket 服务 =====
const WS_PORT = 8080;
const wss = new WebSocket.Server({ port: WS_PORT });
console.log(`[WS] multi-backend bridge listening on ws://0.0.0.0:${WS_PORT}`);

wss.on('connection', (ws, req) => {
    const params = url.parse(req.url, true).query;
    const token = params.token;
    const backendId = params.backend;   // 指定要连接的后端
    const topic = params.topic;

    // ===== 认证 =====
    if (!token || !isValidToken(token)) {
        ws.close(4001, 'Unauthorized');
        return;
    }
    if (!backendId || !BACKENDS[backendId]) {
        ws.close(4003, 'Unknown backend');
        return;
    }
    if (!topic) {
        ws.close(4002, 'Missing topic');
        return;
    }

    console.log(`[WS] client connected: backend=${backendId}, topic=${topic}`);

    // ===== 获取该后端的 MQTT 连接 =====
    const mqttClient = getBackendClient(backendId);
    if (!mqttClient) {
        ws.close(4003, 'Backend unavailable');
        return;
    }
    const entry = pools.get(backendId);
    if (entry) entry.refCount++;

    // ===== 订阅 =====
    const subscriptions = new Set([topic]);
    mqttClient.subscribe(topic, (err) => {
        if (err) console.error(`[MQTT] ${backendId} subscribe error:`, err);
    });

    // ===== 浏览器 → MQTT =====
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const pubTopic = msg.topic || topic;
            const payload = msg.payload !== undefined ? msg.payload : data.toString();
            mqttClient.publish(pubTopic, payload);
        } catch {
            mqttClient.publish(topic, data.toString());
        }
    });

    // ===== MQTT → 浏览器 =====
    const messageHandler = (msgTopic, payload) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (subscriptions.has(msgTopic)) {
            ws.send(JSON.stringify({
                backend: backendId,
                topic: msgTopic,
                payload: payload.toString()
            }));
        }
    };
    mqttClient.on('message', messageHandler);

    // ===== 清理 =====
    ws.on('close', () => {
        console.log(`[WS] client disconnected: backend=${backendId}`);
        mqttClient.removeListener('message', messageHandler);
        mqttClient.unsubscribe(topic);
        releaseBackendClient(backendId);
    });

    ws.on('error', (err) => console.error('[WS] error:', err.message));
});

// ===== 心跳保活（应对 Cloudflare 100s 空闲超时）=====
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    });
}, 30000);

// ===== Token 校验 =====
function isValidToken(token) {
    return token === 'your-secret-token';
}

// ===== 优雅退出 =====
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] closing all connections...');
    wss.close();
    pools.forEach((entry, id) => {
        entry.client.end(true);
        console.log(`[MQTT] ${id} closed`);
    });
    process.exit(0);
}); 