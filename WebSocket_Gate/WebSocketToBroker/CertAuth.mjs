// CertAuth.mjs
import fs from 'node:fs';
import * as path from 'node:path';
import { X509Certificate, verify, createHash } from 'node:crypto';

const AUTH_MAX_SKEW_MS = 5 * 60_000;
const MAX_CHAIN_DEPTH = 16;

// 环境变量：OTMC_DUMP_CERTS=1 时才打印每张证书的完整 PEM
const DUMP_CERTS = process.env.OTMC_DUMP_CERTS === '1';

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

function toPem(cert) {
    let b64;
    if (Buffer.isBuffer(cert) || cert instanceof Uint8Array) {
        // 来自 parseMqttAuthFromProtocol 的 DER Buffer
        b64 = Buffer.from(cert).toString('base64');
    } else {
        // 兼容旧路径 / 客户端协议里直接给的 base64url 字符串
        b64 = String(cert).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
    }
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

        let parent = null;
        for (const cand of pool) {
            if (seen.has(cand.fingerprint256)) continue;
            try {
                const issuedOk = cur.checkIssued(cand);
                const verifyOk = issuedOk && cur.verify(cand.publicKey);
                if (verifyOk) { parent = cand; break; }
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
// ============================================================
function verifyMqttAuth(auth, certChain) {
    if (!auth || typeof auth !== 'object') return false;
    if (!Array.isArray(certChain) || certChain.length === 0) {
        console.warn('[CertAuth] empty certChain');
        return false;
    }
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
            console.warn('[CertAuth] auth.ts missing/invalid:', auth.ts);
            return false;
        }
    } else {
        console.warn('[CertAuth] auth.ts missing/invalid:', auth.ts);
        return false;
    }

    if (Math.abs(Date.now() - tsMs) > AUTH_MAX_SKEW_MS) {
        console.warn(`[CertAuth] auth.ts out of window: ${tsStr}`);
        return false;
    }

    if (typeof auth.cid !== 'string' || auth.payload !== `${auth.cid}|${tsStr}`) {
        console.warn('[CertAuth] auth payload does not match cid|ts');
        return false;
    }

    // --- 解析 leaf ---
    let leaf;
    try {
        leaf = new X509Certificate(toPem(certChain[0]));
    } catch (err) {
        console.warn('[CertAuth] invalid leaf cert:', err.message);
        return false;
    }

    // --- 解析客户端提供的中间证书 ---
    const provided = [];
    for (let i = 1; i < certChain.length; i++) {
        try {
            provided.push(new X509Certificate(toPem(certChain[i])));
        } catch (err) {
            console.warn(`[CertAuth] invalid cert in chain[${i}]:`, err.message);
        }
    }

    // --- 重建链 ---
    const fullChain = buildChainToTrustAnchor(leaf, provided, TRUSTED_CERTS);
    if (!fullChain) {
        console.warn('[CertAuth] unable to build chain to a trusted anchor');
        return false;
    }
    console.log(
        '[CertAuth] chain rebuilt:',
        fullChain.map((c, i) => `[${i}] ${c.subject.replace(/\n/g, ', ')}`).join('  ->  ')
    );

    // --- 有效期 ---
    const now = Date.now();
    for (const cert of fullChain) {
        const from = new Date(cert.validFrom).getTime();
        const to = new Date(cert.validTo).getTime();
        if (!(from <= now && now <= to)) {
            console.warn('[CertAuth] cert expired/not-yet-valid:', cert.subject);
            return false;
        }
    }

    // --- 逐级验签 ---
    for (let i = 0; i < fullChain.length - 1; i++) {
        const child = fullChain[i];
        const parent = fullChain[i + 1];
        try {
            if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
                console.warn(`[CertAuth] chain signature check failed: [${i}] <- [${i + 1}]`);
                return false;
            }
        } catch (err) {
            console.warn(`[CertAuth] chain verify error at ${i}:`, err.message);
            return false;
        }
    }

    // --- payload 签名验证 ---
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
            console.warn(`[CertAuth] verify (dsaEncoding=${enc}) threw:`, err.message);
        }
    }

    if (!ok) {
        console.warn(
            `[CertAuth] payload signature invalid (signature length=${signature.length}B, ` +
            `tried ieee-p1363 and der)`
        );
        return false;
    }

    console.log(
        '[CertAuth] mqtt auth OK, subject=%s, sigFormat=%s',
        leaf.subject.replace(/\n/g, ', '),
        usedEncoding
    );
    return true;
}

// Base64URL → Buffer（兼容无填充 / 带填充 / 标准 base64）
function b64urlToBuffer(str) {
    let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return Buffer.from(b64, 'base64');
}

