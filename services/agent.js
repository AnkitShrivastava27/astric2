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

const { db } = require('../config/firebase');
const { AI_CHAT_PROVIDERS } = require('./ai');
const actions = require('./agentActions');     // tool schemas, read tools, validate/execute, plans

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

module.exports = {
  TOOLS: actions.TOOLS, READ_NAMES: actions.READ_NAMES, runReadTool: actions.runReadTool,
  getAgentModelConfig, resolveOrgContext,
  validateAction: actions.validateAction, executeAction: actions.executeAction, executePlan: actions.executePlan,
};
