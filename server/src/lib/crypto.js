// Tokens, hashes and encryption. Nothing here logs or returns key material.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque random token: prefix + 32 random bytes, base64url. */
export function randomToken(prefix, bytes = 32) {
  return prefix + randomBytes(bytes).toString('base64url');
}

/** sha-256 as a Buffer (stored in bytea columns). */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Human-friendly one-time code (recovery codes): 4-4-4 from an unambiguous alphabet. */
export function recoveryCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const raw = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[raw[i] % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export function normaliseRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

function gcmSeal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function gcmOpen(key, { iv, ct, tag }, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Encryption with SECRETS_MASTER_KEY.
 * - seal/open: direct AES-256-GCM with a per-purpose subkey (HKDF). For MFA secrets and
 *   short-lived cookies.
 * - envelopeSeal/envelopeOpen: a fresh data key per value, wrapped by the master key.
 *   For tenant secrets, so the master key can be rotated by re-wrapping data keys.
 * @param {string} masterKeyB64
 */
export function createSealer(masterKeyB64) {
  const master = Buffer.from(masterKeyB64, 'base64');
  if (master.length !== 32) throw new Error('master key must be 32 bytes');
  const subkeys = new Map();
  const subkey = (purpose) => {
    if (!subkeys.has(purpose)) subkeys.set(purpose, Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `fishtape:${purpose}`, 32)));
    return subkeys.get(purpose);
  };

  return {
    /** @returns {string} v1.iv.ct.tag */
    seal(purpose, plaintext, aad = '') {
      const { iv, ct, tag } = gcmSeal(subkey(purpose), Buffer.from(String(plaintext), 'utf8'), aad);
      return `v1.${b64u(iv)}.${b64u(ct)}.${b64u(tag)}`;
    },
    /** @returns {string|null} plaintext, or null when the value is not authentic */
    open(purpose, sealed, aad = '') {
      try {
        const [v, iv, ct, tag] = String(sealed).split('.');
        if (v !== 'v1') return null;
        return gcmOpen(subkey(purpose), { iv: unb64u(iv), ct: unb64u(ct), tag: unb64u(tag) }, aad).toString('utf8');
      } catch {
        return null;
      }
    },
    envelopeSeal(plaintext, aad = '') {
      const dek = randomBytes(32);
      const wrapped = gcmSeal(subkey('kek'), dek, aad);
      const body = gcmSeal(dek, Buffer.from(String(plaintext), 'utf8'), aad);
      return JSON.stringify({
        v: 1,
        wk: [b64u(wrapped.iv), b64u(wrapped.ct), b64u(wrapped.tag)].join('.'),
        iv: b64u(body.iv), ct: b64u(body.ct), tag: b64u(body.tag),
      });
    },
    envelopeOpen(sealed, aad = '') {
      const o = JSON.parse(sealed);
      if (o.v !== 1) throw new Error('unknown envelope version');
      const [wiv, wct, wtag] = o.wk.split('.');
      const dek = gcmOpen(subkey('kek'), { iv: unb64u(wiv), ct: unb64u(wct), tag: unb64u(wtag) }, aad);
      return gcmOpen(dek, { iv: unb64u(o.iv), ct: unb64u(o.ct), tag: unb64u(o.tag) }, aad).toString('utf8');
    },
  };
}
