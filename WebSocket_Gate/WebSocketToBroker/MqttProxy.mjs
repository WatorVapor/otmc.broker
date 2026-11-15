// multi-bridge-server.js
import WebSocket, { WebSocketServer } from 'ws';
import mqtt from 'mqtt';
import { createServer } from 'node:http';
import { unlinkSync, mkdirSync } from 'node:fs';
import fs from 'node:fs';
import { X509Certificate, verify, createPublicKey } from 'node:crypto';
import * as path from 'path';

// ============================================================
// 0. 全局状态
// ============================================================
const TEMP_DIR = '/var/run/otmc';
const SOCKET_PATH = `${TEMP_DIR}/websocket.mqtt.sock`;

const AUTH_MAX_SKEW_MS = 5 * 60_000;
const MAX_CHAIN_DEPTH = 16;

// 环境变量：OTMC_DUMP_CERTS=1 时才打印每张证书的完整 PEM
const DUMP_CERTS = process.env.OTMC_DUMP_CERTS === '1';

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
        }
    },
    'backend-b': {
        url: 'mqtt://192.168.1.100:1883',
        options: {
            clientId: 'bridge-b-' + Math.random().toString(16).slice(2, 8),
            clean: true,
            reconnectPeriod: 5000,
        }
    },
    'backend-c': {
        url: 'mqtts://remote.example.com:8883',
        options: {
            clientId: 'bridge-c-' + Math.random().toString(16).slice(2, 8),
            clean: true,
            reconnectPeriod: 5000,
            rejectUnauthorized: true,
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

function loadPemBundle(pem) {
    const matches = String(pem).match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
    ) || [];
    return matches.map((p) => new X509Certificate(p));
}

const TRUSTED_CERTS = [
    ...loadPemBundle(caRootMqttClient),
    ...loadPemBundle(caTrustedMqttClient),
];

// ============================================================
// 4. 认证辅助函数
// ============================================================

function toPem(base64Cert) {
    let b64 = String(base64Cert).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const lines = b64.match(/.{1,64}/g)?.join('\n') ?? '';
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

function buildChainToTrustAnchor(leaf, providedIntermediates, trustedCerts) {
    const isTrusted = (c) => trustedCerts.some((t) => t.raw.equals(c.raw));
    const hex = (s) => (s ? Buffer.from(s, 'binary').toString('hex').toUpperCase() : '<none>');

    if (DUMP_CERTS) {
        const pemOf = (cert) => {
            const b64 = Buffer.from(cert.raw).toString('base64');
            const lines = b64.match(/.{1,64}/g)?.join('\n') ?? '';
            return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
        };
        const dumpCert = (tag, cert) => {
            console.log(`\n===== ${tag} =====`);
            console.log(`subject   : ${cert.subject.replace(/\n/g, ', ')}`);
            console.log(`issuer    : ${cert.issuer.replace(/\n/g, ', ')}`);
            console.log(`notBefore : ${cert.validFrom}`);
            console.log(`notAfter  : ${cert.validTo}`);
            console.log(`SHA256    : ${cert.fingerprint256}`);
            console.log(`PEM       :`);
            console.log(pemOf(cert));
        };
        console.log('\n[CHAIN] ============ INPUT CERTIFICATES ============');
        dumpCert('leaf (chain[0])', leaf);
        providedIntermediates.forEach((c, i) => dumpCert(`providedIntermediates[${i}]`, c));
        trustedCerts.forEach((c, i) => dumpCert(`trustedCerts[${i}]`, c));
        console.log('[CHAIN] ===========================================\n');
    }

    const chain = [leaf];
    const seen = new Set([leaf.fingerprint256]);
    const pool = [
        ...providedIntermediates.filter((c) => !seen.has(c.fingerprint256)),
        ...trustedCerts,
    ];

    let cur = leaf;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
        if (isTrusted(cur)) return chain;
        if (cur.checkIssued(cur)) return null;

        let parent = null;
        for (const cand of pool) {
            if (seen.has(cand.fingerprint256)) continue;
            try {
                const issuedOk = cur.checkIssued(cand);
                const verifyOk = issuedOk && cur.verify(cand.publicKey);
                if (issuedOk && verifyOk) { parent = cand; break; }
            } catch { /* 换下一个 */ }
        }
        if (!parent) {
            console.warn(
                `[CHAIN] depth=${depth} no parent for "${cur.subject.replace(/\n/g, ', ')}" ` +
                `(issuer=${cur.issuer.replace(/\n/g, ', ')})`
            );
            return null;
        }
        chain.push(parent);
        seen.add(parent.fingerprint256);
        cur = parent;
    }
    return null;
}

// ============================================================
// 5. 证书链 + 签名校验
//    ts 兼容 number(ms) 与 ISO 8601 字符串
//    签名既兼容浏览器 WebCrypto 的 raw (ieee-p1363)，也兼容 Node/openssl 的 DER
// ============================================================
function verifyMqttAuth(auth) {
    if (!auth || typeof auth !== 'object') return false;
    if (!Array.isArray(auth.chain) || auth.chain.length === 0) return false;
    if (typeof auth.payload !== 'string' || typeof auth.sig !== 'string') return false;

    if (auth.alg !== 'ECDSA-P384-SHA384') {
        console.warn('[WS] unsupported alg:', auth.alg);
        return false;
    }

    // 兼容两种 ts
    let tsMs;
    let tsStr;

    if (typeof auth.ts === 'number' && Number.isFinite(auth.ts)) {
        tsMs = auth.ts;
        tsStr = String(auth.ts);
    } else if (typeof auth.ts === 'string') {
        tsMs = Date.parse(auth.ts);
        tsStr = auth.ts;
        if (Number.isNaN(tsMs)) {
            console.warn('[WS] auth.ts missing/invalid:', auth.ts);
            return false;
        }
    } else {
        console.warn('[WS] auth.ts missing/invalid:', auth.ts);
        return false;
    }

    if (Math.abs(Date.now() - tsMs) > AUTH_MAX_SKEW_MS) {
        console.warn(`[WS] auth.ts out of window: ${tsStr}`);
        return false;
    }

    if (typeof auth.cid !== 'string' || auth.payload !== `${auth.cid}|${tsStr}`) {
        console.warn('[WS] auth payload does not match cid|ts');
        return false;
    }

    // --- 解析 leaf ---
    let leaf;
    try {
        leaf = new X509Certificate(toPem(auth.chain[0]));
    } catch (err) {
        console.warn('[WS] invalid leaf cert:', err.message);
        return false;
    }

    // --- 解析客户端提供的中间证书 ---
    const provided = [];
    for (let i = 1; i < auth.chain.length; i++) {
        try {
            provided.push(new X509Certificate(toPem(auth.chain[i])));
        } catch (err) {
            console.warn(`[WS] invalid cert in chain[${i}]:`, err.message);
        }
    }

    // --- 重建链 ---
    const fullChain = buildChainToTrustAnchor(leaf, provided, TRUSTED_CERTS);
    if (!fullChain) {
        console.warn('[WS] unable to build chain to a trusted anchor');
        return false;
    }
    console.log(
        '[WS] chain rebuilt:',
        fullChain.map((c, i) => `[${i}] ${c.subject.replace(/\n/g, ', ')}`).join('  ->  ')
    );

    // --- 有效期 ---
    const now = Date.now();
    for (const cert of fullChain) {
        const from = new Date(cert.validFrom).getTime();
        const to = new Date(cert.validTo).getTime();
        if (!(from <= now && now <= to)) {
            console.warn('[WS] cert expired/not-yet-valid:', cert.subject);
            return false;
        }
    }

    // --- 逐级验签 ---
    for (let i = 0; i < fullChain.length - 1; i++) {
        const child = fullChain[i];
        const parent = fullChain[i + 1];
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

    // --- payload 签名验证 ---
    // 浏览器 WebCrypto 输出 raw (r||s, IEEE P1363)，P-384 为 96 字节；
    // Node crypto.verify 默认期望 DER，需显式指定 dsaEncoding。
    // leaf.publicKey 已是 KeyObject (type='public')，直接作为 key 使用。
    const verifyData = Buffer.from(auth.payload, 'utf8');
    const signature = Buffer.from(auth.sig, 'base64url');
    const publicKeyObj = leaf.publicKey;

    const isLikelyRaw = signature.length === 96;
    const encodings = isLikelyRaw ? ['ieee-p1363', 'der'] : ['der', 'ieee-p1363'];

    let ok = false;
    let usedEncoding = '';

    for (const enc of encodings) {
        try {
            ok = verify(
                'sha384',
                verifyData,
                { key: publicKeyObj, dsaEncoding: enc },
                signature
            );
            usedEncoding = enc;
            if (ok) break;
        } catch (err) {
            console.warn(`[WS] verify (dsaEncoding=${enc}) threw:`, err.message);
        }
    }

    if (!ok) {
        console.warn(
            `[WS] payload signature invalid (signature length=${signature.length}B, ` +
            `tried ieee-p1363 and der)`
        );
        return false;
    }

    console.log(
        '[WS] mqtt auth OK, subject=%s, sigFormat=%s',
        leaf.subject.replace(/\n/g, ', '),
        usedEncoding
    );
    return true;
}

// ============================================================
// 6. MQTT 连接池
// ============================================================
const pools = new Map();
const topicRefs = new Map();
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