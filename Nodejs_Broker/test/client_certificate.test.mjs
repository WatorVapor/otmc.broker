import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

// ---------------------------------------------------------------------------
// Module mocks. client_certificate_.mjs parses real X509 objects, but building
// test chains with openssl would make the suite environment dependent. Keep
// the real hashing / signature primitives and replace only X509Certificate
// with a small in-memory certificate model.
// ---------------------------------------------------------------------------

const realCrypto = await import('node:crypto');
const bs58 = (await import('bs58')).default;

const certSpecs = new Map();

class FakeX509Certificate {
    constructor(buffer) {
        const pem = buffer.toString();
        const spec = certSpecs.get(pem);
        if (!spec) throw new Error(`unknown test certificate: ${pem}`);
        Object.assign(this, spec);
        this.pem = pem;
    }
}

mock.module('node:crypto', {
    exports: {
        default: { ...realCrypto, X509Certificate: FakeX509Certificate },
    },
});

const configState = {
    config: { mqtt: { client: { caRoot: Buffer.alloc(0), caTrusted: Buffer.alloc(0) } } },
};

mock.module('../config.mjs', {
    exports: { config: configState.config },
});

mock.method(console, 'log', () => {});
const errorLogs = [];
mock.method(console, 'error', (...args) => errorLogs.push(args));

const { ClientCertificate } = await import('../client_certificate_.mjs');
const { ClientCollector } = await import('../client_collect.mjs');

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pem = (name) =>
    `-----BEGIN CERTIFICATE-----\n${name}\n-----END CERTIFICATE-----`;

function makeCert(name, { issuer = name, signedBy = null, validFrom, validTo } = {}) {
    const keyPair = realCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spec = {
        name,
        subject: `CN=${name}`,
        issuer: `CN=${issuer}`,
        fingerprint256: `fp:${name}`,
        validFromDate: validFrom ?? new Date(Date.now() - 60 * 60 * 1000),
        validToDate: validTo ?? new Date(Date.now() + 60 * 60 * 1000),
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey,
        signedBy,
        checkIssued(parent) {
            return this.signedBy === parent.name;
        },
    };
    certSpecs.set(pem(name), spec);
    return spec;
}

function buildChain() {
    const root = makeCert('root');
    const intermediate = makeCert('intermediate', { issuer: 'root', signedBy: 'root' });
    const leaf = makeCert('leaf', { issuer: 'intermediate', signedBy: 'intermediate' });
    return { root, intermediate, leaf };
}

function configure({ caRoot = pem('root'), caTrusted = pem('intermediate') } = {}) {
    configState.config.mqtt.client.caRoot = Buffer.from(caRoot);
    configState.config.mqtt.client.caTrusted = Buffer.from(caTrusted);
}

function hashOf(spec) {
    const der = spec.publicKey.export({ type: 'spki', format: 'der' });
    return bs58.encode(realCrypto.createHash('sha256').update(der).digest());
}

function signWith(spec, data) {
    return realCrypto
        .createSign('SHA256')
        .update(JSON.stringify(data))
        .end()
        .sign(spec.privateKey, 'base64');
}

function hasError(fragment) {
    return errorLogs.some((args) => args.some((arg) => String(arg).includes(fragment)));
}

beforeEach(() => {
    new ClientCollector().clear();
    certSpecs.clear();
    errorLogs.length = 0;
    configState.config.mqtt.client.caRoot = Buffer.alloc(0);
    configState.config.mqtt.client.caTrusted = Buffer.alloc(0);
});

// ---------------------------------------------------------------------------
// Chain validation
// ---------------------------------------------------------------------------

test('isValid rebuilds root -> intermediate -> leaf and accepts a trusted chain', () => {
    buildChain();
    configure();

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.isValid(), true);
    assert.deepEqual(
        certificate.internal.fullChain.map((cert) => cert.name),
        ['root', 'intermediate', 'leaf']
    );
});

