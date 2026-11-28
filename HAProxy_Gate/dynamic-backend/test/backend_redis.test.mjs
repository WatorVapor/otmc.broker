import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. They must be registered before importing the module under test.
// ---------------------------------------------------------------------------

mock.module('../config.mjs', {
    exports: {
        config: {
            redis: { rootNodes: [], defaults: {} },
        },
    },
});

const logs = [];
const errorLogs = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'error', (...args) => errorLogs.push(args));

const redisState = {
    values: new Map(),
    getImpl: null,
    gets: [],
    subscribeCalls: [],
    publishCalls: [],
    errorHandler: null,
    connectCount: 0,
};

redisState.getImpl = async (key) => redisState.values.get(key) ?? null;

const fakeCluster = {
    on(event, listener) {
        if (event === 'error') redisState.errorHandler = listener;
        return this;
    },
    async connect() {
        redisState.connectCount += 1;
        return this;
    },
    async get(key) {
        redisState.gets.push(key);
        return redisState.getImpl(key);
    },
    async subscribe(topic, listener) {
        redisState.subscribeCalls.push({ topic, listener });
        return 1;
    },
    async publish(topic, message) {
        redisState.publishCalls.push({ topic, message });
        return 1;
    },
};

mock.module('redis', {
    exports: { createCluster: () => fakeCluster },
});

const { BackendInRedis } = await import('../backend_redis.mjs');

// Snapshot what happened while the module was being evaluated.
const connectCountAtImport = redisState.connectCount;
const subscribeCallsAtImport = [...redisState.subscribeCalls];

const ENDPOINTS_KEY = 'otmc:broker:store:endpoints';
const endpointKey = (nodeId) => `otmc:broker:store:endpoint:${nodeId}`;

function setEndpoints(endpoints) {
    redisState.values.set(ENDPOINTS_KEY, JSON.stringify(endpoints));
}

function setEndpoint(nodeId, value) {
    redisState.values.set(endpointKey(nodeId), JSON.stringify(value));
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor() timed out');
        await new Promise((resolve) => setImmediate(resolve));
    }
}

beforeEach(() => {
    redisState.values.clear();
    redisState.getImpl = async (key) => redisState.values.get(key) ?? null;
    redisState.gets.length = 0;
    redisState.publishCalls.length = 0;
    logs.length = 0;
    errorLogs.length = 0;
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Module bootstrap
// ---------------------------------------------------------------------------

test('connects once at import and subscribes to endpoint updates', () => {
    assert.equal(connectCountAtImport, 1);
    assert.equal(subscribeCallsAtImport.length, 1);
    assert.equal(subscribeCallsAtImport[0].topic, 'otmc:broker:endpoint:update');
    assert.equal(typeof subscribeCallsAtImport[0].listener, 'function');
});

test('registers an error handler on the Redis cluster', () => {
    assert.equal(typeof redisState.errorHandler, 'function');
    redisState.errorHandler(new Error('cluster down'));
    assert.ok(
        errorLogs.some((args) => String(args[0]).includes('Redis Cluster Error')),
        'cluster errors should be logged'
    );
});

// ---------------------------------------------------------------------------
// BackendInRedis.getAllBackends
// ---------------------------------------------------------------------------

test('getAllBackends maps endpoint records to {host, port} backends', async () => {
    setEndpoints([{ nodeId: 'A' }, { nodeId: 'B' }]);
    setEndpoint('A', { nodeId: 'A', host: '10.0.0.1', port: 18883 });
    setEndpoint('B', { nodeId: 'B', host: '10.0.0.2', port: 18884 });

    const backends = await BackendInRedis.getAllBackends();

    assert.deepEqual(backends, {
        A: { host: '10.0.0.1', port: 18883 },
        B: { host: '10.0.0.2', port: 18884 },
    });
    assert.deepEqual(redisState.gets, [
        ENDPOINTS_KEY,
        endpointKey('A'),
        endpointKey('B'),
    ]);
});

test('getAllBackends returns an empty object when the endpoints key is missing', async () => {
    const backends = await BackendInRedis.getAllBackends();

    assert.deepEqual(backends, {});
    assert.deepEqual(redisState.gets, [ENDPOINTS_KEY]);
});

test('getAllBackends skips endpoints whose detail record is missing', async () => {
    setEndpoints([{ nodeId: 'A' }, { nodeId: 'B' }]);
    setEndpoint('B', { nodeId: 'B', host: '10.0.0.2', port: 18884 });

    const backends = await BackendInRedis.getAllBackends();

    assert.deepEqual(backends, {
        B: { host: '10.0.0.2', port: 18884 },
    });
});

test('getAllBackends keys the backend by the nodeId stored in the detail record', async () => {
    setEndpoints([{ nodeId: 'requested' }]);
    setEndpoint('requested', { nodeId: 'actual', host: '10.0.0.3', port: 18885 });

    const backends = await BackendInRedis.getAllBackends();

    assert.deepEqual(backends, {
        actual: { host: '10.0.0.3', port: 18885 },
    });
});

test('getAllBackends keeps the first entry when a nodeId is listed twice', async () => {
    let detailReads = 0;
    redisState.getImpl = async (key) => {
        if (key === ENDPOINTS_KEY) {
            return JSON.stringify([{ nodeId: 'A' }, { nodeId: 'A' }]);
        }
        if (key === endpointKey('A')) {
            detailReads += 1;
            return detailReads === 1
                ? JSON.stringify({ nodeId: 'A', host: 'first', port: 1 })
                : JSON.stringify({ nodeId: 'A', host: 'second', port: 2 });
        }
        return null;
    };

    const backends = await BackendInRedis.getAllBackends();

    assert.deepEqual(backends, {
        A: { host: 'first', port: 1 },
    });
});

test('getAllBackends propagates malformed endpoint JSON', async () => {
    redisState.values.set(ENDPOINTS_KEY, 'not-json');

    await assert.rejects(
        BackendInRedis.getAllBackends(),
        (error) => error instanceof SyntaxError
    );
});

// ---------------------------------------------------------------------------
// Pub/Sub driven refresh
// ---------------------------------------------------------------------------

test('an endpoint update message triggers a fresh read from Redis', async () => {
    const listener = subscribeCallsAtImport[0].listener;
    redisState.gets.length = 0;

    listener(JSON.stringify({ nodeId: 'A' }));

    await waitFor(() => redisState.gets.length > 0);
    assert.equal(redisState.gets[0], ENDPOINTS_KEY);
});
