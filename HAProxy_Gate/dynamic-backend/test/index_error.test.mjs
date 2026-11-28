import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. They must be registered before importing the module under test.
// ---------------------------------------------------------------------------

mock.method(console, 'log', () => {});
const errorLogs = [];
mock.method(console, 'error', (...args) => errorLogs.push(args));

const state = {
    exitCode: null,
    registered: false,
};

const exitMock = mock.method(process, 'exit', (code) => {
    state.exitCode = code;
});

mock.module('../backend_redis.mjs', {
    exports: {
        BackendInRedis: {
            async getAllBackends() {
                throw new Error('redis down');
            },
        },
    },
});

mock.module('../backend_in_haproxy.mjs', {
    exports: {
        BackendOfHaproxy: {
            async listCurrentBackends() {
                return [];
            },
            async addBackend() {},
        },
    },
});

mock.module('../pubsub_redis.mjs', {
    exports: {
        PubSubRedis: {
            async registerBrokerUpdates() {
                state.registered = true;
            },
        },
    },
});

await import('../index.mjs');

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor() timed out');
        await new Promise((resolve) => setImmediate(resolve));
    }
}

after(() => {
    exitMock.mock.restore();
    mock.restoreAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('exits with code 1 when reading the backends from Redis fails', async () => {
    await waitFor(() => state.exitCode !== null);

    assert.equal(state.exitCode, 1);
    assert.ok(
        errorLogs.some(
            ([prefix, message]) =>
                String(prefix).includes('同步过程中发生错误') && message === 'redis down'
        ),
        'the error message should be logged'
    );
});

test('still registers the PubSub callback after a failed initial sync', async () => {
    await waitFor(() => state.registered === true);
});
