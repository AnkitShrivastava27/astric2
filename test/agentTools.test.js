const test = require('node:test');
const assert = require('node:assert');
const { make } = require('./fakeFirestore');

const fake = make();
const fbPath = require.resolve('../config/firebase');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { db: fake.db, admin: fake.admin } };
process.env.VOICE_API_BASE_URL = 'https://voice.test';
const actions = require('../services/agentActions');

const ORG = 'org1';
const ctx = (extra = {}) => ({ uid: ORG, orgOwnerUid: ORG, plan: 'premium', isEmployee: false, authHeader: 'Bearer tok', planned: { batches: new Set(), voiceProducts: new Set() }, ...extra });
const col = (n) => fake.db.collection('users').doc(ORG).collection(n);
const put = (n, id, d) => col(n).doc(id).set(d);
const get = async (n, id) => (await col(n).doc(id).get()).data();
const all = async (n) => (await col(n).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const ts = (s) => new fake.Ts(new Date(s));
const future = () => new Date(Date.now() + 2 * 86400e3).toISOString();

test.before(async () => {
  const L = (name, phone, extra = {}) => ({ name, phone, phoneNorm: phone.replace(/\D/g, ''), stage: 'qualified', priority: 'hot', source: 'facebookAds', batchId: '', createdAt: ts('2026-10-20T10:00:00Z'), activities: [], visibleTo: [ORG], ...extra });
  await put('leads', 'l1', L('Ravi Sharma', '+919811111111', { company: 'Acme', estimatedValue: 50000, notes: 'Wants a demo', activities: [{ note: 'Called, call back Friday', type: 'note', createdBy: 'Priya', createdAt: ts('2026-10-21T10:00:00Z') }], productName: 'CRM Pro' }));
  await put('leads', 'l2', L('Ravi Verma', '+919822222222'));
  await put('leads', 'l3', L('Meena Iyer', '+919833333333', { batchId: 'b1', visibleTo: ['emp1'] }));
  await put('leads', 'l4', L('NoPhone Nick', '', {}));
  await put('lead_batches', 'b1', { name: 'Diwali list', mode: 'manual' });
  await put('customers', 'c1', { name: 'Acme Corp', email: 'ops@acme.com', phone: '+919844444444', notes: 'VIP', activities: [] });
  await put('projects', 'p1', { name: 'Website Redesign', status: 'active', linkedCustomerId: 'c1', description: 'New site' });
  const T = (id, d) => put('tasks', id, d);
  await T('t1', { title: 'Design homepage', status: 'done', priority: 'high', assignedTo: 'Priya', assigneeId: 'emp1', projectId: 'p1', deadline: ts('2026-10-10T00:00:00Z') });
  await T('t2', { title: 'Build contact form', status: 'inProgress', priority: 'medium', assignedTo: 'Priya', assigneeId: 'emp1', projectId: 'p1', deadline: ts('2026-10-15T00:00:00Z') });
  await T('t3', { title: 'Write copy', status: 'todo', priority: 'low', assignedTo: 'Ravi', assigneeId: 'emp2', projectId: 'p1', deadline: ts('2030-01-01T00:00:00Z') });
  await put('invoices', 'i1', { invoiceNumber: 'INV-1', clientName: 'Acme Corp', clientEmail: 'ops@acme.com', status: 'sent', dueDate: ts('2026-09-01T00:00:00Z'), items: [{ quantity: 2, unitPrice: 500 }] });
  await put('products', 'pr1', { name: 'CRM Pro', rate: 999, rateUnit: 'month', active: true, features: ['Leads', 'Tasks'] });
  await put('products', 'pr2', { name: 'Old thing', active: false });
  await put('voice_products', 'vp1', { name: 'CRM Pro Pitch', active: true });
});

test('get_lead_details returns the full picture of one lead', async () => {
  const r = await actions.runReadTool('get_lead_details', { leadName: 'Ravi Sharma' }, ctx());
  assert.strictEqual(r.name, 'Ravi Sharma'); assert.strictEqual(r.phone, '+919811111111'); assert.strictEqual(r.company, 'Acme');
  assert.strictEqual(r.estimatedValue, 50000); assert.strictEqual(r.product, 'CRM Pro'); assert.match(r.recentActivity[0].note, /call back Friday/);
});
test('get_lead_details by phone digits, and an ambiguous name asks which one', async () => {
  assert.strictEqual((await actions.runReadTool('get_lead_details', { phone: '9822222222' }, ctx())).name, 'Ravi Verma');
  await assert.rejects(() => actions.runReadTool('get_lead_details', { leadName: 'Ravi' }, ctx()), /matches 2 leads.*Which one/);
  await assert.rejects(() => actions.runReadTool('get_lead_details', { leadName: 'Zzz' }, ctx()), /couldn't find/);
});
test('an employee cannot read leads that are not shared with them', async () => {
  const emp = ctx({ uid: 'emp1', isEmployee: true });
  await assert.rejects(() => actions.runReadTool('get_lead_details', { leadName: 'Ravi Sharma' }, emp), /couldn't find/);
  assert.strictEqual((await actions.runReadTool('get_lead_details', { leadName: 'Meena' }, emp)).batch, 'Diwali list');
  const f = await actions.runReadTool('find_leads', { countOnly: true }, emp);
  assert.strictEqual(f.total, 1);
});
test('get_customer_details includes linked projects and invoices', async () => {
  const r = await actions.runReadTool('get_customer_details', { customerName: 'acme' }, ctx());
  assert.strictEqual(r.email, 'ops@acme.com'); assert.deepStrictEqual(r.projects.map((p) => p.name), ['Website Redesign']);
  assert.strictEqual(r.invoices[0].total, 1000);
});
test('find_tasks: overdue, by assignee, and employees only see their own', async () => {
  const o = await actions.runReadTool('find_tasks', { overdue: true }, ctx());
  assert.deepStrictEqual(o.tasks.map((t) => t.title), ['Build contact form']);
  assert.strictEqual((await actions.runReadTool('find_tasks', { assignee: 'ravi', countOnly: true }, ctx())).total, 1);
  assert.strictEqual((await actions.runReadTool('find_tasks', { status: 'open' }, ctx({ uid: 'emp1', isEmployee: true }))).total, 1);
});
test('get_project_details rolls up task progress', async () => {
  const r = await actions.runReadTool('get_project_details', { projectName: 'website' }, ctx());
  assert.strictEqual(r.customer, 'Acme Corp'); assert.strictEqual(r.tasks.total, 3); assert.strictEqual(r.tasks.percentDone, 33); assert.strictEqual(r.tasks.overdue, 1);
});
test('find_invoices flags overdue and totals; list_products hides archived', async () => {
  const r = await actions.runReadTool('find_invoices', { status: 'overdue' }, ctx());
  assert.strictEqual(r.count, 1); assert.strictEqual(r.invoices[0].status, 'overdue'); assert.strictEqual(r.totalAmount, 1000);
  const p = await actions.runReadTool('list_products', {}, ctx());
  assert.deepStrictEqual(p.products.map((x) => x.name), ['CRM Pro']);
});

test('add_note saves a note and puts it on the lead timeline', async () => {
  const v = await actions.validateAction('add_note', { content: 'Prefers WhatsApp over calls', attachTo: 'lead', attachName: 'Ravi Sharma' }, ctx());
  assert.match(v.summary, /on the lead Ravi Sharma/);
  const r = await actions.executeAction('add_note', v.echo, ctx());
  assert.strictEqual(r.entity, 'note');
  const notes = await all('notes'); assert.strictEqual(notes.length, 1); assert.strictEqual(notes[0].tag, 'lead'); assert.strictEqual(notes[0].tagLabel, 'Ravi Sharma');
  assert.match((await get('leads', 'l1')).activities.slice(-1)[0].note, /Prefers WhatsApp/);
});
test('add_note: standalone note works for the admin; employees are told why not', async () => {
  const r = await actions.executeAction('add_note', { content: 'Buy domain', title: 'Todo' }, ctx());
  assert.match(r.message, /saved/i);
  await assert.rejects(() => actions.validateAction('add_note', { content: 'x' }, ctx({ uid: 'emp1', isEmployee: true })), /not available to team members/);
});
test('update_lead changes one lead, logs it, and refuses a phone change', async () => {
  const v = await actions.validateAction('update_lead', { leadName: 'Ravi Verma', setStage: 'won', setEstimatedValue: 12000 }, ctx());
  await actions.executeAction('update_lead', v.echo, ctx());
  const l = await get('leads', 'l2'); assert.strictEqual(l.stage, 'won'); assert.strictEqual(l.estimatedValue, 12000); assert.match(l.activities.slice(-1)[0].note, /status → won/);
  await assert.rejects(() => actions.validateAction('update_lead', { leadName: 'Ravi Verma', setPhone: '999' }, ctx()), /phone number is not supported|Changing a phone/);
  await assert.rejects(() => actions.validateAction('update_lead', { leadName: 'Ravi Verma' }, ctx()), /Nothing to change/);
});
test('update_task changes status and deadline', async () => {
  const v = await actions.validateAction('update_task', { taskTitle: 'Write copy', setStatus: 'inProgress', setDeadline: '2026-12-01' }, ctx());
  assert.ok(v.echo.setDeadline.includes('2026-12')); // echo is JSON-safe
  await actions.executeAction('update_task', v.echo, ctx());
  assert.strictEqual((await get('tasks', 't3')).status, 'inProgress');
  await assert.rejects(() => actions.validateAction('update_task', { taskTitle: 'Write copy', setStatus: 'todo' }, ctx({ uid: 'emp1', isEmployee: true })), /only change tasks assigned to you/);
});

test('schedule_lead_call (reminder) puts a call on the calendar linked to the lead', async () => {
  const v = await actions.validateAction('schedule_lead_call', { leadName: 'Ravi Sharma', callType: 'reminder', startTime: future(), note: 'Discuss pricing' }, ctx());
  const r = await actions.executeAction('schedule_lead_call', v.echo, ctx());
  assert.strictEqual(r.entity, 'calendar_event');
  const ev = (await all('calendar_events')).find((e) => e.linkedId === 'l1');
  assert.strictEqual(ev.title, 'Call Ravi Sharma'); assert.strictEqual(ev.linkedTo, 'lead');
});
test('schedule_lead_call (ai) makes a batch of one and calls the voice service', async () => {
  const calls = [];
  const http = async (cfg) => { calls.push(cfg); return { data: { ok: true } }; };
  const v = await actions.validateAction('schedule_lead_call', { leadName: 'Ravi Verma', callType: 'ai', startTime: future(), productName: 'CRM Pro Pitch' }, ctx());
  assert.match(v.summary, /AI call to Ravi Verma/);
  const r = await actions.executeAction('schedule_lead_call', v.echo, ctx({ http }));
  assert.strictEqual(r.entity, 'voice_campaign');
  assert.match(calls[0].url, /\/v1\/batches\/.+\/schedule$/); assert.strictEqual(calls[0].data.productId, 'vp1');
  const lead = await get('leads', 'l2'); assert.ok(lead.batchId);
  const b = await get('lead_batches', lead.batchId); assert.strictEqual(b.mode, 'ai'); assert.match(b.name, /^Call: Ravi Verma/);
});
test('schedule_lead_call (ai): lead in a batch is not moved silently; no phone and no product are explained', async () => {
  const t = future();
  await assert.rejects(() => actions.validateAction('schedule_lead_call', { leadName: 'Meena', callType: 'ai', startTime: t, productName: 'CRM Pro Pitch' }, ctx()), /already in the batch "Diwali list"/);
  await assert.rejects(() => actions.validateAction('schedule_lead_call', { leadName: 'NoPhone', callType: 'ai', startTime: t, productName: 'CRM Pro Pitch' }, ctx()), /no phone number/);
  await assert.rejects(() => actions.validateAction('schedule_lead_call', { leadName: 'Ravi Sharma', callType: 'ai', startTime: t, productName: 'Nope' }, ctx()), /No Astric Voice product/);
  await assert.rejects(() => actions.validateAction('schedule_lead_call', { leadName: 'Ravi Sharma', callType: 'ai', startTime: '2020-01-01T10:00:00', productName: 'CRM Pro Pitch' }, ctx()), /in the past/);
});
test('schedule_lead_call (ai): if the voice service refuses, nothing is left behind', async () => {
  const before = (await all('lead_batches')).length;
  const http = async () => { const e = new Error('x'); e.response = { data: { detail: 'No minutes left' } }; throw e; };
  const v = await actions.validateAction('schedule_lead_call', { leadName: 'Ravi Sharma', callType: 'ai', startTime: future(), productName: 'CRM Pro Pitch' }, ctx());
  await assert.rejects(() => actions.executeAction('schedule_lead_call', v.echo, ctx({ http })), /No minutes left/);
  assert.strictEqual((await all('lead_batches')).length, before);
  assert.ok(!(await get('leads', 'l1')).batchId);
});
