// app.mjs — express application for the Space certificate signing API.
// Kept free of top-level side effects so it can be unit tested; server.mjs
// owns the unix-socket listener.
import express from 'express';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);

export const DEFAULT_CLIENT_ROOT = '/usr/local/etc/certs/client_cert';
export const DEFAULT_TEMP_DIR = '/var/run/otmc';

export const PROFILE = {
  'space-1st-level': {
    caName: 'client-broker-inter',
    cnPattern: /^OTMC-Client_Intermediate_4_Space_1st_level_Cert$/,
    extFile: 'client-space-top.ext',
    allowedBearer: process.env.SIGN_TOKEN, // 生产环境请改用 JWT + 审计
  },
};

// 简单令牌鉴权（生产请替换为 OIDC / mTLS）
function authenticateBearer(req, res, next) {
  next();
}

/**
 * Build the signing app.
 *
 * @param {object} [options]
 * @param {string} [options.clientRoot] directory holding the CA key/cert,
 *   serial file and extension file.
 * @param {string} [options.tempDir] working directory for per-request CSRs.
 */
export function createApp({
  clientRoot = DEFAULT_CLIENT_ROOT,
  tempDir = DEFAULT_TEMP_DIR,
} = {}) {
  const signKeyPath = path.join(clientRoot, 'client-broker-inter.key');
  const signCaPath = path.join(clientRoot, 'client-broker-inter.crt');
  const signSrlPath = path.join(clientRoot, 'client-space-top.srl');
  const signExtPath = path.join(clientRoot, 'client-space-top.ext');

  const app = express();

  app.use(express.json({ limit: '64kb' }));

  app.post('/sign/client/space-1st-level', authenticateBearer, async (req, res) => {
    const { csr, profile } = req.body || {};
    console.log('csr:=<', csr, '>');

    if (typeof csr !== 'string' || csr.length === 0) {
      return res.status(400).json({ error: 'csr is required' });
    }

    const matchProfile = Object.hasOwn(PROFILE, profile) ? PROFILE[profile] : undefined;
    if (!matchProfile) {
      return res.status(400).json({ error: 'unknown profile' });
    }

    const csrSha256 = crypto.createHash('sha256').update(csr, 'utf8').digest('hex');
    console.log('csrSha256:=<', csrSha256, '>');
    const run_ws = `${tempDir}/${csrSha256}`;

    const reqCSRPath = `${run_ws}/request_temp.csr`;
    const respCRTPath = `${run_ws}/response_temp.crt`;

    let response;
    try {
      await fs.mkdir(run_ws, { recursive: true });
      await fs.writeFile(reqCSRPath, csr, 'utf8');

      // 1) 校验 CSR 自签名
      await exec('openssl', ['req', '-in', reqCSRPath, '-noout', '-verify']);

      // 2) 解析 Subject，校验 CN
      const { stdout: subjOut } = await exec('openssl', [
        'req', '-in', reqCSRPath, '-noout', '-subject', '-nameopt', 'RFC2253'
      ]);
      const cnMatch = subjOut.match(/CN=([^,]+)/);
      console.log('cnMatch:=<', cnMatch, '>');
      const cn = (cnMatch?.[1] ?? '').trim();
      if (!cn || !matchProfile.cnPattern.test(cn)) {
        response = { status: 400, body: { error: 'subject policy violation' } };
      } else {
        // 3) 用 CA 私钥签发
        await exec('openssl', [
          'x509', '-req',
          '-in', reqCSRPath,
          '-CA', signCaPath,
          '-CAkey', signKeyPath,
          '-CAserial', signSrlPath,
          '-CAcreateserial',
          '-sha384', '-days', '36500',
          '-extfile', signExtPath,
          '-extensions', 'v3_req',
          '-out', respCRTPath,
        ]);

        const certificate = await fs.readFile(respCRTPath, 'utf8');
        console.log('certificate:=,', certificate, '>');
        const caCert = await fs.readFile(signCaPath, 'utf8');

        const { stdout: info } = await exec('openssl', ['x509', '-in', respCRTPath, '-noout', '-serial', '-dates', '-issuer']);
        const serial = (info.match(/serial=([0-9A-F]+)/) || [])[1] || '';
        const nb = (info.match(/notBefore=(.+)/) || [])[1] || '';
        const na = (info.match(/notAfter=(.+)/) || [])[1] || '';

        // TODO: 审计日志（token 主体、CSR 指纹、serial、IP、时间）

        response = {
          status: 200,
          body: {
            certificate,
            chain: [caCert],
            serial,
            notBefore: nb,
            notAfter: na,
            issuerCN: 'OTMC-Client_Intermediate_4_Client_Broker_Inter_Cert',
            requestId: csrSha256,
          },
        };
      }
    } catch (e) {
      console.error('sign failed', e);
      response = { status: 500, body: { error: 'sign failed', detail: String(e?.message || e) } };
    } finally {
      // Clean up before replying so a retry with the same CSR never observes
      // half-written temp files.
      await fs.rm(reqCSRPath, { force: true }).catch(() => {});
      await fs.rm(respCRTPath, { force: true }).catch(() => {});
    }

    return res.status(response.status).json(response.body);
  });

  // ===== 兜底日志 + 404 =====
  app.use((req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || '-';
    console.warn(
      `[unhandled] ${new Date().toISOString()} ${req.method} ${req.originalUrl} ` +
      `ip=${ip} auth=${req.get('authorization') ? 'yes' : 'no'}`
    );
    res.status(404).json({ error: 'not found' });
  });

  // 更细粒度的未处理错误（如 JSON 解析失败、body 超限等）
  app.use((err, req, res, next) => {
    console.error(
      `[error] ${new Date().toISOString()} ${req.method} ${req.originalUrl} ` +
      `ip=${req.ip} err=${err?.name}: ${err?.message}`
    );
    if (res.headersSent) return next(err);
    res.status(err?.status || 500).json({ error: 'internal error' });
  });

  return app;
}
