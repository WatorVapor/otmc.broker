// multi-bridge-server.js
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { unlinkSync, mkdirSync } from 'node:fs';
import { handleProtocols, handleVerifyClient, handleConnection,clearAllConnection } from './ClientSession.mjs';

// ============================================================
// 0. 全局状态
// ============================================================
const TEMP_DIR = '/var/run/otmc';
const SOCKET_PATH = `${TEMP_DIR}/websocket.mqtt.sock`;

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
// 11. WebSocket 服务
// ============================================================
const httpServer = createServer();

const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols, request) => {
        return handleProtocols(protocols, request);
    },
    verifyClient: (info, done) => {
        return handleVerifyClient(info, done);
    },
});

httpServer.listen(SOCKET_PATH, () => {
    console.log(`[WS] multi-backend bridge listening on unix://${SOCKET_PATH}`);
});

wss.on('connection', (ws, req) => {
    handleConnection(ws, req);
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
    clearAllConnection();

    httpServer.close(() => {
        try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
        process.exit(0);
    });

    setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));