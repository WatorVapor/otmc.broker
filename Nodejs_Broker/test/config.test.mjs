import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. config.mjs reads its certificates and the tailscale0 address
// while it is being evaluated, so the mocks must exist before the import.
// ---------------------------------------------------------------------------

const fsState = {
    reads: [],
};

mock.module('fs', {
    exports: {
        readFileSync(filePath) {
            fsState.reads.push(String(filePath));
            return Buffer.from(`CERT:${filePath}`);
        },
    },
});

const osState = {
    interfaces: {
        tailscale0: [
            { family: 'IPv6', internal: false, address: 'fe80::1' },
            { family: 6, internal: false, address: '2001:db8::1' },
            { family: 'IPv4', internal: false, address: '192.0.2.1' },
        ],
    },
};

mock.module('os', {
    exports: {
        networkInterfaces() {
            return osState.interfaces;
        },
    },
});

const firstImport = await import('../config.mjs');
const readsAtFirstImport = [...fsState.reads];

after(() => mock.restoreAll());

const CERT_FILES = [
    '/usr/local/etc/certs/valkey-cluster/valkey-root.crt',
    '/usr/local/etc/certs/valkey-cluster/valkey-client.crt',
    '/usr/local/etc/certs/valkey-cluster/valkey-client.key',
    '/usr/local/etc/certs/client_cert/client-root.crt',
    '/usr/local/etc/certs/client_cert/ca_inter_bundle.crt',
];

test('reads the five certificate files at import time', () => {
    assert.deepEqual(readsAtFirstImport, CERT_FILES);
});

test('exposes the MQTT listener and client CA material', () => {
    const { config } = firstImport;

    assert.equal(config.mqtt.port, 18883);
    assert.equal(config.mqtt.host, '2001:db8::1');
    assert.deepEqual(config.mqtt.client.caRoot, Buffer.from(`CERT:${CERT_FILES[3]}`));
    assert.deepEqual(config.mqtt.client.caTrusted, Buffer.from(`CERT:${CERT_FILES[4]}`));
});

test('exposes the Valkey cluster addresses and TLS material', () => {
    const { config } = firstImport;

    assert.deepEqual(
        config.valkey.address.map(({ host, port }) => ({ host, port })),
        [
            { host: 'valkey-cluster-conoha-pdf-coltd.wator.xyz', port: 6379 },
            { host: 'valkey-cluster-conoha-wator.wator.xyz', port: 6379 },
            { host: 'valkey-cluster-conoha-ndhealth.wator.xyz', port: 6379 },
        ]
    );
    assert.equal(config.valkey.useTLS, true);
    assert.equal(config.valkey.advancedConfiguration.tlsAdvancedConfiguration.insecure, true);

    assert.deepEqual(config.redis.rootNodes, [
        { socket: { host: 'valkey-cluster-conoha-pdf-coltd.wator.xyz', port: 6379 } },
        { socket: { host: 'valkey-cluster-conoha-wator.wator.xyz', port: 6379 } },
        { socket: { host: 'valkey-cluster-conoha-ndhealth.wator.xyz', port: 6379 } },
    ]);
    assert.deepEqual(config.redis.defaults.socket.ca, Buffer.from(`CERT:${CERT_FILES[0]}`));
    assert.deepEqual(config.redis.defaults.socket.cert, Buffer.from(`CERT:${CERT_FILES[1]}`));
    assert.deepEqual(config.redis.defaults.socket.key, Buffer.from(`CERT:${CERT_FILES[2]}`));
});

test('leaves mqtt.host undefined when tailscale0 is missing', async () => {
    osState.interfaces = {};

    const { config } = await import('../config.mjs?no-tailscale0');

    assert.equal(config.mqtt.host, undefined);
});

test('leaves mqtt.host undefined when tailscale0 only has a link-local address', async () => {
    osState.interfaces = {
        tailscale0: [{ family: 'IPv6', internal: false, address: 'fe80::1' }],
    };

    const { config } = await import('../config.mjs?link-local-only');

    assert.equal(config.mqtt.host, undefined);
});
