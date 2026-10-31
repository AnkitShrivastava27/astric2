/**
 * services/agentActions.js  —  everything Agent Mode can DO.
 *
 *  READ tools   run immediately while the model is thinking (search the web, look at the calendar, find leads,
 *               business snapshot, list team/products/batches, voice setup status). They never change anything.
 *  WRITE tools  are only PROPOSED (validate -> human summary). Nothing is written until the user confirms; then
 *               executeAction() re-validates from scratch and performs it. Several write tools in one prompt are
 *               bundled into one "plan" that the user confirms once (see routes/agent.js).
 *
 * Names, not ids: the model refers to employees / teams / batches / products by NAME and this file resolves them,
 * including things created earlier in the same plan (ctx.planned), so "create a batch, then call it tomorrow" works.
 */
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { webSearch } = require('./webSearch');

const fb = () => require('../config/firebase');           // lazy: tests swap this module out
const ing = () => require('./leadIngest');

const STAGES = ['new_', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const PRIORITIES = ['hot', 'warm', 'cold'];
const SOURCES = ['facebookAds', 'googleAds', 'websiteForm', 'whatsapp', 'referral', 'coldCall', 'linkedin', 'manualWalkIn', 'other'];
const DEFAULT_TZ = 'Asia/Kolkata';
const MAX_SCAN = 2000;
const MAX_BULK_WRITE = 500;

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// small helpers
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
const digits = (s) => String(s || '').replace(/\D/g, '');
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const orgRef = (ctx) => fb().db.collection('users').doc(ctx.orgOwnerUid);
const plan = (ctx) => (ctx.planned = ctx.planned || { batches: new Set(), voiceProducts: new Set() });

function requireString(p, f, { max = 500 } = {}) {
  const v = p[f];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${f}" is required.`);
  if (v.length > max) throw new Error(`"${f}" is too long.`);
  return v.trim();
}
function optString(p, f, { max = 2000 } = {}) {
  const v = p[f];
  if (v == null) return '';
  if (typeof v !== 'string') throw new Error(`"${f}" must be text.`);
  return v.slice(0, max).trim();
}
function requireDate(p, f) {
  const d = new Date(p[f]);
  if (!p[f] || isNaN(d.getTime())) throw new Error(`"${f}" must be a valid date/time.`);
  return d;
}
function requireEnum(p, f, allowed, fallback) {
  const v = p[f];
  if (v == null || v === '') return fallback;
  if (!allowed.includes(v)) throw new Error(`"${f}" must be one of: ${allowed.join(', ')}`);
  return v;
}
function requireNumber(p, f, { min = -Infinity, max = Infinity } = {}) {
  const v = Number(p[f]);
  if (Number.isNaN(v)) throw new Error(`"${f}" must be a number.`);
  if (v < min || v > max) throw new Error(`"${f}" is out of range.`);
  return v;
}
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

async function loadAll(colRef, limit = 1000) {
  const snap = await colRef.limit(limit).get();
  const out = [];
  snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
  return out;
}
const toDate = (v) => (v && typeof v.toDate === 'function' ? v.toDate() : v instanceof Date ? v : v ? new Date(v) : null);

/** Wall-clock string the calendar stores: "2026-10-27T10:00:00.000" (no zone). */
function toWall(v, tz = DEFAULT_TZ) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''));
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(v))) return `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}.000`;   // already wall-clock
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error('invalid date/time');
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000`;
}

/** An ISO string WITH an offset is exact; one without is read as wall-clock time in `tz`. Returns a UTC Date. */
function parseInTz(v, tz = DEFAULT_TZ) {
  const s = String(v || '');
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { const d = new Date(s); if (isNaN(d.getTime())) throw new Error('invalid date/time'); return d; }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s) || /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('invalid date/time');
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const wall = (ms) => Date.parse(toWall(new Date(ms).toISOString(), tz).slice(0, 19) + 'Z');
  let guess = asUtc;
  for (let i = 0; i < 2; i++) guess = asUtc - (wall(guess) - guess);          // converge on the zone's offset (handles DST)
  return new Date(guess);
}

// ── lookups by NAME ────────────────────────────────────────────────────────────────────────────────────────
function pickByName(items, name, label, key = 'name') {
  const n = norm(name);
  if (!n) return null;
  const exact = items.filter((x) => norm(x[key]) === n);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`More than one ${label} is called "${name}". Please use a more specific name.`);
  const part = items.filter((x) => norm(x[key]).includes(n) || (n.includes(norm(x[key])) && norm(x[key]).length > 2));
  if (part.length === 1) return part[0];
  if (part.length > 1) throw new Error(`"${name}" matches several ${label}s (${part.slice(0, 5).map((x) => x[key]).join(', ')}). Which one?`);
  return null;
}
const employees = async (ctx) => (ctx._emps = ctx._emps || (await loadAll(orgRef(ctx).collection('employees'))).filter((e) => e.isActive !== false));
const teams = async (ctx) => (ctx._teams = ctx._teams || await loadAll(orgRef(ctx).collection('teams'), 200));
const batches = async (ctx) => loadAll(orgRef(ctx).collection('lead_batches'), 500);          // fresh: plans may create some
const voiceProducts = async (ctx) => loadAll(orgRef(ctx).collection('voice_products'), 200);

async function resolveEmployees(ctx, names) {
  const all = await employees(ctx);
  const out = [];
  for (const n of names) {
    const e = pickByName(all, n, 'employee');
    if (!e) throw new Error(`No employee named "${n}" found in this organization.`);
    if (!out.some((x) => x.id === e.id)) out.push(e);
  }
  return out;
}

// ── lead filtering ─────────────────────────────────────────────────────────────────────────────────────────
const FILTER_PROPS = {
  stage: { type: 'string', enum: STAGES, description: 'Lead status/stage.' },
  priority: { type: 'string', enum: PRIORITIES },
  source: { type: 'string', enum: SOURCES },
  batchName: { type: 'string', description: 'Only leads inside this existing batch.' },
  search: { type: 'string', description: 'Text to find in name, company, email or phone.' },
  createdFrom: { type: 'string', description: 'YYYY-MM-DD; leads created on/after this day.' },
  createdTo: { type: 'string', description: 'YYYY-MM-DD; leads created on/before this day.' },
};

function cleanFilter(f) {
  f = f && typeof f === 'object' ? f : {};
  const out = {};
  if (f.stage) out.stage = requireEnum(f, 'stage', STAGES);
  if (f.priority) out.priority = requireEnum(f, 'priority', PRIORITIES);
  if (f.source) out.source = requireEnum(f, 'source', SOURCES);
  if (f.batchName) out.batchName = clip(f.batchName, 80);
  if (f.search) out.search = clip(f.search, 80);
  if (f.createdFrom) out.createdFrom = clip(f.createdFrom, 10);
  if (f.createdTo) out.createdTo = clip(f.createdTo, 10);
  return out;
}
const describeFilter = (f) => Object.entries(f).map(([k, v]) => `${k === 'stage' ? 'status' : k} = ${v}`).join(', ') || 'all leads';

async function matchLeads(ctx, filter, { onlyUnbatched = false } = {}) {
  const f = cleanFilter(filter);
  let q = orgRef(ctx).collection('leads');
  let batchId = '';
  if (f.batchName) {
    const b = pickByName(await batches(ctx), f.batchName, 'batch');
    if (!b) throw new Error(`No batch named "${f.batchName}" found.`);
    batchId = b.id;
  }
  if (f.stage) q = q.where('stage', '==', f.stage);
  else if (f.priority) q = q.where('priority', '==', f.priority);
  else if (f.source) q = q.where('source', '==', f.source);
  else if (batchId) q = q.where('batchId', '==', batchId);
  const snap = await q.limit(MAX_SCAN).get();
  const from = f.createdFrom ? new Date(`${f.createdFrom}T00:00:00`) : null;
  const to = f.createdTo ? new Date(`${f.createdTo}T23:59:59`) : null;
  const s = norm(f.search), sd = digits(f.search);
  const rows = [];
  let skippedBatched = 0;
  snap.forEach((d) => {
    const l = d.data();
    if (!canSee(ctx, l)) return;
    if (f.priority && l.priority !== f.priority) return;
    if (f.source && l.source !== f.source) return;
    if (batchId && l.batchId !== batchId) return;
    if (from || to) { const c = toDate(l.createdAt); if (!c || (from && c < from) || (to && c > to)) return; }
    if (s && !(norm(l.name).includes(s) || norm(l.company).includes(s) || norm(l.email).includes(s) || (sd.length >= 4 && digits(l.phone).includes(sd)))) return;
    if (onlyUnbatched && l.batchId) { skippedBatched++; return; }
    rows.push({ id: d.id, ...l });
  });
  return { rows, skippedBatched, filter: f, scanned: snap.size, truncated: snap.size >= MAX_SCAN };
}

// ── who may see what ─────────────────────────────────────────────────────────────────────────────────────
// Same rule as the app / Firestore rules: the admin sees every lead; an employee only the leads shared with them.
const canSee = (ctx, l) => !ctx.isEmployee || (Array.isArray(l.visibleTo) && l.visibleTo.includes(ctx.uid)) || l.createdBy === ctx.uid;

const iso = (v) => { const d = toDate(v); return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''; };
const day = (v) => iso(v).slice(0, 10);

/** One lead by id, name, phone or email. Several matches -> an error that lists them so the user can pick. */
async function findLead(ctx, a) {
  a = a || {};
  if (a.leadId) {
    const s = await orgRef(ctx).collection('leads').doc(String(a.leadId)).get();
    if (s.exists && canSee(ctx, s.data())) return { id: s.id, ...s.data() };
  }
  const q = clip(a.leadName || a.name || a.phone || a.email || a.search || '', 80).trim();
  if (!q) throw new Error('Tell me which lead (a name, phone number or email).');
  const { rows } = await matchLeads(ctx, { search: q });
  if (!rows.length) throw new Error(`I couldn't find a lead matching "${q}".`);
  const exact = rows.filter((l) => norm(l.name) === norm(q) || norm(l.email) === norm(q) || (digits(q).length >= 6 && digits(l.phone).endsWith(digits(q).slice(-10))));
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  throw new Error(`"${q}" matches ${rows.length} leads: ${rows.slice(0, 5).map((l) => `${l.name}${l.phone ? ` (${l.phone})` : ''}`).join(', ')}${rows.length > 5 ? '…' : ''}. Which one? Give the phone number or full name.`);
}
async function findCustomer(ctx, a) {
  a = a || {};
  const q = clip(a.customerName || a.name || a.phone || a.email || a.search || '', 80).trim();
  if (!q) throw new Error('Tell me which customer (a name, phone number or email).');
  const all = await loadAll(orgRef(ctx).collection('customers'), 1000);
  const n = norm(q), d = digits(q);
  const rows = all.filter((c) => norm(c.name).includes(n) || norm(c.email) === n || (d.length >= 6 && digits(c.phone).endsWith(d.slice(-10))));
  if (!rows.length) throw new Error(`I couldn't find a customer matching "${q}".`);
  const exact = rows.filter((c) => norm(c.name) === n);
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  throw new Error(`"${q}" matches ${rows.length} customers: ${rows.slice(0, 5).map((c) => c.name).join(', ')}. Which one?`);
}
const recentActivities = (arr, n = 8) => (Array.isArray(arr) ? arr : []).map((a) => ({ type: a.type || 'note', note: clip(a.note, 240), by: a.createdBy || '', at: iso(a.createdAt) }))
  .sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, n);
