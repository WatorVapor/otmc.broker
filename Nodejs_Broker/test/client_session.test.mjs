import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. Certificate validation needs real X509 chains, so replace the
// ClientCertificate collaborator with a controllable fake. mqtt-packet stays
// real: the assertions inspect the actual bytes written to the socket.
// ---------------------------------------------------------------------------

const logs = [];
const errorLogs = [];
mock.method(console, 'log', (...args) => logs.push(args));
mock.method(console, 'error', (...args) => errorLogs.push(args));

const certificateState = {
    certArgs: null,
    isValid: true,
    pubKeyHash: ['hash-1', 'hash-2', 'hash-3', 'hash-4'],
    verified: new Set(['hash-2']),
    challenges: null,
};

class FakeClientCertificate {
    constructor(clientCert, clientId) {
        certificateState.certArgs = { clientCert, clientId };
    }

    isValid() {
        return certificateState.isValid;
    }

    getPublicKeyHash() {
        return certificateState.pubKeyHash;
    }

    verifySignature(challenges) {
        certificateState.challenges = challenges;
        return certificateState.verified;
    }
}

mock.module('../client_certificate_.mjs', {
    exports: { ClientCertificate: FakeClientCertificate },
});

const mqttPacket = (await import('mqtt-packet')).default;
const { ClientSession } = await import('../client_session.mjs');
const { ClientCollector } = await import('../client_collect.mjs');
const { ClientAcl } = await import('../client_acl.mjs');
const { ClientTopic } = await import('../client_topics.mjs');

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REASON_SUCCESS = 0x00;
const REASON_CONTINUE_AUTH = 0x18;
const REASON_NOT_AUTHORIZED = 0x87;

let testSequence = 0;
function topic(name = 'topic') {
    testSequence += 1;
    return `test${testSequence}/${name}`;
}

function createSocket() {
    return {
        clientId: undefined,
        writes: [],
        ended: false,
        write(chunk) {
            this.writes.push(Buffer.from(chunk));
            return true;
        },
        end() {
            this.ended = true;
        },
    };
}

function parsePacket(buffer) {
    const parser = mqttPacket.parser({ protocolVersion: 5 });
    let packet;
    parser.on('packet', (parsed) => {
        packet = parsed;
    });
    parser.parse(buffer);
    return packet;
}

function onlyPacket(socket) {
    assert.equal(socket.writes.length, 1, 'expected exactly one written packet');
    return parsePacket(socket.writes[0]);
}

function authenticatedSession(acl = [{ topic: '#', action: 'all' }], clientId = 'client-1') {
    const socket = createSocket();
    socket.clientId = clientId;
    const session = new ClientSession(socket);
    session.internal.acl = new ClientAcl();
    session.internal.acl.addAcl(clientId, acl);
    return { session, socket };
}

function connect(session, packet) {
    session.handlePacket(session.socket, { cmd: 'connect', ...packet });
    return session.socket;
}

