const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { make } = require('./fakeFirestore');

// Swap the real firebase module for the in-memory one BEFORE the services load it.
const fake = make();
const fbPath = require.resolve('../config/firebase');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { db: fake.db, admin: fake.admin } };
const actions = require('../services/agentActions');

const ORG = 'org1';
const ctx = () => ({ uid: ORG, orgOwnerUid: ORG, plan: 'premium', authHeader: 'Bearer tok', planned: { batches: new Set(), voiceProducts: new Set() } });
const col = (n) => fake.db.collection('users').doc(ORG).collection(n);
const put = async (n, id, d) => col(n).doc(id).set(d);
const all = async (n) => { const s = await col(n).get(); return s.docs.map((d) => ({ id: d.id, ...d.data() })); };

test.before(async () => {
  await put('employees', 'e1', { name: 'Ravi Kumar', isActive: true, role: 'Sales' });
  await put('employees', 'e2', { name: 'Priya Shah', isActive: true });
  await put('employees', 'e3', { name: 'Amit Rao', isActive: true });
  await put('employees', 'e4', { name: 'Old Timer', isActive: false });
  await put('teams', 't1', { name: 'Sales Team', members: [{ uid: 'e1', name: 'Ravi Kumar' }, { uid: 'e2', name: 'Priya Shah' }, { uid: 'e4', name: 'Old Timer' }] });
  const L = (name, phone, stage, extra = {}) => ({ name, phone, phoneNorm: phone.replace(/\D/g, ''), stage, priority: 'warm', source: 'other', batchId: '', createdAt: new fake.Ts(new Date('2026-10-20T10:00:00Z')), ...extra });
  await put('leads', 'l1', L('Asha', '+919800000001', 'qualified'));
  await put('leads', 'l2', L('Bala', '+919800000002', 'qualified'));
  await put('leads', 'l3', L('Chitra', '+919800000003', 'qualified', { batchId: 'oldb' }));
  await put('leads', 'l4', L('Dev', '+919800000004', 'new_'));
  await put('lead_batches', 'oldb', { name: 'Old import', mode: 'manual' });
  await put('calendar_events', 'c1', { title: 'Demo with Acme', startTime: '2026-10-27T10:00:00.000', endTime: '2026-10-27T10:30:00.000', source: 'booking', description: 'Booked' });
  await put('calendar_events', 'c2', { title: 'Team sync', startTime: '2026-10-27T16:00:00.000', endTime: '2026-10-27T16:30:00.000' });
  await put('calendar_events', 'c3', { title: 'Later', startTime: '2026-11-02T09:00:00.000', endTime: '2026-11-02T09:30:00.000' });
});

test('get_calendar returns only the meetings in the date range, sorted', async () => {
  const r = await actions.runReadTool('get_calendar', { fromDate: '2026-10-27' }, ctx());
  assert.deepStrictEqual(r.events.map((e) => e.title), ['Demo with Acme', 'Team sync']);
  assert.strictEqual(r.events[0].bookedOnline, true);
  const wide = await actions.runReadTool('get_calendar', { fromDate: '2026-10-27', toDate: '2026-11-02' }, ctx());
  assert.strictEqual(wide.count, 3);
});

test('find_leads filters by status and counts', async () => {
  const r = await actions.runReadTool('find_leads', { stage: 'qualified', countOnly: true }, ctx());
  assert.strictEqual(r.total, 3); assert.strictEqual(r.leads, undefined);
  const s = await actions.runReadTool('find_leads', { search: '0003' }, ctx());
  assert.deepStrictEqual(s.leads.map((l) => l.name), ['Chitra']);
});

test('business_snapshot counts leads per status', async () => {
  const r = await actions.runReadTool('business_snapshot', {}, ctx());
  assert.strictEqual(r.leadsByStatus.qualified, 3); assert.strictEqual(r.leadsByStatus.new_, 1); assert.strictEqual(r.totalLeads, 4); assert.strictEqual(r.employees, 4);
});

