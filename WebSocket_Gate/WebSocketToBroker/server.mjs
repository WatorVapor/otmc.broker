// multi-bridge-server.js
import WebSocket, { WebSocketServer } from 'ws';
import mqtt from 'mqtt';
import { createServer } from 'node:http';
import { unlinkSync, mkdirSync } from 'node:fs';
import fs from 'node:fs';
import { X509Certificate, verify } from 'node:crypto';
import * as path from "path";

const TEMP_DIR = '/var/run/otmc';
const SOCKET_PATH = `${TEMP_DIR}/websocket.mqtt.sock`;

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

// ===== WebSocket 子协议白名单（可全局，也可按后端区分）=====
// 全局默认允许的协议
const DEFAULT_ALLOWED_PROTOCOLS = new Set(['mqtt', 'mqttv3.1', 'mqtt-bridge.v1']);

// 若需要“按后端”区分，可启用下面这张表（未列出的后端回落到 DEFAULT）
const ALLOWED_BY_BACKEND = {
    'backend-a': new Set(['mqtt', 'mqttv3.1']),
    'backend-b': new Set(['mqtt']),
    'backend-c': new Set(['mqtt']),
};

// ===== 连接池：每个后端复用一条 MQTT 连接 =====
const pools = new Map();       // backendId -> { client, refCount, closeTimer, subscribers }
const topicRefs = new Map();   // `${backendId}\u0000${topic}` -> refCount

const IDLE_TIMEOUT_MS = 60_000;  // 引用归零后保留连接的时长

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
        refCount: 1,          // 由调用方持有
        closeTimer: null,
        subscribers: new Set(),  // { ws, topic }
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

    // 引用归零后延迟断开，避免频繁重连
    entry.closeTimer = setTimeout(() => {
        const e = pools.get(backendId);
        if (e !== entry || e.refCount > 0) return;
        e.client.end(true);
        pools.delete(backendId);
        console.log(`[MQTT] ${backendId} pool removed (idle)`);
    }, IDLE_TIMEOUT_MS);
}

// ===== topic 引用计数：避免共享连接上 unsubscribe 误伤其他客户端 =====
function acquireTopic(entry, backendId, ws, topic) {
    const key = `${backendId}\u0000${topic}`;
    const n = topicRefs.get(key) ?? 0;
    topicRefs.set(key, n + 1);

    const sub = { ws, topic };
    entry.subscribers.add(sub);

    if (n === 0) {
        entry.client.subscribe(topic, (err) => {
            if (err) console.error(`[MQTT] ${backendId} subscribe "${topic}" error:`, err.message);
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

// ===== MQTT 通配符匹配（+ 单层，# 多层末尾）=====
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

// ===== 启动前清理旧 socket =====
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

// ===== WebSocket 服务（带子协议协商）=====
const httpServer = createServer();

const wss = new WebSocketServer({
    server: httpServer,

    // protocols: Set<string>（客户端请求的子协议）
    // request  : http.IncomingMessage
    handleProtocols: (protocols, request) => {
        // 未携带任何子协议 → ws 不会调用此函数，握手以“无子协议”继续

        let backendId = null;
        try {
            const url = new URL(request.url ?? '/', 'ws://localhost');
            backendId = url.searchParams.get('backend');
        } catch { /* URL 解析失败按默认处理 */ }

        // 优先使用按后端白名单，否则回落到全局默认
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
            `(client sent: ${[...protocols].join(', ') || '<none>'}${backendId ? `, backend=${backendId}` : ''})`
        );
        return false;  // false => 中止握手
    },
});

httpServer.listen(SOCKET_PATH, () => {
    console.log(`[WS] multi-backend bridge listening on unix://${SOCKET_PATH}`);
});

wss.on('connection', (ws, req) => {
    // 使用 WHATWG URL 替代已废弃的 url.parse
    let params;
    try {
        params = new URL(req.url ?? '/', 'ws://localhost').searchParams;
    } catch {
        ws.close(4000, 'Bad request');
        return;
    }
    const headers = req.headers;
    // console.log('[WS] headers:=<', headers, '>');
    const  headsWSSecKey = headers['sec-websocket-protocol'];
    // console.log('[WS] headsWSSecKey:=<', headsWSSecKey, '>');
    const certMqttAuth = parseMqttAuthText(headsWSSecKey);
    // console.log('[WS] certMqttAuth:=<', certMqttAuth, '>');
    const certMqttAuthJson = certMqttAuth.auth;
    console.log('[WS] certMqttAuthJson:=<', certMqttAuthJson, '>');
    const verifyResult = verifyMqttAuth(certMqttAuthJson);
    if (!verifyResult) {
        ws.close(4001, 'Unauthorized');
        return;
    }

    const token     = params.get('token');
    const backendId = params.get('backend');
    const topic     = params.get('topic');

    // 不打印 token 明文
    console.log(
        `[WS] new connection: backend=${backendId}, topic=${topic}, subprotocol=${ws.protocol || '<none>'}`
    );

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

    // ===== 获取该后端的 MQTT 连接 =====
    const entry = getBackendClient(backendId);
    if (!entry) {
        ws.close(4003, 'Backend unavailable');
        return;
    }

    // ===== 订阅（引用计数）=====
    const sub = acquireTopic(entry, backendId, ws, topic);
    console.log(`[WS] client connected: backend=${backendId}, topic=${topic}`);

    // 心跳标记
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

// ===== 心跳：发送 ping 并检测 pong，清理半死连接 =====
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30_000);

// ===== Token 校验 =====
function isValidToken(token) {
    return token === 'your-secret-token';
}

// ===== 优雅退出 =====
let shuttingDown = false;

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

    // 兜底：1s 内没退出就强制退出
    setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));



const  parseMqttAuthText = (text) => {
  const clean = String(text).trim().replace(/>\s*$/, '');
  const map = {};

  for (const item of clean.split(',')) {
    const seg = item.trim();
    if (!seg) continue;

    const dotIndex = seg.indexOf('.');

    // 例如 mqtt 没有 ".xxx"，值置空
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

const  decodeBase64UrlJson = (s) => {
  try {
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (err) {
    // 解码失败则保留原始值，避免整个解析失败
    return s;
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));


const caRootMqttClient = fs.readFileSync(path.resolve( "/usr/local/etc/certs/client_cert/client-root.crt"));
const caTrustedMqttClient = fs.readFileSync(path.resolve( "/usr/local/etc/certs/client_cert/ca_inter_bundle.crt"));

const verifyMqttAuth = (auth) => {
  if (!auth || typeof auth !== 'object') {
    return false;
  }
  const certs = auth.chain.map((c) => new X509Certificate(toPem(c)));
  console.log('[WS] certs:=<', certs, '>');
  const leafCert = certs[0]; // 叶子证书，用它的公钥验签
  const verifyData = Buffer.from(auth.payload, 'utf8');
  const signature = Buffer.from(auth.sig, 'base64url'); // sig 是 Base64URL
  const isValid = verify(
    'sha384',                 // ECDSA-P384-SHA384 中的哈希算法
    verifyData,               // 原始 payload 字节
    leafCert.publicKey,       // 叶子证书公钥
    signature,
    { dsaEncoding: 'der' }    // 如果失败，改成 'ieee-p1363' 再试
  );
  console.log('[WS] isValid:=<', isValid, '>');

}

function toPem(base64Cert) {
  const lines = base64Cert.match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
}