function authData(overrides = {}) {
    return {
        cert: 'CLIENT-CERT-PEM',
        challenges: [
            {
                data: { challenge: 'challenge-1', timeStamp: '2026-01-01T00:00:00.000Z' },
                signature: 'c2lnbmF0dXJl',
                algorithm: 'SHA256',
                keyAddress: 'hash-2',
            },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    new ClientCollector().clear();
    new ClientAcl().clear();
    certificateState.certArgs = null;
    certificateState.isValid = true;
    certificateState.pubKeyHash = ['hash-1', 'hash-2', 'hash-3', 'hash-4'];
    certificateState.verified = new Set(['hash-2']);
    certificateState.challenges = null;
    logs.length = 0;
    errorLogs.length = 0;
});

// ---------------------------------------------------------------------------
// CONNECT / AUTH
// ---------------------------------------------------------------------------

test('CONNECT registers the client, stores a challenge and replies with AUTH 0x18', () => {
    const session = new ClientSession(createSocket());

    const socket = connect(session, {
        clientId: 'client-1',
        properties: { userProperties: { space: 'space-a' } },
    });

    assert.match(socket.clientId, /^client-1_broker_/);
    assert.equal(new ClientCollector().getClient(socket.clientId), session);

    const challenge = new ClientCollector().getChallenge(socket.clientId);
    assert.equal(typeof challenge, 'string');

    const auth = onlyPacket(socket);
    assert.equal(auth.cmd, 'auth');
    assert.equal(auth.reasonCode, REASON_CONTINUE_AUTH);
    assert.equal(auth.properties.authenticationMethod, 'certchain');
    assert.equal(auth.properties.authenticationData.toString(), challenge);
});

test('CONNECT without a client id generates one', () => {
    const session = new ClientSession(createSocket());

    const socket = connect(session, {});

    assert.match(socket.clientId, /^client_.+_broker_/);
    assert.equal(new ClientCollector().hasClient(socket.clientId), true);
});

test('AUTH with an unsupported authentication method is rejected', () => {
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: { authenticationMethod: 'plain', authenticationData: '{}' },
    });

    const connack = onlyPacket(socket);
    assert.equal(connack.cmd, 'connack');
    assert.equal(connack.reasonCode, REASON_NOT_AUTHORIZED);
    assert.equal(socket.ended, true);
});

test('AUTH without authentication data is rejected', () => {
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: { authenticationMethod: 'certchain' },
    });

    assert.equal(onlyPacket(socket).reasonCode, REASON_NOT_AUTHORIZED);
});

test('AUTH with invalid JSON is rejected', () => {
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: { authenticationMethod: 'certchain', authenticationData: '{not-json' },
    });

    assert.equal(onlyPacket(socket).reasonCode, REASON_NOT_AUTHORIZED);
});

test('AUTH with an invalid certificate chain is rejected', () => {
    certificateState.isValid = false;
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: {
            authenticationMethod: 'certchain',
            authenticationData: JSON.stringify(authData()),
        },
    });

    assert.equal(onlyPacket(socket).reasonCode, REASON_NOT_AUTHORIZED);
    assert.equal(certificateState.certArgs.clientId, 'client-1');
});

test('current behaviour: an empty verified-challenge set is not rejected', () => {
    // Known bug: handleAuth() checks `challengeHash.length === 0`, but
    // verifySignature() returns a Set (which has .size, not .length). The
    // check therefore never fires and the client is accepted with read ACLs.
    certificateState.verified = new Set();
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: {
            authenticationMethod: 'certchain',
            authenticationData: JSON.stringify(authData()),
        },
    });

    const connack = onlyPacket(socket);
    assert.equal(connack.reasonCode, REASON_SUCCESS);
    assert.deepEqual(JSON.parse(connack.properties.userProperties.acl), [
        { topic: 'hash-2/#', action: 'read' },
        { topic: 'hash-2/hash-3/#', action: 'read' },
        { topic: 'hash-2/hash-3/hash-4/#', action: 'read' },
    ]);
});

test('AUTH with a valid chain and signature returns CONNACK with the computed ACL', () => {
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);
    const payload = authData();

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: {
            authenticationMethod: 'certchain',
            authenticationData: JSON.stringify(payload),
        },
    });

    assert.deepEqual(certificateState.certArgs, {
        clientCert: 'CLIENT-CERT-PEM',
        clientId: 'client-1',
    });
    assert.deepEqual(certificateState.challenges, payload.challenges);

    const connack = onlyPacket(socket);
    assert.equal(connack.cmd, 'connack');
    assert.equal(connack.reasonCode, REASON_SUCCESS);
    assert.equal(socket.ended, false);

    const acl = JSON.parse(connack.properties.userProperties.acl);
    assert.deepEqual(acl, [
        { topic: 'hash-2/#', action: 'all' },
        { topic: 'hash-2/hash-3/#', action: 'read' },
        { topic: 'hash-2/hash-3/hash-4/#', action: 'read' },
    ]);
    assert.deepEqual(session.internal.acl.getAcl('client-1'), acl);
});

