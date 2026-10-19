// server.mjs  —  npm i express fs/promises child_process
import express from 'express';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';

const exec = promisify(execFile);
const app = express();
app.use(express.json({ limit: '64kb' }));

const KEY_DIR = process.env.KEY_DIR || './pki';
const PROFILE = {
  'client-space-top': {
    caName: 'client-broker-inter',
    cnPattern: /^OTMC-Client_Intermediate_4_Space_1st_level_Cert$/,
    extFile: 'client-space-top.ext',
    allowedBearer: process.env.SIGN_TOKEN,        // 生产环境请改用 JWT + 审计
  },
};

// 简单令牌鉴权（生产请替换为 OIDC / mTLS）
function authenticateBearer(req, res, next) {
  const h = req.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!tok) return res.status(401).json({ error: 'missing token' });
  if (!Object.values(PROFILE).some(p => p.allowedBearer === tok))
    return res.status(403).json({ error: 'invalid token' });
  req.token = tok;
  next();
}

app.post('/v1/sign-ca', authenticateBearer, async (req, res) => {
  const { profile, csr } = req.body || {};
  const p = PROFILE[profile];
  if (!p) return res.status(400).json({ error: 'unknown profile' });
  if (typeof csr !== 'string' || !csr.includes('BEGIN CERTIFICATE REQUEST'))
    return res.status(400).json({ error: 'invalid csr' });

  const id = crypto.randomUUID();
  const dir = path.join(KEY_DIR, 'tmp');
  await fs.mkdir(dir, { recursive: true });
  const csrPath = path.join(dir, `${id}.csr`);
  const crtPath = path.join(dir, `${id}.crt`);

  try {
    await fs.writeFile(csrPath, csr, 'utf8');

    // 1) 校验 CSR 自签名
    await exec('openssl', ['req', '-in', csrPath, '-noout', '-verify']);

    // 2) 解析 Subject，校验 CN
    const { stdout: subjOut } = await exec('openssl', [
      'req', '-in', csrPath, '-noout', '-subject', '-nameopt', 'RFC2253'
    ]);
    const cnMatch = subjOut.match(/CN=([^,]+)/);
    if (!cnMatch || !p.cnPattern.test(cnMatch[1]))
      return res.status(400).json({ error: 'subject policy violation' });

    // 3) 用 CA 私钥签发
    await exec('openssl', [
      'x509', '-req',
      '-in', csrPath,
      '-CA', path.join(KEY_DIR, `${p.caName}.crt`),
      '-CAkey', path.join(KEY_DIR, `${p.caName}.key`),
      '-CAserial', path.join(KEY_DIR, `${p.caName}.srl`),
      '-CAcreateserial',
      '-sha384', '-days', '36500',
      '-extfile', path.join(KEY_DIR, p.extFile),
      '-extensions', 'v3_req',
      '-out', crtPath,
    ]);

    const certificate = await fs.readFile(crtPath, 'utf8');
    const caCert = await fs.readFile(path.join(KEY_DIR, `${p.caName}.crt`), 'utf8');

    const { stdout: info } = await exec('openssl', ['x509', '-in', crtPath, '-noout', '-serial', '-dates', '-issuer']);
    const serial = (info.match(/serial=([0-9A-F]+)/) || [])[1] || '';
    const nb = (info.match(/notBefore=(.+)/) || [])[1] || '';
    const na = (info.match(/notAfter=(.+)/)  || [])[1] || '';

    // TODO: 审计日志（token 主体、CSR 指纹、serial、IP、时间）

    res.json({
      certificate,
      chain: [caCert],
      serial,
      notBefore: nb,
      notAfter: na,
      issuerCN: 'OTMC-Client_Intermediate_4_Client_Broker_Inter_Cert',
      requestId: id,
    });
  } catch (e) {
    console.error('sign failed', e);
    res.status(500).json({ error: 'sign failed', detail: String(e?.message || e) });
  } finally {
    await fs.rm(csrPath, { force: true }).catch(() => {});
    await fs.rm(crtPath, { force: true }).catch(() => {});
  }
});

app.listen(process.env.PORT || 8443, () => console.log('sign-api ready'));