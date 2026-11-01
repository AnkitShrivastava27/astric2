const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { make } = require('./fakeFirestore');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const fake = make();
stub('../config/firebase', { db: fake.db, admin: fake.admin });
let uid = 'boss';
stub('../middleware/auth', { requireAuth: (req, _res, next) => { req.uid = uid; next(); } });
stub('../middleware/rateLimit', { rateLimit: () => (_q, _s, n) => n() });
const express = require('express');
const secrets = require('../routes/secrets');
const google = require('../routes/google');

let server, base;
test.before(async () => {
  await fake.db.collection('users').doc('boss').set({ role: 'admin' });
  await fake.db.collection('users').doc('emp1').set({ role: 'employee', adminId: 'boss' });
  await fake.db.collection('users').doc('emp2').set({ role: 'employee', adminId: 'boss' });
  const app = express(); app.use(express.json()); app.use(secrets); app.use(google);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

test("personal secrets: each person's Google tokens are theirs alone (not teammates, not even the admin)", async () => {
  uid = 'emp1';
  assert.strictEqual((await api('POST', '/secrets/store', { scope: 'personal', id: 'google_contacts', credentials: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-abcdefghijkl', accessToken: 'ya29.AAA', refreshToken: '1//RRR' } })).status, 200);
  const raw = (await fake.db.collection('users').doc('emp1').collection('integrations_personal').doc('google_contacts').get()).data();
  assert.ok(raw.credentials.refreshToken.startsWith('enc:v1:')); assert.ok(!JSON.stringify(raw).includes('1//RRR'));
  assert.strictEqual((await fake.db.collection('users').doc('boss').collection('integrations_personal').doc('google_contacts').get()).exists, false);   // NOT stored on the company document
  assert.strictEqual((await api('POST', '/secrets/reveal', { scope: 'personal', id: 'google_contacts' })).json.credentials.accessToken, 'ya29.AAA');
  for (const other of ['emp2', 'boss']) {
    uid = other;
    assert.deepStrictEqual((await api('POST', '/secrets/reveal', { scope: 'personal', id: 'google_contacts' })).json.credentials, {});
    assert.deepStrictEqual((await api('POST', '/secrets/reveal', { scope: 'personal' })).json.items, {});
  }
  uid = 'emp1';
  assert.deepStrictEqual(Object.keys((await api('POST', '/secrets/reveal', { scope: 'personal' })).json.items), ['google_contacts']);
});
test('personal secrets can be deleted by their owner', async () => {
  uid = 'emp1';
  await api('POST', '/secrets/delete', { scope: 'personal', id: 'google_contacts' });
  assert.deepStrictEqual((await api('POST', '/secrets/reveal', { scope: 'personal', id: 'google_contacts' })).json.credentials, {});
});

const page = async (qs) => { const r = await fetch(`${base}/oauth/google/callback?${qs}`); return { status: r.status, html: await r.text(), cache: r.headers.get('cache-control') }; };
test('redirect page hands the code to the app link and also shows it for manual paste', async () => {
  const r = await page('code=4%2F0AbCd&state=xyz');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.cache, 'no-store');
  assert.match(r.html, /biznexus:\/\/oauth\/google\?code=4%2F0AbCd&amp;state=xyz/);
  assert.match(r.html, /<code>4\/0AbCd<\/code>/);
});
test('redirect page cannot be used for script injection', async () => {
  const r = await page('code=' + encodeURIComponent('"><script>alert(1)</script>') + '&state=' + encodeURIComponent('</script><script>alert(2)</script>'));
  assert.ok(!r.html.includes('<script>alert')); assert.ok(!/<\/script><script>/.test(r.html));
});
test('a refusal from Google is explained and no code is shown', async () => {
  const r = await page('error=access_denied&error_description=The%20user%20denied');
  assert.match(r.html, /did not connect/); assert.match(r.html, /The user denied/); assert.ok(!r.html.includes('<code>'));
});
