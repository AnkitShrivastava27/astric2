/**
 * routes/google.js — Google Contacts / Calendar / Drive for the app.
 *
 *  Connect      GET  /integrations/google/authorize-url?service=contacts|calendar|drive
 *               GET  /integrations/google/callback           (Google redirects here)
 *               GET  /integrations/google/status
 *               POST /integrations/google/disconnect
 *  Contacts     GET  /integrations/google/contacts/preview   what WOULD be imported (nothing is saved)
 *               POST /integrations/google/contacts/import    import only the ones the person ticked
 *               GET  /integrations/google/contacts/imported  what has been imported so far
 *  Calendar     GET  /integrations/google/calendar/events?from=&to=
 *               POST /integrations/google/calendar/events    create an event in Google Calendar
 *  Drive        GET  /integrations/google/drive/browse?parent=   pick folders (folders only)
 *               GET  /integrations/google/drive/folders         the linked folders
 *               POST /integrations/google/drive/folders         link a folder   (many allowed)
 *               POST /integrations/google/drive/folders/remove  unlink          (never deletes in Drive)
 *               GET  /integrations/google/drive/files?folderId= files inside a linked folder (read-only, not copied)
 */
'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { signState, verifyState } = require('../services/oauthState');
const google = require('../services/google');
const { ingestMany, normalizePhone } = require('../services/leadIngest');
const env = require('../config/env');

const SCHEME = env.APP_DEEPLINK_SCHEME || 'biznexus';
const MAX_LINKED_FOLDERS = 25;
const MAX_IMPORT = 500;

const deeplink = (status, service, message) => `${SCHEME}://oauth/google?status=${status}&service=${encodeURIComponent(service || '')}${message ? `&message=${encodeURIComponent(message)}` : ''}`;

const orgOf = async (uid) => (await google.orgOf(uid)).org;
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof google.GoogleError || e.status) return res.status(e.status || 502).json({ error: e.message, ...(e.reconnect ? { reconnect: true } : {}), ...(e.setup ? { setup: true } : {}) });
    console.error('[google]', e.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 150);
const limit = (n, k) => rateLimit({ windowMs: 60_000, max: n, keyFn: (r) => `g-${k}:${r.uid}` });

// ── Connect ──────────────────────────────────────────────────────────────────
router.get('/integrations/google/authorize-url', requireAuth, wrap(async (req, res) => {
  const service = String(req.query.service || '');
  const st = await google.channelRef(req.uid).get();
  const granted = st.exists ? (st.data().scopes || []) : [];
  const state = signState({ uid: req.uid, provider: 'google', service });
  res.json({ url: await google.authUrl({ uid: req.uid, service, state, grantedScopes: granted }) });
}));

router.get('/integrations/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const p = verifyState(state);
  if (!p || p.provider !== 'google') return res.redirect(deeplink('error', '', 'Invalid or expired connection request.'));
  if (error || !code) return res.redirect(deeplink('error', p.service, error === 'access_denied' ? 'You cancelled the Google connection.' : 'Google did not return a code.'));
  try {
    await google.completeConnect({ uid: p.uid, service: p.service, code });
    return res.redirect(deeplink('success', p.service));
  } catch (e) {
    console.error('[google/callback]', e.message);
    return res.redirect(deeplink('error', p.service, e instanceof google.GoogleError ? e.message : 'Could not complete the Google connection.'));
  }
});

router.get('/integrations/google/status', requireAuth, wrap(async (req, res) => {
  res.json(await google.getStatus(req.uid));
}));

// ── The company's own Google app (Client ID + Secret): admin sets it once ───────────────────────────────
router.get('/integrations/google/app', requireAuth, wrap(async (req, res) => { res.json(await google.getApp(req.uid)); }));
router.post('/integrations/google/app', requireAuth, limit(10, 'app'), wrap(async (req, res) => {
  await google.saveApp(req.uid, (req.body || {}).clientId, (req.body || {}).clientSecret);
  res.json({ ok: true, ...(await google.getApp(req.uid)) });
}));
router.post('/integrations/google/app/remove', requireAuth, wrap(async (req, res) => {
  await google.removeApp(req.uid);
  res.json({ ok: true });
}));

router.post('/integrations/google/disconnect', requireAuth, wrap(async (req, res) => {
  await google.disconnect(req.uid);
  res.json({ ok: true });
}));

