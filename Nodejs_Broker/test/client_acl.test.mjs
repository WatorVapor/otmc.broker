import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

// The module is intentionally chatty; keep the test output readable.
mock.method(console, 'log', () => {});

const { ClientAcl } = await import('../client_acl.mjs');

// The ACL store lives in a module-level Map, so every instance shares it.
// Clear it before each test to keep the tests independent.
beforeEach(() => new ClientAcl().clear());
after(() => mock.restoreAll());

const ACL = [
    { topic: 'space-a/#', action: 'read' },
    { topic: 'space-a/b/#', action: 'all' },
];

test('addAcl stores an ACL for a client id and getAcl returns it', () => {
    const acl = new ClientAcl();

    acl.addAcl('client-1', ACL);

    assert.equal(acl.getAcl('client-1'), ACL);
});

test('getAcl returns undefined for an unknown client id', () => {
    assert.equal(new ClientAcl().getAcl('missing'), undefined);
});

test('addAcl overwrites the ACL of an existing client id', () => {
    const acl = new ClientAcl();
    const replacement = [{ topic: 'other/#', action: 'read' }];

    acl.addAcl('client-1', ACL);
    acl.addAcl('client-1', replacement);

    assert.equal(acl.getAcl('client-1'), replacement);
});

test('removeAcl deletes only the requested client id', () => {
    const acl = new ClientAcl();
    acl.addAcl('client-1', ACL);
    acl.addAcl('client-2', ACL);

    acl.removeAcl('client-1');

    assert.equal(acl.getAcl('client-1'), undefined);
    assert.equal(acl.getAcl('client-2'), ACL);
});

test('getAllAcls returns every stored ACL in insertion order', () => {
    const acl = new ClientAcl();
    const second = [{ topic: 'second/#', action: 'read' }];

    acl.addAcl('client-1', ACL);
    acl.addAcl('client-2', second);

    assert.deepEqual(acl.getAllAcls(), [ACL, second]);
});

test('clear removes every ACL', () => {
    const acl = new ClientAcl();
    acl.addAcl('client-1', ACL);
    acl.addAcl('client-2', ACL);

    acl.clear();

    assert.deepEqual(acl.getAllAcls(), []);
});

test('separate ClientAcl instances share the same module-level store', () => {
    const writer = new ClientAcl();
    const reader = new ClientAcl();

    writer.addAcl('client-1', ACL);

    // Documented behaviour: the store is not per instance.
    assert.equal(reader.getAcl('client-1'), ACL);
    assert.deepEqual(reader.getAllAcls(), [ACL]);
});
