'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { rateLimit } = require('../middleware/rateLimit');
const env = require('../config/env');
const { getAiLimitsConfig } = require('../services/ai');

router.get('/', (_, res) => {
  res.status(200).json({
    service: 'Astric Payment Server',
    status: 'ok',
    environment: env.CF_ENV,
    timestamp: new Date().toISOString(),
  });
});

router.get('/health', (_, res) => {
  res.status(200).json({ status: 'ok', environment: env.CF_ENV, timestamp: new Date().toISOString() });
});

// =============================================================================
// GET /config
// Flutter calls this ONCE on startup for non-secret runtime config: EmailJS
// creds (unchanged — EmailJS's "public key" is designed to be public, same
// as a Stripe publishable key), Cashfree/PayPal env, AI token limits, and
// plan gating. AI PROVIDER KEYS ARE NOT HERE — see routes/ai.js, which
// proxies the actual calls and keeps every provider key server-side.
// =============================================================================
router.get('/config', rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `config:${r.ip}` }), async (_, res) => {
  try {
    const limits = await getAiLimitsConfig();

    const DEFAULT_SCREEN_ACCESS = {
      finance: 'basic', invoices: 'basic', customers: 'basic', leads: 'basic',
      projects: 'basic', tasks: 'basic', employees: 'basic', sales: 'basic',
      currency: 'basic', files: 'basic', notes: 'basic', calendar: 'basic',
      reports: 'standard', kpis: 'standard', ai_chat: 'standard',
      email: 'standard', team_chat: 'standard', unified_inbox: 'standard',
      integrations: 'standard', data_storage: 'standard',
      pdf_analyst: 'premium',
    };
    const DEFAULT_SCREEN_LIMITS = {
      max_employees_basic: 3, max_employees_standard: 10, max_employees_premium: 20,
      max_integrations_basic: 2, max_integrations_standard: 6, max_integrations_premium: -1,
      max_storage_mb_basic: 500, max_storage_mb_standard: 5120, max_storage_mb_premium: -1,
      ai_tokens_basic: 10000, ai_tokens_standard: 50000, ai_tokens_premium: 200000,
    };

    let screenAccess = DEFAULT_SCREEN_ACCESS;
    let screenLimits = DEFAULT_SCREEN_LIMITS;
    try {
      const gatingSnap = await db.collection('appConfig').doc('planGating').get();
      if (gatingSnap.exists) {
        const gatingData = gatingSnap.data();
        if (gatingData.screenAccess) screenAccess = { ...DEFAULT_SCREEN_ACCESS, ...gatingData.screenAccess };
        if (gatingData.screenLimits) screenLimits = { ...DEFAULT_SCREEN_LIMITS, ...gatingData.screenLimits };
      }
    } catch (gatingErr) {
      console.warn('[config] Could not read appConfig/planGating:', gatingErr.message);
    }

    return res.status(200).json({
      emailjs: {
        serviceId: env.EMAILJS_SERVICE_ID,
        templateId: env.EMAILJS_TEMPLATE_ID,
        publicKey: env.EMAILJS_PUBLIC_KEY,
      },
      cashfreeEnv: env.CF_ENV,
      googleWebClientId: env.GOOGLE_WEB_CLIENT_ID,
      hubspotClientId: env.HUBSPOT_CLIENT_ID,
      hubspotClientSecret: env.HUBSPOT_CLIENT_SECRET,
      paypalEnv: env.PP_ENV,
      aiLimits: {
        basicTokensLimit: limits.basic_tokens_limit,
        standardTokensLimit: limits.standard_tokens_limit,
        premiumTokensLimit: limits.premium_tokens_limit,
        tokenPackSize: limits.token_pack_size,
      },
      screenAccess,
      screenLimits,
    });
  } catch (err) {
    console.error('/config error:', err.message);
    return res.status(500).json({ error: 'Failed to load config.' });
  }
});

module.exports = router;
