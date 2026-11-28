import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. They must be registered before importing the module under test.
// ---------------------------------------------------------------------------

const haproxyConfig = {
    socketPath: '/fake/haproxy/admin.sock',
    haproxyBackendPath: '/fake/haproxy/backends',
    commandTimeoutMs: 42,
};

mock.module('../config.mjs', {
    exports: {
        config: { redis: {}, haproxy: haproxyConfig },
    },
});

// Keep the (very chatty) production logging out of the test output.
const logs = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'error', (...args) => logs.push(args));

const fsState = {
    files: new Map(),
    writeCalls: [],
    rmCalls: [],
    existsCalls: [],
};

mock.module('node:fs', {
    exports: {
        writeFileSync(filePath, data) {
            fsState.writeCalls.push({ filePath, data });
            fsState.files.set(filePath, data);
        },
        existsSync(filePath) {
            fsState.existsCalls.push(filePath);
            return fsState.files.has(filePath);
        },
        rmSync(filePath, options) {
            fsState.rmCalls.push({ filePath, options });
            fsState.files.delete(filePath);
        },
    },
});

const execState = {
    calls: [],
    failOn: null,
};

mock.module('node:child_process', {
    exports: {
        execSync(command) {
            execState.calls.push(command);
            if (execState.failOn && command.includes(execState.failOn)) {
                throw new Error(`exec failed: ${command}`);
            }
            return '';
        },
    },
});

const netState = {
    sockets: [],
    afterConnect: null,
};

function createFakeSocket() {
    const listeners = new Map();
    return {
        path: null,
        written: '',
        encoding: null,
        timeoutMs: null,
        timeoutCallback: null,
        destroyed: false,
        setEncoding(encoding) {
            this.encoding = encoding;
            return this;
        },
        on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(listener);
            return this;
        },
        write(chunk) {
            this.written += chunk;
            return true;
        },
        setTimeout(timeoutMs, callback) {
            this.timeoutMs = timeoutMs;
            this.timeoutCallback = callback;
            return this;
        },
        destroy() {
            this.destroyed = true;
        },
        emit(event, payload) {
            for (const listener of listeners.get(event) ?? []) listener(payload);
        },
    };
}

mock.module('node:net', {
    exports: {
        default: {
            createConnection(socketPath, onConnect) {
                const socket = createFakeSocket();
                socket.path = socketPath;
                netState.sockets.push(socket);
                // `executeRuntimeCommand` registers its listeners synchronously
                // after createConnection() returns, so emit from a microtask.
                queueMicrotask(() => {
                    onConnect();
                    netState.afterConnect?.(socket);
                });
                return socket;
            },
        },
    },
});

const { BackendOfHaproxy } = await import('../backend_in_haproxy.mjs');

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

const NODE_ID = 'E4C4iCxV8X6PWYw79m594JSv6r67esNLdeg3VVzWvNhb';
const BACKEND_PATH = `/fake/haproxy/backends/mqtt_backend_${NODE_ID}.cfg`;

const EXPECTED_BACKEND_CONFIG =
`backend mqtt_backend_${NODE_ID}
    mode tcp
    server mqtt_broker_E4C4iCxV8X [192.0.2.10]:18883 ssl ca-file /usr/local/etc/certs/internal_cert/internal-root.crt crt /usr/local/etc/certs/internal_cert/internal-client.crt.key.pem verify required
`;

function respondWith(text) {
    return (socket) => {
        socket.emit('data', text);
        socket.emit('end');
    };
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor() timed out');
        await new Promise((resolve) => setImmediate(resolve));
    }
}

