import crypto from 'node:crypto';
import { config } from './config.mjs';
import bs58 from 'bs58';


class ClientCertificate {
  constructor(clientCert) {
    this.internal = new ClientCertificateInternal(clientCert);
  }
  isValid() {
    return this.internal.isValid();
  }
  getPublicKeyHash() {
    return this.internal.getPublicKeyHash();
  }
  verifySignature(challenges) {
    return this.internal.verifySignature(challenges);
  }
}

export { ClientCertificate };

class ClientCertificateInternal {
  constructor(clientCert) {
    this.clientCert = clientCert;
    this.fullChainPem = [];
    this.fullChain = [];
    this.fullChainMap = {}; // keyAddresses 
    this.trustedRootFingerprints = new Set(); // 允许配置多个 root
  }

  isValid() {
    try {
      if (!this.collectCertFullChain()) return false;
      if (!this.loadCerts())           return false;
      return this.verifyCertChain();
    } catch (err) {
      console.error('ClientCertificateInternal:isValid:error:', err);
      return false;
    }
  }

  collectCertFullChain() {
    const rootCert    = config?.mqtt?.client?.caRoot;
    const trustedCert = config?.mqtt?.client?.caTrusted;

    const rootPem    = this.splitCertChain(rootCert?.toString());
    const trustedPem = this.splitCertChain(trustedCert?.toString());
    const clientPem  = this.splitCertChain(this.clientCert?.toString());

    if (rootPem.length === 0) {
      console.error('ClientCertificateInternal:collectCertFullChain:no caRoot configured');
      return false;
    }

    // 记录配置里的可信根指纹
    this.trustedRootFingerprints.clear();
    for (const pem of rootPem) {
      try {
        const c = new crypto.X509Certificate(Buffer.from(pem));
        this.trustedRootFingerprints.add(c.fingerprint256);
      } catch (err) {
        console.error('collectCertFullChain:bad caRoot pem:', err);
      }
    }
    if (this.trustedRootFingerprints.size === 0) {
      console.error('collectCertFullChain:no parsable caRoot');
      return false;
    }

    this.fullChainPem = [...rootPem, ...trustedPem, ...clientPem];
    return true;
  }

  splitCertChain(certChain) {
    const pemRegex = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    return certChain?.match(pemRegex) ?? [];
  }

  loadCerts() {
    // 1) 解析 + 按指纹去重
    const byFp = new Map();
    for (const pem of this.fullChainPem) {
      try {
        const c = new crypto.X509Certificate(Buffer.from(pem));
        if (!byFp.has(c.fingerprint256)) byFp.set(c.fingerprint256, c);
      } catch (err) {
        console.error('loadCerts:parse error:', err);
      }
    }
    const certs = [...byFp.values()];
    if (certs.length === 0) return false;

    // 2) 选根：必须自签 **且** 指纹在可信集合里
    const rootIdx = certs.findIndex(
      c => c.subject === c.issuer && this.trustedRootFingerprints.has(c.fingerprint256)
    );
    if (rootIdx === -1) {
      console.error('loadCerts:no trusted self-signed root found');
      return false;
    }

    // 3) 从根向下重建
    const remaining = certs.slice();
    const root = remaining.splice(rootIdx, 1)[0];
    this.fullChain = [root];

    while (remaining.length > 0) {
      const parent = this.fullChain[this.fullChain.length - 1];
      const idx = remaining.findIndex(child => child.checkIssued(parent));
      if (idx === -1) {
        console.error('loadCerts:chain broken at:', parent.subject);
        console.error('loadCerts:orphans:', remaining.map(c => c.subject));
        return false;                     // 不塞，直接失败
      }
      this.fullChain.push(remaining.splice(idx, 1)[0]);
    }

    // 4) 打印链
    console.log('loadCerts:fullChain =', this.fullChain.map(c => c.subject));
    return true;
  }

  verifyCertChain() {
    if (this.fullChain.length < 2) {
      console.error('verifyCertChain:chain too short');
      return false;
    }

    const now = Date.now();
    for (let i = 0; i < this.fullChain.length; i++) {
      const c = this.fullChain[i];
      if (now < c.validFromDate.getTime() || now > c.validToDate.getTime()) {
        console.error('verifyCertChain:expired/not-yet-valid:', c.subject);
        return false;
      }
      if (i === 0) continue;
      const parent = this.fullChain[i - 1];
      // checkIssued 已包含签发者 DN 匹配 + 签名校验
      if (!c.checkIssued(parent)) {
        console.error(
          `verifyCertChain:link[${i}] broken: "${c.subject}" !<- "${parent.subject}"`
        );
        return false;
      }
    }

    // 5) 链尾必须就是传入的 clientCert
    const leafPem = this.splitCertChain(this.clientCert?.toString());
    if (leafPem.length === 0) {
      console.error('verifyCertChain:no clientCert pem');
      return false;
    }
    const expectedLeaf = new crypto.X509Certificate(Buffer.from(leafPem[0]));
    const actualLeaf   = this.fullChain[this.fullChain.length - 1];
    if (actualLeaf.fingerprint256 !== expectedLeaf.fingerprint256) {
      console.error(
        'verifyCertChain:last cert is not clientCert:',
        actualLeaf.subject, '≠', expectedLeaf.subject
      );
      return false;
    }

    return true;
  }
  verifySignature(challenges) {
    if (this.fullChain.length === 0) {
      console.error('verifySignature:chain is empty');
      return false;
    }
    for(const challenge of challenges) {
      console.log('verifySignature:challenge:=<', challenge,'>');
      const isValid = this.verifySignatureSingle(challenge.data, challenge.signature, challenge.algorithm, this.fullChainMap[challenge.keyAddress]);
      if (!isValid) {
        console.error('verifySignature:challenge invalid for keyAddress=<', challenge.keyAddress, '>');
        continue; // 继续验证下一个 challenge
      }
    }
  }

  verifySignatureSingle(dataJson, signatureB64, algorithm, cert) {
    if (!cert) {
      console.error('verifySignatureSingle: cert not found');
      return false;
    }

    const signature = Buffer.from(signatureB64, 'base64');
    const data = Buffer.from(JSON.stringify(dataJson) , 'utf8');

    const verify = crypto.createVerify(String(algorithm || 'sha256').toLowerCase());
    verify.update(data);
    verify.end();
    const result = verify.verify(cert.publicKey, signature);
    console.log('verifySignatureSingle:result=<', result, '>');
    return result;
  }



  getPublicKeyHash() {
    if (this.fullChain.length === 0) {
      console.error('getPublicKeyHash:chain is empty');
      return null;
    }
    const allHashes = [];
    for (const cert of this.fullChain) {
      const pubKeyDer = cert.publicKey.export({ type: 'spki', format: 'der' });
      const hash = crypto.createHash('sha256').update(pubKeyDer).digest('hex');
      const base58Hash = bs58.encode(Buffer.from(hash, 'hex'));
      allHashes.push(base58Hash);
      this.fullChainMap[base58Hash] = cert; // 将公钥哈希映射到证书
    }
    console.log('getPublicKeyHash:allHashes=<', allHashes, '>');
    return allHashes;
  }
}