test('AUTH accepts authenticationData as a Buffer', () => {
    const socket = createSocket();
    socket.clientId = 'client-1';
    const session = new ClientSession(socket);

    session.handlePacket(socket, {
        cmd: 'auth',
        properties: {
            authenticationMethod: 'certchain',
            authenticationData: Buffer.from(JSON.stringify(authData())),
        },
    });

    assert.equal(onlyPacket(socket).reasonCode, REASON_SUCCESS);
});

test('AUTH accepts the certificate under every supported alias', () => {
    for (const alias of ['cert', 'certificate', 'chain', 'certChain']) {
        const socket = createSocket();
        socket.clientId = `client-${alias}`;
        const session = new ClientSession(socket);
        const payload = authData({ cert: undefined, [alias]: `PEM-${alias}` });

        session.handlePacket(socket, {
            cmd: 'auth',
            properties: {
                authenticationMethod: 'certchain',
                authenticationData: JSON.stringify(payload),
            },
        });

        assert.equal(onlyPacket(socket).reasonCode, REASON_SUCCESS, alias);
        assert.equal(certificateState.certArgs.clientCert, `PEM-${alias}`);
    }
});

// ---------------------------------------------------------------------------
// SUBSCRIBE
// ---------------------------------------------------------------------------

test('SUBSCRIBE grants readable topics and rejects everything else', () => {
    const base = topic();
    const { session, socket } = authenticatedSession([
        { topic: `${base}/#`, action: 'read' },
    ]);

    session.handlePacket(socket, {
        cmd: 'subscribe',
        messageId: 7,
        subscriptions: [
            { topic: `${base}/a/b`, qos: 1 },
            { topic: 'outside/topic', qos: 2 },
        ],
    });

    const suback = onlyPacket(socket);
    assert.equal(suback.cmd, 'suback');
    assert.equal(suback.messageId, 7);
    assert.deepEqual(suback.granted, [1, REASON_NOT_AUTHORIZED]);

    assert.deepEqual(session.internal.topics.getSubscriptions(`${base}/a/b`), ['client-1']);
    assert.deepEqual(session.internal.topics.getSubscriptions('outside/topic'), []);
});

test('SUBSCRIBE treats an "all" ACL entry as readable and defaults qos to 0', () => {
    const base = topic();
    const { session, socket } = authenticatedSession([
        { topic: `${base}/#`, action: 'all' },
    ]);

    session.handlePacket(socket, {
        cmd: 'subscribe',
        messageId: 8,
        subscriptions: [{ topic: `${base}/a` }],
    });

    assert.deepEqual(onlyPacket(socket).granted, [0]);
});

test('SUBSCRIBE does not grant a topic that only has write permission', () => {
    const base = topic();
    const { session, socket } = authenticatedSession([
        { topic: `${base}/#`, action: 'write' },
    ]);

    session.handlePacket(socket, {
        cmd: 'subscribe',
        messageId: 9,
        subscriptions: [{ topic: `${base}/a`, qos: 1 }],
    });

    assert.deepEqual(onlyPacket(socket).granted, [REASON_NOT_AUTHORIZED]);
    assert.deepEqual(session.internal.topics.getSubscriptions(`${base}/a`), []);
});

// ---------------------------------------------------------------------------
// PUBLISH / forwarding
// ---------------------------------------------------------------------------

function subscribeTarget(topicName, clientId = 'target-1') {
    const socket = createSocket();
    new ClientCollector().addClient(clientId, { socket });
    new ClientTopic().addSubscription(topicName, clientId);
    return socket;
}

