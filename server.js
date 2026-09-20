/**
 * server.js
 *
 * Thin entrypoint. All logic lives in routes/, services/, middleware/,
 * config/. Every endpoint path below is IDENTICAL to the previous
 * single-file server — this is a reorganization + security pass, not an
 * API change, so the existing Flutter app keeps working against the same
 * URLs (the only client-visible change is that some calls now need an
 * `Authorization: Bearer <Firebase ID token>` header — see each route file
 * for which ones).
 *
 * ENVIRONMENT VARIABLES — set in Render Dashboard → Environment:
 * ──────────────────────────────────────────────────────────────
 *  CASHFREE_APP_ID / CASHFREE_SECRET_KEY / CASHFREE_ENV
 *  FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *  ADMIN_API_KEY              — required for every admin route
 *  PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV
 *  SERVER_BASE_URL            — e.g. https://astricserver.onrender.com (no trailing slash)
 *  PORT                       — set automatically by Render
 *
 *  -- EmailJS (unchanged) -----------------------------------------------------
 *  EMAILJS_SERVICE_ID / EMAILJS_TEMPLATE_ID / EMAILJS_PUBLIC_KEY
 *
 *  -- AI (all keys stay server-side; client calls /ai/chat and /ai/image) ----
 *  DEEPSEEK_API_KEY / GROK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY (reserved)
 *
 *  -- Messaging ---------------------------------------------------------------
 *  META_VERIFY_TOKEN / META_APP_SECRET / TELEGRAM_BOT_TOKEN
 *
 *  -- HubSpot (Astric's own shared OAuth app) ----------------------------------
 *  HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET / HUBSPOT_SCOPES (optional)
 *
 *  -- OAuth state signing (optional, falls back to ADMIN_API_KEY) ------------
 *  OAUTH_STATE_SECRET
 *
 *  -- Deep link back into the app after OAuth connect (optional) -------------
 *  APP_DEEPLINK_SCHEME        — defaults to "biznexus"
 *
 * NOTE: Salesforce and QuickBooks do NOT need global env vars — each user
 * supplies their own Connected App / Intuit App Client ID+Secret via
 * POST /integrations/{salesforce,quickbooks}/credentials, stored in
 * Firestore, never returned to any client after that.
 */
'use strict';

const express = require('express');
const app = express();

// Capture the raw request body alongside the parsed JSON — needed by
// services/meta.js to verify Meta's X-Hub-Signature-256 webhook signature.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.use(require('./middleware/cors'));

app.use(require('./routes/config'));
app.use(require('./routes/payments.cashfree'));
app.use(require('./routes/payments.paypal'));
app.use(require('./routes/ai'));
app.use(require('./routes/admin'));
app.use(require('./routes/messaging'));
app.use(require('./routes/referral'));
app.use(require('./routes/notifications'));
app.use(require('./routes/integrations'));
app.use(require('./routes/agent'));
app.use(require('./routes/ai-website'))

const env = require('./config/env');
const { CF_BASE_URL } = require('./services/cashfree');
const { PP_BASE_URL } = require('./services/paypal');

app.listen(env.PORT, () => {
  // console.log(`\n✅  Astric Payment Server listening on port ${env.PORT}`);
  // console.log(`    Cashfree    : ${env.CF_ENV}  →  ${CF_BASE_URL}`);
  // console.log(`    PayPal      : ${env.PP_ENV}  →  ${PP_BASE_URL}`);
  // console.log(`    Server URL  : ${env.SERVER_BASE_URL}`);
  // console.log(`    Firebase    : ${env.FIREBASE_PROJECT_ID}`);
  // console.log(`    EmailJS     : serviceId=${env.EMAILJS_SERVICE_ID || '(not set)'}`);
  // console.log(`    DeepSeek    : key_set=${env.DEEPSEEK_API_KEY.length > 0}`);
  // console.log(`    Grok (xAI)  : key_set=${env.GROK_API_KEY.length > 0}`);
  // console.log(`    OpenAI      : key_set=${env.OPENAI_API_KEY.length > 0}`);
  // console.log(`    Anthropic   : key_set=${env.ANTHROPIC_API_KEY.length > 0}`);
  // console.log(`    HubSpot     : client_id_set=${env.HUBSPOT_CLIENT_ID.length > 0}`);
  // console.log(`    Meta        : app_secret_set=${env.META_APP_SECRET.length > 0}`);
  // console.log(`    Admin key   : set=${env.ADMIN_API_KEY.length > 0}\n`);
  console.log(`   api is working`);
});
