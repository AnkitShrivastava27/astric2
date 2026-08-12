'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const {
  AI_CHAT_PROVIDERS, GROK_API_KEY, GROK_IMAGE_URL,
  currentMonthKey, getAiLimitsConfig, getImageLimitsConfig,
} = require('../services/ai');
const { DEFAULT_AI_LIMITS } = require('../config/env');

// =============================================================================
// POST /ai/chat
// Keys never leave the server. req.uid comes from the verified Firebase ID
// token (requireAuth) — NOT from the request body — so quota can't be
// bypassed by claiming to be a different uid.
// =============================================================================
router.post('/ai/chat', requireAuth, rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `ai-chat:${r.uid}` }), async (req, res) => {
  try {
    const { provider, model, messages, maxTokens, temperature, useCompletionTokens } = req.body;
    const uid = req.uid;

    const cfg = AI_CHAT_PROVIDERS[provider];
    if (!cfg) return res.status(400).json({ error: `Unknown provider: ${provider}` });
    if (!cfg.key) return res.status(500).json({ error: `${provider} is not configured on the server.` });
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' });
    }

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found.' });
    const userData = userSnap.data();
    const plan = userData.subscription?.plan || 'basic';
    const addonTokens = Number(userData.addonTokens || 0);

    const usageRef = db.collection('users').doc(uid).collection('ai').doc('usage');
    const usageSnap = await usageRef.get();
    const curMonth = currentMonthKey();
    const usageData = usageSnap.exists ? usageSnap.data() : {};
    const tokensUsedThisMonth = usageData.lastResetMonth === curMonth ? Number(usageData.tokensUsedThisMonth || 0) : 0;

    const limits = await getAiLimitsConfig();
    const planLimit = {
      basic: limits.basic_tokens_limit, standard: limits.standard_tokens_limit, premium: limits.premium_tokens_limit,
    }[plan] ?? limits.basic_tokens_limit;

    if (tokensUsedThisMonth >= planLimit + addonTokens) {
      return res.status(402).json({ error: 'AI token limit reached for this month.', limitReached: true });
    }

    const tokenKey = useCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
    const upstream = await axios.post(cfg.url, {
      model: model || cfg.defaultModel,
      messages,
      [tokenKey]: maxTokens || 4096,
      temperature: temperature ?? 0.7,
    }, { headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' }, timeout: 45_000 });

    const reply = (upstream.data?.choices?.[0]?.message?.content || '').trim();
    const tokensConsumed = upstream.data?.usage?.total_tokens ?? Math.ceil(reply.length / 4);

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(usageRef);
      const freshData = fresh.exists ? fresh.data() : {};
      const already = freshData.lastResetMonth === curMonth ? Number(freshData.tokensUsedThisMonth || 0) : 0;
      tx.set(usageRef, {
        tokensUsedThisMonth: already + tokensConsumed, lastResetMonth: curMonth,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return res.status(200).json({ reply, tokensConsumed });
  } catch (err) {
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

    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found.' });
    const plan = userSnap.data().subscription?.plan || 'basic';

    const imgLimits = await getImageLimitsConfig();
    const planImageLimit = { basic: 0, standard: imgLimits.standard_images, premium: imgLimits.premium_images }[plan] ?? 0;

    const usageRef = db.collection('users').doc(uid).collection('ai').doc('usage');
    const usageSnap = await usageRef.get();
    const curMonth = currentMonthKey();
    const usageData = usageSnap.exists ? usageSnap.data() : {};
    const imageGensThisMonth = usageData.lastResetMonth === curMonth ? Number(usageData.imageGensThisMonth || 0) : 0;

    if (imageGensThisMonth >= planImageLimit) {
      return res.status(402).json({ error: 'Image generation limit reached for this month.', limitReached: true });
    }

    const upstream = await axios.post(GROK_IMAGE_URL, {
      model: 'grok-imagine-image-quality', prompt, n: 1,
    }, { headers: { Authorization: `Bearer ${GROK_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 90_000 });

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(usageRef);
      const freshData = fresh.exists ? fresh.data() : {};
      const already = freshData.lastResetMonth === curMonth ? Number(freshData.imageGensThisMonth || 0) : 0;
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
