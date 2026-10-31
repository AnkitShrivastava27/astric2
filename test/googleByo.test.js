const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { make } = require('./fakeFirestore');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_WEB_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;   // NO server-wide Google app
process.env.SERVER_BASE_URL = 'https://srv.test';
const fake = make();
stub('../config/firebase', { db: fake.db, admin: fake.admin });
let uid = 'boss';
stub('../middleware/auth', { requireAuth: (req, _res, next) => { req.uid = uid; next(); } });
stub('../middleware/rateLimit', { rateLimit: () => (_q, _s, n) => n() });
const express = require('express');
const google = require('../services/google');
const router = require('../routes/google');
const { signState } = require('../services/oauthState');

const GOOD_ID = '1234567890-abcdefghij.apps.googleusercontent.com';
const GOOD_SECRET = 'GOCSPX-supersecretvalue123';
const posted = [];
google.deps.http = {
  post: async (url, body) => {
    posted.push({ url, body: String(body) });
    const p = new URLSearchParams(String(body));
    if (url.includes('/token')) {
      if (p.get('client_secret') !== GOOD_SECRET || p.get('client_id') !== GOOD_ID) { const e = new Error('x'); e.response = { status: 401, data: { error: 'invalid_client' } }; throw e; }
      if (p.get('grant_type') === 'authorization_code' && p.get('code') === 'astric-check') { const e = new Error('x'); e.response = { status: 400, data: { error: 'invalid_grant' } }; throw e; }
      return { data: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/contacts.readonly' } };
    }
    return { data: {} };
  },
  get: async () => ({ data: { email: 'me@acme.com' } }),
  request: async () => ({ data: { connections: [] } }),
};

let server, base;
test.before(async () => {
  await fake.db.collection('users').doc('boss').set({ role: 'admin' });
  await fake.db.collection('users').doc('emp').set({ role: 'employee', adminId: 'boss' });
  await fake.db.collection('users').doc('otherboss').set({ role: 'admin' });
  const app = express(); app.use(express.json()); app.use(router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }); return { status: r.status, json: await r.json().catch(() => ({})), loc: r.headers.get('location') }; };

test('before the company sets its app: connecting says exactly what to do, and flags it as a setup problem', async () => {
  const st = await api('GET', '/integrations/google/status'); assert.strictEqual(st.json.configured, false); assert.strictEqual(st.json.isAdmin, true);
  const r = await api('GET', '/integrations/google/authorize-url?service=contacts');
  assert.strictEqual(r.status, 400); assert.strictEqual(r.json.setup, true); assert.match(r.json.error, /has not set up its Google app/);
});
test('an employee cannot set or remove the company credentials', async () => {
  uid = 'emp';
  assert.strictEqual((await api('POST', '/integrations/google/app', { clientId: GOOD_ID, clientSecret: GOOD_SECRET })).status, 403);
  assert.strictEqual((await api('POST', '/integrations/google/app/remove')).status, 403);
  assert.strictEqual((await api('GET', '/integrations/google/app')).json.canEdit, false);
  uid = 'boss';
});
test('bad input is rejected before Google is even asked; wrong credentials are rejected by Google and NOT saved', async () => {
  assert.strictEqual((await api('POST', '/integrations/google/app', { clientId: 'not-an-id', clientSecret: GOOD_SECRET })).status, 400);
  assert.strictEqual((await api('POST', '/integrations/google/app', { clientId: GOOD_ID, clientSecret: 'short' })).status, 400);
  const bad = await api('POST', '/integrations/google/app', { clientId: GOOD_ID, clientSecret: 'GOCSPX-the-wrong-secret-xx' });
  assert.strictEqual(bad.status, 400); assert.match(bad.json.error, /does not accept/);
  assert.strictEqual((await fake.db.collection('users').doc('boss').collection('google_app').doc('main').get()).exists, false);
});
test('valid credentials are saved ENCRYPTED and the secret is never returned', async () => {
  const r = await api('POST', '/integrations/google/app', { clientId: GOOD_ID, clientSecret: GOOD_SECRET });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.configured, true); assert.strictEqual(r.json.clientId, GOOD_ID);
  assert.match(r.json.secretMasked, /^••••/); assert.ok(!JSON.stringify(r.json).includes('supersecret'));
  assert.match(r.json.redirectUri, /https:\/\/srv\.test\/integrations\/google\/callback/);
  const raw = (await fake.db.collection('users').doc('boss').collection('google_app').doc('main').get()).data();
  assert.ok(raw.clientSecret.startsWith('enc:v1:')); assert.ok(!JSON.stringify(raw).includes('supersecret'));
});
test('an EMPLOYEE connects with the company app: the Google sign-in URL uses the company client id', async () => {
  uid = 'emp';
  const r = await api('GET', '/integrations/google/authorize-url?service=contacts');
  assert.strictEqual(r.status, 200); assert.strictEqual(new URL(r.json.url).searchParams.get('client_id'), GOOD_ID);
  const state = signState({ uid: 'emp', provider: 'google', service: 'contacts' });
  posted.length = 0;
  const cb = await api('GET', `/integrations/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.match(cb.loc, /status=success/);
  assert.strictEqual(new URLSearchParams(posted[0].body).get('client_secret'), GOOD_SECRET);   // the company's secret did the exchange
  assert.strictEqual((await api('GET', '/integrations/google/status')).json.connected, true);
  uid = 'boss';
});
test("another company's admin does not get this company's credentials", async () => {
  uid = 'otherboss';
  const a = await api('GET', '/integrations/google/app');
  assert.strictEqual(a.json.configured, false); assert.strictEqual(a.json.clientId, '');
  assert.strictEqual((await api('GET', '/integrations/google/authorize-url?service=contacts')).status, 400);
  uid = 'boss';
});
test('removing the credentials stops new connections', async () => {
  assert.strictEqual((await api('POST', '/integrations/google/app/remove')).json.ok, true);
  uid = 'emp';
  assert.strictEqual((await api('GET', '/integrations/google/authorize-url?service=drive')).json.setup, true);
  uid = 'boss';
});
