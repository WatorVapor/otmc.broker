// multi-bridge-server.js
import WebSocket, { WebSocketServer } from 'ws';
import mqtt from 'mqtt';
import { createServer } from 'node:http';
import { unlinkSync, mkdirSync } from 'node:fs';
import fs from 'node:fs';
import { X509Certificate, verify } from 'node:crypto';
import * as path from 'path';

// ============================================================
// 0. 全局状态
// ============================================================
const TEMP_DIR = '/var/run/otmc';
const SOCKET_PATH = `${TEMP_DIR}/websocket.mqtt.sock`;

let shuttingDown = false;

// ============================================================
// 1. 多个 MQTT 后端配置
// ============================================================
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
        url: 'mqtts://remote.example.com:8883',
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

// ============================================================
// 2. WebSocket 子协议白名单
// ============================================================
const DEFAULT_ALLOWED_PROTOCOLS = new Set(['mqtt', 'mqttv3.1', 'mqtt-bridge.v1']);

const ALLOWED_BY_BACKEND = {
    'backend-a': new Set(['mqtt', 'mqttv3.1']),
    'backend-b': new Set(['mqtt']),
    'backend-c': new Set(['mqtt']),
};

// ============================================================
// 3. MQTT 认证用的信任锚（证书）
// ============================================================
const caRootMqttClient = fs.readFileSync(
    path.resolve('/usr/local/etc/certs/client_cert/client-root.crt')
);
const caTrustedMqttClient = fs.readFileSync(
    path.resolve('/usr/local/etc/certs/client_cert/ca_inter_bundle.crt')
);

// 把 PEM bundle 拆成多个 X509Certificate（new X509Certificate 只读第一个）
function loadPemBundle(pem) {
    const matches = String(pem).match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
    ) || [];
    return matches.map((p) => new X509Certificate(p));
}

// 这里同时信任 root 与 inter bundle（与原实现一致）。
// 更严格的做法是只信任 root，把 inter 作为链中间环节由 checkIssued+verify 动态验证。
const TRUSTED_CERTS = [
    ...loadPemBundle(caRootMqttClient),
    ...loadPemBundle(caTrustedMqttClient),
];

// ============================================================
// 4. 认证辅助函数
// ============================================================
function toPem(base64Cert) {
    const lines = String(base64Cert).match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

function decodeBase64UrlJson(s) {
    try {
        let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
        return s;
    }
}

function parseMqttAuthText(text) {
    const clean = String(text).trim().replace(/>\s*$/, '');
    const map = {};

    for (const item of clean.split(',')) {
        const seg = item.trim();
        if (!seg) continue;

        const dotIndex = seg.indexOf('.');
        if (dotIndex === -1) {
            map[seg] = '';
            continue;
        }

        const key = seg.slice(0, dotIndex).trim();
        const rawValue = seg.slice(dotIndex + 1).trim();

        if (key === 'auth') {
            map[key] = decodeBase64UrlJson(rawValue);
        } else {
            map[key] = rawValue;
        }
    }

    return map;
}

// ============================================================
// 5. 证书链 + 签名校验
//    auth = { chain: [leafB64, interB64?, rootB64?], payload, sig }
//    chain 顺序约定：leaf → … → root
// ============================================================
function verifyMqttAuth(auth) {
    if (!auth || typeof auth !== 'object') return false;
    if (!Array.isArray(auth.chain) || auth.chain.length === 0) return false;
    if (typeof auth.payload !== 'string' || typeof auth.sig !== 'string') return false;

    // --- 解析证书链 ---
    let certs;
    try {
        certs = auth.chain.map((c) => new X509Certificate(toPem(c)));
    } catch (err) {
        console.warn('[WS] invalid cert in chain:', err.message);
        return false;
    }

    // --- 有效期 ---
    // 注意：X509Certificate.verify() 本身不检查有效期，必须手动检查
    const now = Date.now();
    for (const cert of certs) {
        const from = new Date(cert.validFrom).getTime();
        const to = new Date(cert.validTo).getTime();
        if (!(from <= now && now <= to)) {
            console.warn('[WS] cert expired/not-yet-valid:', cert.subject);
            return false;
        }
    }

    // --- 链内逐级验签：certs[i] 必须由 certs[i+1] 签发 ---
    for (let i = 0; i < certs.length - 1; i++) {
        const child = certs[i];
        const parent = certs[i + 1];
        try {
            if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
                console.warn(`[WS] chain signature check failed: [${i}] <- [${i + 1}]`);
                return false;
            }
        } catch (err) {
            console.warn(`[WS] chain verify error at ${i}:`, err.message);
            return false;
        }
    }

    // --- 链尾必须锚定到受信任证书 ---
    const last = certs[certs.length - 1];
    const anchored = TRUSTED_CERTS.some((t) => {
        // (A) 链尾本身就是受信任证书
        if (last.raw.equals(t.raw)) return true;
        // (B) 链尾由受信任证书签发（例如 chain 只到 intermediate）
        try {
            return last.checkIssued(t) && last.verify(t.publicKey);
        } catch {
            return false;
        }
    });
    if (!anchored) {
        console.warn('[WS] chain does not anchor to trusted root');
        return false;
    }

    // --- 用叶子证书公钥验证 payload 签名 ---
    const leaf = certs[0];
    const verifyData = Buffer.from(auth.payload, 'utf8');
    const signature = Buffer.from(auth.sig, 'base64url');

    let ok = false;
    try {
        ok = verify('sha384', verifyData, leaf.publicKey, signature, {
            dsaEncoding: 'der',
        });
    } catch {
        try {
            ok = verify('sha384', verifyData, leaf.publicKey, signature, {
                dsaEncoding: 'ieee-p1363',
            });
        } catch (err2) {
            console.warn('[WS] signature verify error:', err2.message);
            return false;
        }
    }

    if (!ok) {
        console.warn('[WS] payload signature invalid');
        return false;
    }

    console.log('[WS] mqtt auth OK, subject=%s', leaf.subject);
    return true;
}

