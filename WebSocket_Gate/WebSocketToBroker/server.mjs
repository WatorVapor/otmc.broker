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

// [FIX] auth 时间戳允许的最大时钟偏差
const AUTH_MAX_SKEW_MS = 5 * 60_000;
// [FIX] 证书链重建的最大深度，防止恶意构造的环形链
const MAX_CHAIN_DEPTH = 16;

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

// 同时信任 root 与 inter bundle：
//   - root 作为最终锚点
//   - inter bundle 作为"权威中间证书池"，用来补全客户端缺漏/拼错的中间层
const TRUSTED_CERTS = [
    ...loadPemBundle(caRootMqttClient),
    ...loadPemBundle(caTrustedMqttClient),
];

// ============================================================
// 4. 认证辅助函数
// ============================================================

// [FIX] 客户端送来的是 base64url (RFC 4648 §5)，OpenSSL PEM 只认标准 base64。
// 必须先把 '-'→'+'、'_'→'/' 并补齐 padding，否则会报:
//   error:04800064:PEM routines::bad base64 decode
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

// [FIX] 从 leaf 出发，在 "客户端提供的中间证书 + 本地 trust store" 中按
// AKID/SKID + 签名关系重建链。这样：
//   1. 客户端链拼错（同名不同 key）会被自动纠正
//   2. 客户端无法用伪造的中间层旁路服务端校验
//   3. 客户端只送 leaf 也能由本地 bundle 补全
function buildChainToTrustAnchor(leaf, providedIntermediates, trustedCerts) {
    const isTrusted = (c) => trustedCerts.some((t) => t.raw.equals(c.raw));
    const hex = (s) => (s ? Buffer.from(s, 'binary').toString('hex') : '<none>');

    const chain = [leaf];
    const seen = new Set([leaf.fingerprint256]);
    const pool = [
        ...providedIntermediates.filter((c) => !seen.has(c.fingerprint256)),
        ...trustedCerts,
    ];

    let cur = leaf;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
        if (isTrusted(cur)) {
            console.log(`[CHAIN] depth=${depth} "${cur.subject}" is a trusted anchor, done`);
            return chain;
        }
        if (cur.checkIssued(cur)) {
            console.warn(`[CHAIN] depth=${depth} "${cur.subject}" self-signed but NOT trusted`);
            return null;
        }

        console.log(`[CHAIN] depth=${depth} cur="${cur.subject}"`);
        console.log(`[CHAIN]   issuer = ${cur.issuer}`);
        console.log(`[CHAIN]   AKID   = ${hex(cur.authorityKeyIdentifier)}`);
        console.log(`[CHAIN]   pool   = ${pool.length} (seen=${seen.size})`);

        let parent = null;
        for (const cand of pool) {
            if (seen.has(cand.fingerprint256)) continue;
            try {
                const issuedOk = cur.checkIssued(cand);
                const verifyOk = issuedOk && cur.verify(cand.publicKey);
                // 只对 subject 与 issuer 字符串能对上的候选打日志，避免刷屏
                if (cur.issuer === cand.subject) {
                    console.log(
                        `[CHAIN]   candidate "${cand.subject}" SKID=${hex(cand.subjectKeyIdentifier)} ` +
                        `checkIssued=${issuedOk} verify=${verifyOk}`
                    );
                }
                if (issuedOk && verifyOk) { parent = cand; break; }
            } catch (err) {
                if (cur.issuer === cand.subject) {
                    console.log(`[CHAIN]   candidate "${cand.subject}" verify threw: ${err.message}`);
                }
            }
        }

        if (!parent) {
            console.warn(`[CHAIN] depth=${depth} no parent for "${cur.subject}" (issuer=${cur.issuer})`);
            return null;
        }
        console.log(`[CHAIN] depth=${depth} parent = "${parent.subject}"`);
        chain.push(parent);
        seen.add(parent.fingerprint256);
        cur = parent;
    }
    return null;
}


// ============================================================
// 5. 证书链 + 签名校验
//    auth = { v, alg, ts, cid, payload, sig, chain: [leafB64, ...] }
//    ts 既支持 number(ms) 也支持 ISO 8601 字符串（如 2026-11-13T14:04:28.236Z）
// ============================================================
function verifyMqttAuth(auth) {
    if (!auth || typeof auth !== 'object') return false;
    if (!Array.isArray(auth.chain) || auth.chain.length === 0) return false;
    if (typeof auth.payload !== 'string' || typeof auth.sig !== 'string') return false;

    // [FIX] 算法白名单
    if (auth.alg !== 'ECDSA-P384-SHA384') {
        console.warn('[WS] unsupported alg:', auth.alg);
        return false;
    }

    // [FIX] 兼容两种 ts：number(ms) 或 ISO 8601 字符串
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

    // [FIX] payload 必须与 cid|ts 一致，防篡改（ts 使用原样字符串，保证与签名内容一致）
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

    // --- 解析客户端提供的中间证书（允许个别无效，跳过并记录） ---
    const provided = [];
    for (let i = 1; i < auth.chain.length; i++) {
        try {
            provided.push(new X509Certificate(toPem(auth.chain[i])));
        } catch (err) {
            console.warn(`[WS] invalid cert in chain[${i}]:`, err.message);
        }
    }

    // --- 以 leaf 为起点重建到受信任锚点的完整链 ---
    const fullChain = buildChainToTrustAnchor(leaf, provided, TRUSTED_CERTS);
    if (!fullChain) {
        console.warn('[WS] unable to build chain to a trusted anchor');
        return false;
    }
    console.log(
        '[WS] chain rebuilt:',
        fullChain.map((c, i) => `[${i}] ${c.subject}`).join('  ->  ')
    );

    // --- 有效期（X509Certificate.verify 不检查有效期，必须手动检查） ---
    const now = Date.now();
    for (const cert of fullChain) {
        const from = new Date(cert.validFrom).getTime();
        const to = new Date(cert.validTo).getTime();
        if (!(from <= now && now <= to)) {
            console.warn('[WS] cert expired/not-yet-valid:', cert.subject);
            return false;
        }
    }

    // --- 链内逐级验签（重建时已验过，这里再显式校验一次，便于日志） ---
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

    // --- 用叶子证书公钥验证 payload 签名 ---
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

    // [FIX] 重连后 clean:true 的会话订阅会丢失，需要按 subscribers 重新订阅
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
// 10. 请求解析辅助
// ============================================================
// [FIX] handleProtocols 与 connection 共用同一解析逻辑，避免维护两份
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

        // [FIX] 发布 topic 必须落在本连接的订阅 filter 范围内，防越权
        if (!mqttMatch(topic, pubTopic)) {
            console.warn(
                `[WS] publish denied: topic "${pubTopic}" outside subscription "${topic}"`
            );
            return;
        }
        // [FIX] 发布 topic 不允许含通配符（MQTT 规范）
        if (/[+#]/.test(pubTopic)) {
            console.warn(`[WS] publish denied: topic "${pubTopic}" contains wildcard`);
            return;
        }

        entry.client.publish(pubTopic, payload);
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