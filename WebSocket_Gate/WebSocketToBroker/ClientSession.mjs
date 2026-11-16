// multi-bridge-server.js

import {parseMqttAuthText,verifyMqttAuth} from './CertAuth.mjs';
import { getBackendClient, releaseBackend, acquireTopic,releaseTopic } from './MqttProxy.mjs';


// ============================================================
// 2. WebSocket 子协议白名单
// ============================================================
const DEFAULT_ALLOWED_PROTOCOLS = new Set(['mqtt', 'mqttv3.1', 'mqtt-bridge.v1']);

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


const handleProtocols = (protocols, request) => {
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
}

const handleConnection = (ws, req) => {
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
};

export { handleProtocols, handleConnection };