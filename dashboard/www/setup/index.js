import { createApp, reactive, ref, computed, onMounted, shallowRef } from 'vue';
import Antd, { message } from 'ant-design-vue';

/* ============================================================
 *  ASN.1 DER 编码工具
 * ============================================================ */
const textEncoder = new TextEncoder();

function concatBytes(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function derLength(len) {
  if (len < 0x80) return new Uint8Array([len]);
  const tmp = [];
  let n = len;
  while (n > 0) { tmp.unshift(n & 0xff); n = Math.floor(n / 256); }
  return new Uint8Array([0x80 | tmp.length, ...tmp]);
}

function tlv(tag, content) {
  return concatBytes(new Uint8Array([tag]), derLength(content.length), content);
}

const derSequence = (...items) => tlv(0x30, concatBytes(...items));
const derSet = (...items) => tlv(0x31, concatBytes(...items));

function derInteger(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.subarray(i);
  if (v[0] & 0x80) v = concatBytes(new Uint8Array([0x00]), v);
  return tlv(0x02, v);
}

function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const buf = [n & 0x7f];
    n = Math.floor(n / 128);
    while (n > 0) { buf.unshift((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    bytes.push(...buf);
  }
  return tlv(0x06, new Uint8Array(bytes));
}

const derUtf8 = (s) => tlv(0x0c, textEncoder.encode(s));
const derBitString = (bytes) => tlv(0x03, concatBytes(new Uint8Array([0x00]), bytes));

function ecdsaRawToDer(raw) {
  const half = raw.length / 2;
  return derSequence(
    derInteger(raw.subarray(0, half)),
    derInteger(raw.subarray(half, half * 2))
  );
}

function pemFromDer(der, label) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < der.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, der.subarray(i, i + CHUNK));
  }
  const b64 = btoa(binary);
  const lines = (b64.match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

function toUint8Array(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  // 兜底：从可迭代/类数组对象拷贝
  return new Uint8Array(x);
}

/* ============================================================
 *  PKCS#10 CSR 构造
 * ============================================================ */
const ATTR_OIDS = {
  C: '2.5.4.6', ST: '2.5.4.8', L: '2.5.4.7',
  O: '2.5.4.10', OU: '2.5.4.11', CN: '2.5.4.3',
};
const OID_ECDSA_WITH_SHA384 = '1.2.840.10045.4.3.3';

/** 用指定私钥（可导出或不可导出均可）对 Subject + SPKI 签名，返回 PEM 格式 CSR */
async function buildCsrPem(subjectAttrs, publicKeySpki, privateKey) {
  const spki = toUint8Array(publicKeySpki);

  const rdnSeq = subjectAttrs
    .filter((a) => a.value)
    .map((a) => {
      const oid = ATTR_OIDS[a.key];
      if (!oid) throw new Error('不支持的 Subject 属性: ' + a.key);
      return derSet(derSequence(derOid(oid), derUtf8(a.value)));
    });
  const subject = derSequence(...rdnSeq);

  const cri = derSequence(
    derInteger(new Uint8Array([0x00])),
    subject,
    spki,
    tlv(0xa0, new Uint8Array(0))
  );

  // 用私钥签名（对不可导出私钥同样可用）
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, privateKey, cri)
  );
  const sigDer = ecdsaRawToDer(rawSig);

  const csrDer = derSequence(
    cri,
    derSequence(derOid(OID_ECDSA_WITH_SHA384)),
    derBitString(sigDer)
  );

  return pemFromDer(csrDer, 'CERTIFICATE REQUEST');
}

/* ============================================================
 *  IndexedDB 封装
 * ============================================================ */
const DB_NAME = 'mqtt-mtls-keystore';
const DB_VERSION = 1;
const STORE_NAME = 'keys';
const RECORD_KEY = 'client-space-leaf';
const LEGACY_LOCALSTORAGE_KEY = 'mqtt-mtls-client-space-leaf';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB 不可用'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ============================================================
 *  Vue 应用
 * ============================================================ */
