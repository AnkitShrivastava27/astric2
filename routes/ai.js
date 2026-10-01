'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
  AI_CHAT_PROVIDERS, GROK_API_KEY, GROK_IMAGE_URL,
  currentMonthKey, normalizeMonthKey, getAiLimitsConfig, getImageLimitsConfig,
  estimateTokens, reserveTokens, settleTokens, canAccessFeature, resolveOrgBilling,
} = require('../services/ai');
const { DEFAULT_AI_LIMITS } = require('../config/env');

// =============================================================================
// POST /ai/chat
// Keys never leave the server. req.uid comes from the verified Firebase ID
// token (requireAuth) — NOT from the request body — so quota can't be
// bypassed by claiming to be a different uid.
// =============================================================================
router.post('/ai/chat', requireAuth, rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `ai-chat:${r.uid}` }), async (req, res) => {
  let reservation = null;
  let billing = null;
  try {
    const { provider, model, messages, maxTokens, maxCompletionTokens, temperature, useCompletionTokens } = req.body;
    const uid = req.uid;

    const cfg = AI_CHAT_PROVIDERS[provider];
    if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    if (!cfg.key) return res.status(500).json({ error: `${provider} is not configured on the server.` });
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' });
    }

    billing = await resolveOrgBilling(uid);
    if (!billing) return res.status(404).json({ error: 'User not found.' });

    // Cap the model's answer so one long reply can't blow far past the
    // quota. (The old code only checked "used >= limit" BEFORE the call, so
    // a user with 1 token left could still get a 4096-token answer — that's
    // how a 10k plan ended at 11.6k.) Budget = what's left, minus the prompt.
    const requested = Number(maxCompletionTokens || maxTokens) || 4096;
    const promptEstimate = estimateTokens(messages);
    const first = await reserveTokens({
      ...billing, reserve: promptEstimate + Math.min(requested, 4096), minimum: promptEstimate + 50,
    });
    if (!first.ok) {
      return res.status(402).json({ error: 'AI token limit reached for this month.', limitReached: true });
    }
    reservation = first;
    const completionBudget = Math.max(50, Math.min(requested, first.reserved - promptEstimate));

    const tokenKey = useCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
    const upstream = await axios.post(cfg.url, {
      model: model || cfg.defaultModel,
      messages,
      [tokenKey]: completionBudget,
      temperature: temperature ?? 0.7,
    }, { headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, timeout: 45_000 });

    const reply = (upstream.data?.choices?.[0]?.message?.content || '').trim();
    const tokensConsumed = upstream.data?.usage?.total_tokens
      ?? (promptEstimate + Math.ceil(reply.length / 4));

    // Replace the reservation with the real number.
    await settleTokens({ ...billing, reservation, actual: tokensConsumed });
    reservation = null;

    return res.status(200).json({ reply, tokensConsumed });
  } catch (err) {
    // Upstream failed → give the reserved tokens back; the user got nothing.
    if (reservation) await settleTokens({ ...billing, reservation, actual: 0 });
    const msg = err?.response?.data?.error?.message || err?.response?.data?.message || err.message || 'AI request failed.';
    console.error('/ai/chat error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// =============================================================================
// POST /ai/image
// =============================================================================
router.post('/ai/image', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `ai-image:${r.uid}` }), async (req, res) => {
  try {
    const { prompt } = req.body;
    const uid = req.uid;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    if (!GROK_API_KEY) return res.status(500).json({ error: 'Image generation is not configured on the server.' });

    // 🐞 FIX (Image Studio ignoring admin-panel plan gating): this used to
    // hard-code "basic = 0 images" and never looked at the gating the admin
    // edits (appConfig/planGating → image_studio). Now: (1) the plan must be
    // allowed to use the Image Studio screen per the admin panel, and
    // (2) the per-plan image quota is whatever the admin set — including a
    // non-zero basic_images if they choose to give Basic some images.
    // Plan + usage belong to the ORG OWNER (employees share the owner's pool).
    const billing = await resolveOrgBilling(uid);
    if (!billing) return res.status(404).json({ error: 'User not found.' });
    const { plan, orgOwnerUid } = billing;

    if (!(await canAccessFeature('image_studio', plan))) {
      return res.status(403).json({ error: 'Image Studio is not available on your plan.', requiresUpgrade: true });
    }

    const imgLimits = await getImageLimitsConfig();
    const planImageLimit = { basic: imgLimits.basic_images, standard: imgLimits.standard_images, premium: imgLimits.premium_images }[plan] ?? 0;

    const usageRef = db.collection('users').doc(orgOwnerUid).collection('ai').doc('usage');
    const usageSnap = await usageRef.get();
    const curMonth = currentMonthKey();
    const usageData = usageSnap.exists ? usageSnap.data() : {};
    const imageGensThisMonth = normalizeMonthKey(usageData.lastResetMonth) === curMonth ? Number(usageData.imageGensThisMonth || 0) : 0;

    if (imageGensThisMonth >= planImageLimit) {
      return res.status(402).json({ error: 'Image generation limit reached for this month.', limitReached: true });
    }

    // 🐞 FIX ("something went wrong" in Image Studio): this used to omit
    // response_format, so xAI defaulted to returning a `url` pointing at
    // its own image-storage domain. The Flutter client (ImageGenService)
    // then had to do a SECOND, separate fetch of that URL from the
    // device/browser to get actual bytes for the editor — and on Flutter
    // WEB specifically, that's a cross-origin request straight from the
    // browser to xAI's storage domain, which is exactly the kind of call
    // CORS is designed to block unless that domain opts in. A blocked
    // CORS request throws a raw, untyped network exception that isn't an
    // HTTP error status at all, so it can silently miss whatever
    // catch/status-code handling exists on the client and surface as a
    // generic, unhelpful failure. Requesting b64_json instead means the
    // image comes back as part of THIS response — no second cross-origin
    // request, no CORS exposure, works identically on every platform.
    const upstream = await axios.post(GROK_IMAGE_URL, {
      model: 'grok-imagine-image-quality', prompt, n: 1, response_format: 'b64_json',
    }, { headers: { Authorization: `Bearer ${GROK_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 90_000 });

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(usageRef);
      const freshData = fresh.exists ? fresh.data() : {};
      const already = normalizeMonthKey(freshData.lastResetMonth) === curMonth ? Number(freshData.imageGensThisMonth || 0) : 0;
      tx.set(usageRef, {
        imageGensThisMonth: already + 1, lastResetMonth: curMonth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return res.status(200).json(upstream.data);
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message || 'Image generation failed.';
    console.error('/ai/image error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// =============================================================================
// GET /ai-limits  and  GET /ai/limits
// Non-sensitive config, public like the live server. (Two paths preserved
// exactly as they existed — /ai-limits returns token limits, /ai/limits
// returns image limits, from two different Firestore docs. Confusing
// naming inherited from the live server; left as-is since renaming would
// be a breaking client change outside this pass's scope.)
// =============================================================================
router.get('/ai-limits', async (_, res) => {
  try {
    const limits = await getAiLimitsConfig();
    return res.status(200).json({
      basicTokensLimit: limits.basic_tokens_limit,
      standardTokensLimit: limits.standard_tokens_limit,
      premiumTokensLimit: limits.premium_tokens_limit,
      tokenPackSize: limits.token_pack_size,
      source: 'firestore',
    });
  } catch (err) {
    console.error('/ai-limits error:', err.message);
    return res.status(200).json(DEFAULT_AI_LIMITS);
  }
});

router.get('/ai/limits', async (_, res) => {
  try {
    const data = await getImageLimitsConfig();
    return res.status(200).json(data);
  } catch (err) {
    console.error('/ai/limits error:', err.message);
    return res.status(200).json({ basic_images: 3, standard_images: 20, premium_images: 100 });
  }
});

module.exports = router;