test('create_lead_batch: previews the count, skips already-batched leads, and moves exactly those on execute', async () => {
  const v = await actions.validateAction('create_lead_batch', { name: 'Hot qualified', stage: 'qualified' }, ctx());
  assert.match(v.summary, /2 leads/); assert.match(v.summary, /status = qualified/); assert.match(v.summary, /1 already in another batch/);
  const r = await actions.executeAction('create_lead_batch', v.normalized, ctx());
  assert.strictEqual(r.count, 2);
  const leads = await all('leads');
  assert.strictEqual(leads.find((l) => l.id === 'l1').batchId, r.id);
  assert.strictEqual(leads.find((l) => l.id === 'l3').batchId, 'oldb');          // left alone
  assert.strictEqual(leads.find((l) => l.id === 'l4').batchId, '');
  await assert.rejects(() => actions.validateAction('create_lead_batch', { name: 'Hot qualified', stage: 'qualified' }, ctx()), /already exists/);
  await assert.rejects(() => actions.validateAction('create_lead_batch', { name: 'X' }, ctx()), /which leads/i);
  const inc = await actions.validateAction('create_lead_batch', { name: 'Everyone qualified', stage: 'qualified', includeAlreadyBatched: true }, ctx());
  assert.match(inc.summary, /3 leads/);
});

test('assign_task to several employees and a team creates one correctly-shaped task per person', async () => {
  const v = await actions.validateAction('assign_task', { title: 'Call hot leads', deadline: '2026-10-30T12:00:00Z', employeeNames: ['Amit', 'Ravi Kumar'], teamName: 'Sales' }, ctx());
  assert.deepStrictEqual(v.normalized.assignees.map((a) => a.name).sort(), ['Amit Rao', 'Priya Shah', 'Ravi Kumar']);   // inactive Old Timer excluded, Ravi not duplicated
  assert.strictEqual(v.normalized.teamId, 't1');
  assert.match(v.summary, /Amit Rao, Ravi Kumar, Priya Shah/); assert.match(v.summary, /own copy/);
  // the echo (what the app sends back on confirm) must reproduce the same people
  const r = await actions.executeAction('assign_task', v.echo, ctx());
  assert.strictEqual(r.count, 3);
  const tasks = await all('tasks');
  assert.strictEqual(tasks.length, 3);
  const ravi = tasks.find((t) => t.assignedTo === 'Ravi Kumar');
  assert.strictEqual(ravi.assigneeId, 'e1'); assert.strictEqual(ravi.status, 'todo'); assert.strictEqual(ravi.isStandalone, true); assert.strictEqual(ravi.teamId, 't1');
  assert.ok(ravi.deadline.toDate() instanceof Date);
  await assert.rejects(() => actions.validateAction('assign_task', { title: 'x', deadline: '2026-10-30' }, ctx()), /Who should/);
  await assert.rejects(() => actions.validateAction('assign_task', { title: 'x', deadline: '2026-10-30', employeeNames: ['Nobody'] }, ctx()), /No employee named/);
});

test('create_calendar_event stores wall-clock strings like the app and the booking page do', async () => {
  const v = await actions.validateAction('create_calendar_event', { title: 'Client visit', startTime: '2026-11-03T15:00:00', endTime: '2026-11-03T16:00:00+05:30' }, ctx());
  assert.strictEqual(v.normalized.startTime, '2026-11-03T15:00:00.000');
  assert.strictEqual(v.normalized.endTime, '2026-11-03T16:00:00.000');
  const r = await actions.executeAction('create_calendar_event', v.normalized, ctx());
  const ev = (await all('calendar_events')).find((e) => e.id === r.id);
  assert.strictEqual(typeof ev.startTime, 'string'); assert.strictEqual(ev.source, 'agent');
  const back = await actions.runReadTool('get_calendar', { fromDate: '2026-11-03' }, ctx());
  assert.strictEqual(back.count, 1);                                                      // and the read tool sees it
});

test('bulk_create_leads creates leads in one batch and skips duplicates', async () => {
  const v = await actions.validateAction('bulk_create_leads', { batchName: 'Expo list', leads: [{ name: 'Mohan', phone: '9811111111' }, { name: 'Neha', phone: '9822222222' }, { name: 'Dup', phone: '9811111111' }] }, ctx());
  const r = await actions.executeAction('bulk_create_leads', v.normalized, ctx());
  assert.strictEqual(r.count, 2); assert.strictEqual(r.duplicates, 1);
  const b = (await all('lead_batches')).find((x) => x.name === 'Expo list');
  assert.ok(b);
  const mine = (await all('leads')).filter((l) => l.batchId === b.id);
  assert.deepStrictEqual(mine.map((l) => l.name).sort(), ['Mohan', 'Neha']);
});

