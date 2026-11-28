import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. `openssl` is replaced so the tests never need certs, a CA key
// or a serial file. The mock still exercises the real fs + real HTTP stack.
// It must be registered before `../app.mjs` is imported, hence the dynamic
// import below.
// ---------------------------------------------------------------------------

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----\n';
const CA_PEM = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n';
const GOOD_CN = 'OTMC-Client_Intermediate_4_Space_1st_level_Cert';

const execState = {
  calls: [],
  impl: null,
};

function defaultExecImpl(command, args) {
  assert.equal(command, 'openssl');

  if (args[0] === 'req' && args.includes('-verify')) {
    return { stdout: '', stderr: '' };
  }
  if (args[0] === 'req' && args.includes('-subject')) {
    return { stdout: `subject=CN=${execState.subjectCN ?? GOOD_CN}\n`, stderr: '' };
  }
  if (args[0] === 'x509' && args.includes('-req')) {
    // Mimic openssl writing the signed certificate to `-out <file>`.
    return { stdout: '', stderr: '', writeTo: args[args.indexOf('-out') + 1] };
  }
  if (args[0] === 'x509' && args.includes('-serial')) {
    return {
      stdout:
        'serial=0A1B2C\n' +
        'notBefore=Jan  1 00:00:00 2026 GMT\n' +
        'notAfter=Jan  1 00:00:00 2126 GMT\n' +
        'issuer=CN = OTMC-Client_Intermediate_4_Client_Broker_Inter_Cert\n',
      stderr: '',
    };
  }
  throw new Error(`unexpected openssl invocation: ${args.join(' ')}`);
}

mock.module('node:child_process', {
  exports: {
    execFile(command, args, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      execState.calls.push({ command, args: [...args] });
      Promise.resolve()
        .then(() => execState.impl(command, args, options))
        .then(async (result) => {
          const { writeTo, ...stdout } = result ?? {};
          if (writeTo) await fs.writeFile(writeTo, CERT_PEM, 'utf8');
          callback(null, { stdout: '', stderr: '', ...stdout });
        })
        .catch((err) => callback(err));
    },
  },
});

const logs = [];
const warns = [];
const errors = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'warn', (...args) => warns.push(args));
mock.method(console, 'error', (...args) => errors.push(args));

const { createApp } = await import('../app.mjs');

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

const servers = [];
const roots = [];

