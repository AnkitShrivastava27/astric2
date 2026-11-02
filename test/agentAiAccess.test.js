const test = require('node:test');
const assert = require('node:assert');
const { make } = require('./fakeFirestore');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fake = make();
stub('../config/firebase', { db: fake.db, admin: fake.admin });
let uid = 'boss';
stub('../middleware/auth', { requireAuth: (req, _res, next) => { req.uid = uid; next(); } });
stub('../middleware/rateLimit', { rateLimit: () => (_req, _res, next) => next() });
stub('../services/ai', { AI_CHAT_PROVIDERS: { deepseek: { url: 'https://llm.example/v1/chat', key: 'k' } }, estimateTokens: () => 100, reserveTokens: async () => ({ ok: true, reserved: 99999 }), settleTokens: async () => {} });
stub('../services/webSearch', { webSearch: async () => ({ results: [] }) });

const express = require('express');
const router = require('../routes/agent');
let server, base, modelCalls = 0;
router._deps.http = { post: async () => { modelCalls++; return { data: { usage: { total_tokens: 10 }, choices: [{ message: { content: 'Hello from the agent.' } }] } }; } };

test.before(async () => {
  await fake.db.collection('users').doc('boss').set({ role: 'admin', subscription: { plan: 'premium', cycle: 'monthly' } });
  await fake.db.collection('users').doc('emp_no').set({ role: 'employee', adminId: 'boss' });
  await fake.db.collection('users').doc('emp_yes').set({ role: 'employee', adminId: 'boss' });
  await fake.db.collection('users').doc('boss').collection('employees').doc('emp_no').set({ name: 'No Access' });          // switch never touched = off
  await fake.db.collection('users').doc('boss').collection('employees').doc('emp_yes').set({ name: 'Has Access', aiAdvanced: true });
  await fake.db.collection('config').doc('ai_models').set({ agentModeProviderId: 'deepseek', models: [{ id: 'deepseek', enabled: true, modelId: 'deepseek-chat', displayName: 'DS' }] });
  const app = express(); app.use(express.json()); app.use(router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

test('an employee the admin has NOT allowed cannot use Agent Mode (and the model is never called)', async () => {
  uid = 'emp_no'; modelCalls = 0;
  const r = await post('/ai/agent', { message: 'list my employees' });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.json.notAllowed, true); assert.match(r.json.error, /Advanced AI access/);
  assert.strictEqual(modelCalls, 0);
});
test('...nor confirm/execute an action directly through the API', async () => {
  uid = 'emp_no';
  const r = await post('/ai/agent/execute', { type: 'create_task', params: { title: 'x' } });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.json.notAllowed, true);
});
test('an employee the admin HAS allowed can use it', async () => {
  uid = 'emp_yes'; modelCalls = 0;
  const r = await post('/ai/agent', { message: 'hello' });
  assert.strictEqual(r.status, 200); assert.match(r.json.reply, /Hello from the agent/); assert.strictEqual(modelCalls, 1);
});
test('the admin is never restricted', async () => {
  uid = 'boss';
  assert.strictEqual((await post('/ai/agent', { message: 'hello' })).status, 200);
});
