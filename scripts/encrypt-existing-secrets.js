#!/usr/bin/env node
/**
 * One-time migration: encrypts every API key / token that is still stored as plain text in Firestore.
 *
 *   SECRETS_ENCRYPTION_KEY=<64 hex chars> node scripts/encrypt-existing-secrets.js            # DRY RUN: only reports
 *   SECRETS_ENCRYPTION_KEY=<64 hex chars> node scripts/encrypt-existing-secrets.js --apply    # really writes
 *
 * Needs the same FIREBASE_* variables as the server. Safe to run more than once: values that are already
 * encrypted (enc:v1:…) are skipped. Take a Firestore export/backup first.
 *
 * What it covers
 *   users/*​/integrations/*                    credentials.{every field}   (keys typed into the Integrations screen)
 *   users/*​/connectedChannels/*               credentials.{accessToken,botToken,appSecret,pageToken}  (messaging)
 *                                              accessToken / refreshToken / clientSecret     (HubSpot, Salesforce, QuickBooks, Google)
 *   users/*​/lead_capture_secrets/config       fbPageToken, fbAppSecret
 */
'use strict';
const { db } = require('../config/firebase');
const { encrypt, isEncrypted } = require('../services/secretBox');

const APPLY = process.argv.includes('--apply');
const CH_CRED = ['accessToken', 'botToken', 'appSecret', 'pageToken', 'apiKey', 'authToken'];
const CH_TOP = ['accessToken', 'refreshToken', 'clientSecret'];
const stats = { scanned: 0, changed: 0, fields: 0 };

function encryptMap(obj, keys) {
  const out = {}; let n = 0;
  for (const k of keys) { if (typeof obj[k] === 'string' && obj[k] && !isEncrypted(obj[k])) { out[k] = encrypt(obj[k]); n++; } }
  return { out, n };
}

async function run() {
  if (!process.env.SECRETS_ENCRYPTION_KEY) { console.error('Set SECRETS_ENCRYPTION_KEY first.'); process.exit(1); }
  console.log(APPLY ? 'APPLY mode: writing changes.' : 'DRY RUN: nothing will be written. Add --apply to write.');

  for (const [group, handler] of [
    ['integrations', (d) => { const c = d.credentials || {}; const { out, n } = encryptMap(c, Object.keys(c)); return n ? { update: { credentials: { ...c, ...out } }, n } : null; }],
    ['connectedChannels', (d) => {
      const a = encryptMap(d, CH_TOP), b = encryptMap(d.credentials || {}, CH_CRED);
      const n = a.n + b.n; if (!n) return null;
      return { update: { ...a.out, ...(b.n ? { credentials: { ...d.credentials, ...b.out } } : {}) }, n };
    }],
    ['lead_capture_secrets', (d) => { const a = encryptMap(d, ['fbPageToken', 'fbAppSecret']); return a.n ? { update: a.out, n: a.n } : null; }],
  ]) {
    const snap = await db.collectionGroup(group).get();
    for (const doc of snap.docs) {
      stats.scanned++;
      const r = handler(doc.data());
      if (!r) continue;
      stats.changed++; stats.fields += r.n;
      console.log(`${APPLY ? 'encrypted' : 'would encrypt'} ${r.n} field(s) in ${doc.ref.path}`);
      if (APPLY) await doc.ref.set({ ...r.update, secretsEncrypted: true }, { merge: true });
    }
  }
  console.log(`Done. Documents scanned: ${stats.scanned}, changed: ${stats.changed}, fields: ${stats.fields}.`);
}
run().catch((e) => { console.error(e); process.exit(1); });
