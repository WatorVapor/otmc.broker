// multi-bridge-server.js
// ============================================================
// 1. 多个 MQTT 后端配置
// ============================================================
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_CONFIG = {
    path: "/usr/local/etc/haproxy/backends"
};

// ------------------------------------------------------------
// HAProxy .cfg 解析器
// ------------------------------------------------------------
// 带参数的 flag：flag value
const ARG_FLAGS = new Set([
    'ca-file', 'crt', 'key', 'verify', 'weight', 'maxconn', 'minconn',
    'sni', 'proto', 'inter', 'rise', 'fall', 'fastinter', 'downinter',
]);

// 无参数的 flag：仅出现即为 true
const NOARG_FLAGS = new Set([
    'ssl', 'check', 'backup', 'disabled', 'send-proxy', 'send-proxy-v2',
    'no-sslv3', 'no-tlsv10', 'no-tlsv11', 'force-tlsv12', 'force-tlsv13',
]);

// 解析地址，支持 [IPv6]:port 与 host:port 两种形式
const parseAddr = (s) => {
    if (s.startsWith('[')) {                       // 例：[fd7a:115c:a1e0::10]:18883
        const end = s.indexOf(']');
        const host = s.slice(1, end);
        const rest = s.slice(end + 1);
        return { host, port: rest.startsWith(':') ? Number(rest.slice(1)) : null };
    }
    const i = s.lastIndexOf(':');                  // host:port 或无端口
    if (i === -1) return { host: s, port: null };
    return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
};

// 解析一行 server 指令
const parseServer = (toks) => {
    const [name, addr, ...rest] = toks;
    const { host, port } = parseAddr(addr);

    const options = {};
    for (let i = 0; i < rest.length; ) {
        const t = rest[i];
        if (ARG_FLAGS.has(t))       { options[t] = rest[i + 1]; i += 2; }
        else if (NOARG_FLAGS.has(t)){ options[t] = true;       i += 1; }
        else                        { (options._unknown ??= []).push(t); i += 1; }
    }

    return {
        name,
        host,
        port,
        ssl:    options.ssl === true,
        caFile: options['ca-file'] ?? null,
        crt:    options.crt ?? null,
        verify: options.verify ?? null,
        options,
    };
};

// 解析整个 .cfg 文件：去注释、合并续行、提取 backend/mode/server
const parseBackendCfg = (text, fileName) => {
    const lines = [];
    let buf = '';
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/(^|\s)#.*$/, '').trimEnd();   // 去掉 # 注释
        if (!line) continue;
        if (line.endsWith('\\')) {                              // 处理 \ 续行
            buf += line.slice(0, -1) + ' ';
            continue;
        }
        lines.push((buf + line).trim());
        buf = '';
    }
    if (buf.trim()) lines.push(buf.trim());

    let name = null, mode = null;
    const servers = [];

    for (const line of lines) {
        const toks = line.split(/\s+/);
        switch (toks[0]) {
            case 'backend': name = toks[1]; break;
            case 'mode':    mode = toks[1]; break;
            case 'server':  servers.push(parseServer(toks.slice(1))); break;
            // 其它 HAProxy 指令暂不处理
        }
    }

    return { file: fileName, name, mode, servers };
};

// ------------------------------------------------------------
// 读取所有 mqtt_backend_*.cfg
// ------------------------------------------------------------
const readMqttBackendConfig = () => {
    const backendsDir = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        BACKEND_CONFIG.path
    );
    const matchingFiles = readdirSync(backendsDir)
        .filter(name => name.startsWith('mqtt_backend_') && name.endsWith('.cfg'))
        .sort();

    if (matchingFiles.length === 0) {
        throw new Error(`No mqtt_backend_*.cfg file found in ${backendsDir}`);
    }
    console.log('Using MQTT backend config file matchingFiles:=<', matchingFiles, '>');

    const backends = {};
    for (const file of matchingFiles) {
        console.log('Found MQTT backend config file:=<', file, '>');
        const configContent = readFileSync(path.join(backendsDir, file), 'utf8');
        console.log('Config content:=<', configContent, '>');

        const parsed = parseBackendCfg(configContent, file);

        if (!parsed.name) {
            console.warn(`[MqttBackEnd] ${file}: 缺少 'backend' 指令，跳过`);
            continue;
        }
        if (parsed.servers.length === 0) {
            console.warn(`[MqttBackEnd] ${file}: 没有 'server' 行，跳过`);
            continue;
        }
        backends[parsed.name] = parsed;
    }
    for (const name of Object.keys(backends)) {
        console.log('Parsed MQTT name:=<', name, '>');
        console.log('Parsed MQTT backend:=<', backends[name], '>');
    }   
    return backends;
};

const BACKENDS = readMqttBackendConfig();
const matchBackendById = (backendId) => {
    for (const [name, backend] of Object.entries(BACKENDS)) {
        if (name === backendId) {
            return backend;
        }
    }
    return null;
};

export { matchBackendById };