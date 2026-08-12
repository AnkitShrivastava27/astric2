/**
 * services/agent.js
 *
 * Agent Mode: lets premium users create leads/customers/tasks/projects/
 * invoices/calendar events, and assign tasks, via natural-language
 * prompts. Two-step by design (see routes/agent.js):
 *   1. POST /ai/agent          -> model decides what to do, returns a
 *                                 PROPOSED action + human summary. Nothing
 *                                 is written yet.
 *   2. POST /ai/agent/execute  -> only after the user taps confirm. Params
 *                                 are re-validated here independently of
 *                                 whatever the client echoes back — never
 *                                 trust client-supplied params for a write,
 *                                 even if they originated from our own
 *                                 /ai/agent response a moment ago.
 *
 * Every action writes to the exact same Firestore shape the app's own
 * "Add Lead" / "Add Task" / etc. screens use (see shared/models/*.dart in
 * the Flutter app) so agent-created records are indistinguishable from
 * manually-created ones.
 */
'use strict';

const { db, admin } = require('../config/firebase');
const { AI_CHAT_PROVIDERS } = require('./ai');

// =============================================================================
// Tool schemas (OpenAI-compatible `tools` format — DeepSeek/Grok/OpenAI all
// accept this shape).
// =============================================================================
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_lead',
      description: 'Create a new sales lead.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          company: { type: 'string' },
          stage: { type: 'string', enum: ['new_', 'contacted', 'qualified', 'proposal', 'won', 'lost'], default: 'new_' },
          priority: { type: 'string', enum: ['hot', 'warm', 'cold'], default: 'warm' },
          estimatedValue: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_customer',
      description: 'Create a new customer record.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a task. Use assign_task instead if the goal is specifically to hand a task to an employee.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          assignedTo: { type: 'string', description: 'Employee name or id, if any.' },
          deadline: { type: 'string', description: 'ISO 8601 date/time.' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
          projectName: { type: 'string', description: 'Existing project name to link this task to, if any.' },
        },
        required: ['title', 'deadline'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_task',
      description: 'Assign a task to a specific employee by name.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          employeeName: { type: 'string' },
          deadline: { type: 'string', description: 'ISO 8601 date/time.' },
          priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
        },
        required: ['title', 'employeeName', 'deadline'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Create a new project.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          customerName: { type: 'string', description: 'Existing customer name to link this project to, if any.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_calendar_event',
      description: 'Add an event to the calendar.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          startTime: { type: 'string', description: 'ISO 8601 date/time.' },
          endTime: { type: 'string', description: 'ISO 8601 date/time.' },
          isAllDay: { type: 'boolean', default: false },
          invitedEmployeeNames: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'startTime', 'endTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_invoice',
      description: 'Create an invoice for a client with one or more line items.',
      parameters: {
        type: 'object',
        properties: {
          clientName: { type: 'string' },
          clientEmail: { type: 'string' },
          companyName: { type: 'string' },
          dueDate: { type: 'string', description: 'ISO 8601 date.' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number' },
              },
              required: ['description', 'quantity', 'unitPrice'],
            },
          },
          notes: { type: 'string' },
        },
        required: ['clientName', 'items'],
      },
    },
  },
];

// =============================================================================
// Model resolution — reads config/ai_models.agentModeProviderId (set from the
// admin panel's Aimodel.jsx "Agent Mode" picker) and maps it onto the same
// provider config /ai/chat already uses.
// =============================================================================
async function getAgentModelConfig() {
  const snap = await db.collection('config').doc('ai_models').get();
  if (!snap.exists) return null;

  const data = snap.data();
  const agentModeProviderId = data.agentModeProviderId;
  if (!agentModeProviderId) return null;

  const modelEntry = (data.models || []).find(m => m.id === agentModeProviderId);
  if (!modelEntry || !modelEntry.enabled) return null;

  // Admin panel model ids are 'deepseek' | 'grok' | 'gpt' — map 'gpt' to the
  // 'openai' key used in AI_CHAT_PROVIDERS (same mapping the Flutter client
  // already uses for its own model switcher).
  const providerKey = modelEntry.id === 'gpt' ? 'openai' : modelEntry.id;
  const providerCfg = AI_CHAT_PROVIDERS[providerKey];
  if (!providerCfg || !providerCfg.key) return null;

  return { providerCfg, modelId: modelEntry.modelId, displayName: modelEntry.displayName };
}

