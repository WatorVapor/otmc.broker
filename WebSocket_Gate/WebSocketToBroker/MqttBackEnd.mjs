// multi-bridge-server.js
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
