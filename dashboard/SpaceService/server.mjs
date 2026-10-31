// server.mjs  —  npm i express fs/promises child_process
import express from 'express';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import path from 'node:path';


const CLIENT_ROOT = '/usr/local/etc/certs/client_cert';
const TEMP_DIR = '/var/run/otmc';

const exec = promisify(execFile);
import { createServer } from 'node:http';

const SOCKET_PATH = `${TEMP_DIR}/space.api.sock`;

// 清理可能存在的旧 socket 文件
await fs.rm(SOCKET_PATH, { force: true }).catch(() => {});

const app = express();

const server = createServer(app);

server.listen(SOCKET_PATH, () => {
  console.log(`sign-api ready on unix socket: ${SOCKET_PATH}`);
  // 设置 socket 文件权限（可选，根据需要调整）
  fs.chmod(SOCKET_PATH, 0o777).catch(console.error);
});

app.use(express.json({ limit: '64kb' }));

const SIGN_KEY_PATH = `${CLIENT_ROOT}/client-broker-inter.key`;
const SIGN_CA_PATH = `${CLIENT_ROOT}/client-broker-inter.crt`;
const SIGN_SRL_PATH = `${CLIENT_ROOT}/client-broker-inter.srl`;
const SIGN_EXT_PATH = `${CLIENT_ROOT}/client-broker-inter.ext`;

const PROFILE = {
  'space-1st-level': {
    caName: 'client-broker-inter',
    cnPattern: /^OTMC-Client_Intermediate_4_Space_1st_level_Cert$/,
    extFile: 'client-space-top.ext',
    allowedBearer: process.env.SIGN_TOKEN,        // 生产环境请改用 JWT + 审计
  },
};

// 简单令牌鉴权（生产请替换为 OIDC / mTLS）
function authenticateBearer(req, res, next) {
  next();
}

app.post('/sign/client/space-1st-level', authenticateBearer, async (req, res) => {
  const {  csr, profile} = req.body || {};
  console.log('csr:=<',csr,'>');
  const csrSha256 = crypto.createHash('sha256').update(csr, 'utf8').digest('hex');
  console.log('csrSha256:=<',csrSha256,'>');
  const run_ws = `${TEMP_DIR}/${csrSha256}`

  const reqCSRPath = `${run_ws}/request_temp.csr`;
  const respCRTPath =  `${run_ws}/response_temp.crt`;
  const matchProfile = PROFILE[profile];

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
    console.log('cnMatch:=<',cnMatch,'>');
    if (!cnMatch || !matchProfile.cnPattern.test(cnMatch[1]))
      return res.status(400).json({ error: 'subject policy violation' });

    // 3) 用 CA 私钥签发
    await exec('openssl', [
      'x509', '-req',
      '-in', reqCSRPath,
      '-CA', SIGN_CA_PATH,
      '-CAkey', SIGN_KEY_PATH,
      '-CAserial', SIGN_SRL_PATH,
      '-CAcreateserial',
      '-sha384', '-days', '36500',
      '-extfile', SIGN_EXT_PATH,
      '-extensions', 'v3_req',
      '-out', respCRTPath,
    ]);

    const certificate = await fs.readFile(respCRTPath, 'utf8');
    console.log('certificate:=,',certificate,'>');
    const caCert = await fs.readFile(SIGN_CA_PATH, 'utf8');

    const { stdout: info } = await exec('openssl', ['x509', '-in', respCRTPath, '-noout', '-serial', '-dates', '-issuer']);
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
      requestId: csrSha256,
    });
  } catch (e) {
    console.error('sign failed', e);
    res.status(500).json({ error: 'sign failed', detail: String(e?.message || e) });
  } finally {
    await fs.rm(reqCSRPath, { force: true }).catch(() => {});
    await fs.rm(respCRTPath, { force: true }).catch(() => {});
  }
  res.end();
});

// ===== 新增：兜底日志 + 404 =====
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