test('getPublicKeyHash returns root-first Base58 SPKI hashes and fills fullChainMap', () => {
    const { root, intermediate, leaf } = buildChain();
    configure();

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');
    certificate.isValid();

    const hashes = certificate.getPublicKeyHash();

    assert.deepEqual(hashes, [hashOf(root), hashOf(intermediate), hashOf(leaf)]);
    assert.equal(certificate.internal.fullChainMap[hashes[0]], certificate.internal.fullChain[0]);
    assert.equal(certificate.internal.fullChainMap[hashes[1]], certificate.internal.fullChain[1]);
    assert.equal(certificate.internal.fullChainMap[hashes[2]], certificate.internal.fullChain[2]);
});

test('duplicate PEMs are deduplicated by fingerprint', () => {
    buildChain();
    configure({
        caRoot: [pem('root'), pem('root')].join('\n'),
        caTrusted: [pem('intermediate'), pem('intermediate')].join('\n'),
    });

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.isValid(), true);
    assert.equal(certificate.internal.fullChain.length, 3);
});

test('isValid rejects a chain without a configured CA root', () => {
    buildChain();
    configure({ caRoot: '' });

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('no caRoot configured'));
});

test('isValid rejects a CA bundle that has no trusted self-signed root', () => {
    buildChain();
    configure({ caRoot: pem('intermediate') });

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('no trusted self-signed root found'));
});

test('isValid rejects a broken chain', () => {
    buildChain();
    makeCert('orphan-leaf', { issuer: 'unknown', signedBy: 'unknown' });
    configure({ caTrusted: pem('intermediate') });

    const certificate = new ClientCertificate(pem('orphan-leaf'), 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('chain broken at'));
});

test('isValid rejects an expired certificate', () => {
    const { leaf } = buildChain();
    leaf.validToDate = new Date(Date.now() - 1000);
    configure();

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('expired/not-yet-valid'));
});

test('isValid rejects a certificate that is not valid yet', () => {
    const { root } = buildChain();
    root.validFromDate = new Date(Date.now() + 60 * 60 * 1000);
    configure();

    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('expired/not-yet-valid'));
});

test('isValid requires the last chain element to be the first client PEM', () => {
    buildChain();
    makeCert('leaf-child', { issuer: 'leaf', signedBy: 'leaf' });
    configure();

    const certificate = new ClientCertificate(
        `${pem('leaf')}\n${pem('leaf-child')}`,
        'client-1'
    );

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('last cert is not clientCert'));
});

test('isValid rejects a chain with fewer than two certificates', () => {
    buildChain();
    configure({ caTrusted: '' });

    const certificate = new ClientCertificate(pem('root'), 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('chain too short'));
});

test('isValid rejects a missing client certificate', () => {
    buildChain();
    configure();

    const certificate = new ClientCertificate(undefined, 'client-1');

    assert.equal(certificate.isValid(), false);
    assert.ok(hasError('no clientCert pem'));
});

test('isValid returns false for unparsable certificates instead of throwing', () => {
    buildChain();
    configure();

    const certificate = new ClientCertificate(pem('not-registered'), 'client-1');

    assert.equal(certificate.isValid(), false);
});

test('getPublicKeyHash returns null before the chain has been loaded', () => {
    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(certificate.getPublicKeyHash(), null);
});

test('splitCertChain extracts every PEM block and tolerates undefined', () => {
    buildChain();
    const certificate = new ClientCertificate(pem('leaf'), 'client-1');

    assert.deepEqual(certificate.internal.splitCertChain(undefined), []);
    assert.deepEqual(
        certificate.internal.splitCertChain(`noise\n${pem('root')}\njunk\n${pem('intermediate')}`),
        [pem('root'), pem('intermediate')]
    );
});

// ---------------------------------------------------------------------------
// Challenge signature verification
// ---------------------------------------------------------------------------

