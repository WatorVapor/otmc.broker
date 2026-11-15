// multi-bridge-server.js
import fs from 'node:fs';
import { X509Certificate, verify, createPublicKey } from 'node:crypto';
import * as path from 'path';

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

