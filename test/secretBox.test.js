const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

test('round-trips, never stores plaintext, and is different every time', () => {
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const sb = require('../services/secretBox');
  const a = sb.encrypt('sk_live_ABCDEF123456'), b = sb.encrypt('sk_live_ABCDEF123456');
  assert.ok(a.startsWith('enc:v1:')); assert.ok(!a.includes('ABCDEF')); assert.notStrictEqual(a, b);
  assert.strictEqual(sb.decrypt(a), 'sk_live_ABCDEF123456');
  assert.strictEqual(sb.encrypt(a), a);                          // never double-encrypts
  assert.strictEqual(sb.decrypt('legacy-plain'), 'legacy-plain');   // not yet migrated values keep working
  assert.strictEqual(sb.mask(a), '••••3456'); assert.strictEqual(sb.mask(sb.encrypt('short')), '••••••••');
});
test('a tampered value is rejected, not silently read', () => {
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const sb = require('../services/secretBox');
  const e = sb.encrypt('secret'); const parts = e.split(':'); parts[4] = Buffer.from('tampered!!').toString('base64url');
  assert.throws(() => sb.decrypt(parts.join(':')), /could not be decrypted/);
});
test('with no key it refuses to encrypt (never falls back to plaintext)', () => {
  delete process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY_PREV;
  const sb = require('../services/secretBox');
  assert.throws(() => sb.encrypt('x'), /SECRETS_ENCRYPTION_KEY is not set/);
});
test('key rotation: values written with the old key still open', () => {
  const oldK = crypto.randomBytes(32).toString('hex'), newK = crypto.randomBytes(32).toString('hex');
  process.env.SECRETS_ENCRYPTION_KEY = oldK; delete process.env.SECRETS_ENCRYPTION_KEY_PREV;
  const sb = require('../services/secretBox');
  const e = sb.encrypt('rotate me');
  process.env.SECRETS_ENCRYPTION_KEY = newK; process.env.SECRETS_ENCRYPTION_KEY_PREV = oldK;
  assert.strictEqual(sb.decrypt(e), 'rotate me');
  assert.ok(sb.decrypt(sb.encrypt('new')) === 'new');
});
