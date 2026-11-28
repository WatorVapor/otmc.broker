import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. They must be registered before importing the module under test.
// ---------------------------------------------------------------------------

const logs = [];
const errorLogs = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'error', (...args) => errorLogs.push(args));

const state = {
    backends: {},
    current: [],
    added: [],
    listCalls: 0,
    registered: null,
};

mock.module('../backend_redis.mjs', {
    exports: {
        BackendInRedis: {
            async getAllBackends() {
                return state.backends;
            },
        },
    },
});

mock.module('../backend_in_haproxy.mjs', {
    exports: {
        BackendOfHaproxy: {
            async listCurrentBackends() {
                state.listCalls += 1;
                return [...state.current];
            },
            async addBackend(nodeId, backend) {
                state.added.push({ nodeId, backend });
            },
        },
    },
});

mock.module('../pubsub_redis.mjs', {
    exports: {
        PubSubRedis: {
            async registerBrokerUpdates(callback) {
                state.registered = callback;
            },
        },
    },
});

// index.mjs runs main() on import, so seed the fake state first.
state.backends = {
    A: { host: '10.0.0.1', port: 18883 },
    B: { host: '10.0.0.2', port: 18884 },
    C: { host: '10.0.0.3', port: 18885 },
};
state.current = ['A'];

await import('../index.mjs');

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('waitFor() timed out');
        await new Promise((resolve) => setImmediate(resolve));
    }
}

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('adds only the backends HAProxy does not know about yet', async () => {
    await waitFor(() => state.added.length === 2 && state.registered !== null);

    assert.deepEqual(
        state.added.map(({ nodeId }) => nodeId).sort(),
        ['B', 'C']
    );
    assert.deepEqual(
        state.added.find(({ nodeId }) => nodeId === 'B'),
        { nodeId: 'B', backend: { host: '10.0.0.2', port: 18884 } }
    );
    assert.equal(state.listCalls, 1);
});

test('registers a PubSub callback that re-runs the synchronisation', async () => {
    await waitFor(() => state.registered !== null);

    // Everything is present now, so the next sync should not add anything.
    state.current = ['A', 'B', 'C'];
    const addedBefore = state.added.length;
    const listCallsBefore = state.listCalls;

    state.registered('endpoint update');

    await waitFor(() => state.listCalls > listCallsBefore);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(state.added.length, addedBefore);
});
