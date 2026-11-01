const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { make } = require('./fakeFirestore');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const fake = make();
stub('../config/firebase', { db: fake.db, admin: fake.admin });
let uid = 'org1';
stub('../middleware/auth', { requireAuth: (req, _res, next) => { req.uid = uid; next(); } });
stub('../middleware/rateLimit', { rateLimit: () => (_q, _s, n) => n() });
const express = require('express');
const router = require('../routes/leadCapture');
const secrets = require('../routes/secrets');

let server, base;
test.before(async () => {
  await fake.db.collection('users').doc('org1').set({ role: 'admin' });
  await fake.db.collection('users').doc('emp1').set({ role: 'employee', adminId: 'org1' });
  const app = express(); app.use(express.json()); app.use(router); app.use(secrets);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const api = async (m, p, body) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const wait = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)); } };

test('async import answers immediately with a jobId, then progress reaches "done" with the final counts', async () => {
  const rows = ['name,phone']; for (let i = 0; i < 60; i++) rows.push(`Lead ${i},98${String(10000000 + i)}`); rows.push(',5'); rows.push('Dup,9810000000');
  const r = await api('POST', '/capture/import', { csv: rows.join('\n'), async: true, batchName: 'Big file' });
  assert.strictEqual(r.status, 202); assert.ok(r.json.jobId); assert.strictEqual(r.json.total, 62);
  const done = await wait(async () => { const j = (await api('GET', `/capture/import/${r.json.jobId}`)).json; if (j.status === 'failed') throw new Error('job failed: ' + j.error); return j.status === 'done' ? j : null; });
  assert.strictEqual(done.created, 60); assert.strictEqual(done.duplicates, 1); assert.strictEqual(done.invalid, 1); assert.strictEqual(done.processed, 62); assert.strictEqual(done.batchName, 'Big file');
});
test('an import can name its source, and it is cleaned', async () => {
  const r = await api('POST', '/capture/import', { csv: 'name,phone\nFrom Google,9855500001', sourceLabel: '  Google Contacts<b>  ' });
  assert.strictEqual(r.json.created, 1);
  const l = (await fake.db.collection('users').doc('org1').collection('leads').get()).docs.map((d) => d.data()).find((x) => x.name === 'From Google');
  assert.strictEqual(l.sourceCustom, 'Google Contacts b');
});
test('without the async flag the old behaviour (wait for the result) still works', async () => {
  const r = await api('POST', '/capture/import', { csv: 'name,phone\nSolo,9877700001' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.created, 1);
});
test('a job id from another organisation, or garbage, is not readable', async () => {
  uid = 'emp1';                                              // same org: allowed to look
  const j = await api('POST', '/capture/import', { csv: 'name,phone\nEmp lead,9866600001', async: true });
  assert.strictEqual(j.status, 202);
  assert.strictEqual((await api('GET', '/capture/import/not*valid')).status, 400);
  assert.strictEqual((await api('GET', '/capture/import/doesnotexist1')).status, 404);
  uid = 'org1';
});
test('a job that stopped updating is reported as failed instead of loading forever', async () => {
  const ref = fake.db.collection('users').doc('org1').collection('lead_import_jobs').doc('stalledjob1');
  await ref.set({ status: 'running', total: 500, processed: 120, created: 120, errors: [], updatedAt: new fake.Ts(new Date(Date.now() - 20 * 60e3)) });
  const j = (await api('GET', '/capture/import/stalledjob1')).json;
  assert.strictEqual(j.status, 'failed'); assert.match(j.error, /run the file again.*duplicates will be skipped/); assert.strictEqual(j.created, 120);
});

test('secrets/store keeps only ciphertext; reveal gives the plaintext back to a member of the same org', async () => {
  const s = await api('POST', '/secrets/store', { scope: 'integration', id: 'mailchimp', credentials: { apiKey: 'abcd1234efgh5678-us1', listId: 'L99' } });
  assert.strictEqual(s.status, 200); assert.strictEqual(s.json.masked.apiKey, '••••-us1');
  const raw = (await fake.db.collection('users').doc('org1').collection('integrations').doc('mailchimp').get()).data();
  assert.ok(raw.credentials.apiKey.startsWith('enc:v1:')); assert.ok(!JSON.stringify(raw).includes('abcd1234'));
  uid = 'emp1';
  const rv = await api('POST', '/secrets/reveal', { scope: 'integration', id: 'mailchimp' });
  assert.deepStrictEqual(rv.json.credentials, { apiKey: 'abcd1234efgh5678-us1', listId: 'L99' });
  const all = await api('POST', '/secrets/reveal', { scope: 'integration' });
  assert.strictEqual(all.json.items.mailchimp.listId, 'L99');
  uid = 'org1';
});
test('secrets/store validates input and wipes on delete', async () => {
  assert.strictEqual((await api('POST', '/secrets/store', { scope: 'nope', id: 'x1', credentials: { a: 'b' } })).status, 400);
  assert.strictEqual((await api('POST', '/secrets/store', { scope: 'integration', id: '../x', credentials: { a: 'b' } })).status, 400);
  assert.strictEqual((await api('POST', '/secrets/store', { scope: 'integration', id: 'zapier', credentials: {} })).status, 400);
  assert.strictEqual((await api('POST', '/secrets/store', { scope: 'integration', id: 'zapier', credentials: { 'bad key': 'v' } })).status, 400);
  await api('POST', '/secrets/delete', { scope: 'integration', id: 'mailchimp' });
  assert.deepStrictEqual((await api('POST', '/secrets/reveal', { scope: 'integration', id: 'mailchimp' })).json.credentials, {});
});
test('with no encryption key configured the server refuses to store (and says so plainly)', async () => {
  const k = process.env.SECRETS_ENCRYPTION_KEY; delete process.env.SECRETS_ENCRYPTION_KEY;
  const r = await api('POST', '/secrets/store', { scope: 'integration', id: 'slack1', credentials: { webhookUrl: 'https://hooks.slack.com/x' } });
  process.env.SECRETS_ENCRYPTION_KEY = k;
  assert.strictEqual(r.status, 500); assert.match(r.json.error, /Secure storage is not set up/);
  assert.strictEqual((await fake.db.collection('users').doc('org1').collection('integrations').doc('slack1').get()).exists, false);
});
