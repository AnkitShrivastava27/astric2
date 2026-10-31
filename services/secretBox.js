/**
 * services/secretBox.js
 *
 * Encrypts every secret a user hands us (API keys, client secrets, OAuth tokens, webhook URLs) before it
 * is written to Firestore. AES-256-GCM, a fresh random IV per value, authenticated (tampering is detected).
 *
 *   stored value:  "enc:v1:<iv>:<authTag>:<ciphertext>"   (all base64url)
 *
 * Key: SECRETS_ENCRYPTION_KEY — 32 random bytes as 64 hex chars or base64 (generate: `openssl rand -hex 32`).
 *      Any other string is accepted and stretched with scrypt, but a random 32-byte key is strongly preferred.
 *      Optional SECRETS_ENCRYPTION_KEY_PREV lets you rotate: new writes use the new key, old values still open.
 *
 * Behaviour you can rely on:
 *   - encrypt() NEVER falls back to plaintext. No key configured -> it throws, so a secret is never saved unprotected.
 *   - decrypt() passes plain (legacy, not-yet-migrated) strings straight through, so the rollout is safe:
 *     deploy, run scripts/encrypt-existing-secrets.js, done.
 *   - mask() gives the UI something safe to show ("••••a1b2") — the real value never goes back to a client.
 */
'use strict';

const crypto = require('crypto');
const PREFIX = 'enc:v1:';
const SALT = 'astric-secretbox-v1';

function keyFrom(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try { const b = Buffer.from(raw, 'base64'); if (b.length === 32 && b.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) return b; } catch (_) { /* fall through */ }
  return crypto.scryptSync(raw, SALT, 32);
}
const keys = () => [keyFrom(process.env.SECRETS_ENCRYPTION_KEY), keyFrom(process.env.SECRETS_ENCRYPTION_KEY_PREV)].filter(Boolean);

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);
const b64 = (buf) => buf.toString('base64url');

function encrypt(plain) {
  if (plain == null || plain === '') return '';
  if (isEncrypted(plain)) return plain;                        // already protected: never double-encrypt
  const [key] = keys();
  if (!key) throw new Error('SECRETS_ENCRYPTION_KEY is not set on the server, so secrets cannot be stored safely.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${PREFIX}${b64(iv)}:${b64(c.getAuthTag())}:${b64(ct)}`;
}

function decrypt(value) {
  if (!isEncrypted(value)) return value == null ? '' : value;  // legacy plaintext
  const [, , iv, tag, ct] = value.split(':');
  const list = keys();
  if (!list.length) throw new Error('SECRETS_ENCRYPTION_KEY is not set on the server, so stored secrets cannot be read.');
  for (const key of list) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    } catch (_) { /* try the previous key */ }
  }
  throw new Error('A stored secret could not be decrypted (wrong or rotated key).');
}

/** "••••a1b2" — enough to recognise a key, useless to steal. Short values show only dots. */
function mask(plainOrEncrypted) {
  let v = '';
  try { v = decrypt(plainOrEncrypted); } catch (_) { return '••••••••'; }
  v = String(v || '');
  if (!v) return '';
  return v.length <= 8 ? '••••••••' : `••••${v.slice(-4)}`;
}

const encryptFields = (obj, fields) => { const o = { ...(obj || {}) }; for (const f of fields) if (o[f] != null && o[f] !== '') o[f] = encrypt(o[f]); return o; };
const decryptFields = (obj, fields) => { const o = { ...(obj || {}) }; for (const f of fields) if (o[f] != null) o[f] = decrypt(o[f]); return o; };

module.exports = { encrypt, decrypt, isEncrypted, mask, encryptFields, decryptFields, PREFIX };
