import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------
// Module mocks. redis_config.mjs talks to the Valkey cluster, the filesystem
// and the internal certificate; all three are replaced with fakes so the test
// needs neither certificates nor a reachable cluster.
// ---------------------------------------------------------------------------

const logs = [];
const errorLogs = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'error', (...args) => errorLogs.push(args));

const config = {
    mqtt: { host: '10.0.0.1', port: 18883 },
    valkey: {
        address: [{ host: 'valkey.example', port: 6379 }],
        useTLS: true,
        advancedConfiguration: { logLevel: 'trace' },
    },
    redis: {
        rootNodes: [{ socket: { host: 'valkey.example', port: 6379 } }],
        defaults: { socket: { tls: true } },
    },
};

mock.module('../config.mjs', { exports: { config } });

const fsState = {
    certExists: true,
    existsCalls: [],
    readCalls: [],
};

mock.module('fs', {
    exports: {
        existsSync(filePath) {
            fsState.existsCalls.push(String(filePath));
            return fsState.certExists;
        },
        readFileSync(filePath) {
            fsState.readCalls.push(String(filePath));
            return 'INTERNAL-SERVER-CERT';
        },
    },
});

// A fixed digest keeps the hand-rolled Base58 node id deterministic.
const FIXED_DIGEST = Buffer.from('0102030405', 'hex');
const EXPECTED_NODE_ID = bs58.encode(FIXED_DIGEST);

class FakeX509Certificate {
    constructor(content) {
        this.content = content;
        this.publicKey = {
            export() {
                return 'SPKI-PEM';
            },
        };
    }
}

mock.module('crypto', {
    exports: {
        X509Certificate: FakeX509Certificate,
        createHash() {
            return {
                update() {
                    return this;
                },
                digest() {
                    return Buffer.from(FIXED_DIGEST);
                },
            };
        },
    },
});

const redisState = {
    values: new Map(),
    gets: [],
    sets: [],
    publishes: [],
    connectCount: 0,
    connectImpl: null,
    errorHandler: null,
    createArgs: [],
};

const fakeCluster = {
    on(event, listener) {
        if (event === 'error') redisState.errorHandler = listener;
        return this;
    },
    async connect() {
        redisState.connectCount += 1;
        if (redisState.connectImpl) await redisState.connectImpl();
        return this;
    },
    async get(key) {
        redisState.gets.push(key);
        return redisState.values.get(key) ?? null;
    },
    async set(key, value, options) {
        redisState.sets.push({ key, value, options });
        redisState.values.set(key, value);
        return 'OK';
    },
    async publish(topic, message) {
        redisState.publishes.push({ topic, message });
        return 1;
    },
};

mock.module('redis', {
    exports: {
        createCluster(options) {
            redisState.createArgs.push(options);
            return fakeCluster;
        },
    },
});

class ProcessExitError extends Error {
    constructor(code) {
        super(`process.exit(${code})`);
        this.code = code;
    }
}

const exitMock = mock.method(process, 'exit', (code) => {
    throw new ProcessExitError(code);
});

const { RedisConfig } = await import('../redis_config.mjs');
const { ClientCollector } = await import('../client_collect.mjs');

