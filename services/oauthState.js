/**
 * services/oauthState.js
 *
 * The `state` param on an OAuth authorize URL is the only thing carrying
 * "which of our users is this?" through the redirect to HubSpot/Salesforce/
 * QuickBooks and back. It must be signed so an attacker can't hand-craft a
 * callback URL with someone ELSE's uid and get a stranger's OAuth tokens
 * attached to their own account.
 *
 * Signed with ADMIN_API_KEY (already a secret you have) via HMAC-SHA256.
 * For extra hygiene you can set a dedicated OAUTH_STATE_SECRET env var
 * instead — falls back to ADMIN_API_KEY if that's not set.
 */
'use strict';

const crypto = require('crypto');
const { ADMIN_API_KEY } = require('../config/env');

const SECRET = process.env.OAUTH_STATE_SECRET || ADMIN_API_KEY || 'insecure-fallback-key-set-ADMIN_API_KEY';

function signState(payload) {
  const json = JSON.stringify({ ...payload, ts: Date.now() });
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyState(state, maxAgeMs = 15 * 60 * 1000) {
  const [b64, sig] = String(state || '').split('.');
  if (!b64 || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
  } catch (_) {
    return null;
  }
  if (!payload.ts || Date.now() - payload.ts > maxAgeMs) return null;
  return payload;
}

module.exports = { signState, verifyState };
