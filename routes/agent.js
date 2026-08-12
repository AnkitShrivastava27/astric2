'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
  TOOLS, getAgentModelConfig, resolveOrgContext, validateAction, executeAction,
} = require('../services/agent');
const { currentMonthKey, getAiLimitsConfig } = require('../services/ai');

const SYSTEM_PROMPT = `You are a business assistant embedded in a CRM app, operating in Agent Mode.
You can create leads, customers, tasks, projects, calendar events, and invoices, and assign tasks
to employees, by calling the provided tools. Only call a tool when the user's message clearly asks
you to create or assign something specific — if a required detail is missing (e.g. no deadline for
a task), ask a short clarifying question in plain text instead of guessing or calling the tool with
made-up values. For anything that isn't a create/assign request, just answer normally in text.
Today's date is ${new Date().toISOString().slice(0, 10)}.`;

// =============================================================================
// POST /ai/agent
// Step 1: the model decides what to do. If it wants to call a tool, we
// return the PROPOSED action + a human summary — nothing is written yet.
// The client must show this to the user and call /ai/agent/execute only
// after they confirm.
// =============================================================================
router.post('/ai/agent', requireAuth, rateLimit({ windowMs: 60_000, max: 20, keyFn: r => `agent:${r.uid}` }), async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required.' });
    }

    const ctx = await resolveOrgContext(req.uid);
    if (!ctx) return res.status(404).json({ error: 'User not found.' });
    if (ctx.plan !== 'premium') {
      return res.status(403).json({ error: 'Agent Mode is a Premium feature.', requiresUpgrade: true });
    }

    const modelCfg = await getAgentModelConfig();
    if (!modelCfg) {
      return res.status(503).json({ error: 'Agent Mode is not enabled right now. Try again later.' });
    }

    // Same quota pool as regular AI chat — agent calls are still LLM calls.
    const usageRef = db.collection('users').doc(ctx.orgOwnerUid).collection('ai').doc('usage');
    const usageSnap = await usageRef.get();
    const curMonth = currentMonthKey();
    const usageData = usageSnap.exists ? usageSnap.data() : {};
    const tokensUsedThisMonth = usageData.lastResetMonth === curMonth ? Number(usageData.tokensUsedThisMonth || 0) : 0;
    const limits = await getAiLimitsConfig();
    const planLimit = limits.premium_tokens_limit; // ctx.plan is always 'premium' here
    if (tokensUsedThisMonth >= planLimit) {
      return res.status(402).json({ error: 'AI token limit reached for this month.', limitReached: true });
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(Array.isArray(history) ? history.slice(-10) : []),
      { role: 'user', content: message },
    ];

    const upstream = await axios.post(modelCfg.providerCfg.url, {
      model: modelCfg.modelId,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.3,
    }, {
      headers: { Authorization: `Bearer ${modelCfg.providerCfg.key}`, 'Content-Type': 'application/json' },
      timeout: 45_000,
    });

    const choice = upstream.data?.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    const tokensConsumed = upstream.data?.usage?.total_tokens ?? 200;

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(usageRef);
      const freshData = fresh.exists ? fresh.data() : {};
      const already = freshData.lastResetMonth === curMonth ? Number(freshData.tokensUsedThisMonth || 0) : 0;
      tx.set(usageRef, {
        tokensUsedThisMonth: already + tokensConsumed, lastResetMonth: curMonth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    if (!toolCall) {
      const reply = (choice?.message?.content || '').trim();
      return res.status(200).json({ needsConfirmation: false, reply });
    }

    let params;
    try {
      params = JSON.parse(toolCall.function.arguments || '{}');
    } catch (_) {
      return res.status(200).json({ needsConfirmation: false, reply: "I couldn't parse that request — could you rephrase it?" });
    }

    const actionType = toolCall.function.name;
    try {
      const { normalized, summary } = await validateAction(actionType, params, ctx);
      return res.status(200).json({
        needsConfirmation: true,
        action: { type: actionType, params: normalized },
        summary,
      });
    } catch (validationErr) {
      // Surface the validation problem as a normal reply rather than a
      // confirmable action — e.g. "No employee named X found."
      return res.status(200).json({ needsConfirmation: false, reply: validationErr.message });
    }

  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message || 'Agent request failed.';
    console.error('/ai/agent error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// =============================================================================
// POST /ai/agent/execute
// Step 2: only reached after the user taps confirm on the client. Params
// are re-validated from scratch here — never trust the client echo, even
// though it just came from our own /ai/agent response.
// =============================================================================
router.post('/ai/agent/execute', requireAuth, rateLimit({ windowMs: 60_000, max: 20, keyFn: r => `agent-exec:${r.uid}` }), async (req, res) => {
  try {
    const { type, params } = req.body;
    if (!type || !params) return res.status(400).json({ error: 'type and params are required.' });

    const ctx = await resolveOrgContext(req.uid);
    if (!ctx) return res.status(404).json({ error: 'User not found.' });
    if (ctx.plan !== 'premium') {
      return res.status(403).json({ error: 'Agent Mode is a Premium feature.', requiresUpgrade: true });
    }

    const result = await executeAction(type, params, ctx);
    console.log(`[agent/execute] uid=${req.uid} org=${ctx.orgOwnerUid} type=${type} -> ${result.entity}:${result.id}`);
    return res.status(200).json({ success: true, ...result });

  } catch (err) {
    console.error('/ai/agent/execute error:', err.message);
    return res.status(400).json({ error: err.message || 'Could not complete that action.' });
  }
});

module.exports = router;