// =============================================================================
// Org context — resolves an authenticated uid (which may be an employee's
// own auth account) to the org owner's uid that all Firestore writes must
// target, and checks the org's plan.
// =============================================================================
async function resolveOrgContext(uid) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return null;
  const userData = userSnap.data();

  const orgOwnerUid = (userData.isEmployee && userData.adminId) ? userData.adminId : uid;
  const orgSnap = orgOwnerUid === uid ? userSnap : await db.collection('users').doc(orgOwnerUid).get();
  if (!orgSnap.exists) return null;

  const plan = orgSnap.data().subscription?.plan || 'basic';
  return { uid, orgOwnerUid, plan, isEmployee: !!userData.isEmployee };
}

// =============================================================================
// Validation + preview (step 1 — never writes anything)
// =============================================================================
function requireString(params, field, { max = 500 } = {}) {
  const v = params[field];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${field}" is required.`);
  if (v.length > max) throw new Error(`"${field}" is too long.`);
  return v.trim();
}
function optString(params, field, { max = 2000 } = {}) {
  const v = params[field];
  if (v == null) return '';
  if (typeof v !== 'string') throw new Error(`"${field}" must be text.`);
  return v.slice(0, max);
}
function requireDate(params, field) {
  const v = params[field];
  const d = new Date(v);
  if (!v || isNaN(d.getTime())) throw new Error(`"${field}" must be a valid date/time.`);
  return d;
}
function requireEnum(params, field, allowed, fallback) {
  const v = params[field];
  if (v == null) return fallback;
  if (!allowed.includes(v)) throw new Error(`"${field}" must be one of: ${allowed.join(', ')}`);
  return v;
}
function requireNumber(params, field, { min = -Infinity, max = Infinity } = {}) {
  const v = Number(params[field]);
  if (isNaN(v)) throw new Error(`"${field}" must be a number.`);
  if (v < min || v > max) throw new Error(`"${field}" is out of range.`);
  return v;
}