function verifiedCertificate(challenge = 'challenge-1') {
    const chain = buildChain();
    configure();
    const certificate = new ClientCertificate(pem('leaf'), 'client-1');
    assert.equal(certificate.isValid(), true);
    const hashes = certificate.getPublicKeyHash();
    new ClientCollector().addChallenge('client-1', challenge);
    return { certificate, chain, hashes, challenge };
}

test('verifySignature accepts a valid challenge signature and returns its key address', () => {
    const { certificate, chain, hashes, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };

    const verified = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'SHA256',
            keyAddress: hashes[2],
        },
    ]);

    assert.deepEqual([...verified], [hashes[2]]);
});

test('verifySignature accepts a lowercase / missing algorithm', () => {
    const { certificate, chain, hashes, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };

    const lower = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'sha256',
            keyAddress: hashes[2],
        },
    ]);
    const missing = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            keyAddress: hashes[2],
        },
    ]);

    assert.deepEqual([...lower], [hashes[2]]);
    assert.deepEqual([...missing], [hashes[2]]);
});

test('verifySignature rejects a signature made for a different challenge', () => {
    const { certificate, chain, hashes } = verifiedCertificate();
    const data = { challenge: 'other-challenge', timeStamp: new Date().toISOString() };

    const verified = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'SHA256',
            keyAddress: hashes[2],
        },
    ]);

    assert.equal(verified.size, 0);
    assert.ok(hasError('challenge not found or does not match'));
});

test('verifySignature rejects a stale or future timestamp', () => {
    const { certificate, chain, hashes, challenge } = verifiedCertificate();

    for (const timeStamp of [
        new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        'not-a-date',
    ]) {
        const data = { challenge, timeStamp };
        const verified = certificate.verifySignature([
            {
                data,
                signature: signWith(chain.leaf, data),
                algorithm: 'SHA256',
                keyAddress: hashes[2],
            },
        ]);
        assert.equal(verified.size, 0, `timestamp should be rejected: ${timeStamp}`);
    }

    assert.ok(hasError('timestamp is too old or too far in the future'));
});

test('verifySignature rejects an unknown key address', () => {
    const { certificate, chain, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };

    const verified = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'SHA256',
            keyAddress: 'unknown-key-address',
        },
    ]);

    assert.equal(verified.size, 0);
    assert.ok(hasError('cert not found'));
});

test('verifySignature rejects a signature made by a different chain key', () => {
    const { certificate, chain, hashes, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };

    const verified = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.intermediate, data),
            algorithm: 'SHA256',
            keyAddress: hashes[2],
        },
    ]);

    assert.equal(verified.size, 0);
});

test('verifySignature keeps only the challenges that verify', () => {
    const { certificate, chain, hashes, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };

    const verified = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'SHA256',
            keyAddress: hashes[2],
        },
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'SHA256',
            keyAddress: hashes[1], // leaf signature, intermediate key address
        },
    ]);

    assert.deepEqual([...verified], [hashes[2]]);
});

test('verifySignature returns false when called before isValid', () => {
    const { chain, hashes, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };
    const fresh = new ClientCertificate(pem('leaf'), 'client-1');

    assert.equal(
        fresh.verifySignature([
            {
                data,
                signature: signWith(chain.leaf, data),
                algorithm: 'SHA256',
                keyAddress: hashes[2],
            },
        ]),
        false
    );
});

test('verifySignature returns an empty set when getPublicKeyHash was never called', () => {
    const { chain, hashes, challenge } = verifiedCertificate();
    const data = { challenge, timeStamp: new Date().toISOString() };

    // Rebuild the chain without calling getPublicKeyHash().
    const certificate = new ClientCertificate(pem('leaf'), 'client-1');
    assert.equal(certificate.isValid(), true);

    const verified = certificate.verifySignature([
        {
            data,
            signature: signWith(chain.leaf, data),
            algorithm: 'SHA256',
            keyAddress: hashes[2],
        },
    ]);

    assert.equal(verified.size, 0);
});