// ── Contacts: preview → choose → import ──────────────────────────────────────
async function markExisting(org, contacts) {
  const orgRef = db.collection('users').doc(org);
  return Promise.all(contacts.map(async (c) => {
    let existsAs = '';
    const pn = c.phone ? normalizePhone(c.phone) : '';
    if (pn && pn.length >= 8) {
      const idx = await orgRef.collection('lead_phone_index').doc(pn).get();
      if (idx.exists) existsAs = 'lead';
    }
    if (!existsAs && c.email) {
      const l = await orgRef.collection('leads').where('email', '==', c.email).limit(1).get();
      if (!l.empty) existsAs = 'lead';
      else { const cu = await orgRef.collection('customers').where('email', '==', c.email).limit(1).get(); if (!cu.empty) existsAs = 'customer'; }
    }
    const imp = await orgRef.collection('google_contacts_imported').doc(safeId(c.id)).get();
    return { ...c, existsAs, imported: imp.exists };
  }));
}

router.get('/integrations/google/contacts/preview', requireAuth, limit(30, 'prev'), wrap(async (req, res) => {
  const org = await orgOf(req.uid);
  const page = await google.listContacts(req.uid, { pageToken: String(req.query.pageToken || ''), pageSize: req.query.pageSize });
  res.json({ ...page, contacts: await markExisting(org, page.contacts) });     // NOTHING is written here
}));

router.post('/integrations/google/contacts/import', requireAuth, limit(6, 'imp'), wrap(async (req, res) => {
  const org = await orgOf(req.uid);
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter((x) => /^people\/[A-Za-z0-9_-]+$/.test(x)))];
  if (!ids.length) return res.status(400).json({ error: 'Tick at least one contact to import.' });
  if (ids.length > MAX_IMPORT) return res.status(400).json({ error: `Import up to ${MAX_IMPORT} contacts at a time.` });
  const target = b.target === 'customers' ? 'customers' : 'leads';

  const contacts = await google.getContacts(req.uid, ids);
  if (!contacts.length) return res.status(404).json({ error: 'Those contacts were not found in Google any more.' });
  const orgRef = db.collection('users').doc(org);
  const rows = [];                                     // what we report back per contact
  let created = 0, duplicates = 0, invalid = 0, batchName = '';

  if (target === 'leads') {
    const { prepareImport, finishImport } = require('./leadCapture')._import;
    const prep = await prepareImport(org, req.uid, { productId: b.productId, batchName: b.batchName });
    const records = contacts.map((c) => ({ name: c.name, phone: c.phone, email: c.email, company: c.company, message: c.jobTitle }));
    const result = await ingestMany(org, records, { createdBy: req.uid, defaultSource: 'other', sourceLabel: 'Google Contacts', ...prep.opts });
    const fin = await finishImport(org, prep, result);
    created = result.created; duplicates = result.duplicates; invalid = result.invalid; batchName = fin.batchName || '';
  } else {
    for (const c of contacts) {
      if (!c.name && !c.phone && !c.email) { invalid++; continue; }
      let dup = false;
      if (c.email) dup = !(await orgRef.collection('customers').where('email', '==', c.email).limit(1).get()).empty;
      if (!dup && c.phone) dup = !(await orgRef.collection('customers').where('phone', '==', c.phone).limit(1).get()).empty;
      if (dup) { duplicates++; continue; }
      await orgRef.collection('customers').doc().set({
        name: c.name || c.email || c.phone, email: c.email, phone: c.phone, notes: [c.company, c.jobTitle].filter(Boolean).join(' · '),
        activities: [], sentEmails: [], customFields: { source: 'Google Contacts' }, createdAt: admin.firestore.FieldValue.serverTimestamp(), createdByUid: req.uid,
      });
      created++;
    }
  }
  // Remember what came across so the app can show it (and mark it "already imported" next time).
  const importId = orgRef.collection('google_imports').doc().id;
  const now = admin.firestore.Timestamp.now();
  await Promise.all(contacts.map((c) => orgRef.collection('google_contacts_imported').doc(safeId(c.id)).set({
    id: c.id, name: c.name, phone: c.phone, email: c.email, company: c.company, birthday: c.birthday || null,
    target, importId, batchName, importedBy: req.uid, importedAt: now,
  })));
  await orgRef.collection('google_imports').doc(importId).set({ target, requested: ids.length, created, duplicates, invalid, batchName, importedBy: req.uid, importedAt: now });
  res.json({ ok: true, importId, target, requested: ids.length, created, duplicates, invalid, batchName });
}));

router.get('/integrations/google/contacts/imported', requireAuth, wrap(async (req, res) => {
  const org = await orgOf(req.uid);
  const snap = await db.collection('users').doc(org).collection('google_contacts_imported').orderBy('importedAt', 'desc').limit(300).get();
  const toIso = (t) => (t && t.toDate ? t.toDate().toISOString() : '');
  res.json({ contacts: snap.docs.map((d) => { const x = d.data(); return { id: x.id, name: x.name, phone: x.phone, email: x.email, company: x.company, birthday: x.birthday || null, target: x.target, batchName: x.batchName || '', importedAt: toIso(x.importedAt) }; }) });
}));

