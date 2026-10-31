/**
 * routes/secrets.js — the only way the app saves or reads API keys / tokens the user types in.
 *
 *   POST /secrets/store   { scope: 'integration'|'channel', id, credentials:{k:v}, meta?:{} }
 *       Encrypts every value (AES-256-GCM, services/secretBox) and stores it in Firestore. Nothing readable is stored.
 *   POST /secrets/reveal  { scope, id? }
 *       Returns the plaintext to the signed-in member of that organisation, for the moment it is needed (kept in
 *       app memory only). Without `id` it returns every credential set of that scope.
 *   POST /secrets/delete  { scope, id }
 *
 * Firestore rules block the app from writing credentials itself (see firestore.rules), so a client can never
 * put a plaintext key back.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { encrypt, decrypt, mask } = require('../services/secretBox');

const SCOPES = {
  integration: { col: 'integrations', field: 'credentials' },
  channel: { col: 'connectedChannels', field: 'credentials' },
};
const ID_RE = /^[a-zA-Z0-9_-]{2,40}$/;

async function orgOf(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) { const e = new Error('User not found.'); e.status = 404; throw e; }
  const u = snap.data();
  return (u.role === 'employee' && u.adminId) ? u.adminId : uid;
}
const handler = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('[secrets]', e.message);
    res.status(500).json({ error: /SECRETS_ENCRYPTION_KEY/.test(e.message) ? 'Secure storage is not set up on the server yet.' : 'Something went wrong. Please try again.' });
  }
};
function scopeOf(body) {
  const sc = SCOPES[(body || {}).scope];
  if (!sc) { const e = new Error('Unknown scope.'); e.status = 400; throw e; }
  const id = String((body || {}).id || '');
  return { sc, id };
}

router.post('/secrets/store', requireAuth, rateLimit({ windowMs: 60_000, max: 30, keyFn: (r) => `sec:${r.uid}` }), handler(async (req, res) => {
  const { sc, id } = scopeOf(req.body);
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id.' });
  const creds = (req.body || {}).credentials;
  if (!creds || typeof creds !== 'object' || Array.isArray(creds)) return res.status(400).json({ error: 'credentials must be an object.' });
  const entries = Object.entries(creds);
  if (!entries.length || entries.length > 20) return res.status(400).json({ error: 'Between 1 and 20 credential fields are allowed.' });

  const stored = {}, masked = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) return res.status(400).json({ error: `Invalid field name "${k}".` });
    const val = String(v == null ? '' : v);
    if (val.length > 4000) return res.status(400).json({ error: `"${k}" is too long.` });
    stored[k] = val ? encrypt(val) : '';
    masked[k] = val ? mask(stored[k]) : '';
  }
  const org = await orgOf(req.uid);
  const extra = {};
  const meta = (req.body || {}).meta;
  if (meta && typeof meta === 'object') {
    for (const k of ['connected', 'isActive']) if (typeof meta[k] === 'boolean') extra[k] = meta[k];
    if (meta.type) extra.type = String(meta.type).slice(0, 30);
  }
  // The app reads these docs itself, so each scope keeps the date format its model expects:
  // integrations -> Firestore Timestamp, messaging channels -> ISO string (+ type / isActive).
  const isChannel = req.body.scope === 'channel';
  await db.collection('users').doc(org).collection(sc.col).doc(id).set({
    ...(isChannel ? { type: id, isActive: true } : { connected: true }),
    ...extra,
    [sc.field]: stored, maskedCredentials: masked,
    connectedAt: isChannel ? new Date().toISOString() : admin.firestore.Timestamp.now(),
    secretsEncrypted: true,
  }, { merge: true });
  res.json({ ok: true, masked });
}));

router.post('/secrets/reveal', requireAuth, rateLimit({ windowMs: 60_000, max: 60, keyFn: (r) => `secr:${r.uid}` }), handler(async (req, res) => {
  const { sc, id } = scopeOf(req.body);
  const org = await orgOf(req.uid);
  const col = db.collection('users').doc(org).collection(sc.col);
  const open = (data) => {
    const out = {};
    for (const [k, v] of Object.entries((data && data[sc.field]) || {})) { try { out[k] = decrypt(v); } catch (_) { out[k] = ''; } }
    return out;
  };
  if (id) {
    const snap = await col.doc(id).get();
    return res.json({ credentials: snap.exists ? open(snap.data()) : {} });
  }
  const all = await col.get();
  const items = {};
  all.docs.forEach((d) => { if (d.data()[sc.field]) items[d.id] = open(d.data()); });
  res.json({ items });
}));

router.post('/secrets/delete', requireAuth, handler(async (req, res) => {
  const { sc, id } = scopeOf(req.body);
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid id.' });
  const org = await orgOf(req.uid);
  await db.collection('users').doc(org).collection(sc.col).doc(id).set(
    { [sc.field]: {}, maskedCredentials: {}, connected: false }, { merge: true });
  res.json({ ok: true });
}));

module.exports = router;
module.exports._orgOf = orgOf;