beforeEach(() => {
    fsState.files.clear();
    fsState.writeCalls.length = 0;
    fsState.rmCalls.length = 0;
    fsState.existsCalls.length = 0;

    execState.calls.length = 0;
    execState.failOn = null;

    netState.sockets.length = 0;
    netState.afterConnect = respondWith('mqtt_backend_AAA\nmqtt_backend_BBB\n');

    logs.length = 0;
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// listCurrentBackends
// ---------------------------------------------------------------------------

test('listCurrentBackends sends "show backend" and parses node ids', async () => {
    netState.afterConnect = respondWith(
        'mqtt_backend_AAA\n' +
        '# mqtt_backend_BBB\n' +
        'not-a-backend\n' +
        'mqtt_backend_CCC\n' +
        'mqtt_backend_\n'
    );

    const nodeIds = await BackendOfHaproxy.listCurrentBackends();

    assert.deepEqual(nodeIds, ['AAA', 'BBB', 'CCC']);

    assert.equal(netState.sockets.length, 1);
    const socket = netState.sockets[0];
    assert.equal(socket.path, '/fake/haproxy/admin.sock');
    assert.equal(socket.encoding, 'utf8');
    assert.equal(socket.timeoutMs, 42);
    assert.equal(socket.written, 'show backend\n');
});

test('listCurrentBackends returns an empty list when HAProxy has no mqtt backends', async () => {
    netState.afterConnect = respondWith('\n');

    assert.deepEqual(await BackendOfHaproxy.listCurrentBackends(), []);
});

test('listCurrentBackends rejects when the runtime socket times out', async () => {
    netState.afterConnect = () => {}; // never answer

    const promise = BackendOfHaproxy.listCurrentBackends();
    const assertion = assert.rejects(promise, /Command timed out: show backend/);

    await waitFor(() => netState.sockets.length === 1);
    netState.sockets[0].timeoutCallback();

    await assertion;
    assert.equal(netState.sockets[0].destroyed, true);
});

test('listCurrentBackends rejects when the runtime socket errors', async () => {
    netState.afterConnect = (socket) => socket.emit('error', new Error('ECONNREFUSED'));

    const promise = BackendOfHaproxy.listCurrentBackends();
    await assert.rejects(promise, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// addBackend
// ---------------------------------------------------------------------------

test('addBackend writes the generated cfg file and reloads HAProxy', async () => {
    await BackendOfHaproxy.addBackend(NODE_ID, { host: '192.0.2.10', port: 18883 });

    assert.equal(fsState.writeCalls.length, 1);
    assert.equal(fsState.writeCalls[0].filePath, BACKEND_PATH);
    assert.equal(fsState.writeCalls[0].data, EXPECTED_BACKEND_CONFIG);

    assert.deepEqual(execState.calls, ['docker kill -s HUP otmc-haproxy', 'sleep 3']);

    // After reloading, addBackend re-reads the current backend list.
    assert.equal(netState.sockets.length, 1);
    assert.equal(netState.sockets[0].written, 'show backend\n');
});

test('addBackend still reports the backend list when the HAProxy reload fails', async () => {
    execState.failOn = 'docker kill';

    await BackendOfHaproxy.addBackend(NODE_ID, { host: '192.0.2.10', port: 18883 });

    assert.equal(fsState.writeCalls.length, 1);
    assert.ok(
        logs.some((args) => String(args[0]).includes('Error reloading HAProxy configuration')),
        'reload failure should be logged'
    );
    assert.equal(netState.sockets.length, 1);
    assert.equal(netState.sockets[0].written, 'show backend\n');
});

// ---------------------------------------------------------------------------
// deleteBackend
// ---------------------------------------------------------------------------

test('deleteBackend removes an existing cfg file and reloads HAProxy', async () => {
    fsState.files.set(BACKEND_PATH, 'old');

    await BackendOfHaproxy.deleteBackend(NODE_ID);

    assert.deepEqual(fsState.rmCalls, [
        { filePath: BACKEND_PATH, options: { force: true } },
    ]);
    assert.equal(fsState.files.has(BACKEND_PATH), false);
    assert.deepEqual(execState.calls, ['docker kill -s HUP otmc-haproxy', 'sleep 3']);
    assert.equal(netState.sockets.length, 1);
});

test('deleteBackend does not remove anything when the cfg file is absent', async () => {
    await BackendOfHaproxy.deleteBackend(NODE_ID);

    assert.deepEqual(fsState.existsCalls, [BACKEND_PATH]);
    assert.deepEqual(fsState.rmCalls, []);
    assert.deepEqual(execState.calls, ['docker kill -s HUP otmc-haproxy', 'sleep 3']);
});