// 命名规则排序：leaf 最前，caN 按 N 降序（ca2 在 ca1 前，ca1 最靠根）
function certRank(name) {
    if (name === 'leaf' || name.startsWith('leaf-')) return 0;
    const m = /^ca(\d+)$/.exec(name);
    if (m) return 1_000_000 - parseInt(m[1], 10);
    return 500_000;
}

function orderLeafToRoot(certsMap, auth) {
    if (certsMap.size === 0) return [];
    const out = [];
    const used = new Set();

    // ① 优先使用 auth.chain（其本身就是 leaf → root 的顺序）
    if (auth && Array.isArray(auth.chain)) {
        const byHex = new Map();
        for (const c of certsMap.values()) byHex.set(c.der.toString('hex'), c);

        for (const chainB64 of auth.chain) {
            let der;
            try { der = b64urlToBuffer(chainB64); } catch { continue; }
            const match = byHex.get(der.toString('hex'));
            if (match && !used.has(match.name)) {
                out.push(match.der);
                used.add(match.name);
            }
        }
    }

    // ② 其余未匹配的按命名规则排序追加
    const rest = [];
    for (const c of certsMap.values()) if (!used.has(c.name)) rest.push(c);
    rest.sort((a, b) => certRank(a.name) - certRank(b.name));
    for (const c of rest) out.push(c.der);

    return out;
}

/**
 * 解析子协议 Set/数组，返回 { auth, certChain }
 *   auth      : { v, alg, ts, cid, payload, sig, chain[] } | null
 *   certChain : Buffer[]   // DER，从叶子 → 上级（最后一个是链尾中间证书，不含根）
 */
function parseMqttAuthFromProtocol(protocols) {
    let auth = null;
    const certsMap = new Map(); // name -> { name, der }

    for (const protocol of protocols) {
        if (typeof protocol !== 'string') continue;
        if (protocol === 'mqtt') continue;

        // ---- auth.<b64url(json)> ----
        if (protocol.startsWith('auth.')) {
            try {
                const jsonStr = b64urlToBuffer(protocol.slice(5)).toString('utf8');
                auth = JSON.parse(jsonStr);
            } catch {
                auth = null;
            }
            continue;
        }

        // ---- cert-<label>.<b64url(der)> ----
        if (protocol.startsWith('cert-')) {
            const rest = protocol.slice(5);
            const dot = rest.indexOf('.');
            if (dot < 0) continue;
            const name = rest.slice(0, dot);
            const b64  = rest.slice(dot + 1);
            try {
                const der = b64urlToBuffer(b64);
                certsMap.set(name, { name, der });
            } catch { /* 忽略单个证书解码失败 */ }
        }
    }

    return { auth, certChain: orderLeafToRoot(certsMap, auth) };
}

// ============================================================
// 6. BackendId：SPKI DER → SHA256 → Base58
// ============================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);

    let zeros = 0;
    while (zeros < buf.length && buf[zeros] === 0) zeros++;

    const digits = [0];
    for (let i = zeros; i < buf.length; i++) {
        let carry = buf[i];
        for (let j = 0; j < digits.length; j++) {
            carry += digits[j] << 8;
            digits[j] = carry % 58;
            carry = (carry / 58) | 0;
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = (carry / 58) | 0;
        }
    }

    let out = '';
    for (let i = 0; i < zeros; i++) out += BASE58_ALPHABET[0];
    for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
    return out;
}

// 从后往前找第一张"非自签"的证书（跳过根），即最上级中间证书
function pickTopIntermediate(certChain) {
    for (let i = certChain.length - 1; i >= 1; i--) {
        let der;
        try {
            der = Buffer.isBuffer(certChain[i])
                ? certChain[i]
                : b64urlToBuffer(certChain[i]);
        } catch {
            continue;
        }
        try {
            const c = new X509Certificate(der);
            if (c.subject !== c.issuer) return c; // 非自签 → 中间证书
        } catch { /* skip invalid */ }
    }
    return null;
}

function calculateMqttBackendId(certChain) {
    if (!Array.isArray(certChain) || certChain.length < 2) {
        console.warn('[CertAuth] certChain has no intermediate, refuse to compute backendId');
        return null;
    }

    const top = pickTopIntermediate(certChain);
    if (!top) {
        console.warn('[CertAuth] no non-self-signed intermediate in certChain');
        return null;
    }

    try {
        const spkiDer = top.publicKey.export({ type: 'spki', format: 'der' });
        const hash = createHash('sha256').update(spkiDer).digest();
        return base58Encode(hash);
    } catch (err) {
        console.warn('[CertAuth] calculateMqttBackendId failed:', err.message);
        return null;
    }
}

export {
    parseMqttAuthText,
    parseMqttAuthFromProtocol,
    verifyMqttAuth,
    calculateMqttBackendId,
};