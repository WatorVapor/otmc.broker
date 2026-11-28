import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. index.mjs starts the Unix-socket server and a Valkey
// connection on import, so net, fs and both collaborators are faked.
// ---------------------------------------------------------------------------

const logs = [];
const errorLogs = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'error', (...args) => errorLogs.push(args));

const SOCKET_PATH = '/var/run/otmc/mqtt.sock';

const fsState = {
    socketExists: true,
    existsCalls: [],
    unlinks: [],
    chmods: [],
};

mock.module('fs', {
    exports: {
        existsSync(filePath) {
            fsState.existsCalls.push(filePath);
            return fsState.socketExists;
        },
        unlinkSync(filePath) {
            fsState.unlinks.push(filePath);
            fsState.socketExists = false;
        },
        chmodSync(filePath, mode) {
            fsState.chmods.push({ filePath, mode });
        },
    },
});

const netState = {
    connectionHandler: null,
    listenPath: null,
    listenCallback: null,
    server: null,
};

mock.module('net', {
    exports: {
        default: {
            createServer(connectionHandler) {
                netState.connectionHandler = connectionHandler;
                netState.server = {
                    listen(path, callback) {
                        netState.listenPath = path;
                        netState.listenCallback = callback;
                        callback?.();
                    },
                };
                return netState.server;
            },
        },
    },
});

const sessionState = {
    sessions: [],
    parseCalls: [],
    deleteCalls: [],
};

class FakeClientSession {
    constructor(socket) {
        this.socket = socket;
        sessionState.sessions.push(this);
    }

    parse(chunk) {
        sessionState.parseCalls.push({ session: this, chunk });
    }

    delete(clientId) {
        sessionState.deleteCalls.push({ session: this, clientId });
    }
}

mock.module('../client_session.mjs', {
    exports: { ClientSession: FakeClientSession },
});

const redisState = {
    setups: 0,
};

class FakeRedisConfig {
    async setup() {
        redisState.setups += 1;
    }
}

mock.module('../redis_config.mjs', {
    exports: { RedisConfig: FakeRedisConfig },
});

const exitState = { codes: [] };
const exitMock = mock.method(process, 'exit', (code) => {
    exitState.codes.push(code);
});

// Capture the signal listeners added by index.mjs without mocking process.on,
// which would also affect the test runner itself.
const sigintBefore = new Set(process.listeners('SIGINT'));
const sigtermBefore = new Set(process.listeners('SIGTERM'));

await import('../index.mjs');

const startup = {
    setups: redisState.setups,
    listenPath: netState.listenPath,
    chmods: [...fsState.chmods],
    unlinks: [...fsState.unlinks],
    existsCalls: [...fsState.existsCalls],
};

const cleanupOnSigint = process.listeners('SIGINT').find((listener) => !sigintBefore.has(listener));
const cleanupOnSigterm = process.listeners('SIGTERM').find((listener) => !sigtermBefore.has(listener));

after(() => {
    if (cleanupOnSigint) process.removeListener('SIGINT', cleanupOnSigint);
    if (cleanupOnSigterm) process.removeListener('SIGTERM', cleanupOnSigterm);
    exitMock.mock.restore();
    mock.restoreAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSocket() {
    const listeners = new Map();
    return {
        clientId: undefined,
        on(event, listener) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(listener);
            return this;
        },
        emit(event, payload) {
            for (const listener of listeners.get(event) ?? []) listener(payload);
        },
    };
}

function connectSocket() {
    const socket = createSocket();
    netState.connectionHandler(socket);
    return socket;
}

beforeEach(() => {
    sessionState.sessions.length = 0;
    sessionState.parseCalls.length = 0;
    sessionState.deleteCalls.length = 0;

    fsState.existsCalls.length = 0;
    fsState.unlinks.length = 0;
    fsState.chmods.length = 0;

    exitState.codes.length = 0;
    logs.length = 0;
    errorLogs.length = 0;
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

test('starts Valkey, removes a stale socket file and listens on the UDS', () => {
    assert.equal(startup.setups, 1);
    assert.equal(startup.listenPath, SOCKET_PATH);
    assert.deepEqual(startup.unlinks, [SOCKET_PATH]);
    assert.deepEqual(startup.chmods, [{ filePath: SOCKET_PATH, mode: '0777' }]);
});

test('registers SIGINT and SIGTERM handlers', () => {
    assert.equal(typeof cleanupOnSigint, 'function');
    assert.equal(typeof cleanupOnSigterm, 'function');
});

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

test('each connection gets a ClientSession and forwards data chunks to parse()', () => {
    const socket = connectSocket();
    const chunk = Buffer.from([0x10, 0x00]);

    socket.emit('data', chunk);

    assert.equal(sessionState.sessions.length, 1);
    assert.equal(sessionState.sessions[0].socket, socket);
    assert.deepEqual(sessionState.parseCalls, [
        { session: sessionState.sessions[0], chunk },
    ]);
});

test('a close event deletes the session state when the client authenticated', () => {
    const socket = connectSocket();
    socket.clientId = 'client-1';

    socket.emit('close');

    assert.deepEqual(sessionState.deleteCalls, [
        { session: sessionState.sessions[0], clientId: 'client-1' },
    ]);
    assert.equal(Object.hasOwn(socket, 'clientId'), false);
    assert.ok(logs.some((args) => String(args[0]).includes('[Disconnect]')));
});

test('a close event without a client id does not call delete()', () => {
    const socket = connectSocket();

    socket.emit('close');

    assert.deepEqual(sessionState.deleteCalls, []);
});

test('an error event logs the failure and deletes the session state', () => {
    const socket = connectSocket();
    socket.clientId = 'client-1';

    socket.emit('error', new Error('ECONNRESET'));

    assert.deepEqual(sessionState.deleteCalls, [
        { session: sessionState.sessions[0], clientId: 'client-1' },
    ]);
    assert.equal(Object.hasOwn(socket, 'clientId'), false);
    assert.ok(
        errorLogs.some(
            (args) => String(args[0]).includes('[Error] Socket') && String(args[1]).includes('ECONNRESET')
        )
    );
});

test('an error event without a client id does not call delete()', () => {
    const socket = connectSocket();

    socket.emit('error', new Error('ECONNRESET'));

    assert.deepEqual(sessionState.deleteCalls, []);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

test('SIGINT removes the socket file and exits with code 0', () => {
    fsState.socketExists = true;

    cleanupOnSigint();

    assert.deepEqual(fsState.unlinks, [SOCKET_PATH]);
    assert.deepEqual(exitState.codes, [0]);
});

test('SIGTERM exits with code 0 even when the socket file is already gone', () => {
    fsState.socketExists = false;

    cleanupOnSigterm();

    assert.deepEqual(fsState.unlinks, []);
    assert.deepEqual(exitState.codes, [0]);
});