async function findEmployeeByName(orgOwnerUid, name) {
  if (!name) return null;
  const snap = await db.collection('users').doc(orgOwnerUid).collection('employees')
    .where('name', '==', name).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function findProjectByName(orgOwnerUid, name) {
  if (!name) return null;
  const snap = await db.collection('users').doc(orgOwnerUid).collection('projects')
    .where('name', '==', name).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function findCustomerByName(orgOwnerUid, name) {
  if (!name) return null;
  const snap = await db.collection('users').doc(orgOwnerUid).collection('customers')
    .where('name', '==', name).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

/**
 * Validates params for `type` and returns { normalized, summary }.
 * Throws with a user-facing message on invalid input. Does NOT write.
 */
async function validateAction(type, params, ctx) {
  const { orgOwnerUid } = ctx;
  params = params || {};

  switch (type) {
    case 'create_lead': {
      const name = requireString(params, 'name');
      const email = optString(params, 'email', { max: 200 });
      const phone = optString(params, 'phone', { max: 40 });
      const company = optString(params, 'company', { max: 200 });
      const stage = requireEnum(params, 'stage', ['new_', 'contacted', 'qualified', 'proposal', 'won', 'lost'], 'new_');
      const priority = requireEnum(params, 'priority', ['hot', 'warm', 'cold'], 'warm');
      const estimatedValue = params.estimatedValue != null ? requireNumber(params, 'estimatedValue', { min: 0 }) : null;
      const notes = optString(params, 'notes');
      return {
        normalized: { name, email, phone, company, stage, priority, estimatedValue, notes },
        summary: `Create a lead for ${name}${company ? ` (${company})` : ''}${estimatedValue ? `, est. value ${estimatedValue}` : ''}.`,
      };
    }
    case 'create_customer': {
      const name = requireString(params, 'name');
      const email = optString(params, 'email', { max: 200 });
      const phone = optString(params, 'phone', { max: 40 });
      const notes = optString(params, 'notes');
      return {
        normalized: { name, email, phone, notes },
        summary: `Create a customer record for ${name}.`,
      };
    }
    case 'create_task':
    case 'assign_task': {
      const title = requireString(params, 'title', { max: 200 });
      const description = optString(params, 'description');
      const deadline = requireDate(params, 'deadline');
      const priority = requireEnum(params, 'priority', ['low', 'medium', 'high'], 'medium');

      let assignedToId = '';
      let assignedToName = '';
      const nameToFind = type === 'assign_task' ? params.employeeName : params.assignedTo;
      if (nameToFind) {
        const emp = await findEmployeeByName(orgOwnerUid, nameToFind);
        if (!emp) throw new Error(`No employee named "${nameToFind}" found in this organization.`);
        assignedToId = emp.id;
        assignedToName = emp.name;
      } else if (type === 'assign_task') {
        throw new Error('assign_task requires employeeName.');
      }

      let projectId = null, projectName = null;
      if (params.projectName) {
        const proj = await findProjectByName(orgOwnerUid, params.projectName);
        if (proj) { projectId = proj.id; projectName = proj.name; }
      }

      return {
        normalized: { title, description, deadline, priority, assignedToId, assignedToName, projectId },
        summary: `Create task "${title}"${assignedToName ? ` and assign it to ${assignedToName}` : ''}, due ${deadline.toDateString()}.`,
      };
    }
    case 'create_project': {
      const name = requireString(params, 'name');
      const description = optString(params, 'description');
      let linkedCustomerId = null, customerName = null;
      if (params.customerName) {
        const cust = await findCustomerByName(orgOwnerUid, params.customerName);
        if (cust) { linkedCustomerId = cust.id; customerName = cust.name; }
      }
      return {
        normalized: { name, description, linkedCustomerId },
        summary: `Create project "${name}"${customerName ? ` linked to ${customerName}` : ''}.`,
      };
    }
    case 'create_calendar_event': {
      const title = requireString(params, 'title', { max: 200 });
      const description = optString(params, 'description');
      const location = optString(params, 'location', { max: 200 });
      const startTime = requireDate(params, 'startTime');
      const endTime = requireDate(params, 'endTime');
      if (endTime < startTime) throw new Error('endTime must be after startTime.');
      const isAllDay = !!params.isAllDay;

      const invitedIds = [];
      for (const empName of (params.invitedEmployeeNames || [])) {
        const emp = await findEmployeeByName(orgOwnerUid, empName);
        if (emp) invitedIds.push(emp.id);
      }

      return {
        normalized: { title, description, location, startTime, endTime, isAllDay, invitedEmployeeIds: invitedIds },
        summary: `Add calendar event "${title}" on ${startTime.toLocaleString()}.`,
      };
    }
    case 'create_invoice': {
      const clientName = requireString(params, 'clientName');
      const clientEmail = optString(params, 'clientEmail', { max: 200 });
      const companyName = optString(params, 'companyName', { max: 200 });
      const dueDate = params.dueDate ? requireDate(params, 'dueDate') : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const notes = optString(params, 'notes');

      if (!Array.isArray(params.items) || params.items.length === 0) {
        throw new Error('At least one invoice item is required.');
      }
      const items = params.items.map((it, i) => ({
        description: requireString(it, 'description', { max: 300 }),
        quantity: requireNumber(it, 'quantity', { min: 0.01, max: 1_000_000 }),
        unitPrice: requireNumber(it, 'unitPrice', { min: 0, max: 10_000_000 }),
      }));
      const total = items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);

      return {
        normalized: { clientName, clientEmail, companyName, dueDate, notes, items },
        summary: `Create an invoice for ${clientName} totaling ${total.toFixed(2)} (${items.length} item${items.length > 1 ? 's' : ''}), due ${dueDate.toDateString()}.`,
      };
    }
    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

// =============================================================================
// Execution (step 2 — actually writes to Firestore, AFTER user confirmation)
// =============================================================================
async function executeAction(type, params, ctx) {
  const { normalized } = await validateAction(type, params, ctx); // re-validate independently
  const { orgOwnerUid, uid } = ctx;
  const base = db.collection('users').doc(orgOwnerUid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  switch (type) {
    case 'create_lead': {
      const ref = base.collection('leads').doc();
      await ref.set({
        name: normalized.name, email: normalized.email, phone: normalized.phone,
        company: normalized.company, stage: normalized.stage, priority: normalized.priority,
        assignedTo: '', estimatedValue: normalized.estimatedValue, notes: normalized.notes,
        source: 'other', sourceCustom: 'Agent Mode', activities: [], followUps: [], sentEmails: [],
        customFields: {}, createdAt: now, createdByAgent: true, createdByUid: uid,
      });
      return { id: ref.id, entity: 'lead' };
    }
    case 'create_customer': {
      const ref = base.collection('customers').doc();
      await ref.set({
        name: normalized.name, email: normalized.email, phone: normalized.phone,
        notes: normalized.notes, activities: [], sentEmails: [], customFields: {},
        createdAt: now, createdByAgent: true, createdByUid: uid,
      });
      return { id: ref.id, entity: 'customer' };
    }
    case 'create_task':
    case 'assign_task': {
      const ref = base.collection('tasks').doc();
      await ref.set({
        title: normalized.title, description: normalized.description,
        assignedTo: normalized.assignedToId, deadline: normalized.deadline,
        status: 'todo', priority: normalized.priority,
        projectId: normalized.projectId, isStandalone: !normalized.projectId,
        createdAt: now, createdByAgent: true, createdByUid: uid,
      });
      return { id: ref.id, entity: 'task', assignedToName: normalized.assignedToName };
    }
    case 'create_project': {
      const ref = base.collection('projects').doc();
      await ref.set({
        name: normalized.name, description: normalized.description, status: 'active',
        linkedCustomerId: normalized.linkedCustomerId, createdAt: now,
        createdByAgent: true, createdByUid: uid,
      });
      return { id: ref.id, entity: 'project' };
    }
    case 'create_calendar_event': {
      const ref = base.collection('calendar_events').doc();
      await ref.set({
        title: normalized.title, description: normalized.description, location: normalized.location,
        startTime: admin.firestore.Timestamp.fromDate(normalized.startTime),
        endTime: admin.firestore.Timestamp.fromDate(normalized.endTime),
        isAllDay: normalized.isAllDay, invitedEmployeeIds: normalized.invitedEmployeeIds,
        attachments: [], createdAt: now, updatedAt: now,
        createdByAgent: true, createdByUid: uid,
      });
      return { id: ref.id, entity: 'calendar_event' };
    }
    case 'create_invoice': {
      const ref = base.collection('invoices').doc();
      const invoiceNumber = `INV-${Date.now().toString().slice(-8)}`;
      await ref.set({
        invoiceNumber, clientName: normalized.clientName, clientEmail: normalized.clientEmail,
        companyName: normalized.companyName, items: normalized.items, customFields: [],
        status: 'draft', createdAt: now, dueDate: admin.firestore.Timestamp.fromDate(normalized.dueDate),
        notes: normalized.notes, createdByAgent: true, createdByUid: uid,
      });
      return { id: ref.id, entity: 'invoice', invoiceNumber };
    }
    default:
      throw new Error(`Unknown action type: ${type}`);
  }
}

module.exports = { TOOLS, getAgentModelConfig, resolveOrgContext, validateAction, executeAction };
