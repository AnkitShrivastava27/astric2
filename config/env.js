/**
 * config/env.js
 * Every process.env read for the whole server lives here — one place to see
 * what's configured, one place to add a new var.
 */
'use strict';

function bool(v) { return String(v || '').toLowerCase() === 'true'; }

module.exports = {
  PORT: process.env.PORT || 3000,
  SERVER_BASE_URL: (process.env.SERVER_BASE_URL || 'https://astricserver.onrender.com').replace(/\/+$/, ''),
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || '',

  // App deep-link scheme used to return to the Flutter app after a
  // server-side OAuth exchange (HubSpot/Salesforce/QuickBooks).
  APP_DEEPLINK_SCHEME: process.env.APP_DEEPLINK_SCHEME || 'biznexus',

  // -- Firebase --------------------------------------------------------------
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),

  // -- Cashfree ----------------------------------------------------------------
  CF_ENV: (process.env.CASHFREE_ENV || 'TEST').toUpperCase(),
  CF_APP_ID: process.env.CASHFREE_APP_ID || '',
  CF_SECRET_KEY: process.env.CASHFREE_SECRET_KEY || '',

  // -- PayPal --------------------------------------------------------------
  PP_ENV: (process.env.PAYPAL_ENV || 'SANDBOX').toUpperCase(),
  PP_CLIENT_ID: process.env.PAYPAL_CLIENT_ID || '',
  PP_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET || '',

  FALLBACK_USD_INR_RATE: 83.5,

  // -- EmailJS (unchanged from the live server — client fetches via /config) --
  EMAILJS_SERVICE_ID: process.env.EMAILJS_SERVICE_ID || '',
  EMAILJS_TEMPLATE_ID: process.env.EMAILJS_TEMPLATE_ID || '',
  EMAILJS_PUBLIC_KEY: process.env.EMAILJS_PUBLIC_KEY || '',

  // -- AI (all keys stay server-side; client calls /ai/chat & /ai/image) ------
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  GROK_API_KEY: process.env.GROK_API_KEY || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',

  DEFAULT_AI_LIMITS: {
    basic_tokens_limit: 5000,
    standard_tokens_limit: 50000,
    premium_tokens_limit: 200000,
    token_pack_size: 10000,
  },

  // -- Messaging (WhatsApp/Instagram/Messenger via Meta, Telegram) -----------
  META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN || 'astric_verify_token',
  META_APP_SECRET: process.env.META_APP_SECRET || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',

  // -- HubSpot (single shared app — Astric's own OAuth app, not per-user) -----
  HUBSPOT_CLIENT_ID: process.env.HUBSPOT_CLIENT_ID || '',
  HUBSPOT_CLIENT_SECRET: process.env.HUBSPOT_CLIENT_SECRET || '',
  HUBSPOT_SCOPES: process.env.HUBSPOT_SCOPES || 'crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read',
};
