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

// ── Per-app identity ────────────────────────────────────────────────────────
// appKey = first 12 hex chars of SHA-256(<paying account uid>:<project id>).
// It is STABLE for a project, so every rebuild of the same app gets the same
// Android applicationId AND the same signing key — which is exactly what lets
// a phone update the app in place (keeping its saved data) instead of forcing
// an uninstall. Different projects / different companies always get different
// keys, so no two customers ever share a signing identity.
// applicationId = com.astric.a<appKey> (each segment must start with a letter,
// hence the leading "a").
function makeBuildId() { return crypto.randomBytes(4).toString('hex'); }
function makeAppKey(creditUid, projectId) {
  return crypto.createHash('sha256').update(`${creditUid}:${projectId}`).digest('hex').slice(0, 12);
}
// Fallback for older app versions that don't send a projectId: a throw-away
// identity for just this build (cannot be updated in place — same as before).
function makeEphemeralAppKey(buildId) {
  return crypto.createHash('sha256').update(`ephemeral:${buildId}`).digest('hex').slice(0, 12);
}
function makeAppId(appKey) { return `com.astric.a${appKey}`; }
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

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

module.exports = { sanitizeAppName, makeBuildId, makeAppKey, makeEphemeralAppKey, makeAppId, PROJECT_ID_RE, makeSignedParams, verifySignedParams };
