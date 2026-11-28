// multi-bridge-server.js
import mqtt from 'mqtt';
import { matchBackendById } from './MqttBackEnd.mjs';
import crypto from 'crypto';

// ============================================================
// 6. MQTT 连接池
// ============================================================
const pools = new Map();
const topicRefs = new Map();
const IDLE_TIMEOUT_MS = 60_000;

function createNewConnection(backendId) {
    console.log('[MqttProxy] createNewConnection backendId:=<',backendId,'>');
    const connectionId = `${backendId}-${crypto.randomBytes(16).toString('hex')}`;
    console.log('[MqttProxy] createNewConnection connectionId:=<',connectionId,'>');
    const backEnd = matchBackendById(backendId);
    console.log('[MqttProxy] createNewConnection backEnd:=<',backEnd,'>');
    if (!backEnd) return null;


    return connectionId;
}


function getBackendClient(backendId) {
    console.log('[MqttProxy] creating connection to backend:=<',backendId,'>');
    const existing = pools.get(backendId);
    if (existing) {
        existing.refCount++;
        if (existing.closeTimer) {
            clearTimeout(existing.closeTimer);
            existing.closeTimer = null;
        }
        return existing;
    }

    const backEnd = matchBackendById(backendId);
    if (!backEnd) return null;

    const client = mqtt.connect(backEnd.url, backEnd.options);

    const entry = {
        client,
        refCount: 1,
        closeTimer: null,
        subscribers: new Set(),
    };
    pools.set(backendId, entry);

    client.on('connect', () => {
        console.log(`[MQTT] ${backendId} connected`);
        for (const sub of entry.subscribers) {
            client.subscribe(sub.topic, (err) => {
                if (err) {
                    console.error(
                        `[MQTT] ${backendId} re-subscribe "${sub.topic}" error:`,
                        err.message
                    );
                }
            });
        }
    });
    client.on('reconnect', () => console.log(`[MQTT] ${backendId} reconnecting...`));
    client.on('error', (err) => console.error(`[MQTT] ${backendId} error:`, err.message));
    client.on('close', () => console.log(`[MQTT] ${backendId} closed`));

    client.on('message', (msgTopic, payload) => {
        const text = payload.toString();
        for (const sub of entry.subscribers) {
            if (sub.ws.readyState !== WebSocket.OPEN) continue;
            if (!mqttMatch(sub.topic, msgTopic)) continue;
            sub.ws.send(JSON.stringify({
                backend: backendId,
                topic: msgTopic,
                payload: text,
            }));
        }
    });

    return entry;
}

function releaseBackend(backendId) {
    const entry = pools.get(backendId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (entry.refCount > 0 || entry.closeTimer) return;

    entry.closeTimer = setTimeout(() => {
        const e = pools.get(backendId);
        if (e !== entry || e.refCount > 0) return;
        e.client.end(true);
        pools.delete(backendId);
        console.log(`[MQTT] ${backendId} pool removed (idle)`);
    }, IDLE_TIMEOUT_MS);
}

// ============================================================
// 7. topic 引用计数
// ============================================================
function acquireTopic(entry, backendId, ws, topic) {
    const key = `${backendId}\u0000${topic}`;
    const n = topicRefs.get(key) ?? 0;
    topicRefs.set(key, n + 1);

    const sub = { ws, topic };
    entry.subscribers.add(sub);

    if (n === 0) {
        entry.client.subscribe(topic, (err) => {
            if (err) console.error(
                `[MQTT] ${backendId} subscribe "${topic}" error:`,
                err.message
            );
        });
    }
    return sub;
}

function releaseTopic(entry, backendId, sub) {
    if (shuttingDown) return;
    entry.subscribers.delete(sub);

    const key = `${backendId}\u0000${sub.topic}`;
    const n = (topicRefs.get(key) ?? 1) - 1;
    if (n <= 0) {
        topicRefs.delete(key);
        try {
            entry.client.unsubscribe(sub.topic, () => {});
        } catch { /* client 可能已 end */ }
    } else {
        topicRefs.set(key, n);
    }
}

// ============================================================
// 8. MQTT 通配符匹配
// ============================================================
function mqttMatch(filter, topic) {
    if (filter === topic) return true;
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') return true;
        if (t[i] === undefined) return false;
        if (f[i] === '+') continue;
        if (f[i] !== t[i]) return false;
    }
    return f.length === t.length;
}

export { createNewConnection, getBackendClient, releaseBackend, acquireTopic, releaseTopic };