// ── Calendar ─────────────────────────────────────────────────────────────────
const validIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s));
router.get('/integrations/google/calendar/events', requireAuth, limit(60, 'cal'), wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!validIso(from) || !validIso(to)) return res.status(400).json({ error: 'from and to must be ISO dates.' });
  if (Date.parse(to) - Date.parse(from) > 93 * 86400000) return res.status(400).json({ error: 'Ask for at most 3 months at a time.' });
  res.json({ events: await google.listEvents(req.uid, { from: new Date(from).toISOString(), to: new Date(to).toISOString() }) });
}));
router.post('/integrations/google/calendar/events', requireAuth, limit(30, 'calw'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.title || '').trim() || !validIso(b.start) || !validIso(b.end)) return res.status(400).json({ error: 'title, start and end are required.' });
  if (Date.parse(b.end) <= Date.parse(b.start)) return res.status(400).json({ error: 'The event must end after it starts.' });
  res.json({ event: await google.createEvent(req.uid, { title: String(b.title).slice(0, 200), start: b.start, end: b.end, description: String(b.description || '').slice(0, 2000), location: String(b.location || '').slice(0, 300) }) });
}));

// ── Drive: link folders, browse in place ─────────────────────────────────────
const foldersCol = (uid) => db.collection('users').doc(uid).collection('google_drive_folders');
async function linked(uid) { const s = await foldersCol(uid).get(); return s.docs.map((d) => ({ id: d.id, ...d.data() })); }

router.get('/integrations/google/drive/browse', requireAuth, limit(60, 'drb'), wrap(async (req, res) => {
  const parent = String(req.query.parent || 'root');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(parent)) return res.status(400).json({ error: 'Invalid folder.' });
  const r = await google.listDrive(req.uid, { parent, foldersOnly: true, pageToken: String(req.query.pageToken || '') });
  const l = new Set((await linked(req.uid)).map((x) => x.id));
  res.json({ folders: r.files.map((f) => ({ ...f, linked: l.has(f.id) })), nextPageToken: r.nextPageToken });
}));
router.get('/integrations/google/drive/folders', requireAuth, wrap(async (req, res) => {
  res.json({ folders: (await linked(req.uid)).map((f) => ({ id: f.id, name: f.name, link: f.link || '' })), max: MAX_LINKED_FOLDERS });
}));
router.post('/integrations/google/drive/folders', requireAuth, limit(30, 'drl'), wrap(async (req, res) => {
  const id = String((req.body || {}).folderId || '');
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(id)) return res.status(400).json({ error: 'Invalid folder.' });
  const cur = await linked(req.uid);
  if (cur.some((f) => f.id === id)) return res.json({ ok: true, already: true });
  if (cur.length >= MAX_LINKED_FOLDERS) return res.status(400).json({ error: `You can link up to ${MAX_LINKED_FOLDERS} folders. Remove one first.` });
  const f = await google.getDriveFile(req.uid, id);                 // proves it exists and that this person can open it
  if (!f.isFolder) return res.status(400).json({ error: 'That is a file, not a folder.' });
  if (f.trashed) return res.status(400).json({ error: 'That folder is in the Drive trash.' });
  await foldersCol(req.uid).doc(id).set({ name: f.name, link: f.link, addedAt: admin.firestore.Timestamp.now() });
  res.json({ ok: true, folder: { id, name: f.name, link: f.link } });
}));
router.post('/integrations/google/drive/folders/remove', requireAuth, wrap(async (req, res) => {
  const id = String((req.body || {}).folderId || '');
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(id)) return res.status(400).json({ error: 'Invalid folder.' });
  await foldersCol(req.uid).doc(id).delete();                       // only the link inside Astric; Drive is untouched
  res.json({ ok: true });
}));
router.get('/integrations/google/drive/files', requireAuth, limit(60, 'drf'), wrap(async (req, res) => {
  const folderId = String(req.query.folderId || '');
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(folderId)) return res.status(400).json({ error: 'Invalid folder.' });
  const ids = new Set((await linked(req.uid)).map((f) => f.id));
  if (!ids.size) return res.status(403).json({ error: 'Link a folder first.' });
  // Only folders you linked (or folders inside them) can be opened: this is not a way to browse the whole Drive.
  if (!(await google.isInsideLinked(req.uid, folderId, ids))) return res.status(403).json({ error: 'That folder is not one of your linked folders.' });
  const r = await google.listDrive(req.uid, { parent: folderId, pageToken: String(req.query.pageToken || '') });
  res.json(r);
}));

module.exports = router;
