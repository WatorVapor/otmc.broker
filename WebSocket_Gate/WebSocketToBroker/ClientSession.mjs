// multi-bridge-server.js

import {parseMqttAuthFromProtocol,verifyMqttAuth,calculateMqttBackendId} from './CertAuth.mjs';
import {createNewConnection, getBackendClient, releaseBackend, acquireTopic,releaseTopic } from './MqttProxy.mjs';


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

const handleVerifyClient = (info, done) => {
    const raw = info.req.headers['sec-websocket-protocol'];
    if (!raw || !raw.trim()) {
        console.warn('[verifyClient] missing sec-websocket-protocol');
        return cb(false, 401, 'Missing subprotocol');
    }
    console.log('[ClientSession] handleVerifyClient raw:=<', raw, '>');
    const protocols = raw.split(',').map(s => s.trim()).filter(Boolean);
    console.log('[ClientSession] handleVerifyClient protocols:=<', protocols, '>');
    const {auth, certChain} = parseMqttAuthFromProtocol(protocols);
    console.log('[ClientSession] handleVerifyClient auth:=<', auth, '>');
    console.log('[ClientSession] handleVerifyClient certChain:=<', certChain, '>');
    const isValid = verifyMqttAuth(auth, certChain);
    console.log('[ClientSession] handleVerifyClient verifyMqttAuth result:=<', isValid, '>');
    if (isValid) {
        info.req.backEndId = calculateMqttBackendId(certChain);
        console.log('[ClientSession] handleProtocols info.req.backEndId:=<', info.req.backEndId, '>');
        done(true);
    } else {
        done(false, 4001, 'Unauthorized');
    }
}


const handleProtocols = (protocols, request) => {
    console.log('[ClientSession]  handleProtocols protocols=:<',protocols,'>');
    console.log('[ClientSession] handleProtocols request.backEndId:=<', request.backEndId, '>');
    return "mqtt";
}



const handleConnection = (ws, req) => {
    console.log('[ClientSession] handleConnection req.backEndId:=<', req.backEndId, '>');
    const backendId = req.backEndId;
    const connectId = createNewConnection(backendId);
    if (!connectId) {
        ws.close(4003, 'Backend unavailable');
        return;
    }
    req.mqttConnectId = connectId;

    const sub = acquireTopic(entry, backendId, ws, topic);
    console.log(`[ClientSession] client connected: backend=${backendId}, topic=${topic}`);

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
                `[ClientSession] publish denied: topic "${pubTopic}" outside subscription "${topic}"`
            );
            return;
        }
        if (/[+#]/.test(pubTopic)) {
            console.warn(`[ClientSession] publish denied: topic "${pubTopic}" contains wildcard`);
            return;
        }

        entry.client.publish(pubTopic, payload);
    });

    ws.on('close', () => {
        console.log(`[ClientSession] client disconnected: backend=${backendId}, topic=${topic}`);
        releaseTopic(entry, backendId, sub);
        releaseBackend(backendId);
    });

    ws.on('error', (err) => console.error('[ClientSession] error:', err.message));
};

const clearAllConnection = () => {
    console.log('[ClientSession] clearing all connections...');
    for (const [id, entry] of pools) {
        if (entry.closeTimer) clearTimeout(entry.closeTimer);
        entry.client.end(true);
        console.log(`[MQTT] ${id} closed`);
    }
    pools.clear();
    topicRefs.clear();    
};

export { handleProtocols, handleVerifyClient, handleConnection, clearAllConnection };