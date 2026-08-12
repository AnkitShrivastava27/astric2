/**
 * middleware/adminAuth.js
 *
 * ONE consistent admin-auth check, used by every admin route
 * (/update-pricing, /update-ai-limits, /admin/ai/limits,
 * /admin/referral/config). The live server had two different patterns for
 * this (Bearer-only vs Bearer-or-x-admin-key) and one admin route
 * (/admin/referral/config) with no check at all — consolidated here so that
 * can't happen again.
 *
 * Accepts the key via `Authorization: Bearer <key>` OR `x-admin-key: <key>`
 * for backward compatibility with any existing admin-panel calls.
 */
'use strict';

const crypto = require('crypto');
const { ADMIN_API_KEY } = require('../config/env');

function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(500).json({ error: 'ADMIN_API_KEY not configured on server.' });
  }
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = bearer || req.headers['x-admin-key'] || '';

  if (!token || !safeEquals(token, ADMIN_API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

module.exports = { requireAdmin };