async function startApp(options) {
  const app = createApp(options);
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function postJson(base, body, init = {}) {
  return fetch(`${base}/sign/client/space-1st-level`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Fresh, writable client_cert + temp dirs for a single test. */
async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'space-service-'));
  roots.push(root);
  const clientRoot = path.join(root, 'client_cert');
  const tempDir = path.join(root, 'run');
  await fs.mkdir(clientRoot, { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  await fs.writeFile(path.join(clientRoot, 'client-broker-inter.crt'), CA_PEM, 'utf8');
  await fs.writeFile(path.join(clientRoot, 'client-broker-inter.key'), 'KEY', 'utf8');
  await fs.writeFile(path.join(clientRoot, 'client-space-top.ext'), '[ v3_req ]\n', 'utf8');

  return { root, clientRoot, tempDir };
}

beforeEach(() => {
  execState.calls.length = 0;
  execState.subjectCN = GOOD_CN;
  execState.impl = defaultExecImpl;
  logs.length = 0;
  warns.length = 0;
  errors.length = 0;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('signs a CSR with the configured CA and returns certificate metadata', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  const csr = '-----BEGIN CERTIFICATE REQUEST-----\nGOOD\n-----END CERTIFICATE REQUEST-----\n';

  const res = await postJson(base, { csr, profile: 'space-1st-level' });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.certificate, CERT_PEM);
  assert.deepEqual(body.chain, [CA_PEM]);
  assert.equal(body.serial, '0A1B2C');
  assert.equal(body.notBefore, 'Jan  1 00:00:00 2026 GMT');
  assert.equal(body.notAfter, 'Jan  1 00:00:00 2126 GMT');
  assert.equal(body.issuerCN, 'OTMC-Client_Intermediate_4_Client_Broker_Inter_Cert');
  assert.equal(body.requestId, sha256(csr));

  // The request work dir is named after the CSR fingerprint.
  const runDir = path.join(tempDir, sha256(csr));
  assert.equal((await fs.stat(runDir)).isDirectory(), true);
});

test('passes the expected openssl arguments for verify, subject and signing', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  const csr = 'CSR-CONTENT';

  assert.equal((await postJson(base, { csr, profile: 'space-1st-level' })).status, 200);

  const runDir = path.join(tempDir, sha256(csr));
  const csrPath = path.join(runDir, 'request_temp.csr');
  const crtPath = path.join(runDir, 'response_temp.crt');

  assert.deepEqual(execState.calls[0].args, ['req', '-in', csrPath, '-noout', '-verify']);
  assert.deepEqual(execState.calls[1].args, [
    'req', '-in', csrPath, '-noout', '-subject', '-nameopt', 'RFC2253',
  ]);
  assert.deepEqual(execState.calls[2].args, [
    'x509', '-req',
    '-in', csrPath,
    '-CA', path.join(clientRoot, 'client-broker-inter.crt'),
    '-CAkey', path.join(clientRoot, 'client-broker-inter.key'),
    '-CAserial', path.join(clientRoot, 'client-space-top.srl'),
    '-CAcreateserial',
    '-sha384', '-days', '36500',
    '-extfile', path.join(clientRoot, 'client-space-top.ext'),
    '-extensions', 'v3_req',
    '-out', crtPath,
  ]);
  assert.deepEqual(execState.calls[3].args, ['x509', '-in', crtPath, '-noout', '-serial', '-dates', '-issuer']);
});

test('removes the temporary CSR and certificate after a successful request', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  const csr = 'CSR-CONTENT';

  assert.equal((await postJson(base, { csr, profile: 'space-1st-level' })).status, 200);

  const runDir = path.join(tempDir, sha256(csr));
  assert.equal(await exists(path.join(runDir, 'request_temp.csr')), false);
  assert.equal(await exists(path.join(runDir, 'response_temp.crt')), false);
});

test('accepts requests without an Authorization header (bearer check is a no-op)', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 200);
});

test('derives a stable requestId per CSR and separate work dirs per CSR', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const first = await (await postJson(base, { csr: 'one', profile: 'space-1st-level' })).json();
  const again = await (await postJson(base, { csr: 'one', profile: 'space-1st-level' })).json();
  const second = await (await postJson(base, { csr: 'two', profile: 'space-1st-level' })).json();

  assert.equal(first.requestId, again.requestId);
  assert.notEqual(first.requestId, second.requestId);
  assert.match(first.requestId, /^[0-9a-f]{64}$/);
  assert.equal((await fs.stat(path.join(tempDir, first.requestId))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(tempDir, second.requestId))).isDirectory(), true);
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('rejects a missing csr with 400 and does not touch the filesystem', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const res = await postJson(base, { profile: 'space-1st-level' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'csr is required' });
  assert.equal(execState.calls.length, 0);
  assert.deepEqual(await fs.readdir(tempDir), []);
});

test('rejects a non-string csr with 400', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  for (const csr of [null, 42, { pem: 'x' }, ['x'], '']) {
    const res = await postJson(base, { csr, profile: 'space-1st-level' });
    assert.equal(res.status, 400, `csr=${JSON.stringify(csr)}`);
    assert.deepEqual(await res.json(), { error: 'csr is required' });
  }
  assert.equal(execState.calls.length, 0);
});

test('rejects an unknown profile with 400', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  for (const profile of [undefined, '', 'space-2nd-level', 'toString', '__proto__', 'constructor']) {
    const res = await postJson(base, { csr: 'CSR', profile });
    assert.equal(res.status, 400, `profile=${String(profile)}`);
    assert.deepEqual(await res.json(), { error: 'unknown profile' });
  }
  assert.equal(execState.calls.length, 0);
  assert.deepEqual(await fs.readdir(tempDir), []);
});

test('rejects a CSR whose CN violates the profile pattern', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  execState.subjectCN = 'evil.example.com';

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'subject policy violation' });

  // No signing attempt, and the temp CSR is still cleaned up.
  assert.equal(execState.calls.some(({ args }) => args[0] === 'x509' && args.includes('-req')), false);
  assert.equal(await exists(path.join(tempDir, sha256('CSR'), 'request_temp.csr')), false);
});

