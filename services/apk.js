'use strict';
// Pure helpers for the App Studio → .apk pipeline (no Firebase/network, so they
// are unit-testable). See routes/app-apk.js for how they're used.
const crypto = require('crypto');

// App label shown under the icon / in the app list. Kept to a conservative
// character set because it is passed to Gradle and an XML resource.
function sanitizeAppName(raw) {
  const cleaned = String(raw || '')
    .normalize('NFKD').replace(/[^\x20-\x7E]/g, '')   // ASCII only
    .replace(/[^A-Za-z0-9 \-]/g, '')                  // letters, digits, space, dash
    .replace(/\s+/g, ' ').trim().slice(0, 30);
  return cleaned || 'My App';
}

// Unique, always-valid Android applicationId: com.astric.a<8 hex chars>
// (each segment must start with a letter — hence the leading "a").
function makeBuildId() { return crypto.randomBytes(4).toString('hex'); }
function makeAppId(buildId) { return `com.astric.a${buildId}`; }

// ── Signed, expiring download links ────────────────────────────────────────
// The browser/OS downloader can't send an Authorization header, so the app
// asks the (authenticated) status endpoint for a link that carries its own
// proof: HMAC(buildId.expiry). It only works for that build and for ~15 min.
function sign(secret, buildId, exp) {
  return crypto.createHmac('sha256', secret).update(`${buildId}.${exp}`).digest('hex');
}
function makeSignedParams(secret, buildId, ttlMs = 15 * 60 * 1000, now = Date.now()) {
  const exp = now + ttlMs;
  return { exp, sig: sign(secret, buildId, exp) };
}
function verifySignedParams(secret, buildId, exp, sig, now = Date.now()) {
  const e = Number(exp);
  if (!secret || !Number.isFinite(e) || e < now || typeof sig !== 'string') return false;
  const good = Buffer.from(sign(secret, buildId, e));
  const given = Buffer.from(sig);
  return good.length === given.length && crypto.timingSafeEqual(good, given);
}

module.exports = { sanitizeAppName, makeBuildId, makeAppId, makeSignedParams, verifySignedParams };
