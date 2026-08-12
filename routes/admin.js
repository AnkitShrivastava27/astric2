'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAdmin } = require('../middleware/adminAuth');
const { rateLimit } = require('../middleware/rateLimit');

const adminLimit = rateLimit({ windowMs: 60_000, max: 20, keyFn: r => `admin:${r.ip}` });

// ─────────────────────────────────────────────────────────────────────────
// POST /update-pricing
// ─────────────────────────────────────────────────────────────────────────
router.post('/update-pricing', requireAdmin, adminLimit, async (req, res) => {
  try {
    const priceFields = [
      'basic_monthly', 'basic_annual', 'standard_monthly', 'standard_annual',
      'premium_monthly', 'premium_annual', 'token_pack_price',
    ];
    const update = {};
    for (const key of priceFields) {
      if (req.body[key] !== undefined) {
        const val = Number(req.body[key]);
        if (isNaN(val) || val < 0) return res.status(400).json({ error: `${key} must be a non-negative number.` });
        update[key] = val;
      }
    }
    if (req.body.vercel_api_url !== undefined) update.vercel_api_url = String(req.body.vercel_api_url).trim();
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided.' });

    update.updated_at = admin.firestore.FieldValue.serverTimestamp();
    update.updated_by = req.body.updatedBy || 'admin';
    await db.collection('pricing_config').doc('plans').set(update, { merge: true });

    const updatedFields = Object.keys(update).filter(k => k !== 'updated_at' && k !== 'updated_by');
    console.log(`Pricing updated by "${update.updated_by}":`, updatedFields);
    return res.status(200).json({ success: true, updated: updatedFields, message: 'Done. Flutter app reflects changes within ~1 second.' });
  } catch (err) {
    console.error('update-pricing error:', err.message);
    return res.status(500).json({ error: 'Failed to update pricing.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /update-ai-limits
// ─────────────────────────────────────────────────────────────────────────
router.post('/update-ai-limits', requireAdmin, adminLimit, async (req, res) => {
  try {
    const limitFields = ['basic_tokens_limit', 'standard_tokens_limit', 'premium_tokens_limit', 'token_pack_size'];
    const update = {};
    for (const key of limitFields) {
      if (req.body[key] !== undefined) {
        const val = Number(req.body[key]);
        if (!Number.isInteger(val) || val < 0) return res.status(400).json({ error: `${key} must be a non-negative integer.` });
        update[key] = val;
      }
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'No valid fields provided.' });

    update.updated_at = admin.firestore.FieldValue.serverTimestamp();
    update.updated_by = req.body.updatedBy || 'admin';
    await db.collection('ai_limits').doc('config').set(update, { merge: true });

    const updatedFields = Object.keys(update).filter(k => k !== 'updated_at' && k !== 'updated_by');
    console.log(`AI limits updated by "${update.updated_by}":`, updatedFields);
    return res.status(200).json({ success: true, updated: updatedFields, message: 'Done. Flutter app reflects new limits within ~1 second.' });
  } catch (err) {
    console.error('/update-ai-limits error:', err.message);
    return res.status(500).json({ error: 'Failed to update AI limits.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /admin/ai/limits  (image gen limits — separate Firestore doc, see services/ai.js)
// ─────────────────────────────────────────────────────────────────────────
router.post('/admin/ai/limits', requireAdmin, adminLimit, async (req, res) => {
  const { basic_images, standard_images, premium_images } = req.body;
  if (basic_images == null || standard_images == null || premium_images == null) {
    return res.status(400).json({ error: 'basic_images, standard_images, premium_images are required' });
  }
  const b = parseInt(basic_images), s = parseInt(standard_images), p = parseInt(premium_images);
  if ([b, s, p].some(v => isNaN(v) || v < 0)) {
    return res.status(400).json({ error: 'Image limits must be non-negative integers' });
  }
  try {
    await db.collection('config').doc('ai_limits').set({
      basic_images: b, standard_images: s, premium_images: p,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`[admin/ai/limits] basic=${b} standard=${s} premium=${p}`);
    return res.status(200).json({ success: true, basic_images: b, standard_images: s, premium_images: p });
  } catch (err) {
    console.error('[POST /admin/ai/limits]', err.message);
    return res.status(500).json({ error: 'Failed to save limits' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /admin/referral/config
// SECURITY FIX: the live server had ZERO auth on this route despite the
// /admin/ path — anyone could change referral economics. Now behind the
// same requireAdmin check as every other admin route.
// ─────────────────────────────────────────────────────────────────────────
router.post('/admin/referral/config', requireAdmin, adminLimit, async (req, res) => {
  const { pointsPerReferral, pointsPerToken, enabled } = req.body;
  if (pointsPerReferral == null || pointsPerToken == null) {
    return res.status(400).json({ error: 'Missing fields.' });
  }
  try {
    await db.collection('config').doc('referral').set({
      pointsPerReferral: parseInt(pointsPerReferral),
      pointsPerToken: parseInt(pointsPerToken),
      enabled: enabled !== false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log('[admin/referral/config] updated:', { pointsPerReferral, pointsPerToken, enabled });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[admin/referral/config]', err.message);
    return res.status(500).json({ error: 'Save failed.' });
  }
});

module.exports = router;
