import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

mock.method(console, 'log', () => {});

const { ClientCollector } = await import('../client_collect.mjs');

beforeEach(() => new ClientCollector().clear());
after(() => mock.restoreAll());

test('addClient stores a client and getClient returns it', () => {
    const collector = new ClientCollector();
    const client = { socket: {} };

    collector.addClient('client-1', client);

    assert.equal(collector.getClient('client-1'), client);
    assert.equal(collector.hasClient('client-1'), true);
});

test('getClient returns undefined for an unknown client id', () => {
    assert.equal(new ClientCollector().getClient('missing'), undefined);
    assert.equal(new ClientCollector().hasClient('missing'), false);
});

test('getClientCount and getAllClients reflect the stored clients', () => {
    const collector = new ClientCollector();
    const first = { socket: {} };
    const second = { socket: {} };

    collector.addClient('client-1', first);
    collector.addClient('client-2', second);

    assert.equal(collector.getClientCount(), 2);
    assert.deepEqual(collector.getAllClients(), [first, second]);
});

test('removeClient deletes only the requested client', () => {
    const collector = new ClientCollector();
    collector.addClient('client-1', {});
    collector.addClient('client-2', {});

    collector.removeClient('client-1');

    assert.equal(collector.hasClient('client-1'), false);
    assert.equal(collector.hasClient('client-2'), true);
});

test('addChallenge / getChallenge / removeChallenge manage pending challenges', () => {
    const collector = new ClientCollector();

    collector.addChallenge('client-1', 'challenge-1');

    assert.equal(collector.getChallenge('client-1'), 'challenge-1');
    assert.deepEqual(collector.getAllChallenges(), [['client-1', 'challenge-1']]);

    collector.removeChallenge('client-1');

    assert.equal(collector.getChallenge('client-1'), undefined);
    assert.deepEqual(collector.getAllChallenges(), []);
});

test('hasChallenge only accepts the exact pending challenge', () => {
    const collector = new ClientCollector();
    collector.addChallenge('client-1', 'challenge-1');

    assert.equal(collector.hasChallenge('client-1', 'challenge-1'), true);
    assert.equal(collector.hasChallenge('client-1', 'challenge-2'), false);
    // No pending challenge -> `undefined` (falsy), not `false`.
    assert.equal(collector.hasChallenge('client-2', 'challenge-1'), undefined);
});

test('clear removes clients and pending challenges', () => {
    const collector = new ClientCollector();
    collector.addClient('client-1', {});
    collector.addChallenge('client-1', 'challenge-1');

    collector.clear();

    assert.equal(collector.getClientCount(), 0);
    assert.deepEqual(collector.getAllChallenges(), []);
});

test('separate ClientCollector instances share the same module-level store', () => {
    const writer = new ClientCollector();
    const reader = new ClientCollector();

    writer.addClient('client-1', {});
    writer.addChallenge('client-1', 'challenge-1');

    // Documented behaviour: clients and challenges are not per instance.
    assert.equal(reader.hasClient('client-1'), true);
    assert.equal(reader.getChallenge('client-1'), 'challenge-1');
});
