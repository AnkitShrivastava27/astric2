const test = require('node:test');
const assert = require('node:assert');
const { make } = require('./fakeFirestore');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const fake = make();
stub('../config/firebase', { db: fake.db, admin: fake.admin });
stub('../middleware/auth', { requireAuth: (req, _res, next) => { req.uid = 'org1'; next(); } });
stub('../middleware/rateLimit', { rateLimit: () => (_req, _res, next) => next() });
stub('../services/ai', {
  AI_CHAT_PROVIDERS: { deepseek: { url: 'https://llm.example/v1/chat', key: 'k' } },
  estimateTokens: () => 100, reserveTokens: async () => ({ ok: true, reserved: 99999 }), settleTokens: async () => {},
});
let searches = [];
stub('../services/webSearch', { webSearch: async (q) => { searches.push(q); return { results: [{ title: 'Gold today', url: 'https://gold.example', snippet: 'Gold is 74,000 per 10g' }] }; } });

const express = require('express');
const router = require('../routes/agent');

let server, base;
const script = [];                                   // queued model replies
const seen = [];                                     // what the model was sent
router._deps.http = { post: async (_url, body) => { seen.push(JSON.parse(JSON.stringify(body))); const r = script.shift(); if (!r) throw new Error('no scripted reply'); return { data: { usage: { total_tokens: 50 }, choices: [{ message: r }] } }; } };
const tc = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test.before(async () => {
  await fake.db.collection('users').doc('org1').set({ subscription: { plan: 'premium', cycle: 'monthly' } });
  await fake.db.collection('config').doc('ai_models').set({ agentModeProviderId: 'deepseek', models: [{ id: 'deepseek', enabled: true, modelId: 'deepseek-chat', displayName: 'DS' }] });
  await fake.db.collection('users').doc('org1').collection('lead_batches').doc('b1').set({ name: 'Warm leads', mode: 'manual' });
  await fake.db.collection('users').doc('org1').collection('calendar_events').doc('c1').set({ title: 'Demo with Acme', startTime: '2026-10-27T10:00:00.000', endTime: '2026-10-27T10:30:00.000' });
  const app = express(); app.use(express.json()); app.use(router);
  await new Promise((r) => { server = app.listen(0, r); }); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
const post = async (path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

test('the model looks at the calendar first, then answers in plain text', async () => {
  script.push({ content: null, tool_calls: [tc('1', 'get_calendar', { fromDate: '2026-10-27' })] }, { content: 'You have 1 meeting: Demo with Acme at 10:00.' });
  const r = await post('/ai/agent', { message: 'what meetings do I have on 27 Oct?' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.needsConfirmation, false);
  assert.match(r.json.reply, /Demo with Acme/);
  const toolMsg = seen.at(-1).messages.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /Demo with Acme/);                                    // the model really got the calendar data
  assert.ok(seen[0].tools.some((t) => t.function.name === 'web_search') && seen[0].tools.some((t) => t.function.name === 'schedule_voice_calls'));
  assert.match(seen[0].messages[0].content, /India time/);
});

test('real-time question: web_search runs, sources are returned', async () => {
  script.push({ content: null, tool_calls: [tc('1', 'web_search', { query: 'gold rate today' })] }, { content: 'Gold is about 74,000 per 10 g [1].' });
  const r = await post('/ai/agent', { message: 'gold rate today?' });
  assert.deepStrictEqual(searches, ['gold rate today']);
  assert.match(r.json.reply, /74,000/); assert.deepStrictEqual(r.json.sources, [{ title: 'Gold today', url: 'https://gold.example' }]);
});

test('several write tools in one prompt come back as ONE confirmable plan, in order', async () => {
  script.push({ content: null, tool_calls: [
    tc('1', 'create_voice_product', { name: 'Solar Rooftop', price: 'Rs 3 lakh', goal: 'Book a visit' }),
    tc('2', 'create_lead_batch', { name: 'Interested', stage: 'new_' }),
    tc('3', 'schedule_voice_calls', { batchName: 'Interested', productName: 'Solar Rooftop', startTime: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) + 'T10:00:00' }),
  ] });
  await fake.db.collection('users').doc('org1').collection('leads').doc('x1').set({ name: 'Eve', phone: '+919800000009', stage: 'new_', batchId: '', priority: 'warm' });
  const r = await post('/ai/agent', { message: 'make a solar product, batch my new leads and call them tomorrow 10am' });
  assert.strictEqual(r.json.needsConfirmation, true); assert.strictEqual(r.json.action.type, 'plan');
  assert.deepStrictEqual(r.json.action.params.steps.map((s) => s.type), ['create_voice_product', 'create_lead_batch', 'schedule_voice_calls']);
  assert.match(r.json.summary, /1\. Create the Astric Voice product/); assert.match(r.json.summary, /3\. Start AI calling/);
  // nothing written yet
  assert.strictEqual((await fake.db.collection('users').doc('org1').collection('voice_products').get()).size, 0);
  // confirm -> executes all three (voice API stubbed through ctx.http by replacing axios for this call)
  const axios = require('axios'); const real = axios.request; const calls = [];
  const orig = axios.defaults.adapter; axios.defaults.adapter = async (cfg) => { calls.push(cfg); return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config: cfg }; };
  process.env.VOICE_API_BASE_URL = 'https://voice.example.com';
  const done = await post('/ai/agent/execute', { type: 'plan', params: r.json.action.params });
  axios.defaults.adapter = orig;
  assert.strictEqual(done.status, 200); assert.strictEqual(done.json.success, true); assert.strictEqual(done.json.count, 3);
  assert.strictEqual((await fake.db.collection('users').doc('org1').collection('voice_products').get()).size, 1);
  assert.strictEqual(calls.length, 1); assert.match(calls[0].url, /voice\.example\.com\/v1\/batches\/.+\/schedule/);
  assert.strictEqual(calls[0].headers.Authorization || calls[0].headers.get?.('Authorization'), 'Bearer abc');
});

test('a single write tool keeps the old single-action response shape', async () => {
  script.push({ content: null, tool_calls: [tc('1', 'create_customer', { name: 'Zed Corp' })] });
  const r = await post('/ai/agent', { message: 'add customer Zed Corp' });
  assert.strictEqual(r.json.needsConfirmation, true); assert.strictEqual(r.json.action.type, 'create_customer'); assert.strictEqual(r.json.action.params.name, 'Zed Corp');
  assert.strictEqual(r.json.summary, 'Create a customer record for Zed Corp.');
});

test('a rejected proposal is explained to the model, which then asks the user', async () => {
  script.push({ content: null, tool_calls: [tc('1', 'assign_task', { title: 'Call leads', deadline: '2026-10-30' })] }, { content: 'Who should I assign it to?' });
  const r = await post('/ai/agent', { message: 'assign a task to call leads' });
  assert.strictEqual(r.json.needsConfirmation, false); assert.match(r.json.reply, /Who should/);
  assert.match(seen.at(-1).messages.find((m) => m.role === 'tool').content, /Who should get this task/);
});

test('non-premium plans are refused', async () => {
  await fake.db.collection('users').doc('org1').set({ subscription: { plan: 'basic' } });
  const r = await post('/ai/agent', { message: 'hi' });
  assert.strictEqual(r.status, 403);
  await fake.db.collection('users').doc('org1').set({ subscription: { plan: 'premium' } });
});
