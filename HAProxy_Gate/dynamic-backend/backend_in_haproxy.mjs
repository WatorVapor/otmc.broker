import net from 'node:net';
import { config } from './config.mjs';
import * as fs from 'node:fs';
import path from 'path';
import { execSync } from 'node:child_process';

// ============ 配置区 ============
const SOCKET_PATH = config.haproxy.socketPath;
const COMMAND_TIMEOUT_MS = config.haproxy.commandTimeoutMs;

// ============ 核心通信函数 ============

/**
 * 通过 Unix Socket 执行 HAProxy Runtime API 命令
 * @param {string} command - 要执行的 Runtime API 命令
 * @returns {Promise<string>} - 命令执行结果
 */
function executeRuntimeCommand(command) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(SOCKET_PATH, () => {
            client.write(`${command}\n`);
        });

        let data = '';
        client.setEncoding('utf8');
        client.on('data', (chunk) => {
            data += chunk;
        });

        client.on('end', () => {
            resolve(data.trim());
        });

        client.on('error', (err) => {
            reject(err);
        });

        client.setTimeout(COMMAND_TIMEOUT_MS, () => {
            client.destroy();
            reject(new Error(`Command timed out: ${command}`));
        });
    });
}

// ============ Backend 操作封装 ============

/**
 * 获取当前所有 Backend 的名称列表
 */
async function listCurrentBackends() {
    const result = await executeRuntimeCommand('show backend');
    console.log('listCurrentBackends: result:=<', result, '>');
    const lines = result.split('\n');
    const backends = [];
    for (const line of lines) {
        const match = line.match(/mqtt_backend_(\S+)/);
        if (match) backends.push(match[1]);
    }
    return backends;
}


const generateBackendConfig = (nodeId, peerBackend) => {
    const backendConfig = 
`backend mqtt_backend_${nodeId}
    mode tcp
    server mqtt_broker_${nodeId.slice(0, 10)} [${peerBackend.host}]:${peerBackend.port} ssl ca-file /usr/local/etc/certs/internal_cert/internal-root.crt crt /usr/local/etc/certs/internal_cert/internal-client.crt.key.pem verify required
`;
    return backendConfig;
};


const reloadHaproxyConfig = async () => {
    try {
        execSync('docker kill -s HUP otmc-haproxy');
        execSync('sleep 3'); // 等待 HAProxy 重新加载配置
        console.log('reloadHaproxyConfig: HAProxy configuration reloaded successfully.');
    } catch (error) {
        console.error('reloadHaproxyConfig: Error reloading HAProxy configuration:', error);
    }
}


class BackendOfHaproxy {
    static async syncBackends() {
        await syncBackends();
    }
    static async listCurrentBackends() {
        return await listCurrentBackends();
    }
    static async addBackend(nodeId, peerBackend) {
        console.log(`[ADD] BackendOfHaproxy.addBackend: peerBackend:=<`, peerBackend, `>`);
        const backendConfig = generateBackendConfig(nodeId, peerBackend);
        console.log(`[ADD] BackendOfHaproxy.addBackend: backendConfig:=<`, backendConfig, `>`);
        const backendFilePath = path.join(config.haproxy.haproxyBackendPath, `mqtt_backend_${nodeId}.cfg`);
        fs.writeFileSync(backendFilePath, backendConfig);
        console.log(`[ADD] BackendOfHaproxy.addBackend: backendFilePath:=<`, backendFilePath, `>`);
        // 重新加载 HAProxy 配置
        await reloadHaproxyConfig();
        console.log(`[ADD] BackendOfHaproxy.addBackend: reload haproxy config done.`);
        const currentBackends = await listCurrentBackends();
        console.log(`[ADD] BackendOfHaproxy.addBackend: currentBackends:=<`, currentBackends, `>`);
    }
    static async deleteBackend(nodeId) {
        const backendFilePath = path.join(config.haproxy.haproxyBackendPath, `mqtt_backend_${nodeId}.cfg`);
        if (fs.existsSync(backendFilePath)) {
            fs.rmSync(backendFilePath, { force: true });
            console.log(`[DELETE] BackendOfHaproxy.deleteBackend: Deleted backend file: ${backendFilePath}`);
        }
        // 重新加载 HAProxy 配置
        await reloadHaproxyConfig();
        console.log(`[DELETE] BackendOfHaproxy.deleteBackend: reload haproxy config done.`);
        const currentBackends = await listCurrentBackends();
        console.log(`[ADD] BackendOfHaproxy.addBackend: currentBackends:=<`, currentBackends, `>`);
    }
}

export { BackendOfHaproxy };
