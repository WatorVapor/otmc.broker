import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

mock.method(console, 'log', () => {});

const { ClientTopic } = await import('../client_topics.mjs');

after(() => mock.restoreAll());

// Subscriptions live in a module-level Map and there is no clear() helper.
// Give every test its own topic namespace so tests cannot see each other.
let testSequence = 0;
function namespace() {
    testSequence += 1;
    return `test${testSequence}`;
}

test('addSubscription stores an exact topic and getSubscriptions returns its clients', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a/b`, 'client-1');
    topics.addSubscription(`${base}/a/b`, 'client-2');

    assert.deepEqual(topics.getSubscriptions(`${base}/a/b`), ['client-1', 'client-2']);
});

test('adding the same client twice does not duplicate it', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a`, 'client-1');
    topics.addSubscription(`${base}/a`, 'client-1');

    assert.deepEqual(topics.getSubscriptions(`${base}/a`), ['client-1']);
});

test('getSubscriptions returns an empty array for an unknown topic', () => {
    assert.deepEqual(new ClientTopic().getSubscriptions(`${namespace()}/unknown`), []);
});

test('a + wildcard matches a single topic level', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a/+`, 'client-1');

    assert.deepEqual(topics.getSubscriptions(`${base}/a/b`), ['client-1']);
    assert.deepEqual(topics.getSubscriptions(`${base}/a/c`), ['client-1']);
    assert.deepEqual(topics.getSubscriptions(`${base}/b/b`), []);
});

test('a # wildcard matches the parent topic and all descendants', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a/#`, 'client-1');

    assert.deepEqual(topics.getSubscriptions(`${base}/a`), ['client-1']);
    assert.deepEqual(topics.getSubscriptions(`${base}/a/b`), ['client-1']);
    assert.deepEqual(topics.getSubscriptions(`${base}/a/b/c`), ['client-1']);
});

test('a literal mismatch prevents a wildcard subscription from matching', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a/+/c`, 'client-1');

    assert.deepEqual(topics.getSubscriptions(`${base}/a/b/c`), ['client-1']);
    assert.deepEqual(topics.getSubscriptions(`${base}/a/b/d`), []);
    assert.deepEqual(topics.getSubscriptions(`${base}/x/b/c`), []);
});

test('current behaviour: an exact subscription hides wildcard subscribers', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a/b`, 'exact-client');
    topics.addSubscription(`${base}/a/#`, 'wildcard-client');

    // Known limitation: getSubscriptions() returns early when an exact
    // subscription exists, so wildcard subscribers miss the message.
    assert.deepEqual(topics.getSubscriptions(`${base}/a/b`), ['exact-client']);
});

test('current behaviour: overlapping wildcard patterns deliver duplicates', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a/#`, 'client-1');
    topics.addSubscription(`${base}/+/b`, 'client-1');

    // Known limitation: every matching pattern contributes its clients.
    assert.deepEqual(topics.getSubscriptions(`${base}/a/b`), ['client-1', 'client-1']);
});

test('current behaviour: a shorter literal subscription matches deeper topics', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a`, 'client-1');

    // Known limitation: mathPatternSubscriptions() only compares the levels
    // present in the subscribed topic, so `${base}/a` matches `${base}/a/b`.
    assert.deepEqual(topics.getSubscriptions(`${base}/a/b`), ['client-1']);
});

test('removeSubscription deletes the whole topic, regardless of client id', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a`, 'client-1');
    topics.addSubscription(`${base}/a`, 'client-2');

    topics.removeSubscription(`${base}/a`, 'client-1');

    // Known limitation: the clientId argument is ignored.
    assert.deepEqual(topics.getSubscriptions(`${base}/a`), []);
});

test('removeClient removes the client from every topic and prunes empty topics', () => {
    const topics = new ClientTopic();
    const base = namespace();

    topics.addSubscription(`${base}/a`, 'client-1');
    topics.addSubscription(`${base}/a`, 'client-2');
    topics.addSubscription(`${base}/b`, 'client-1');

    topics.removeClient('client-1');

    assert.deepEqual(topics.getSubscriptions(`${base}/a`), ['client-2']);
    assert.deepEqual(topics.getSubscriptions(`${base}/b`), []);
});