const app = createApp({
  setup() {
    const subjectFields = [
      { key: 'C',  label: 'C (Country)',           placeholder: 'JP' },
      { key: 'ST', label: 'ST (State / Province)', placeholder: 'Tokyo' },
      { key: 'L',  label: 'L (Locality)',          placeholder: '(可选)' },
      { key: 'O',  label: 'O (Organization)',      placeholder: 'Client' },
      { key: 'OU', label: 'OU (Org Unit)',         placeholder: '(可选)' },
      { key: 'CN', label: 'CN (Common Name)',      placeholder: 'OTMC-Client_Leaf_4_Space_3rd_level_Cert' },
    ];

    const form = reactive({
      C: 'JP', ST: 'Tokyo', L: '', O: 'Client', OU: '',
      CN: 'OTMC-Client_Leaf_4_Space_3rd_level_Cert',
    });

    // 只把 PEM 字符串放进 reactive；CryptoKey 绝不放进响应式系统
    const result = reactive({
      csrPem: '',
      publicKeyPem: '',
      privateKeyPem: '',   // 仅在 extractable=true 时有值
      subject: '',
      createdAt: '',
      extractable: false,
    });

    const loading = ref(false);
    const hasStored = ref(false);
    const cryptoOk = ref(true);
    const indexedDbOk = ref(true);
    const allowExport = ref(false);       // 默认非导出
    const legacyDetected = ref(false);

    const hasResult = computed(() => !!result.csrPem);

    const subjectString = computed(() =>
      subjectFields
        .filter((f) => form[f.key])
        .map((f) => `/${f.key}=${form[f.key]}`)
        .join('')
    );

    function fillFormFromAttrs(attrs) {
      if (!Array.isArray(attrs)) return;
      attrs.forEach((a) => { if (a.key in form) form[a.key] = a.value; });
    }

    /* ---------- 生成 ---------- */
    async function onGenerate() {
      if (!form.C || !form.O || !form.CN) {
        message.warning('请至少填写 C、O、CN');
        return;
      }
      if (!indexedDbOk.value) {
        message.error('IndexedDB 不可用，无法安全存储密钥');
        return;
      }

      loading.value = true;
      try {
        const attrs = subjectFields.map((f) => ({
          key: f.key,
          value: (form[f.key] || '').trim(),
        }));

        // 关键：extractable 由用户勾选决定，默认 false
        const extractable = allowExport.value;

        const keyPair = await crypto.subtle.generateKey(
          { name: 'ECDSA', namedCurve: 'P-384' },
          extractable,
          ['sign', 'verify']
        );

        // 公钥始终可导出
        const spki = new Uint8Array(
          await crypto.subtle.exportKey('spki', keyPair.publicKey)
        );

        // 构造并签名 CSR
        const csrPem = await buildCsrPem(attrs, spki, keyPair.privateKey);

        // 仅在 extractable=true 时导出私钥
        let privateKeyPem = '';
        if (extractable) {
          const pkcs8 = new Uint8Array(
            await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
          );
          privateKeyPem = pemFromDer(pkcs8, 'PRIVATE KEY');
        }

        const createdAt = new Date().toISOString();
        const subject = attrs
          .filter((a) => a.value)
          .map((a) => `/${a.key}=${a.value}`)
          .join('');

        // 存储：CryptoKey 直接以对象形式存入 IndexedDB（结构化克隆）
        await dbPut(RECORD_KEY, {
          version: 2,
          extractable,
          algorithm: 'ECDSA P-384 / SHA-384',
          subject,
          subjectAttrs: attrs,
          createdAt,
          publicKeySpki: spki,     // Uint8Array
          privateKey: keyPair.privateKey, // CryptoKey（不可导出模式下亦支持克隆）
        });

        Object.assign(result, {
          csrPem,
          publicKeyPem: pemFromDer(spki, 'PUBLIC KEY'),
          privateKeyPem,
          subject,
          createdAt,
          extractable,
        });

        hasStored.value = true;
        message.success(
          extractable
            ? '可导出密钥已生成并存入 IndexedDB'
            : '非导出密钥已生成并安全存入 IndexedDB（私钥不可下载）'
        );
      } catch (e) {
        console.error(e);
        message.error('生成失败：' + (e && e.message ? e.message : e));
      } finally {
        loading.value = false;
      }
    }

    /* ---------- 加载 ---------- */
    async function onLoad() {
      loading.value = true;
      try {
        const record = await dbGet(RECORD_KEY);
        if (!record || !record.privateKey) {
          message.warning('IndexedDB 中没有找到已保存的密钥');
          return;
        }

        // 用读出的 CryptoKey 重新签名生成 CSR
        const csrPem = await buildCsrPem(
          record.subjectAttrs,
          record.publicKeySpki,
          record.privateKey
        );

        let privateKeyPem = '';
        if (record.extractable) {
          const pkcs8 = new Uint8Array(
            await crypto.subtle.exportKey('pkcs8', record.privateKey)
          );
          privateKeyPem = pemFromDer(pkcs8, 'PRIVATE KEY');
        }

        fillFormFromAttrs(record.subjectAttrs);

        Object.assign(result, {
          csrPem,
          publicKeyPem: pemFromDer(toUint8Array(record.publicKeySpki), 'PUBLIC KEY'),
          privateKeyPem,
          subject: record.subject || '',
          createdAt: record.createdAt || '',
          extractable: !!record.extractable,
        });

        allowExport.value = !!record.extractable;
        hasStored.value = true;
        message.success('已从 IndexedDB 加载密钥并重新生成 CSR 签名');
      } catch (e) {
        console.error(e);
        message.error('加载失败：' + (e && e.message ? e.message : e));
      } finally {
        loading.value = false;
      }
    }

    /* ---------- 清除 ---------- */
    async function onClear() {
      try {
        await dbDelete(RECORD_KEY);
        hasStored.value = false;
        Object.assign(result, {
          csrPem: '', publicKeyPem: '', privateKeyPem: '',
          subject: '', createdAt: '', extractable: false,
        });
        message.success('已清除 IndexedDB 中的密钥');
      } catch (e) {
        console.error(e);
        message.error('清除失败：' + (e && e.message ? e.message : e));
      }
    }

    /* ---------- 旧版 localStorage 迁移 ---------- */
    function checkLegacy() {
      try {
        legacyDetected.value = !!localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
      } catch (e) {
        legacyDetected.value = false;
      }
    }

    async function migrateLegacy() {
      try {
        const raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);

        if (!data.privateKeyPem) {
          message.error('旧数据中缺少私钥 PEM，无法迁移');
          return;
        }

        // 从 PEM PKCS#8 导入可导出私钥
        const pkcs8 = pemToBytes(data.privateKeyPem, 'PRIVATE KEY');
        const privateKey = await crypto.subtle.importKey(
          'pkcs8',
          pkcs8,
          { name: 'ECDSA', namedCurve: 'P-384' },
          true, // 迁移场景保留导出能力，避免用户丢失原始文件
          ['sign', 'verify']
        );
        const publicKey = await crypto.subtle.importKey(
          'spki',
          pemToBytes(data.publicKeyPem, 'PUBLIC KEY'),
          { name: 'ECDSA', namedCurve: 'P-384' },
          true,
          ['verify']
        );
        const spki = new Uint8Array(
          await crypto.subtle.exportKey('spki', publicKey)
        );

        await dbPut(RECORD_KEY, {
          version: 2,
          extractable: true,
          algorithm: 'ECDSA P-384 / SHA-384',
          subject: data.subject || '',
          subjectAttrs: data.subjectAttrs || [],
          createdAt: data.createdAt || new Date().toISOString(),
          publicKeySpki: spki,
          privateKey,
        });

        localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
        legacyDetected.value = false;
        hasStored.value = true;
        allowExport.value = true;

        message.success('旧版数据已迁移到 IndexedDB（extractable=true），localStorage 已清理');
      } catch (e) {
        console.error(e);
        message.error('迁移失败：' + (e && e.message ? e.message : e));
      }
    }

    function clearLegacy() {
      try {
        localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
        legacyDetected.value = false;
        message.success('已删除旧版 localStorage 数据');
      } catch (e) {
        message.error('删除失败：' + (e && e.message ? e.message : e));
      }
    }

    /* ---------- 复制 / 下载 ---------- */
    async function copyText(text) {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        message.success('已复制到剪贴板');
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); message.success('已复制到剪贴板'); }
        catch (err) { message.error('复制失败，请手动选择文本'); }
        document.body.removeChild(ta);
      }
    }

    function downloadFile(filename, content) {
      if (!content) return;
      const blob = new Blob([content], { type: 'application/x-pem-file' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /* ---------- 初始化 ---------- */
    onMounted(async () => {
      cryptoOk.value = !!(window.crypto && window.crypto.subtle);
      try {
        await openDB();
        indexedDbOk.value = true;
      } catch (e) {
        indexedDbOk.value = false;
        console.warn('IndexedDB 不可用', e);
      }
      checkLegacy();

      if (indexedDbOk.value) {
        try {
          const record = await dbGet(RECORD_KEY);
          if (record && record.privateKey) {
            hasStored.value = true;
            message.info('检测到 IndexedDB 中已保存的密钥，点击“从 IndexedDB 加载”以使用');
          }
        } catch (e) {
          console.warn(e);
        }
      }
    });

    return {
      subjectFields, form, result, loading, hasStored, cryptoOk, indexedDbOk,
      allowExport, legacyDetected, hasResult, subjectString,
      dbName: DB_NAME, recordKey: RECORD_KEY,
      onGenerate, onLoad, onClear,
      migrateLegacy, clearLegacy,
      copyText, downloadFile,
    };
  },
});

/* PEM → 字节（仅用于迁移可导出私钥） */
function pemToBytes(pem, label) {
  const re = new RegExp(
    `-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`
  );
  const m = pem.match(re);
  if (!m) throw new Error(`无法解析 PEM（${label}）`);
  const b64 = m[1].replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

app.use(Antd);
app.mount('#app');