// ============================================================
// 6. MQTT 连接池
// ============================================================
const pools = new Map();       // backendId -> { client, refCount, closeTimer, subscribers }
const topicRefs = new Map();   // `${backendId}\u0000${topic}` -> refCount

const IDLE_TIMEOUT_MS = 60_000;

function getBackendClient(backendId) {
    const existing = pools.get(backendId);
    if (existing) {
        existing.refCount++;
        if (existing.closeTimer) {
            clearTimeout(existing.closeTimer);
            existing.closeTimer = null;
        }
        return existing;
    }

    const config = BACKENDS[backendId];
    if (!config) return null;

    console.log(`[MQTT] creating connection to backend: ${backendId}`);
    const client = mqtt.connect(config.url, config.options);

    const entry = {
        client,
        refCount: 1,
        closeTimer: null,
        subscribers: new Set(), // { ws, topic }
    };
    pools.set(backendId, entry);

    client.on('connect', () => console.log(`[MQTT] ${backendId} connected`));
    client.on('reconnect', () => console.log(`[MQTT] ${backendId} reconnecting...`));
    client.on('error', (err) => console.error(`[MQTT] ${backendId} error:`, err.message));
    client.on('close', () => console.log(`[MQTT] ${backendId} closed`));

    // MQTT -> 浏览器：全局唯一监听，按订阅 filter 过滤后分发
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
// 10. WebSocket 服务
// ============================================================
const httpServer = createServer();

const wss = new WebSocketServer({
    server: httpServer,

    handleProtocols: (protocols, request) => {
        let backendId = null;
        try {
            const url = new URL(request.url ?? '/', 'ws://localhost');
            backendId = url.searchParams.get('backend');
        } catch { /* ignore */ }

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
    let params;
    try {
        params = new URL(req.url ?? '/', 'ws://localhost').searchParams;
    } catch {
        ws.close(4000, 'Bad request');
        return;
    }

    // ===== 证书链 + 签名校验 =====
    const headers = req.headers;
    const headsWSSecKey = headers['sec-websocket-protocol'];
    const certMqttAuth = parseMqttAuthText(headsWSSecKey);
    const certMqttAuthJson = certMqttAuth.auth;
    console.log('[WS] certMqttAuthJson:=<', certMqttAuthJson, '>');

    const verifyResult = verifyMqttAuth(certMqttAuthJson);
    if (!verifyResult) {
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

    // ===== token / backend / topic 校验 =====
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

    // ===== 获取该后端的 MQTT 连接 =====
    const entry = getBackendClient(backendId);
    if (!entry) {
        ws.close(4003, 'Backend unavailable');
        return;
    }

    // ===== 订阅 =====
    const sub = acquireTopic(entry, backendId, ws, topic);
    console.log(`[WS] client connected: backend=${backendId}, topic=${topic}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // ===== 浏览器 -> MQTT =====
    ws.on('message', (data) => {
        const text = Buffer.isBuffer(data) ? data.toString() : String(data);
        try {
            const msg = JSON.parse(text);
            const pubTopic = msg.topic || topic;
            let payload;
            if (msg.payload === undefined) {
                payload = text;
            } else if (typeof msg.payload === 'string' || Buffer.isBuffer(msg.payload)) {
                payload = msg.payload;
            } else {
                payload = JSON.stringify(msg.payload);
            }
            entry.client.publish(pubTopic, payload);
        } catch {
            entry.client.publish(topic, text);
        }
    });

    // ===== 清理 =====
    ws.on('close', () => {
        console.log(`[WS] client disconnected: backend=${backendId}, topic=${topic}`);
        releaseTopic(entry, backendId, sub);
        releaseBackend(backendId);
    });

    ws.on('error', (err) => console.error('[WS] error:', err.message));
});

// ============================================================
// 11. 心跳
// ============================================================
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30_000);

// ============================================================
// 12. Token 校验
// ============================================================
function isValidToken(token) {
    return token === 'your-secret-token';
}

// ============================================================
// 13. 优雅退出
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