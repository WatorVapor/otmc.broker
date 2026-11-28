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
    subscribeCalls: [],
    publishCalls: [],
    errorHandler: null,
    connectCount: 0,
};

const fakeCluster = {
    on(event, listener) {
        if (event === 'error') redisState.errorHandler = listener;
        return this;
    },
    async connect() {
        redisState.connectCount += 1;
        return this;
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

const { PubSubRedis } = await import('../pubsub_redis.mjs');

const connectCountAtImport = redisState.connectCount;

beforeEach(() => {
    redisState.subscribeCalls.length = 0;
    redisState.publishCalls.length = 0;
    logs.length = 0;
    errorLogs.length = 0;
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('connects once at import', () => {
    assert.equal(connectCountAtImport, 1);
});

test('registers an error handler on the Redis cluster', () => {
    assert.equal(typeof redisState.errorHandler, 'function');
    redisState.errorHandler(new Error('cluster down'));
    assert.ok(
        errorLogs.some((args) => String(args[0]).includes('Redis Cluster Error')),
        'cluster errors should be logged'
    );
});

test('registerBrokerUpdates subscribes to the endpoint update topic', async () => {
    const received = [];
    await PubSubRedis.registerBrokerUpdates((message) => received.push(message));

    assert.equal(redisState.subscribeCalls.length, 1);
    assert.equal(redisState.subscribeCalls[0].topic, 'otmc:broker:endpoint:update');

    redisState.subscribeCalls[0].listener('{"nodeId":"A"}');
    assert.deepEqual(received, ['{"nodeId":"A"}']);
});

test('register subscribes to an arbitrary topic and forwards messages', async () => {
    const received = [];
    await PubSubRedis.register('otmc:test:topic', (message) => received.push(message));

    assert.equal(redisState.subscribeCalls.length, 1);
    assert.equal(redisState.subscribeCalls[0].topic, 'otmc:test:topic');

    redisState.subscribeCalls[0].listener('hello');
    assert.deepEqual(received, ['hello']);
});

test('publish forwards the topic and message to Redis', async () => {
    await PubSubRedis.publish('otmc:test:topic', 'payload');

    assert.deepEqual(redisState.publishCalls, [
        { topic: 'otmc:test:topic', message: 'payload' },
    ]);
});