const taskBrief = (t) => ({ title: t.title, status: t.status, priority: t.priority, assignedTo: t.assignedTo || '', due: day(t.deadline), overdue: !!(toDate(t.deadline) && toDate(t.deadline) < new Date() && t.status !== 'done') });
const nameOfBatch = async (ctx, id) => { if (!id) return ''; const b = (await batches(ctx)).find((x) => x.id === id); return b ? b.name : ''; };

const leadBrief = (l) => ({
  id: l.id, name: l.name, phone: l.phone || '', email: l.email || '', company: l.company || '', stage: l.stage, priority: l.priority,
  source: l.source, createdAt: toDate(l.createdAt) ? toDate(l.createdAt).toISOString().slice(0, 10) : '', inBatch: !!l.batchId,
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// TOOL SCHEMAS (OpenAI-compatible)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const dateHelp = 'Local date/time like 2026-10-27T10:00:00 (no timezone) or with an offset like +05:30.';

const READ_TOOLS = [
  fn('web_search', 'Search the web (DuckDuckGo) for current / real-time information: news, prices, rates, weather, sports, facts that may have changed, company or competitor info.',
    { query: { type: 'string' }, recency: { type: 'string', enum: ['day', 'week', 'month', 'year'] } }, ['query']),
  fn('get_calendar', 'Look at the calendar: meetings and events (including meetings booked through the booking page) between two dates.',
    { fromDate: { type: 'string', description: 'YYYY-MM-DD' }, toDate: { type: 'string', description: 'YYYY-MM-DD, defaults to fromDate' } }, ['fromDate']),
  fn('find_leads', 'Search the leads. Use countOnly for "how many".', { ...FILTER_PROPS, limit: { type: 'number' }, countOnly: { type: 'boolean' } }),
  fn('business_snapshot', 'Current numbers: leads per status, tasks by status, customers, employees, meetings today, voice minutes left. Use for "how are we doing" / "summary".'),
  fn('list_items', 'List names of things in the workspace so you can refer to them exactly.',
    { kind: { type: 'string', enum: ['employees', 'teams', 'batches', 'voice_products'] } }, ['kind']),
  fn('get_lead_details', 'Everything about ONE lead: contact details, status, priority, source, product, batch, estimated value, notes, recent activity and follow-ups. Use when the user asks about a specific lead/person ("tell me about Ravi", "what happened with the Sharma lead", "what is X\'s number").',
    { leadName: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, leadId: { type: 'string' } }),
  fn('get_customer_details', 'Everything about ONE customer: contact details, notes, recent activity, linked projects and invoices.', { customerName: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' } }),
  fn('find_tasks', 'Search tasks. Use for "what is overdue", "tasks for Priya", "open tasks in project X".',
    { status: { type: 'string', enum: ['todo', 'inProgress', 'done', 'open'], description: 'open = not done.' }, assignee: { type: 'string' }, projectName: { type: 'string' },
      overdue: { type: 'boolean' }, search: { type: 'string' }, limit: { type: 'number' }, countOnly: { type: 'boolean' } }),
  fn('get_project_details', 'One project: status, linked customer, task progress, overdue and open tasks.', { projectName: { type: 'string' } }, ['projectName']),
  fn('find_invoices', 'Search invoices by status or client; returns totals too.', { status: { type: 'string', enum: ['draft', 'sent', 'paid', 'overdue'] }, clientName: { type: 'string' }, limit: { type: 'number' } }),
  fn('list_products', 'The products/services the company sells (name, price, status, features).', { search: { type: 'string' } }),
  fn('voice_setup_status', 'Check how far Astric Voice (AI calling) is set up: phone provider, company info, products, minutes, scheduled campaigns - and what to do next.'),
];

const WRITE_TOOLS = [
  fn('create_lead', 'Create one lead.', { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, company: { type: 'string' },
    stage: { type: 'string', enum: STAGES }, priority: { type: 'string', enum: PRIORITIES }, estimatedValue: { type: 'number' }, notes: { type: 'string' } }, ['name']),
  fn('bulk_create_leads', 'Create many leads at once (e.g. from a pasted list), optionally putting them all in one new or existing batch.',
    { leads: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' }, notes: { type: 'string' } }, required: ['name'] } },
      batchName: { type: 'string' }, stage: { type: 'string', enum: STAGES }, priority: { type: 'string', enum: PRIORITIES } }, ['leads']),
  fn('create_lead_batch', 'Group EXISTING leads that match a filter (e.g. status = interested) into a new named batch, so they can be assigned or called together.',
    { name: { type: 'string', description: 'Name for the new batch.' }, ...FILTER_PROPS, includeAlreadyBatched: { type: 'boolean', description: 'Also move leads that are already in another batch. Default false.' } }, ['name']),
  fn('update_leads', 'Change the status and/or priority of existing leads that match a filter (at least one filter is required).',
    { ...FILTER_PROPS, setStage: { type: 'string', enum: STAGES }, setPriority: { type: 'string', enum: PRIORITIES } }),
  fn('create_customer', 'Create a customer record.', { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, notes: { type: 'string' } }, ['name']),
  fn('create_task', 'Create a task, optionally for one or more employees or a whole team (each person gets their own copy).',
    { title: { type: 'string' }, description: { type: 'string' }, assignedTo: { type: 'array', items: { type: 'string' }, description: 'Employee names.' }, teamName: { type: 'string', description: 'Give the task to every member of this team.' },
      deadline: { type: 'string', description: 'ISO 8601 date/time.' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, projectName: { type: 'string' } }, ['title', 'deadline']),
  fn('assign_task', 'Assign the same task to one or more employees and/or a whole team. Each person gets their own copy.',
    { title: { type: 'string' }, description: { type: 'string' }, employeeNames: { type: 'array', items: { type: 'string' } }, teamName: { type: 'string' },
      deadline: { type: 'string', description: 'ISO 8601 date/time.' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, projectName: { type: 'string' } }, ['title', 'deadline']),
  fn('create_project', 'Create a project.', { name: { type: 'string' }, description: { type: 'string' }, customerName: { type: 'string' } }, ['name']),
  fn('create_calendar_event', 'Add a meeting/event to the calendar.',
    { title: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, startTime: { type: 'string', description: dateHelp }, endTime: { type: 'string', description: dateHelp },
      isAllDay: { type: 'boolean' }, invitedEmployeeNames: { type: 'array', items: { type: 'string' } } }, ['title', 'startTime', 'endTime']),
  fn('create_invoice', 'Create a draft invoice.', { clientName: { type: 'string' }, clientEmail: { type: 'string' }, companyName: { type: 'string' }, dueDate: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: 'number' }, unitPrice: { type: 'number' } }, required: ['description', 'quantity', 'unitPrice'] } }, notes: { type: 'string' } }, ['clientName', 'items']),
  fn('add_note', 'Save a note. Optionally attach it to a lead, customer or project (it then also shows in that lead/customer\'s history).',
    { content: { type: 'string' }, title: { type: 'string' }, attachTo: { type: 'string', enum: ['lead', 'customer', 'project', 'none'] }, attachName: { type: 'string', description: 'Name of the lead/customer/project.' } }, ['content']),
  fn('update_lead', 'Change ONE specific lead: status, priority, estimated value, phone, email or company. (For many leads at once use update_leads.)',
    { leadName: { type: 'string' }, phone: { type: 'string' }, leadId: { type: 'string' }, setStage: { type: 'string', enum: STAGES }, setPriority: { type: 'string', enum: PRIORITIES },
      setEstimatedValue: { type: 'number' }, setPhone: { type: 'string' }, setEmail: { type: 'string' }, setCompany: { type: 'string' } }),
  fn('schedule_lead_call', 'Schedule an OUTBOUND CALL to ONE lead. callType "ai" = the Astric Voice AI phones them at that time (needs a voice product); "reminder" = a calendar reminder for a human to call.',
    { leadName: { type: 'string' }, phone: { type: 'string' }, leadId: { type: 'string' }, callType: { type: 'string', enum: ['ai', 'reminder'] },
      startTime: { type: 'string', description: dateHelp }, productName: { type: 'string', description: 'Voice product (AI calls only).' }, note: { type: 'string', description: 'What the call is about.' },
      moveFromBatch: { type: 'boolean', description: 'Only if the lead is already in another batch and the user agreed to move them.' } }, ['startTime']),
  fn('update_task', 'Change ONE existing task: status, deadline or priority.', { taskTitle: { type: 'string' }, setStatus: { type: 'string', enum: ['todo', 'inProgress', 'done'] },
    setDeadline: { type: 'string' }, setPriority: { type: 'string', enum: ['low', 'medium', 'high'] } }, ['taskTitle']),
  fn('create_voice_product', 'Create a product/service for Astric Voice (AI calling) with the pitch the AI caller will use.',
    { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'string', description: 'Price or offer as text, e.g. "Rs 4,999 / month".' }, goal: { type: 'string', description: 'What the call should achieve, e.g. "book a demo".' },
      pitch: { type: 'string' }, features: { type: 'array', items: { type: 'string' } },
      objections: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } } }, ['name']),
  fn('schedule_voice_calls', 'Start or schedule AI calling (Astric Voice) for a batch of leads, now or at a future time.',
    { batchName: { type: 'string' }, productName: { type: 'string', description: 'The Astric Voice product to talk about.' },
      startTime: { type: 'string', description: `When to start. ${dateHelp} Omit to start now.` }, provider: { type: 'string', enum: ['auto', 'vobiz', 'telnyx'] } }, ['batchName', 'productName']),
];