test('an authorised QoS 0 PUBLISH is forwarded to subscribers without an ack', () => {
    const topicName = topic();
    const targetSocket = subscribeTarget(topicName);
    const { session, socket } = authenticatedSession([
        { topic: `${topicName.split('/')[0]}/#`, action: 'write' },
    ]);

    session.handlePacket(socket, {
        cmd: 'publish',
        topic: topicName,
        payload: Buffer.from('hello'),
        qos: 0,
        retain: false,
        dup: false,
    });

    assert.equal(socket.writes.length, 0);

    const forwarded = parsePacket(targetSocket.writes[0]);
    assert.equal(forwarded.cmd, 'publish');
    assert.equal(forwarded.topic, topicName);
    assert.equal(forwarded.payload.toString(), 'hello');
    assert.equal(forwarded.qos, 0);
    assert.equal(forwarded.retain, false);
    assert.equal(forwarded.dup, false);
});

test('an authorised QoS 1 PUBLISH is forwarded and acknowledged with reason 0', () => {
    const topicName = topic();
    const targetSocket = subscribeTarget(topicName);
    const { session, socket } = authenticatedSession([
        { topic: `${topicName.split('/')[0]}/#`, action: 'all' },
    ]);

    session.handlePacket(socket, {
        cmd: 'publish',
        topic: topicName,
        payload: Buffer.from('qos1'),
        qos: 1,
        messageId: 11,
    });

    assert.equal(targetSocket.writes.length, 1);
    const puback = onlyPacket(socket);
    assert.equal(puback.cmd, 'puback');
    assert.equal(puback.messageId, 11);
    assert.equal(puback.reasonCode, REASON_SUCCESS);
});

test('an authorised QoS 2 PUBLISH is forwarded and acknowledged with PUBREC reason 0', () => {
    const topicName = topic();
    subscribeTarget(topicName);
    const { session, socket } = authenticatedSession([
        { topic: `${topicName.split('/')[0]}/#`, action: 'write' },
    ]);

    session.handlePacket(socket, {
        cmd: 'publish',
        topic: topicName,
        payload: Buffer.from('qos2'),
        qos: 2,
        messageId: 12,
    });

    const pubrec = onlyPacket(socket);
    assert.equal(pubrec.cmd, 'pubrec');
    assert.equal(pubrec.messageId, 12);
    assert.equal(pubrec.reasonCode, REASON_SUCCESS);
});

test('a PUBLISH without write permission is rejected per QoS', () => {
    const base = topic();
    const topicName = `${base}/denied`;

    for (const [qos, cmd] of [[1, 'puback'], [2, 'pubrec']]) {
        const { session, socket } = authenticatedSession([
            { topic: `${base}/#`, action: 'read' },
        ]);

        session.handlePacket(socket, {
            cmd: 'publish',
            topic: topicName,
            payload: Buffer.from('nope'),
            qos,
            messageId: 20 + qos,
        });

        const packet = onlyPacket(socket);
        assert.equal(packet.cmd, cmd);
        assert.equal(packet.reasonCode, REASON_NOT_AUTHORIZED);
    }
});

test('a rejected QoS 0 PUBLISH is dropped silently', () => {
    const base = topic();
    const { session, socket } = authenticatedSession([
        { topic: `${base}/#`, action: 'read' },
    ]);

    session.handlePacket(socket, {
        cmd: 'publish',
        topic: `${base}/denied`,
        payload: Buffer.from('nope'),
        qos: 0,
    });

    assert.equal(socket.writes.length, 0);
});

test('forwarding skips subscriptions whose client has disappeared', () => {
    const topicName = topic();
    new ClientTopic().addSubscription(topicName, 'ghost-client');
    const { session, socket } = authenticatedSession([
        { topic: `${topicName.split('/')[0]}/#`, action: 'all' },
    ]);

    assert.doesNotThrow(() => {
        session.handlePacket(socket, {
            cmd: 'publish',
            topic: topicName,
            payload: Buffer.from('hello'),
            qos: 0,
        });
    });

    assert.equal(socket.writes.length, 0);
    assert.ok(logs.some((args) => String(args[0]).includes('无法找到客户端')));
});

