const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { make } = require('./fakeFirestore');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.GOOGLE_CLIENT_ID = 'cid'; process.env.GOOGLE_CLIENT_SECRET = 'csec'; process.env.SERVER_BASE_URL = 'https://srv.test';
const fake = make();
stub('../config/firebase', { db: fake.db, admin: fake.admin });
stub('../middleware/auth', { requireAuth: (req, _res, next) => { req.uid = 'u1'; next(); } });
stub('../middleware/rateLimit', { rateLimit: () => (_q, _s, n) => n() });

const express = require('express');
const google = require('../services/google');
const router = require('../routes/google');
const { signState } = require('../services/oauthState');

const people = [
  { resourceName: 'people/c1', names: [{ displayName: 'Asha Rao' }], phoneNumbers: [{ value: '+91 98000 00001' }], emailAddresses: [{ value: 'Asha@X.com' }], organizations: [{ name: 'X Ltd', title: 'CTO' }], birthdays: [{ date: { month: 3, day: 9 } }] },
  { resourceName: 'people/c2', names: [{ displayName: 'Bala' }], phoneNumbers: [{ value: '+91 98000 00002' }] },
  { resourceName: 'people/c3', names: [{ displayName: 'Existing Eve' }], phoneNumbers: [{ value: '9800000003' }] },
];
const calls = [];
google.deps.http = {
  post: async (url) => { calls.push(['POST', url]); if (url.includes('/token')) return { data: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/contacts.readonly https://www.googleapis.com/auth/drive.readonly' } }; return { data: {} }; },
  get: async () => ({ data: { email: 'me@gmail.com' } }),
  request: async (cfg) => {
    calls.push([cfg.method, cfg.url, cfg.params && (cfg.params.toString ? cfg.params.toString() : cfg.params)]);
    if (cfg.url.endsWith('/connections')) return { data: { connections: people, totalItems: 3 } };
    if (cfg.url.endsWith('people:batchGet')) { const want = cfg.params.getAll('resourceNames'); return { data: { responses: people.filter((p) => want.includes(p.resourceName)).map((p) => ({ person: p })) } }; }
    if (cfg.url.endsWith('/drive/v3/files')) return { data: { files: [{ id: 'fold1', name: 'Contracts', mimeType: 'application/vnd.google-apps.folder' }, { id: 'doc1', name: 'a.pdf', mimeType: 'application/pdf', size: '10' }] } };
    if (cfg.url.includes('/drive/v3/files/')) { const id = decodeURIComponent(cfg.url.split('/').pop()); return { data: id === 'fold1' ? { id, name: 'Contracts', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] } : id === 'subfo1' ? { id, name: 'Sub', mimeType: 'application/vnd.google-apps.folder', parents: ['fold1'] } : { id, name: 'Elsewhere', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] } }; }
    if (cfg.url.includes('/calendar/v3/')) return { data: { items: [{ id: 'e1', summary: 'Standup', start: { dateTime: '2026-11-02T10:00:00+05:30' }, end: { dateTime: '2026-11-02T10:15:00+05:30' } }, { id: 'e2', status: 'cancelled' }] } };
    throw new Error('unexpected ' + cfg.url);
  },
};

let server, base;
test.before(async () => {
  await fake.db.collection('users').doc('u1').set({ role: 'admin' });
  await fake.db.collection('users').doc('u1').collection('lead_phone_index').doc('919800000003').set({ leadId: 'x' });
  const app = express(); app.use(express.json()); app.use(router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }); return { status: r.status, json: await r.json().catch(() => ({})), loc: r.headers.get('location') }; };