const TOOLS = [...READ_TOOLS, ...WRITE_TOOLS];
const READ_NAMES = new Set(READ_TOOLS.map((t) => t.function.name));

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// READ TOOLS
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function runReadTool(name, args, ctx) {
  args = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'web_search': {
      const r = await webSearch(String(args.query || ''), { recency: args.recency, max: 5 });
      (ctx.sources = ctx.sources || []).push(...r.results.map((x) => ({ title: x.title, url: x.url })));
      return r.results.length ? { results: r.results } : { results: [], note: `Search unavailable: ${r.error || 'no results'}. Say you could not look it up.` };
    }
    case 'get_calendar': {
      const from = requireString(args, 'fromDate', { max: 10 });
      const to = args.toDate ? String(args.toDate).slice(0, 10) : from;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Dates must look like 2026-10-27.');
      const end = new Date(`${to}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
      const snap = await orgRef(ctx).collection('calendar_events')
        .where('startTime', '>=', `${from}T00:00`).where('startTime', '<', `${end.toISOString().slice(0, 10)}T00:00`).limit(200).get();
      const ev = [];
      snap.forEach((d) => { const e = d.data(); ev.push({ title: e.title, start: String(e.startTime).slice(0, 16).replace('T', ' '), end: String(e.endTime || '').slice(0, 16).replace('T', ' '),
        location: e.location || '', allDay: !!e.isAllDay, bookedOnline: e.source === 'booking', details: clip(e.description, 160) }); });
      ev.sort((a, b) => a.start.localeCompare(b.start));
      return { from, to, count: ev.length, events: ev.slice(0, 40) };
    }
    case 'find_leads': {
      const m = await matchLeads(ctx, args);
      const limit = Math.max(1, Math.min(Number(args.limit) || 15, 30));
      return { total: m.rows.length, ...(m.truncated ? { note: `Only the first ${MAX_SCAN} leads were scanned.` } : {}), filter: m.filter,
        ...(args.countOnly ? {} : { leads: m.rows.slice(0, limit).map(leadBrief) }) };
    }
    case 'business_snapshot': {
      const base = orgRef(ctx);
      const count = async (q) => { try { return (await q.count().get()).data().count; } catch (_) { return (await q.get()).size; } };
      const [leadsByStage, taskTodo, taskProg, taskDone, customers, emps] = await Promise.all([
        Promise.all(STAGES.map(async (s) => [s, await count(base.collection('leads').where('stage', '==', s))])),
        count(base.collection('tasks').where('status', '==', 'todo')), count(base.collection('tasks').where('status', '==', 'inProgress')),
        count(base.collection('tasks').where('status', '==', 'done')), count(base.collection('customers')), count(base.collection('employees')),
      ]);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: DEFAULT_TZ });
      const tomorrow = new Date(Date.now() + 86400e3).toLocaleDateString('en-CA', { timeZone: DEFAULT_TZ });
      const meetings = await count(base.collection('calendar_events').where('startTime', '>=', `${today}T00:00`).where('startTime', '<', `${tomorrow}T00:00`));
      let minutesLeft = null;
      try { const w = (await base.collection('voice').doc('wallet').get()).data(); if (w) minutesLeft = Math.max(0, Number(w.minutesPurchased || 0) - Number(w.minutesUsed || 0)); } catch (_) {}
      const stages = Object.fromEntries(leadsByStage);
      return { leadsByStatus: stages, totalLeads: Object.values(stages).reduce((a, b) => a + b, 0),
        tasks: { todo: taskTodo, inProgress: taskProg, done: taskDone }, customers, employees: emps, meetingsToday: meetings, voiceMinutesLeft: minutesLeft };
    }
    case 'list_items': {
      const kind = requireEnum(args, 'kind', ['employees', 'teams', 'batches', 'voice_products'], '');
      if (kind === 'employees') return { employees: (await employees(ctx)).slice(0, 80).map((e) => ({ name: e.name, role: e.role || e.designation || '', department: e.department || '' })) };
      if (kind === 'teams') return { teams: (await teams(ctx)).slice(0, 50).map((t) => ({ name: t.name, members: (t.members || []).map((m) => m.name) })) };
      if (kind === 'batches') return { batches: (await batches(ctx)).slice(0, 80).map((b) => ({ name: b.name, mode: b.mode || 'manual', voiceStatus: (b.voice && b.voice.status) || '' })) };
      if (kind === 'voice_products') return { products: (await voiceProducts(ctx)).slice(0, 50).map((p) => ({ name: p.name, active: p.active !== false, price: p.price || '', goal: p.goal || '' })) };
      throw new Error('kind is required.');
    }
    case 'get_lead_details': {
      const l = await findLead(ctx, args);
      const b = await nameOfBatch(ctx, l.batchId);
      return {
        id: l.id, name: l.name, phone: l.phone || '', email: l.email || '', company: l.company || '', status: l.stage, priority: l.priority, source: l.source,
        sourceDetail: l.sourceCustom || '', product: l.productName || '', batch: b, estimatedValue: l.estimatedValue == null ? null : l.estimatedValue,
        assignedTo: l.assignedTo || l.ownerName || 'Unassigned', created: day(l.createdAt), notes: clip(l.notes, 800),
        customFields: l.customFields || {}, categories: l.categories || [],
        followUps: (Array.isArray(l.followUps) ? l.followUps : []).slice(0, 5).map((f) => ({ note: clip(f.note || f.title, 160), due: day(f.dueDate || f.date || f.dueAt), done: !!(f.isDone || f.done || f.completed) })),
        recentActivity: recentActivities(l.activities),
      };
    }
    case 'get_customer_details': {
      const c = await findCustomer(ctx, args);
      const base = orgRef(ctx);
      const [projects, invoices] = await Promise.all([
        loadAll(base.collection('projects'), 300).then((all) => all.filter((p) => p.linkedCustomerId === c.id).map((p) => ({ name: p.name, status: p.status || '' }))),
        c.email ? loadAll(base.collection('invoices').where('clientEmail', '==', c.email), 50).then((all) => all.map((i) => ({ number: i.invoiceNumber, status: i.status, due: day(i.dueDate), total: (i.items || []).reduce((t, it) => t + (+it.quantity || 0) * (+it.unitPrice || 0), 0) }))) : [],
      ]);
      return { id: c.id, name: c.name, phone: c.phone || '', email: c.email || '', company: c.company || '', notes: clip(c.notes, 800), customFields: c.customFields || {}, since: day(c.createdAt), projects, invoices, recentActivity: recentActivities(c.activities) };
    }
    case 'find_tasks': {
      const all = await loadAll(orgRef(ctx).collection('tasks'), 1500);
      let projectId = '';
      if (args.projectName) { const pr = pickByName(await loadAll(orgRef(ctx).collection('projects'), 300), args.projectName, 'project'); if (!pr) throw new Error(`No project named "${args.projectName}".`); projectId = pr.id; }
      const who = norm(args.assignee), q = norm(args.search);
      const rows = all.filter((t) => {
        if (ctx.isEmployee && t.assigneeId !== ctx.uid) return false;          // employees see only their own tasks
        if (args.status === 'open' ? t.status === 'done' : args.status && t.status !== args.status) return false;
        if (who && !norm(t.assignedTo).includes(who)) return false;
        if (projectId && t.projectId !== projectId) return false;
        if (q && !(norm(t.title).includes(q) || norm(t.description).includes(q))) return false;
        if (args.overdue && !(toDate(t.deadline) && toDate(t.deadline) < new Date() && t.status !== 'done')) return false;
        return true;
      }).sort((a, b) => (toDate(a.deadline) || 0) - (toDate(b.deadline) || 0));
      const limit = Math.max(1, Math.min(Number(args.limit) || 15, 30));
      return { total: rows.length, ...(args.countOnly ? {} : { tasks: rows.slice(0, limit).map(taskBrief) }) };
    }
    case 'get_project_details': {
      const pr = pickByName(await loadAll(orgRef(ctx).collection('projects'), 300), requireString(args, 'projectName'), 'project');
      if (!pr) throw new Error(`No project named "${args.projectName}".`);
      const tasks = (await loadAll(orgRef(ctx).collection('tasks'), 1500)).filter((t) => t.projectId === pr.id);
      const by = (st) => tasks.filter((t) => t.status === st).length;
      const cust = pr.linkedCustomerId ? (await orgRef(ctx).collection('customers').doc(pr.linkedCustomerId).get()) : null;
      const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => (toDate(a.deadline) || 0) - (toDate(b.deadline) || 0));
      return { id: pr.id, name: pr.name, description: clip(pr.description, 500), status: pr.status || '', customer: cust && cust.exists ? cust.data().name : '', created: day(pr.createdAt),
        tasks: { total: tasks.length, todo: by('todo'), inProgress: by('inProgress'), done: by('done'), overdue: open.filter((t) => taskBrief(t).overdue).length,
          percentDone: tasks.length ? Math.round((by('done') / tasks.length) * 100) : 0 }, openTasks: open.slice(0, 10).map(taskBrief) };
    }
    case 'find_invoices': {
      const all = await loadAll(orgRef(ctx).collection('invoices'), 1000);
      const q = norm(args.clientName);
      const total = (i) => (i.items || []).reduce((t, it) => t + (+it.quantity || 0) * (+it.unitPrice || 0), 0);
      const isOverdue = (i) => i.status !== 'paid' && toDate(i.dueDate) && toDate(i.dueDate) < new Date();
      const rows = all.filter((i) => (!q || norm(i.clientName).includes(q)) && (!args.status || (args.status === 'overdue' ? isOverdue(i) : i.status === args.status)));
      const limit = Math.max(1, Math.min(Number(args.limit) || 10, 25));
      return { count: rows.length, totalAmount: Math.round(rows.reduce((t, i) => t + total(i), 0) * 100) / 100,
        invoices: rows.slice(0, limit).map((i) => ({ number: i.invoiceNumber, client: i.clientName, status: isOverdue(i) && i.status !== 'draft' ? 'overdue' : i.status, due: day(i.dueDate), total: total(i) })) };
    }
    case 'list_products': {
      const q = norm(args.search);
      const all = (await loadAll(orgRef(ctx).collection('products'), 200)).filter((p) => p.active !== false && (!q || norm(p.name).includes(q)));
      return { count: all.length, products: all.slice(0, 40).map((p) => ({ name: p.name, tagline: p.tagline || '', price: p.rate == null ? 'not priced' : `${p.rate}${p.rateUnit ? ` (${p.rateUnit})` : ''}`, status: p.status || '', features: (p.features || []).slice(0, 6), description: clip(p.description, 200) })) };
    }
    case 'voice_setup_status': return voiceSetupStatus(ctx);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

async function voiceSetupStatus(ctx) {
  const base = orgRef(ctx);
  const get = async (col, doc) => { try { const s = await base.collection(col).doc(doc).get(); return s.exists ? s.data() : null; } catch (_) { return null; } };
  const [settings, info, wallet, secrets] = await Promise.all([get('voice', 'settings'), get('voice', 'info'), get('voice', 'wallet'), get('voice_secrets', 'telephony')]);
  const prods = (await voiceProducts(ctx)).filter((p) => p.active !== false);
  const bs = await batches(ctx);
  const aiBatches = bs.filter((b) => b.mode === 'ai');
  const scheduled = aiBatches.filter((b) => b.voice && ['scheduled', 'running', 'paused'].includes(b.voice.status));
  const carriers = secrets ? ['vobiz', 'telnyx'].filter((k) => secrets[k]) : [];
  const minutes = wallet ? Math.max(0, Number(wallet.minutesPurchased || 0) - Number(wallet.minutesUsed || 0)) : 0;
  const hasInfo = !!(info && (info.about || info.description || info.services || (info.faq || []).length));
  const steps = [];
  if (!carriers.length) steps.push('Add your Vobiz or Telnyx account in Astric Voice → Settings (the app cannot do this for you: it needs your private keys).');
  if (!hasInfo) steps.push('Fill in company details and FAQs in Astric Voice → Company, so the AI can answer questions.');
  if (!prods.length) steps.push('Create a voice product (I can do this: tell me the product, price, and what the call should achieve).');
  if (minutes <= 0) steps.push('Buy call minutes in Astric Voice → Overview.');
  if (!settings) steps.push('Open Astric Voice → Settings once and press Save to set the agent name, language and calling hours.');
  if (!steps.length) steps.push('Ready. Pick a batch of leads and I can schedule the calls.');
  return { phoneProviders: carriers, companyInfoFilled: hasInfo, activeProducts: prods.map((p) => p.name), minutesLeft: minutes, aiBatches: aiBatches.length,
    campaigns: scheduled.map((b) => ({ batch: b.name, status: b.voice.status })), nextSteps: steps };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// WRITE: validate (never writes) -> { normalized, summary }
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
async function resolveAssignees(ctx, names, teamName) {
  const people = await resolveEmployees(ctx, names);
  let team = null;
  if (teamName) {
    team = pickByName(await teams(ctx), teamName, 'team');
    if (!team) throw new Error(`No team named "${teamName}" found.`);
    const all = await employees(ctx);
    for (const m of team.members || []) {
      const e = all.find((x) => x.id === m.uid);
      if (e && !people.some((p) => p.id === e.id)) people.push(e);
    }
    if (!people.length) throw new Error(`The team "${team.name}" has no active members.`);
  }
  return { people: people.map((e) => ({ id: e.id, name: e.name })), teamId: team ? team.id : '', teamName: team ? team.name : '' };
}

async function validateAction(type, params, ctx) {
  params = params && typeof params === 'object' ? params : {};
  switch (type) {
    case 'create_lead': {
      const name = requireString(params, 'name');
      const n = { name, email: optString(params, 'email', { max: 200 }), phone: optString(params, 'phone', { max: 40 }), company: optString(params, 'company', { max: 200 }),
        stage: requireEnum(params, 'stage', STAGES, 'new_'), priority: requireEnum(params, 'priority', PRIORITIES, 'warm'),
        estimatedValue: params.estimatedValue != null ? requireNumber(params, 'estimatedValue', { min: 0 }) : null, notes: optString(params, 'notes') };
      return { normalized: n, summary: `Create a lead for ${name}${n.company ? ` (${n.company})` : ''}${n.estimatedValue ? `, est. value ${n.estimatedValue}` : ''}.` };
    }
    case 'bulk_create_leads': {
      if (!Array.isArray(params.leads) || !params.leads.length) throw new Error('"leads" must be a list with at least one lead.');
      if (params.leads.length > 300) throw new Error('Up to 300 leads at a time.');
      const leads = params.leads.map((l, i) => {
        const name = requireString(l || {}, 'name');
        return { name, phone: optString(l, 'phone', { max: 40 }), email: optString(l, 'email', { max: 200 }), company: optString(l, 'company', { max: 200 }), notes: optString(l, 'notes', { max: 500 }) };
      });
      const batchName = optString(params, 'batchName', { max: 80 });
      if (batchName) plan(ctx).batches.add(norm(batchName));
      const n = { leads, batchName, stage: requireEnum(params, 'stage', STAGES, 'new_'), priority: requireEnum(params, 'priority', PRIORITIES, 'warm') };
      return { normalized: n, summary: `Add ${leads.length} lead${leads.length > 1 ? 's' : ''}${batchName ? ` in the batch "${batchName}"` : ''}: ${leads.slice(0, 4).map((l) => l.name).join(', ')}${leads.length > 4 ? '…' : ''}.` };
    }
    case 'create_lead_batch': {
      const name = requireString(params, 'name', { max: 80 });
      const filter = cleanFilter(params);
      if (!Object.keys(filter).length) throw new Error('Tell me which leads to group (for example a status, priority, or source).');
      const includeAlreadyBatched = !!params.includeAlreadyBatched;
      const dup = (await batches(ctx)).find((x) => norm(x.name) === norm(name));
      if (dup) throw new Error(`A batch called "${dup.name}" already exists. Choose another name.`);
      const m = await matchLeads(ctx, filter, { onlyUnbatched: !includeAlreadyBatched });
      if (!m.rows.length) throw new Error(`No leads match (${describeFilter(filter)})${m.skippedBatched ? `. ${m.skippedBatched} matching lead${m.skippedBatched > 1 ? 's are' : ' is'} already in another batch; say "include already batched leads" to move them.` : '.'}`);
      plan(ctx).batches.add(norm(name));
      return { normalized: { name, ...filter, includeAlreadyBatched },
        summary: `Create the batch "${name}" with ${m.rows.length} lead${m.rows.length > 1 ? 's' : ''} (${describeFilter(filter)})${m.skippedBatched ? `; ${m.skippedBatched} already in another batch will be left where they are` : ''}.` };
    }
    case 'update_leads': {
      const filter = cleanFilter(params);
      if (!Object.keys(filter).length) throw new Error('Tell me which leads to change (a status, priority, source, batch or name).');
      const setStage = requireEnum(params, 'setStage', STAGES, '');
      const setPriority = requireEnum(params, 'setPriority', PRIORITIES, '');
      if (!setStage && !setPriority) throw new Error('Nothing to change: give a new status or priority.');
      const m = await matchLeads(ctx, filter);
      if (!m.rows.length) throw new Error(`No leads match (${describeFilter(filter)}).`);
      if (m.rows.length > MAX_BULK_WRITE) throw new Error(`That would change ${m.rows.length} leads. Please narrow it down (max ${MAX_BULK_WRITE}).`);
      return { normalized: { ...filter, setStage, setPriority },
        summary: `Change ${m.rows.length} lead${m.rows.length > 1 ? 's' : ''} (${describeFilter(filter)}) → ${[setStage && `status = ${setStage}`, setPriority && `priority = ${setPriority}`].filter(Boolean).join(', ')}.` };
    }
    case 'create_customer': {
      const name = requireString(params, 'name');
      return { normalized: { name, email: optString(params, 'email', { max: 200 }), phone: optString(params, 'phone', { max: 40 }), notes: optString(params, 'notes') }, summary: `Create a customer record for ${name}.` };
    }
    case 'create_task':
    case 'assign_task': {
      const title = requireString(params, 'title', { max: 200 });
      const deadline = requireDate(params, 'deadline');
      const names = asList(params.employeeNames || params.employeeName || params.assignedTo);   // either spelling works, so the echoed params always round-trip
      const teamName = optString(params, 'teamName', { max: 80 });
      if (type === 'assign_task' && !names.length && !teamName) throw new Error('Who should get this task? Give one or more employee names, or a team.');
      const who = await resolveAssignees(ctx, names, teamName);
      let projectId = null, projectName = null;
      if (params.projectName) {
        const proj = pickByName(await loadAll(orgRef(ctx).collection('projects'), 300), params.projectName, 'project');
        if (proj) { projectId = proj.id; projectName = proj.name; }
      }
      const n = { title, description: optString(params, 'description'), deadline, priority: requireEnum(params, 'priority', ['low', 'medium', 'high'], 'medium'),
        assignees: who.people, teamId: who.teamId, projectId };
      const to = who.people.length ? (who.people.length > 3 ? `${who.people.length} people` : who.people.map((p) => p.name).join(', ')) : '';
      const echo = { title, description: n.description, deadline: deadline.toISOString(), priority: n.priority, assignedTo: who.people.map((x) => x.name), teamName: who.teamName, projectName: projectName || '' };
      return { normalized: n, echo, summary: `Create task "${title}"${to ? ` and assign it to ${to}${who.teamName ? ` (team ${who.teamName})` : ''}${who.people.length > 1 ? ' — each gets their own copy' : ''}` : ''}${projectName ? ` in project "${projectName}"` : ''}, due ${deadline.toDateString()}.` };
    }
    case 'create_project': {
      const name = requireString(params, 'name');
      let linkedCustomerId = null, customerName = null;
      if (params.customerName) {
        const c = pickByName(await loadAll(orgRef(ctx).collection('customers'), 500), params.customerName, 'customer');
        if (c) { linkedCustomerId = c.id; customerName = c.name; }
      }
      return { normalized: { name, description: optString(params, 'description'), linkedCustomerId }, echo: { name, description: optString(params, 'description'), customerName: customerName || '' }, summary: `Create project "${name}"${customerName ? ` linked to ${customerName}` : ''}.` };
    }
    case 'create_calendar_event': {
      const title = requireString(params, 'title', { max: 200 });
      const isAllDay = !!params.isAllDay;
      let start, end;
      try { start = toWall(params.startTime); end = toWall(params.endTime || params.startTime); } catch (_) { throw new Error('startTime and endTime must be valid dates/times.'); }
      if (isAllDay) { start = `${start.slice(0, 10)}T00:00:00.000`; end = `${end.slice(0, 10)}T00:00:00.000`; }
      if (end < start) throw new Error('endTime must be after startTime.');
      const invited = (await resolveEmployees(ctx, asList(params.invitedEmployeeNames).filter(Boolean)).catch(() => [])).map((e) => e.id);
      return { normalized: { title, description: optString(params, 'description'), location: optString(params, 'location', { max: 200 }), startTime: start, endTime: end, isAllDay, invitedEmployeeIds: invited },
        summary: `Add calendar event "${title}" on ${start.slice(0, 10)} at ${isAllDay ? 'all day' : start.slice(11, 16)}.` };
    }
    case 'create_invoice': {
      const clientName = requireString(params, 'clientName');
      const dueDate = params.dueDate ? requireDate(params, 'dueDate') : new Date(Date.now() + 14 * 86400e3);
      if (!Array.isArray(params.items) || !params.items.length) throw new Error('At least one invoice item is required.');
      const items = params.items.map((it) => ({ description: requireString(it, 'description', { max: 300 }), quantity: requireNumber(it, 'quantity', { min: 0.01, max: 1e6 }), unitPrice: requireNumber(it, 'unitPrice', { min: 0, max: 1e7 }) }));
      const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
      return { normalized: { clientName, clientEmail: optString(params, 'clientEmail', { max: 200 }), companyName: optString(params, 'companyName', { max: 200 }), dueDate, notes: optString(params, 'notes'), items },
        summary: `Create an invoice for ${clientName} totaling ${total.toFixed(2)} (${items.length} item${items.length > 1 ? 's' : ''}), due ${dueDate.toDateString()}.` };
    }
    case 'create_voice_product': {
      const name = requireString(params, 'name', { max: 120 });
      const existing = (await voiceProducts(ctx)).find((p) => norm(p.name) === norm(name));
      if (existing) throw new Error(`A voice product called "${existing.name}" already exists.`);
      const objections = (Array.isArray(params.objections) ? params.objections : []).slice(0, 10).map((o) => ({ q: clip(o && o.q, 200).trim(), a: clip(o && o.a, 500).trim() })).filter((o) => o.q && o.a);
      const n = { name, description: optString(params, 'description', { max: 1000 }), price: optString(params, 'price', { max: 120 }), goal: optString(params, 'goal', { max: 300 }) || 'Book a demo or a call back from the team',
        pitch: optString(params, 'pitch', { max: 1500 }), features: asList(params.features).slice(0, 12).map((f) => clip(f, 200)), objections };
      plan(ctx).voiceProducts.add(norm(name));
      return { normalized: n, summary: `Create the Astric Voice product "${name}"${n.price ? ` (${n.price})` : ''} — goal: ${n.goal}.` };
    }
    case 'schedule_voice_calls': {
      const batchName = requireString(params, 'batchName', { max: 80 });
      const productName = requireString(params, 'productName', { max: 120 });
      const planned = plan(ctx);
      const b = pickByName(await batches(ctx), batchName, 'batch');
      if (!b && !planned.batches.has(norm(batchName))) throw new Error(`No batch named "${batchName}" found. Create it first, or tell me which leads to group.`);
      const p = pickByName(await voiceProducts(ctx), productName, 'voice product');
      if (!p && !planned.voiceProducts.has(norm(productName))) throw new Error(`No Astric Voice product named "${productName}" found. I can create it: tell me the price and what the call should achieve.`);
      let startTime = '';
      let when = 'right away';
      if (params.startTime) {
        const d = parseInTz(params.startTime);
        if (d.getTime() < Date.now() - 60e3) throw new Error('That start time is in the past.');
        if (d.getTime() > Date.now() + 60 * 86400e3) throw new Error('Calls can be scheduled up to 60 days ahead.');
        startTime = d.toISOString();
        when = `on ${d.toLocaleString('en-IN', { timeZone: DEFAULT_TZ, dateStyle: 'medium', timeStyle: 'short' })} IST`;
      }
      const provider = requireEnum(params, 'provider', ['auto', 'vobiz', 'telnyx'], 'auto');
      return { normalized: { batchName: b ? b.name : batchName, productName: p ? p.name : productName, startTime, provider },
        summary: `Start AI calling for the batch "${b ? b.name : batchName}" with "${p ? p.name : productName}" ${when}${provider !== 'auto' ? ` using ${provider}` : ''}.` };
    }
    case 'add_note': {
      const content = requireString(params, 'content', { max: 4000 });
      const kind = requireEnum(params, 'attachTo', ['lead', 'customer', 'project', 'none'], 'none');
      const title = optString(params, 'title', { max: 120 }) || clip(content, 40).replace(/\s+/g, ' ');
      let target = null;
      if (kind !== 'none') {
        const name = requireString(params, 'attachName', { max: 120 });
        if (kind === 'lead') { const l = await findLead(ctx, { leadName: name, leadId: params.attachId }); target = { id: l.id, label: l.name }; }
        else if (kind === 'customer') { const c = await findCustomer(ctx, { customerName: name }); target = { id: c.id, label: c.name }; }
        else { const pr = pickByName(await loadAll(orgRef(ctx).collection('projects'), 300), name, 'project'); if (!pr) throw new Error(`No project named "${name}".`); target = { id: pr.id, label: pr.name }; }
      } else if (ctx.isEmployee) {
        throw new Error('Standalone notes are not available to team members in Agent Mode yet. Attach it to a lead or customer instead.');
      }
      const n = { title, content, attachTo: kind, attachName: target ? target.label : '', attachId: target ? target.id : '' };
      return { normalized: n, echo: n, summary: `Save the note "${title}"${target ? ` on the ${kind} ${target.label}` : ''}.` };
    }
    case 'update_lead': {
      const l = await findLead(ctx, params);
      const upd = {};
      const st = requireEnum(params, 'setStage', STAGES, ''); if (st) upd.stage = st;
      const pr = requireEnum(params, 'setPriority', PRIORITIES, ''); if (pr) upd.priority = pr;
      if (params.setEstimatedValue != null && params.setEstimatedValue !== '') upd.estimatedValue = requireNumber(params, 'setEstimatedValue', { min: 0, max: 1e10 });
      if (params.setPhone) upd.phone = optString(params, 'setPhone', { max: 40 });
      if (params.setEmail) upd.email = optString(params, 'setEmail', { max: 200 });
      if (params.setCompany) upd.company = optString(params, 'setCompany', { max: 200 });
      if (!Object.keys(upd).length) throw new Error('Nothing to change: tell me the new status, priority, value, phone, email or company.');
      if (upd.phone && digits(upd.phone) !== digits(l.phone)) throw new Error('Changing a phone number is not supported here because it must stay unique across your leads. Change it in the lead screen.');
      const label = Object.entries(upd).map(([k, v]) => `${k === 'stage' ? 'status' : k === 'estimatedValue' ? 'value' : k} → ${v}`).join(', ');
      const n = { leadId: l.id, leadName: l.name, ...Object.fromEntries(Object.entries(upd).map(([k, v]) => [`set${k[0].toUpperCase()}${k.slice(1)}`, v])) };
      return { normalized: n, echo: n, summary: `Update the lead ${l.name}: ${label}.` };
    }
    case 'schedule_lead_call': {
      const l = await findLead(ctx, params);
      const callType = requireEnum(params, 'callType', ['ai', 'reminder'], 'ai');
      if (!params.startTime) throw new Error('When should the call happen? Give a date and time.');
      const d = parseInTz(params.startTime);
      if (d.getTime() < Date.now() - 60e3) throw new Error('That time is in the past.');
      if (d.getTime() > Date.now() + 60 * 86400e3) throw new Error('Calls can be scheduled up to 60 days ahead.');
      const when = d.toLocaleString('en-IN', { timeZone: DEFAULT_TZ, dateStyle: 'medium', timeStyle: 'short' });
      const note = optString(params, 'note', { max: 500 });
      if (callType === 'reminder') {
        const n = { leadId: l.id, leadName: l.name, callType, startTime: d.toISOString(), note };
        return { normalized: n, echo: n, summary: `Add a calendar reminder to call ${l.name}${l.phone ? ` (${l.phone})` : ''} on ${when} IST.` };
      }
      if (!digits(l.phone)) throw new Error(`${l.name} has no phone number, so an AI call can't be placed. Add a number first, or use a reminder for a human call.`);
      const productName = requireString(params, 'productName', { max: 120 });
      const p = pickByName(await voiceProducts(ctx), productName, 'voice product');
      if (!p && !plan(ctx).voiceProducts.has(norm(productName))) throw new Error(`No Astric Voice product named "${productName}". I can create it: tell me the price and what the call should achieve.`);
      const cur = l.batchId ? await nameOfBatch(ctx, l.batchId) : '';
      if (l.batchId && !params.moveFromBatch) throw new Error(`${l.name} is already in the batch "${cur || 'another batch'}". I can schedule that whole batch instead, or move ${l.name} into a call of their own (say "move them").`);
      const n = { leadId: l.id, leadName: l.name, callType, startTime: d.toISOString(), productName: p ? p.name : productName, note, moveFromBatch: !!params.moveFromBatch };
      return { normalized: n, echo: n, summary: `Schedule an AI call to ${l.name} (${l.phone}) on ${when} IST with "${n.productName}"${l.batchId ? `, moving them out of "${cur}"` : ''}.` };
    }
    case 'update_task': {
      const t = pickByName(await loadAll(orgRef(ctx).collection('tasks'), 1500), requireString(params, 'taskTitle', { max: 200 }), 'task', 'title');
      if (!t) throw new Error(`No task called "${params.taskTitle}".`);
      if (ctx.isEmployee && t.assigneeId !== ctx.uid) throw new Error('You can only change tasks assigned to you.');
      const st = requireEnum(params, 'setStatus', ['todo', 'inProgress', 'done'], '');
      const pr = requireEnum(params, 'setPriority', ['low', 'medium', 'high'], '');
      const dl = params.setDeadline ? requireDate(params, 'setDeadline') : null;
      if (!st && !pr && !dl) throw new Error('Nothing to change: give a new status, deadline or priority.');
      const n = { taskId: t.id, taskTitle: t.title, ...(st ? { setStatus: st } : {}), ...(pr ? { setPriority: pr } : {}), ...(dl ? { setDeadline: dl.toISOString() } : {}) };
      return { normalized: { ...n, ...(dl ? { setDeadline: dl } : {}) }, echo: n,
        summary: `Update the task "${t.title}": ${[st && `status → ${st}`, pr && `priority → ${pr}`, dl && `due ${dl.toDateString()}`].filter(Boolean).join(', ')}.` };
    }
    default: throw new Error(`Unknown action type: ${type}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
// WRITE: execute (after the user confirmed)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let _voiceBase = { at: 0, url: '' };
async function voiceBaseUrl() {
  if (process.env.VOICE_API_BASE_URL) return process.env.VOICE_API_BASE_URL.replace(/\/+$/, '');
  if (Date.now() - _voiceBase.at < 5 * 60e3 && _voiceBase.url) return _voiceBase.url;
  const snap = await fb().db.collection('pricing_config').doc('plans').get();
  const url = String((snap.exists ? snap.data().voice_api_base_url : '') || '').trim().replace(/\/+$/, '');
  _voiceBase = { at: Date.now(), url };
  return url;
}

async function callVoiceApi(ctx, method, path, body) {
  const base = await voiceBaseUrl();
  if (!base) throw new Error('Astric Voice is not connected on this server yet (voice backend address missing).');
  if (!ctx.authHeader) throw new Error('Missing sign-in for the voice service.');
  try {
    const r = await (ctx.http || axios)({ method, url: `${base}/v1${path}`, data: body, headers: { Authorization: ctx.authHeader, 'Content-Type': 'application/json' }, timeout: 30000 });
    return r.data;
  } catch (e) {
    const d = e.response && e.response.data;
    throw new Error((d && (d.detail || d.error || d.message)) || e.message || 'The voice service did not answer.');
  }
}

function taskDoc(n, who, now) {
  return { title: n.title, description: n.description, assignedTo: who ? who.name : 'Unassigned', assigneeId: who ? who.id : '',
    deadline: fb().admin.firestore.Timestamp.fromDate(n.deadline), status: 'todo', priority: n.priority, projectId: n.projectId || '',
    isStandalone: !n.projectId, linkedLeadId: null, linkedCustomerId: null, teamId: n.projectId ? '' : (n.teamId || ''),
    createdAt: now, createdByAgent: true };
}

async function executeAction(type, params, ctx) {
  const { normalized: n } = await validateAction(type, params, ctx);   // re-validate independently of what the client sent
  const { admin } = fb();
  const base = orgRef(ctx);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const uid = ctx.uid;

  switch (type) {
    case 'create_lead': {
      const f = { name: n.name, email: n.email, phone: n.phone, company: n.company, notes: n.notes, value: n.estimatedValue || '' };
      const r = await ing().ingestLead(ctx.orgOwnerUid, f, { createdBy: uid, defaultSource: 'other', sourceLabel: 'Agent Mode' });
      if (r.status === 'duplicate') throw new Error('A lead with this phone number already exists.');
      if (r.status !== 'created') throw new Error(r.reason || 'Could not create the lead.');
      if (n.stage !== 'new_' || n.priority !== 'warm') await base.collection('leads').doc(r.id).update({ stage: n.stage, priority: n.priority });
      return { id: r.id, entity: 'lead' };
    }
    case 'bulk_create_leads': {
      let batchId = '';
      if (n.batchName) {
        const ex = pickByName(await batches(ctx), n.batchName, 'batch');
        batchId = ex ? ex.id : await ing().createBatch(ctx.orgOwnerUid, n.batchName, uid);
      }
      let created = 0, duplicates = 0, invalid = 0; const ids = [];
      for (const l of n.leads) {
        const r = await ing().ingestLead(ctx.orgOwnerUid, { name: l.name, phone: l.phone, email: l.email, company: l.company, notes: l.notes },
          { createdBy: uid, defaultSource: 'other', sourceLabel: 'Agent Mode', batchId });
        if (r.status === 'created') { created++; ids.push(r.id); } else if (r.status === 'duplicate') duplicates++; else invalid++;
      }
      if (ids.length && (n.stage !== 'new_' || n.priority !== 'warm')) for (const id of ids) await base.collection('leads').doc(id).update({ stage: n.stage, priority: n.priority });
      if (!created && batchId && !(await base.collection('leads').where('batchId', '==', batchId).limit(1).get()).size) await ing().deleteBatch(ctx.orgOwnerUid, batchId);
      if (!created) throw new Error(`No leads were added (${duplicates} already existed, ${invalid} had no usable details).`);
      return { entity: 'leads', count: created, duplicates, invalid, batchId, message: `${created} lead${created > 1 ? 's' : ''} added${duplicates ? `, ${duplicates} skipped (same phone already exists)` : ''}${invalid ? `, ${invalid} skipped (no usable details)` : ''}.` };
    }
    case 'create_lead_batch': {
      const m = await matchLeads(ctx, n, { onlyUnbatched: !n.includeAlreadyBatched });
      if (!m.rows.length) throw new Error('No leads match any more.');
      const existing = pickByName(await batches(ctx), n.name, 'batch');
      if (existing && norm(existing.name) === norm(n.name)) throw new Error(`A batch called "${existing.name}" already exists. Pick another name.`);
      const batchId = await ing().createBatch(ctx.orgOwnerUid, n.name, uid);
      for (let i = 0; i < m.rows.length; i += 400) {
        const wb = fb().db.batch();
        for (const l of m.rows.slice(i, i + 400)) wb.update(base.collection('leads').doc(l.id), { batchId });
        await wb.commit();
      }
      return { id: batchId, entity: 'batch', count: m.rows.length, message: `Batch "${n.name}" created with ${m.rows.length} lead${m.rows.length > 1 ? 's' : ''}.` };
    }
    case 'update_leads': {
      const m = await matchLeads(ctx, n);
      if (!m.rows.length) throw new Error('No leads match any more.');
      if (m.rows.length > MAX_BULK_WRITE) throw new Error('Too many leads match. Please narrow it down.');
      const upd = {}; if (n.setStage) upd.stage = n.setStage; if (n.setPriority) upd.priority = n.setPriority;
      const note = { id: crypto.randomUUID(), note: `Changed by Agent Mode: ${Object.entries(upd).map(([k, v]) => `${k === 'stage' ? 'status' : k} → ${v}`).join(', ')}`, type: n.setStage ? 'stage_change' : 'note', createdBy: 'Agent Mode', createdAt: admin.firestore.Timestamp.now() };
      for (let i = 0; i < m.rows.length; i += 400) {
        const wb = fb().db.batch();
        for (const l of m.rows.slice(i, i + 400)) wb.update(base.collection('leads').doc(l.id), { ...upd, activities: admin.firestore.FieldValue.arrayUnion(note) });
        await wb.commit();
      }
      return { entity: 'leads', count: m.rows.length, message: `${m.rows.length} lead${m.rows.length > 1 ? 's' : ''} updated.` };
    }
    case 'create_customer': {
      const ref = base.collection('customers').doc();
      await ref.set({ name: n.name, email: n.email, phone: n.phone, notes: n.notes, activities: [], sentEmails: [], customFields: {}, createdAt: now, createdByAgent: true, createdByUid: uid });
      return { id: ref.id, entity: 'customer' };
    }
    case 'create_task':
    case 'assign_task': {
      const people = n.assignees && n.assignees.length ? n.assignees : [null];
      const ids = [];
      for (const p of people) {
        const ref = base.collection('tasks').doc();
        await ref.set({ ...taskDoc(n, p, now), createdByUid: uid });
        ids.push(ref.id);
      }
      return { id: ids[0], ids, entity: 'task', count: ids.length, message: ids.length > 1 ? `Task created for ${ids.length} people.` : 'Task created.' };
    }
    case 'create_project': {
      const ref = base.collection('projects').doc();
      await ref.set({ name: n.name, description: n.description, status: 'active', linkedCustomerId: n.linkedCustomerId, createdAt: now, createdByAgent: true, createdByUid: uid });
      return { id: ref.id, entity: 'project' };
    }
    case 'create_calendar_event': {
      const ref = base.collection('calendar_events').doc();
      const stamp = new Date().toISOString();
      await ref.set({ title: n.title, description: n.description, location: n.location, startTime: n.startTime, endTime: n.endTime, isAllDay: n.isAllDay,
        color: 'teal', repeat: 'none', reminderMinutes: 30, invitedEmployeeIds: n.invitedEmployeeIds, linkedTo: 'none', linkedId: null, linkedLabel: null,
        attachments: [], createdAt: stamp, updatedAt: stamp, source: 'agent', createdByUid: uid });
      return { id: ref.id, entity: 'calendar_event' };
    }
    case 'create_invoice': {
      const ref = base.collection('invoices').doc();
      const invoiceNumber = `INV-${Date.now().toString().slice(-8)}`;
      await ref.set({ invoiceNumber, clientName: n.clientName, clientEmail: n.clientEmail, companyName: n.companyName, items: n.items, customFields: [], status: 'draft',
        createdAt: now, dueDate: admin.firestore.Timestamp.fromDate(n.dueDate), notes: n.notes, createdByAgent: true, createdByUid: uid });
      return { id: ref.id, entity: 'invoice', invoiceNumber };
    }
    case 'add_note': {
      const nowIso = new Date().toISOString();
      const logLine = { id: crypto.randomUUID(), note: n.content, type: 'note', createdBy: 'Agent Mode', createdAt: admin.firestore.Timestamp.now() };
      let noteId = '';
      if (!ctx.isEmployee) {            // the Notes screen reads users/{owner}/notes
        const ref = base.collection('notes').doc();
        await ref.set({ title: n.title, content: n.content, color: 'gold', tag: n.attachTo === 'none' ? 'none' : n.attachTo, tagId: n.attachId || null, tagLabel: n.attachName || null, isPinned: false, createdAt: nowIso, updatedAt: nowIso, createdByAgent: true });
        noteId = ref.id;
      }
      if (n.attachTo === 'lead') await base.collection('leads').doc(n.attachId).update({ activities: admin.firestore.FieldValue.arrayUnion(logLine) });
      else if (n.attachTo === 'customer') await base.collection('customers').doc(n.attachId).update({ activities: admin.firestore.FieldValue.arrayUnion(logLine) });
      return { id: noteId || n.attachId, entity: 'note', message: n.attachTo === 'none' ? 'Note saved.' : `Note saved on ${n.attachName}.` };
    }
    case 'update_lead': {
      const ref = base.collection('leads').doc(n.leadId);
      const cur = await ref.get();
      if (!cur.exists || !canSee(ctx, cur.data())) throw new Error('That lead no longer exists.');
      const upd = {};
      if (n.setStage) upd.stage = n.setStage; if (n.setPriority) upd.priority = n.setPriority;
      if (n.setEstimatedValue != null) upd.estimatedValue = n.setEstimatedValue;
      if (n.setPhone) upd.phone = n.setPhone; if (n.setEmail) upd.email = n.setEmail; if (n.setCompany) upd.company = n.setCompany;
      const note = { id: crypto.randomUUID(), note: `Changed by Agent Mode: ${Object.entries(upd).map(([k, v]) => `${k === 'stage' ? 'status' : k} → ${v}`).join(', ')}`, type: n.setStage ? 'stage_change' : 'note', createdBy: 'Agent Mode', createdAt: admin.firestore.Timestamp.now() };
      await ref.update({ ...upd, activities: admin.firestore.FieldValue.arrayUnion(note) });
      return { id: n.leadId, entity: 'lead', message: `${n.leadName} updated.` };
    }
    case 'schedule_lead_call': {
      const lref = base.collection('leads').doc(n.leadId);
      const ls = await lref.get();
      if (!ls.exists || !canSee(ctx, ls.data())) throw new Error('That lead no longer exists.');
      const lead = { id: ls.id, ...ls.data() };
      if (n.callType === 'reminder') {
        const start = toWall(n.startTime), endD = new Date(parseInTz(n.startTime).getTime() + 15 * 60e3);
        const ref = base.collection('calendar_events').doc();
        const stamp = new Date().toISOString();
        await ref.set({ title: `Call ${lead.name}`, description: n.note || `Call ${lead.name}${lead.phone ? ` on ${lead.phone}` : ''}`, location: '', startTime: start, endTime: toWall(endD.toISOString()), isAllDay: false,
          color: 'teal', repeat: 'none', reminderMinutes: 15, invitedEmployeeIds: [], linkedTo: 'lead', linkedId: lead.id, linkedLabel: lead.name,
          attachments: [], createdAt: stamp, updatedAt: stamp, source: 'agent', createdByUid: uid });
        return { id: ref.id, entity: 'calendar_event', message: `Reminder set to call ${lead.name}.` };
      }
      const p = pickByName(await voiceProducts(ctx), n.productName, 'voice product');
      if (!p) throw new Error(`No voice product named "${n.productName}" found.`);
      if (lead.batchId && !n.moveFromBatch) throw new Error(`${lead.name} is already in a batch.`);
      // The dialler works on batches, so a single call is a batch of one. Named clearly so it is easy to spot and delete.
      const label = parseInTz(n.startTime).toLocaleString('en-IN', { timeZone: DEFAULT_TZ, dateStyle: 'medium', timeStyle: 'short' });
      let batchName = `Call: ${lead.name} (${label})`.slice(0, 80);
      if ((await batches(ctx)).some((b) => norm(b.name) === norm(batchName))) batchName = `${batchName.slice(0, 70)} #${Date.now().toString().slice(-4)}`;
      const batchId = await ing().createBatch(ctx.orgOwnerUid, batchName, uid);
      await base.collection('lead_batches').doc(batchId).update({ mode: 'ai' });
      await lref.update({ batchId, activities: admin.firestore.FieldValue.arrayUnion({ id: crypto.randomUUID(), note: `AI call scheduled for ${label} IST${n.note ? ` — ${n.note}` : ''}`, type: 'note', createdBy: 'Agent Mode', createdAt: admin.firestore.Timestamp.now() }) });
      try {
        const res = await callVoiceApi(ctx, 'POST', `/batches/${batchId}/schedule`, { productId: p.id, scheduledAt: n.startTime });
        return { id: batchId, entity: 'voice_campaign', message: `AI call to ${lead.name} scheduled for ${label} IST — see Astric Voice → Schedules.`, result: res };
      } catch (e) {
        // Don't leave a half-made batch behind if the voice service refused (no minutes, no carrier, ...).
        await lref.update({ batchId: lead.batchId || '' }).catch(() => {});
        await ing().deleteBatch(ctx.orgOwnerUid, batchId).catch(() => {});
        throw e;
      }
    }
    case 'update_task': {
      const ref = base.collection('tasks').doc(n.taskId);
      const cur = await ref.get();
      if (!cur.exists) throw new Error('That task no longer exists.');
      const upd = {};
      if (n.setStatus) upd.status = n.setStatus; if (n.setPriority) upd.priority = n.setPriority;
      if (n.setDeadline) upd.deadline = admin.firestore.Timestamp.fromDate(new Date(n.setDeadline));
      await ref.update(upd);
      return { id: n.taskId, entity: 'task', message: `Task "${n.taskTitle}" updated.` };
    }
    case 'create_voice_product': {
      const ref = base.collection('voice_products').doc();
      await ref.set({ name: n.name, description: n.description, price: n.price, goal: n.goal, pitch: n.pitch, features: n.features, objections: n.objections,
        active: true, createdAt: now, updatedAt: now });
      return { id: ref.id, entity: 'voice_product', message: `Voice product "${n.name}" created.` };
    }
    case 'schedule_voice_calls': {
      const b = pickByName(await batches(ctx), n.batchName, 'batch');
      if (!b) throw new Error(`No batch named "${n.batchName}" found.`);
      const p = pickByName(await voiceProducts(ctx), n.productName, 'voice product');
      if (!p) throw new Error(`No voice product named "${n.productName}" found.`);
      if (b.mode !== 'ai') await base.collection('lead_batches').doc(b.id).update({ mode: 'ai' });     // the dialler only runs AI-mode batches
      const body = { productId: p.id, ...(n.startTime ? { scheduledAt: n.startTime } : {}), ...(n.provider && n.provider !== 'auto' ? { provider: n.provider } : {}) };
      const res = await callVoiceApi(ctx, 'POST', `/batches/${b.id}/schedule`, body);
      return { id: b.id, entity: 'voice_campaign', message: n.startTime ? 'Calls scheduled — see Astric Voice → Schedules.' : 'AI calling started — see Astric Voice → Calls.', result: res };
    }
    default: throw new Error(`Unknown action type: ${type}`);
  }
}

