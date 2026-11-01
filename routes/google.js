/**
 * routes/google.js — the ONLY server part of the Google integrations.
 *
 * Google Contacts / Drive / Calendar work like HubSpot and Salesforce: the company pastes its own Google OAuth
 * Client ID + Secret into the app, the app opens Google's login, and the app itself talks to Google. The server
 * never sees those keys here.
 *
 * The one thing the app cannot do alone: Google only accepts an https "redirect URI" for web OAuth clients, so the
 * browser needs somewhere https to land after the person approves. This page is that place. It hands the code to
 * the app through the app's own link (biznexus://oauth/google?code=…) and ALSO prints the code so it can be pasted
 * into the app if the link does not open. It stores nothing and does not use the code itself.
 *
 *   GET /oauth/google/callback
 */
'use strict';

const express = require('express');
const router = express.Router();
const { APP_DEEPLINK_SCHEME } = require('../config/env');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

router.get('/oauth/google/callback', (req, res) => {
  const { code, state, error, error_description: desc } = req.query;
  const q = new URLSearchParams();
  for (const [k, v] of [['code', code], ['state', state], ['error', error], ['error_description', desc]]) {
    if (typeof v === 'string' && v.length <= 2000) q.set(k, v);
  }
  const link = `${APP_DEEPLINK_SCHEME || 'biznexus'}://oauth/google?${q.toString()}`;
  const failed = typeof error === 'string' && error;
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Google</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;color:#222;line-height:1.5}
a.b{display:inline-block;background:#1a73e8;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600}
code{display:block;word-break:break-all;background:#f1f3f4;padding:10px;border-radius:6px;font-size:12.5px;margin:8px 0}</style></head>
<body>
${failed
    ? `<h2>Google did not connect</h2><p>${esc(desc || error)}</p><p>Go back to the app and try again.</p>`
    : `<h2>Almost done</h2><p>Return to the app to finish connecting Google.</p>
<p><a class="b" href="${esc(link)}">Open the app</a></p>
${typeof code === 'string' && code ? `<p style="font-size:13px;color:#555">If the app does not open, copy this code and paste it where the app asks for it:</p><code>${esc(code)}</code>` : ''}
<script>setTimeout(function(){ location.href = ${JSON.stringify(link).replace(/</g, '\\u003c')}; }, 400);</script>`}
</body></html>`);
});

module.exports = router;
