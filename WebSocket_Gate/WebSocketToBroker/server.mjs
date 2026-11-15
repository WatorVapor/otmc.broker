// multi-bridge-server.js
import WebSocket, { WebSocketServer } from 'ws';
import mqtt from 'mqtt';
import { createServer } from 'node:http';
import { unlinkSync, mkdirSync } from 'node:fs';
import {parseMqttAuthText,verifyMqttAuth} from './CertAuth.mjs';
import { getBackendClient, releaseBackend, acquireTopic,releaseTopic } from './MqttProxy.mjs';

// ============================================================
// 0. 全局状态
// ============================================================
const TEMP_DIR = '/var/run/otmc';
const SOCKET_PATH = `${TEMP_DIR}/websocket.mqtt.sock`;

// ============================================================
// 2. WebSocket 子协议白名单
// ============================================================
const DEFAULT_ALLOWED_PROTOCOLS = new Set(['mqtt', 'mqttv3.1', 'mqtt-bridge.v1']);


let shuttingDown = false;


// ============================================================
// 9. 启动前清理旧 socket
// ============================================================
try {
    mkdirSync(TEMP_DIR, { recursive: true });
} catch (err) {
    if (err.code !== 'EEXIST') {
        console.warn(`[WS] cannot create ${TEMP_DIR}:`, err.message);
    }
}
try {
    unlinkSync(SOCKET_PATH);
} catch (err) {
    if (err.code !== 'ENOENT') throw err;
}

// ============================================================
// 10. 请求解析辅助
// ============================================================
function parseRequestParams(req) {
    try {
        return new URL(req.url ?? '/', 'ws://localhost').searchParams;
    } catch {
        return null;
    }
}

// ============================================================
// 11. WebSocket 服务
// ============================================================
const httpServer = createServer();

const wss = new WebSocketServer({
    server: httpServer,

    handleProtocols: (protocols, request) => {
        const params = parseRequestParams(request);
        const backendId = params?.get('backend') ?? null;

        const allowed = (backendId && ALLOWED_BY_BACKEND[backendId])
            || DEFAULT_ALLOWED_PROTOCOLS;

        for (const proto of protocols) {
            if (allowed.has(proto)) {
                console.log(
                    `[WS] negotiated subprotocol: ${proto}` +
                    (backendId ? ` (backend=${backendId})` : '')
                );
                return proto;
            }
        }

        console.warn(
            `[WS] rejecting handshake: no acceptable subprotocol ` +
            `(client sent: ${[...protocols].join(', ') || '<none>'}` +
            `${backendId ? `, backend=${backendId}` : ''})`
        );
        return false;
    },
});

httpServer.listen(SOCKET_PATH, () => {
    console.log(`[WS] multi-backend bridge listening on unix://${SOCKET_PATH}`);
});

wss.on('connection', (ws, req) => {
    const params = parseRequestParams(req);
    if (!params) {
        ws.close(4000, 'Bad request');
        return;
    }

    // ===== 证书链 + 签名校验 =====
    const headers = req.headers;
    const headsWSSecKey = headers['sec-websocket-protocol'];
    const certMqttAuth = parseMqttAuthText(headsWSSecKey);
    const certMqttAuthJson = certMqttAuth.auth;
    console.log('[WS] certMqttAuthJson:=<', certMqttAuthJson, '>');

    if (!verifyMqttAuth(certMqttAuthJson)) {
        ws.close(4001, 'Unauthorized');
        return;
    }

    // ===== 参数解析 =====
    const token = params.get('token');
    const backendId = params.get('backend');
    const topic = params.get('topic');

    console.log(
        `[WS] new connection: backend=${backendId}, topic=${topic}, ` +
        `subprotocol=${ws.protocol || '<none>'}`
    );

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

    const entry = getBackendClient(backendId);
    if (!entry) {
        ws.close(4003, 'Backend unavailable');
        return;
    }

    const sub = acquireTopic(entry, backendId, ws, topic);
    console.log(`[WS] client connected: backend=${backendId}, topic=${topic}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // ===== 浏览器 -> MQTT =====
    ws.on('message', (data) => {
        const text = Buffer.isBuffer(data) ? data.toString() : String(data);

        let pubTopic;
        let payload;
        try {
            const msg = JSON.parse(text);
            pubTopic = msg.topic || topic;
            if (msg.payload === undefined) {
                payload = text;
            } else if (typeof msg.payload === 'string' || Buffer.isBuffer(msg.payload)) {
                payload = msg.payload;
            } else {
                payload = JSON.stringify(msg.payload);
            }
        } catch {
            pubTopic = topic;
            payload = text;
        }

        if (!mqttMatch(topic, pubTopic)) {
            console.warn(
                `[WS] publish denied: topic "${pubTopic}" outside subscription "${topic}"`
            );
            return;
        }
        if (/[+#]/.test(pubTopic)) {
            console.warn(`[WS] publish denied: topic "${pubTopic}" contains wildcard`);
            return;
        }

        entry.client.publish(pubTopic, payload);
    });

    ws.on('close', () => {
        console.log(`[WS] client disconnected: backend=${backendId}, topic=${topic}`);
        releaseTopic(entry, backendId, sub);
        releaseBackend(backendId);
    });

    ws.on('error', (err) => console.error('[WS] error:', err.message));
});

// ============================================================
// 12. 心跳
// ============================================================
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30_000);

// ============================================================
// 13. Token 校验
// ============================================================
function isValidToken(token) {
    return token === 'your-secret-token';
}

// ============================================================
// 14. 优雅退出
// ============================================================
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SHUTDOWN] ${signal} received, closing...`);

    clearInterval(heartbeat);

    wss.clients.forEach((ws) => ws.terminate());
    wss.close();

    for (const [id, entry] of pools) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.client.end(true);
        console.log(`[MQTT] ${id} closed`);
    }
    pools.clear();
    topicRefs.clear();

    httpServer.close(() => {
        try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));