/** A confirmed PLAN (several actions) runs in order and stops at the first problem, reporting what already happened. */
async function executePlan(steps, ctx) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('The plan is empty.');
  if (steps.length > 8) throw new Error('A plan can have at most 8 steps.');
  const done = [];
  ctx.planned = { batches: new Set(), voiceProducts: new Set() };
  for (const [i, s] of steps.entries()) {
    try {
      const r = await executeAction(s.type, s.params, ctx);
      done.push({ type: s.type, ok: true, ...r });
      if (s.type === 'create_lead_batch' || s.type === 'bulk_create_leads') ctx.planned.batches.add(norm((s.params || {}).name || (s.params || {}).batchName));
    } catch (e) {
      const err = new Error(`Step ${i + 1} of ${steps.length} (${s.type.replace(/_/g, ' ')}) failed: ${e.message}${done.length ? ` — the first ${done.length} step${done.length > 1 ? 's' : ''} were already done.` : ''}`);
      err.done = done;
      throw err;
    }
  }
  return { entity: 'plan', count: done.length, results: done, message: `All ${done.length} steps done.` };
}

module.exports = {
  TOOLS, READ_TOOLS, WRITE_TOOLS, READ_NAMES, runReadTool, validateAction, executeAction, executePlan,
  _t: { toWall, parseInTz, pickByName, matchLeads, cleanFilter, voiceSetupStatus },
};
