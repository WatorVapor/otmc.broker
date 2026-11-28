// End-to-end check with the real `openssl` binary: a throwaway CA issues a
// certificate for a valid CSR, and the result verifies against that CA.
// Skipped automatically when openssl is unavailable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, mock, test } from 'node:test';

import { createApp } from '../app.mjs';

// The service logs full CSRs/certificates and stack traces; keep the test
// output readable.
mock.method(console, 'log', () => {});
mock.method(console, 'warn', () => {});
mock.method(console, 'error', () => {});

const GOOD_CN = 'OTMC-Client_Intermediate_4_Space_1st_level_Cert';

let opensslAvailable = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  opensslAvailable = false;
}

const skip = opensslAvailable ? false : 'openssl binary is not available';

let root;
let clientRoot;
let tempDir;
let base;
let server;

function openssl(args, options = {}) {
  return execFileSync('openssl', args, { encoding: 'utf8', ...options });
}

async function startServer() {
  const app = createApp({ clientRoot, tempDir });
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  if (!opensslAvailable) return;

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'space-service-e2e-'));
  clientRoot = path.join(root, 'client_cert');
  tempDir = path.join(root, 'run');
  await fs.mkdir(clientRoot, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  // Throwaway CA, shaped like client-broker-inter.{crt,key}.
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(clientRoot, 'client-broker-inter.key'),
    '-out', path.join(clientRoot, 'client-broker-inter.crt'),
    '-days', '2',
    '-subj', '/CN=OTMC-Client_Intermediate_4_Client_Broker_Inter_Cert',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ], { stdio: 'ignore' });

  await fs.writeFile(
    path.join(clientRoot, 'client-space-top.ext'),
    '[ v3_req ]\n' +
    'basicConstraints = critical,CA:FALSE\n' +
    'keyUsage = critical,digitalSignature\n' +
    'extendedKeyUsage = clientAuth\n',
    'utf8',
  );

  await startServer();
});

after(async () => {
  mock.restoreAll();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function makeCsr(commonName) {
  const keyPath = path.join(root, `leaf-${Math.random().toString(16).slice(2)}.key`);
  const csrPath = `${keyPath}.csr`;
  openssl([
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', csrPath,
    '-subj', `/CN=${commonName}`,
  ], { stdio: 'ignore' });
  return fs.readFile(csrPath, 'utf8');
}

function sign(csr) {
  return fetch(`${base}/sign/client/space-1st-level`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csr, profile: 'space-1st-level' }),
  });
}

test('issues a certificate that verifies against the configured CA', { skip }, async () => {
  const csr = await makeCsr(GOOD_CN);

  const res = await sign(csr);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.certificate, /BEGIN CERTIFICATE/);
  assert.equal(body.chain.length, 1);
  assert.match(body.chain[0], /BEGIN CERTIFICATE/);
  assert.match(body.requestId, /^[0-9a-f]{64}$/);
  assert.match(body.serial, /^[0-9A-F]+$/);

  const leafPath = path.join(root, 'issued.pem');
  const caPath = path.join(root, 'ca.pem');
  await fs.writeFile(leafPath, body.certificate, 'utf8');
  await fs.writeFile(caPath, body.chain[0], 'utf8');

  assert.match(openssl(['verify', '-CAfile', caPath, leafPath]).trim(), /: OK$/);
  assert.match(openssl(['x509', '-in', leafPath, '-noout', '-subject']), new RegExp(`CN\\s*=\\s*${GOOD_CN}`));
  assert.match(
    openssl(['x509', '-in', leafPath, '-noout', '-issuer']),
    /CN\s*=\s*OTMC-Client_Intermediate_4_Client_Broker_Inter_Cert/,
  );

  // The returned serial is the one openssl actually assigned.
  const serial = openssl(['x509', '-in', leafPath, '-noout', '-serial']).trim().replace(/^serial=/, '');
  assert.equal(serial, body.serial);

  // ~36500 days of validity.
  const notAfter = new Date(body.notAfter);
  assert.equal(Number.isNaN(notAfter.getTime()), false);
  assert.ok(notAfter.getUTCFullYear() > 2120, `unexpected notAfter: ${body.notAfter}`);
});

test('rejects a CSR for a different CN and does not leave temp files', { skip }, async () => {
  const csr = await makeCsr('someone-else.example.com');

  const res = await sign(csr);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'subject policy violation' });

  const requestId = crypto.createHash('sha256').update(csr, 'utf8').digest('hex');
  const runDir = path.join(tempDir, requestId);
  await assert.rejects(fs.access(path.join(runDir, 'request_temp.csr')), { code: 'ENOENT' });
});

test('rejects a malformed CSR with 500', { skip }, async () => {
  const res = await sign('not a certificate request');
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'sign failed');
});