test('forwarding delivers the message to every subscriber', () => {
    const topicName = topic();
    const first = subscribeTarget(topicName, 'target-1');
    const second = subscribeTarget(topicName, 'target-2');
    const { session, socket } = authenticatedSession([
        { topic: `${topicName.split('/')[0]}/#`, action: 'all' },
    ]);

    session.handlePacket(socket, {
        cmd: 'publish',
        topic: topicName,
        payload: Buffer.from('broadcast'),
        qos: 0,
    });

    assert.equal(first.writes.length, 1);
    assert.equal(second.writes.length, 1);
    assert.equal(parsePacket(first.writes[0]).payload.toString(), 'broadcast');
    assert.equal(parsePacket(second.writes[0]).payload.toString(), 'broadcast');
});

// ---------------------------------------------------------------------------
// Other packet types
// ---------------------------------------------------------------------------

test('PINGREQ is answered with PINGRESP', () => {
    const session = new ClientSession(createSocket());

    session.handlePacket(session.socket, { cmd: 'pingreq' });

    assert.equal(onlyPacket(session.socket).cmd, 'pingresp');
});

test('DISCONNECT ends the socket', () => {
    const session = new ClientSession(createSocket());

    session.handlePacket(session.socket, { cmd: 'disconnect' });

    assert.equal(session.socket.ended, true);
    assert.equal(session.socket.writes.length, 0);
});

test('an unsupported packet type is logged and ignored', () => {
    const session = new ClientSession(createSocket());

    session.handlePacket(session.socket, { cmd: 'pubrel' });

    assert.equal(session.socket.writes.length, 0);
    assert.ok(logs.some((args) => String(args[0]).includes('未处理的包类型')));
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('delete removes the client, challenge, ACL and topic subscriptions', () => {
    const topicName = topic();
    const { session, socket } = authenticatedSession([
        { topic: `${topicName.split('/')[0]}/#`, action: 'all' },
    ]);
    const collector = new ClientCollector();
    collector.addClient(socket.clientId, session);
    collector.addChallenge(socket.clientId, 'challenge-1');
    session.internal.topics.addSubscription(topicName, socket.clientId);

    session.delete(socket.clientId);

    assert.equal(collector.hasClient(socket.clientId), false);
    assert.equal(collector.getChallenge(socket.clientId), undefined);
    assert.equal(session.internal.acl.getAcl(socket.clientId), undefined);
    assert.deepEqual(session.internal.topics.getSubscriptions(topicName), []);
});

test('current behaviour: delete before AUTH throws because internal.acl is not created yet', () => {
    const session = new ClientSession(createSocket());

    // Known landmine: index.mjs calls delete() from the socket close/error
    // handlers even when AUTH never completed.
    assert.throws(() => session.delete('never-authenticated'), TypeError);
});

test('parse feeds a generated CONNECT packet into handleConnect', () => {
    const session = new ClientSession(createSocket());
    const packet = mqttPacket.generate(
        {
            cmd: 'connect',
            protocolId: 'MQTT',
            protocolVersion: 5,
            clean: true,
            clientId: 'parsed-client',
        },
        { protocolVersion: 5 }
    );

    session.parse(packet);

    assert.match(session.socket.clientId, /^parsed-client_broker_/);
    assert.equal(onlyPacket(session.socket).cmd, 'auth');
});

test('parse swallows parser errors and logs them', () => {
    const session = new ClientSession(createSocket());
    const errorsBefore = errorLogs.length;

    // AUTH is only parsable with protocolVersion 5; the session parser is
    // created without options, so this exercises the error path.
    assert.doesNotThrow(() => session.parse(Buffer.from([0xf0, 0x00])));

    assert.ok(errorLogs.length > errorsBefore);
});