test('not connected: a clear "connect first" answer, not a crash', async () => {
  const r = await api('GET', '/integrations/google/contacts/preview');
  assert.strictEqual(r.status, 400); assert.strictEqual(r.json.reconnect, true);
});
test('authorize-url asks only for the one permission, offline, with a signed state', async () => {
  const r = await api('GET', '/integrations/google/authorize-url?service=contacts');
  const u = new URL(r.json.url);
  assert.match(u.searchParams.get('scope'), /contacts\.readonly/); assert.doesNotMatch(u.searchParams.get('scope'), /drive|calendar/);
  assert.strictEqual(u.searchParams.get('access_type'), 'offline'); assert.ok(u.searchParams.get('state'));
  assert.strictEqual((await api('GET', '/integrations/google/authorize-url?service=gmail')).status, 400);
});
test('callback stores tokens ENCRYPTED and redirects back into the app', async () => {
  const state = signState({ uid: 'u1', provider: 'google', service: 'contacts' });
  const r = await api('GET', `/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.strictEqual(r.status, 302); assert.match(r.loc, /status=success&service=contacts/);
  const raw = (await fake.db.collection('users').doc('u1').collection('google_connection').doc('main').get()).data();
  assert.ok(raw.accessToken.startsWith('enc:v1:') && raw.refreshToken.startsWith('enc:v1:')); assert.ok(!JSON.stringify(raw).includes('"RT"'));
  const st = await api('GET', '/integrations/google/status');
  assert.deepStrictEqual(st.json.services, { contacts: true, drive: true, calendar: false }); assert.strictEqual(st.json.email, 'me@gmail.com');
  assert.match((await api('GET', '/integrations/google/callback?code=abc&state=bogus')).loc, /status=error/);
});
test('PREVIEW shows contacts and flags duplicates but writes NOTHING', async () => {
  const r = await api('GET', '/integrations/google/contacts/preview');
  assert.strictEqual(r.json.contacts.length, 3);
  assert.strictEqual(r.json.contacts[0].email, 'asha@x.com'); assert.deepStrictEqual(r.json.contacts[0].birthday, { month: 3, day: 9, year: null });
  assert.strictEqual(r.json.contacts.find((c) => c.name === 'Existing Eve').existsAs, 'lead');
  assert.strictEqual((await fake.db.collection('users').doc('u1').collection('leads').get()).size, 0);
});
test('IMPORT only brings in the ticked contacts, into a batch, and remembers them', async () => {
  assert.strictEqual((await api('POST', '/integrations/google/contacts/import', { ids: [] })).status, 400);
  assert.strictEqual((await api('POST', '/integrations/google/contacts/import', { ids: ['../etc'] })).status, 400);
  const r = await api('POST', '/integrations/google/contacts/import', { ids: ['people/c1', 'people/c2'], target: 'leads', batchName: 'Google import' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.created, 2); assert.strictEqual(r.json.batchName, 'Google import');
  const leads = (await fake.db.collection('users').doc('u1').collection('leads').get()).docs.map((d) => d.data());
  assert.deepStrictEqual(leads.map((l) => l.name).sort(), ['Asha Rao', 'Bala']); assert.ok(leads.every((l) => l.batchId && l.sourceCustom === 'Google Contacts'));
  const imp = await api('GET', '/integrations/google/contacts/imported');
  assert.deepStrictEqual(imp.json.contacts.map((c) => c.name).sort(), ['Asha Rao', 'Bala']);
  const again = await api('GET', '/integrations/google/contacts/preview');
  assert.strictEqual(again.json.contacts.find((c) => c.name === 'Bala').imported, true);
  const dup = await api('POST', '/integrations/google/contacts/import', { ids: ['people/c1'], target: 'leads' });
  assert.strictEqual(dup.json.created, 0); assert.strictEqual(dup.json.duplicates, 1);
});
test('IMPORT as customers skips ones that already exist', async () => {
  const r1 = await api('POST', '/integrations/google/contacts/import', { ids: ['people/c1'], target: 'customers' });
  assert.strictEqual(r1.json.created, 1);
  const r2 = await api('POST', '/integrations/google/contacts/import', { ids: ['people/c1'], target: 'customers' });
  assert.strictEqual(r2.json.created, 0); assert.strictEqual(r2.json.duplicates, 1);
});
test('Calendar is not connected yet; Drive links several folders and only opens linked ones', async () => {
  assert.strictEqual((await api('GET', '/integrations/google/calendar/events?from=2026-11-01&to=2026-11-30')).status, 400);
  const br = await api('GET', '/integrations/google/drive/browse');
  assert.ok(br.json.folders.length === 2);                            // fake returns both; real Drive filters to folders
  assert.strictEqual((await api('POST', '/integrations/google/drive/folders', { folderId: 'doc1' })).status, 400);  // a file, not a folder
  assert.strictEqual((await api('POST', '/integrations/google/drive/folders', { folderId: 'fold1' })).json.folder.name, 'Contracts');
  assert.strictEqual((await api('POST', '/integrations/google/drive/folders', { folderId: 'other1' })).json.folder.name, 'Elsewhere');
  assert.strictEqual((await api('GET', '/integrations/google/drive/folders')).json.folders.length, 2);
  assert.strictEqual((await api('GET', '/integrations/google/drive/files?folderId=subfo1')).status, 200);    // inside a linked folder
  assert.strictEqual((await api('POST', '/integrations/google/drive/folders/remove', { folderId: 'other1' })).status, 200);
  assert.strictEqual((await api('GET', '/integrations/google/drive/files?folderId=other1')).status, 403);   // no longer linked
});
test('disconnect clears the stored tokens', async () => {
  assert.strictEqual((await api('POST', '/integrations/google/disconnect')).json.ok, true);
  assert.strictEqual((await api('GET', '/integrations/google/status')).json.connected, false);
});