test('rejects a subject without any CN', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  execState.impl = (command, args) => {
    if (args[0] === 'req' && args.includes('-subject')) {
      return { stdout: 'subject=O=OTMC\n', stderr: '' };
    }
    return defaultExecImpl(command, args);
  };

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'subject policy violation' });
});

test('only the exact signing route is served', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const get = await fetch(`${base}/sign/client/space-1st-level`);
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: 'not found' });

  for (const route of ['/sign/client/space-2nd-level', '/sign', '/']) {
    const res = await fetch(`${base}${route}`);
    assert.equal(res.status, 404, route);
    assert.deepEqual(await res.json(), { error: 'not found' });
  }
  assert.equal(warns.length, 4);
  assert.match(String(warns[0][0]), /\[unhandled\].*GET \/sign\/client\/space-1st-level/);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('returns 500 when the CSR self-signature cannot be verified', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  execState.impl = (command, args) => {
    if (args[0] === 'req' && args.includes('-verify')) {
      throw new Error('verify failure');
    }
    return defaultExecImpl(command, args);
  };

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'sign failed');
  assert.match(body.detail, /verify failure/);
  assert.equal(await exists(path.join(tempDir, sha256('CSR'), 'request_temp.csr')), false);
  assert.equal(errors.length, 1);
});

test('returns 500 when openssl cannot sign and still cleans up temp files', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  execState.impl = (command, args) => {
    if (args[0] === 'x509' && args.includes('-req')) {
      throw new Error('CA key not readable');
    }
    return defaultExecImpl(command, args);
  };

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).detail, /CA key not readable/);
  assert.equal(await exists(path.join(tempDir, sha256('CSR'), 'request_temp.csr')), false);
});

test('returns 500 when the signed certificate cannot be read back', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  // Signing "succeeds" but no file is written.
  execState.impl = (command, args) => {
    if (args[0] === 'x509' && args.includes('-req')) {
      return { stdout: '', stderr: '' };
    }
    return defaultExecImpl(command, args);
  };

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).detail, /ENOENT/);
});

test('returns 500 when the CA certificate is missing from the response chain', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  await fs.rm(path.join(clientRoot, 'client-broker-inter.crt'));
  const { base } = await startApp({ clientRoot, tempDir });

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).detail, /client-broker-inter\.crt/);
});

test('returns 500 when the per-request work dir cannot be created', async () => {
  const { root, clientRoot } = await makeWorkspace();
  const blocked = path.join(root, 'not-a-directory');
  await fs.writeFile(blocked, 'x', 'utf8');
  const { base } = await startApp({ clientRoot, tempDir: blocked });

  const res = await postJson(base, { csr: 'CSR', profile: 'space-1st-level' });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'sign failed');
  assert.equal(execState.calls.length, 0);
});

test('keeps the CSR fingerprint inside the work dir (no path traversal)', async () => {
  const { root, clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });
  const csr = '../../../../etc/passwd';

  assert.equal((await postJson(base, { csr, profile: 'space-1st-level' })).status, 200);

  const runDir = path.join(tempDir, sha256(csr));
  assert.equal(path.dirname(runDir), tempDir);
  assert.deepEqual(await fs.readdir(root), ['client_cert', 'run']);
  assert.equal((await fs.stat(runDir)).isDirectory(), true);
});

// ---------------------------------------------------------------------------
// Body parsing / error middleware
// ---------------------------------------------------------------------------

test('returns 413 through the error middleware for an oversized body', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const res = await postJson(base, { csr: 'a'.repeat(70 * 1024), profile: 'space-1st-level' });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'internal error' });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /\[error\].*POST \/sign\/client\/space-1st-level/);
});

test('returns 400 through the error middleware for malformed JSON', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const res = await postJson(base, '{"csr":');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'internal error' });
  assert.equal(execState.calls.length, 0);
});

test('an empty JSON body is treated as a missing csr', async () => {
  const { clientRoot, tempDir } = await makeWorkspace();
  const { base } = await startApp({ clientRoot, tempDir });

  const res = await postJson(base, '{}');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'csr is required' });
});