test('update_leads changes status for a filter and records an activity', async () => {
  const v = await actions.validateAction('update_leads', { stage: 'new_', setStage: 'contacted' }, ctx());
  assert.match(v.summary, /status = contacted/);
  await actions.executeAction('update_leads', v.normalized, ctx());
  const dev = (await all('leads')).find((l) => l.id === 'l4');
  assert.strictEqual(dev.stage, 'contacted'); assert.match(dev.activities[0].note, /Agent Mode/);
  await assert.rejects(() => actions.validateAction('update_leads', { setStage: 'won' }, ctx()), /which leads/i);
});

test('voice: product -> batch -> schedule works as ONE plan, calling the voice API with the user token', async () => {
  const calls = [];
  const http = async (req) => { calls.push(req); return { data: { ok: true } }; };
  process.env.VOICE_API_BASE_URL = 'https://voice.example.com/';
  const steps = [
    { type: 'create_voice_product', params: { name: 'Solar Rooftop', price: 'Rs 3 lakh', goal: 'Book a site visit', pitch: 'Cut your power bill by 80%', features: ['25 yr warranty'] } },
    { type: 'create_lead_batch', params: { name: 'Interested solar', stage: 'new_' } },          // l4 was changed to contacted above, so use contacted
  ];
  steps[1].params.stage = 'contacted';
  const when = new Date(Date.now() + 86400e3).toISOString().slice(0, 10) + 'T10:00:00';
  steps.push({ type: 'schedule_voice_calls', params: { batchName: 'Interested solar', productName: 'Solar Rooftop', startTime: when } });
  // preview of the whole chain: later steps reference things earlier steps will create
  const c = ctx();
  for (const s of steps) await actions.validateAction(s.type, s.params, c);
  const run = ctx(); run.http = http;
  const r = await actions.executePlan(steps, run);
  assert.strictEqual(r.count, 3);
  const prod = (await all('voice_products')).find((p) => p.name === 'Solar Rooftop');
  assert.ok(prod && prod.active === true && prod.features[0] === '25 yr warranty' && prod.goal === 'Book a site visit');
  const batch = (await all('lead_batches')).find((b) => b.name === 'Interested solar');
  assert.strictEqual(batch.mode, 'ai');                                                      // switched to AI mode for the dialler
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, `https://voice.example.com/v1/batches/${batch.id}/schedule`);
  assert.strictEqual(calls[0].headers.Authorization, 'Bearer tok');
  assert.strictEqual(calls[0].data.productId, prod.id);
  assert.ok(calls[0].data.scheduledAt.endsWith('Z'));
  assert.strictEqual(new Date(calls[0].data.scheduledAt).toISOString().slice(11, 16), '04:30');   // 10:00 IST = 04:30 UTC
});

test('a plan stops at the first failing step and says what was already done', async () => {
  await assert.rejects(() => actions.executePlan([
    { type: 'create_customer', params: { name: 'Zed Corp' } },
    { type: 'schedule_voice_calls', params: { batchName: 'No such batch', productName: 'Solar Rooftop' } },
  ], ctx()), (e) => /Step 2 of 2/.test(e.message) && /No batch named/.test(e.message) && /first 1 step/.test(e.message) && e.done.length === 1);
});

test('schedule_voice_calls rejects the past and unknown products', async () => {
  await assert.rejects(() => actions.validateAction('schedule_voice_calls', { batchName: 'Interested solar', productName: 'Solar Rooftop', startTime: '2020-01-01T10:00:00' }, ctx()), /in the past/);
  await assert.rejects(() => actions.validateAction('schedule_voice_calls', { batchName: 'Interested solar', productName: 'Nope' }, ctx()), /No Astric Voice product/);
});

test('voice_setup_status lists what is still missing', async () => {
  const r = await actions.runReadTool('voice_setup_status', {}, ctx());
  assert.ok(r.nextSteps.some((s) => /Vobiz or Telnyx/.test(s)));
  assert.ok(r.activeProducts.includes('Solar Rooftop'));
  assert.ok(r.aiBatches >= 1);
});

test('timezone helpers', () => {
  const { toWall, parseInTz } = actions._t;
  assert.strictEqual(toWall('2026-10-27T10:00:00Z'), '2026-10-27T15:30:00.000');          // UTC -> IST wall clock
  assert.strictEqual(parseInTz('2026-10-27T10:00:00').toISOString(), '2026-10-27T04:30:00.000Z');
  assert.strictEqual(parseInTz('2026-10-27T10:00:00+00:00').toISOString(), '2026-10-27T10:00:00.000Z');
});