after(() => {
    exitMock.mock.restore();
    mock.restoreAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENDPOINTS_KEY = 'otmc:broker:store:endpoints';
const endpointKey = (nodeId) => `otmc:broker:store:endpoint:${nodeId}`;
const UPDATE_TOPIC = 'otmc:broker:endpoint:update';
const ENDPOINTS_TTL = 3600 * 24;
const ENDPOINT_TTL = 60;

async function captureTimers(run) {
    const timers = [];
    const timerMock = mock.method(globalThis, 'setTimeout', (callback, delay) => {
        timers.push({ callback, delay });
        return timers.length;
    });
    try {
        await run();
    } finally {
        timerMock.mock.restore();
    }
    return timers;
}

function storedEndpoints() {
    return JSON.parse(redisState.values.get(ENDPOINTS_KEY));
}

beforeEach(() => {
    redisState.values.clear();
    redisState.gets.length = 0;
    redisState.sets.length = 0;
    redisState.publishes.length = 0;
    redisState.connectCount = 0;
    redisState.connectImpl = null;
    redisState.errorHandler = null;
    redisState.createArgs.length = 0;

    fsState.certExists = true;
    fsState.existsCalls.length = 0;
    fsState.readCalls.length = 0;

    config.mqtt = { host: '10.0.0.1', port: 18883 };

    new ClientCollector().clear();
    logs.length = 0;
    errorLogs.length = 0;
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('the constructor derives nodeId and publicKey from internal-server.crt', () => {
    const redisConfig = new RedisConfig();

    assert.equal(redisConfig.nodeId, EXPECTED_NODE_ID);
    assert.equal(redisConfig.publicKey, 'SPKI-PEM');
    assert.equal(redisConfig.nonce, 0);
    assert.deepEqual(fsState.existsCalls, ['/usr/local/etc/certs/internal_cert/internal-server.crt']);
    assert.deepEqual(fsState.readCalls, ['/usr/local/etc/certs/internal_cert/internal-server.crt']);
});

test('the constructor exits when internal-server.crt is missing', () => {
    fsState.certExists = false;

    assert.throws(() => new RedisConfig(), ProcessExitError);
    assert.equal(errorLogs.some((args) => String(args[0]).includes('does not exist')), true);
});

test('getConfig is currently a placeholder', () => {
    assert.equal(new RedisConfig().getConfig(), undefined);
});

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

test('setup connects, advertises the MQTT endpoint and publishes the update', async () => {
    const redisConfig = new RedisConfig();

    const timers = await captureTimers(() => redisConfig.setup());

    assert.equal(redisState.connectCount, 1);
    assert.deepEqual(redisState.createArgs, [
        { rootNodes: config.redis.rootNodes, defaults: config.redis.defaults },
    ]);

    assert.deepEqual(redisState.gets, [ENDPOINTS_KEY]);

    assert.equal(redisState.sets.length, 2);

    const [endpointsSet, nodeEndpointSet] = redisState.sets;
    assert.equal(endpointsSet.key, ENDPOINTS_KEY);
    assert.deepEqual(endpointsSet.options, { EX: ENDPOINTS_TTL });
    assert.deepEqual(JSON.parse(endpointsSet.value), [
        {
            host: '10.0.0.1',
            port: 18883,
            publicKey: 'SPKI-PEM',
            nonce: 0,
            nodeId: EXPECTED_NODE_ID,
        },
    ]);

    assert.equal(nodeEndpointSet.key, endpointKey(EXPECTED_NODE_ID));
    assert.deepEqual(nodeEndpointSet.options, { EX: ENDPOINT_TTL });
    assert.deepEqual(JSON.parse(nodeEndpointSet.value), {
        host: '10.0.0.1',
        port: 18883,
        publicKey: 'SPKI-PEM',
        nonce: 0,
        nodeId: EXPECTED_NODE_ID,
        clientCounter: 0,
    });

    assert.deepEqual(redisState.publishes, [{ topic: UPDATE_TOPIC, message: '{}' }]);
    assert.deepEqual(timers.map(({ delay }) => delay), [100 * 1000, 10 * 1000]);
});

test('setup merges existing endpoints and deduplicates by host:port', async () => {
    redisState.values.set(
        ENDPOINTS_KEY,
        JSON.stringify([
            { host: 'old.example', port: 1, nodeId: 'old' },
            { host: '10.0.0.1', port: 18883, nodeId: 'stale' },
            { host: 'old.example', port: 1, nodeId: 'duplicate' },
        ])
    );

    await captureTimers(() => new RedisConfig().setup());

    const endpoints = storedEndpoints();
    assert.equal(endpoints.length, 2);

    const oldEndpoint = endpoints.find(({ host }) => host === 'old.example');
    assert.equal(oldEndpoint.nodeId, 'duplicate');

    const ownEndpoint = endpoints.find(({ host }) => host === '10.0.0.1');
    assert.equal(ownEndpoint.nodeId, EXPECTED_NODE_ID);
});

test('the per-node endpoint advertises the current client count', async () => {
    const collector = new ClientCollector();
    collector.addClient('client-1', {});
    collector.addClient('client-2', {});

    await captureTimers(() => new RedisConfig().setup());

    const nodeEndpoint = JSON.parse(redisState.sets[1].value);
    assert.equal(nodeEndpoint.clientCounter, 2);
});

test('setup registers a cluster error handler that logs failures', async () => {
    await captureTimers(() => new RedisConfig().setup());

    assert.equal(typeof redisState.errorHandler, 'function');
    redisState.errorHandler(new Error('cluster down'));

    assert.ok(errorLogs.some((args) => String(args[0]).includes('Redis Cluster Error')));
});

test('setup propagates connection failures without writing anything', async () => {
    redisState.connectImpl = async () => {
        throw new Error('cluster unavailable');
    };

    await assert.rejects(new RedisConfig().setup(), /cluster unavailable/);

    assert.deepEqual(redisState.sets, []);
    assert.deepEqual(redisState.publishes, []);
});

// ---------------------------------------------------------------------------
// Periodic refresh
// ---------------------------------------------------------------------------

test('the endpoints timer refreshes the shared endpoint list', async () => {
    const redisConfig = new RedisConfig();
    const timers = await captureTimers(() => redisConfig.setup());

    redisState.gets.length = 0;
    redisState.sets.length = 0;
    redisState.publishes.length = 0;

    const nextTimers = await captureTimers(() => timers[0].callback());

    assert.deepEqual(redisState.gets, [ENDPOINTS_KEY]);
    assert.equal(redisState.sets.length, 1);
    assert.equal(redisState.sets[0].key, ENDPOINTS_KEY);
    assert.deepEqual(redisState.publishes, []);
    assert.deepEqual(nextTimers.map(({ delay }) => delay), [100 * 1000]);
});

test('the per-node timer refreshes only this node endpoint', async () => {
    const redisConfig = new RedisConfig();
    const timers = await captureTimers(() => redisConfig.setup());

    redisState.gets.length = 0;
    redisState.sets.length = 0;
    redisState.publishes.length = 0;

    const nextTimers = await captureTimers(() => timers[1].callback());

    assert.deepEqual(redisState.gets, []);
    assert.equal(redisState.sets.length, 1);
    assert.equal(redisState.sets[0].key, endpointKey(EXPECTED_NODE_ID));
    assert.deepEqual(redisState.publishes, [{ topic: UPDATE_TOPIC, message: '{}' }]);
    assert.deepEqual(nextTimers.map(({ delay }) => delay), [10 * 1000]);
});
