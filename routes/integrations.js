'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { signState, verifyState } = require('../services/oauthState');
const {
  connectedChannelRef, exchangeHubspotCode, exchangeSalesforceCode,
  exchangeQuickBooksCode, getValidAccessToken,
} = require('../services/integrations');
const { SERVER_BASE_URL, APP_DEEPLINK_SCHEME, HUBSPOT_CLIENT_ID, HUBSPOT_SCOPES } = require('../config/env');

const VALID_PROVIDERS = new Set(['hubspot', 'salesforce', 'quickbooks']);

function deeplinkResult(provider, status, message) {
  const q = message ? `&message=${encodeURIComponent(message)}` : '';
  return `${APP_DEEPLINK_SCHEME}://oauth/${provider}?status=${status}${q}`;
}

// =============================================================================
// HubSpot — single shared app (Astric's own). No per-user secret involved.
// =============================================================================

// GET /integrations/hubspot/authorize-url  (requireAuth)
router.get('/integrations/hubspot/authorize-url', requireAuth, (req, res) => {
  if (!HUBSPOT_CLIENT_ID) return res.status(500).json({ error: 'HubSpot is not configured on the server.' });
  const redirectUri = `${SERVER_BASE_URL}/integrations/hubspot/callback`;
  const state = signState({ uid: req.uid, provider: 'hubspot' });
  const url = `https://app.hubspot.com/oauth/authorize`
    + `?client_id=${encodeURIComponent(HUBSPOT_CLIENT_ID)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent(HUBSPOT_SCOPES)}`
    + `&state=${encodeURIComponent(state)}`;
  return res.status(200).json({ url });
});

// GET /integrations/hubspot/callback — hit by HubSpot's redirect, not the app directly
router.get('/integrations/hubspot/callback', async (req, res) => {
  const { code, state } = req.query;
  const payload = verifyState(state);
  if (!payload || payload.provider !== 'hubspot') {
    return res.redirect(deeplinkResult('hubspot', 'error', 'Invalid or expired connection request.'));
  }
  if (!code) return res.redirect(deeplinkResult('hubspot', 'error', 'Missing authorization code.'));

  try {
    const redirectUri = `${SERVER_BASE_URL}/integrations/hubspot/callback`;
    const tokens = await exchangeHubspotCode(code, redirectUri);
    await connectedChannelRef(payload.uid, 'hubspot').set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 1800) * 1000,
      connectedAt: Date.now(),
    }, { merge: true });
    console.log(`[integrations/hubspot] connected for uid=${payload.uid}`);
    return res.redirect(deeplinkResult('hubspot', 'success'));
  } catch (err) {
    console.error('[integrations/hubspot/callback]', err?.response?.data || err.message);
    return res.redirect(deeplinkResult('hubspot', 'error', 'Could not complete HubSpot connection.'));
  }
});

// =============================================================================
// Salesforce — per-user Connected App (user pastes their own Client ID/Secret
// ONCE; from then on it lives only in Firestore, read only by the server).
// =============================================================================

// POST /integrations/salesforce/credentials  (requireAuth)
// body: { clientId, clientSecret, environment: 'production'|'sandbox' }
router.post('/integrations/salesforce/credentials', requireAuth, async (req, res) => {
  const { clientId, clientSecret, environment } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required.' });

  await connectedChannelRef(req.uid, 'salesforce').set({
    clientId, clientSecret, environment: environment === 'sandbox' ? 'sandbox' : 'production',
  }, { merge: true });
  return res.status(200).json({ success: true });
});

router.get('/integrations/salesforce/authorize-url', requireAuth, async (req, res) => {
  const snap = await connectedChannelRef(req.uid, 'salesforce').get();
  if (!snap.exists || !snap.data().clientId) {
    return res.status(400).json({ error: 'Save your Salesforce Client ID/Secret first via POST /integrations/salesforce/credentials.' });
  }
  const { clientId, environment } = snap.data();
  const redirectUri = `${SERVER_BASE_URL}/integrations/salesforce/callback`;
  const state = signState({ uid: req.uid, provider: 'salesforce' });
  const base = environment === 'sandbox' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
  const url = `${base}/services/oauth2/authorize`
    + `?response_type=code&client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${encodeURIComponent(state)}`;
  return res.status(200).json({ url });
});

router.get('/integrations/salesforce/callback', async (req, res) => {
  const { code, state } = req.query;
  const payload = verifyState(state);
  if (!payload || payload.provider !== 'salesforce') {
    return res.redirect(deeplinkResult('salesforce', 'error', 'Invalid or expired connection request.'));
  }
  if (!code) return res.redirect(deeplinkResult('salesforce', 'error', 'Missing authorization code.'));

  try {
    const ref = connectedChannelRef(payload.uid, 'salesforce');
    const snap = await ref.get();
    if (!snap.exists) return res.redirect(deeplinkResult('salesforce', 'error', 'Credentials not found.'));
    const { clientId, clientSecret, environment } = snap.data();

    const redirectUri = `${SERVER_BASE_URL}/integrations/salesforce/callback`;
    const tokens = await exchangeSalesforceCode({ code, clientId, clientSecret, redirectUri, environment });

    await ref.set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      instanceUrl: tokens.instance_url,
      expiresAt: Date.now() + 2 * 60 * 60 * 1000, // Salesforce tokens don't return expires_in; assume 2hr, refreshed on demand anyway
      connectedAt: Date.now(),
    }, { merge: true });

    console.log(`[integrations/salesforce] connected for uid=${payload.uid}`);
    return res.redirect(deeplinkResult('salesforce', 'success'));
  } catch (err) {
    console.error('[integrations/salesforce/callback]', err?.response?.data || err.message);
    return res.redirect(deeplinkResult('salesforce', 'error', 'Could not complete Salesforce connection.'));
  }
});

// =============================================================================
// QuickBooks — per-user Intuit App, same pattern as Salesforce, plus realmId.
// =============================================================================

// POST /integrations/quickbooks/credentials
// body: { clientId, clientSecret, environment: 'production'|'sandbox' }
router.post('/integrations/quickbooks/credentials', requireAuth, async (req, res) => {
  const { clientId, clientSecret, environment } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required.' });

  await connectedChannelRef(req.uid, 'quickbooks').set({
    clientId, clientSecret, environment: environment === 'sandbox' ? 'sandbox' : 'production',
  }, { merge: true });
  return res.status(200).json({ success: true });
});

router.get('/integrations/quickbooks/authorize-url', requireAuth, async (req, res) => {
  const snap = await connectedChannelRef(req.uid, 'quickbooks').get();
  if (!snap.exists || !snap.data().clientId) {
    return res.status(400).json({ error: 'Save your QuickBooks Client ID/Secret first via POST /integrations/quickbooks/credentials.' });
  }
  const { clientId } = snap.data();
  const redirectUri = `${SERVER_BASE_URL}/integrations/quickbooks/callback`;
  const state = signState({ uid: req.uid, provider: 'quickbooks' });
  const url = `https://appcenter.intuit.com/connect/oauth2`
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&response_type=code&scope=${encodeURIComponent('com.intuit.quickbooks.accounting')}`
    + `&state=${encodeURIComponent(state)}`;
  return res.status(200).json({ url });
});

router.get('/integrations/quickbooks/callback', async (req, res) => {
  const { code, state, realmId } = req.query;
  const payload = verifyState(state);
  if (!payload || payload.provider !== 'quickbooks') {
    return res.redirect(deeplinkResult('quickbooks', 'error', 'Invalid or expired connection request.'));
  }
  if (!code) return res.redirect(deeplinkResult('quickbooks', 'error', 'Missing authorization code.'));

  try {
    const ref = connectedChannelRef(payload.uid, 'quickbooks');
    const snap = await ref.get();
    if (!snap.exists) return res.redirect(deeplinkResult('quickbooks', 'error', 'Credentials not found.'));
    const { clientId, clientSecret } = snap.data();

    const redirectUri = `${SERVER_BASE_URL}/integrations/quickbooks/callback`;
    const tokens = await exchangeQuickBooksCode({ code, clientId, clientSecret, redirectUri });

    await ref.set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      realmId: realmId || null,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      connectedAt: Date.now(),
    }, { merge: true });

    console.log(`[integrations/quickbooks] connected for uid=${payload.uid}`);
    return res.redirect(deeplinkResult('quickbooks', 'success'));
  } catch (err) {
    console.error('[integrations/quickbooks/callback]', err?.response?.data || err.message);
    return res.redirect(deeplinkResult('quickbooks', 'error', 'Could not complete QuickBooks connection.'));
  }
});

// =============================================================================
// Shared: access-token + disconnect, works for all three providers
// =============================================================================

// GET /integrations/:provider/access-token  (requireAuth)
// Client uses the returned short-lived access token directly against the
// provider's REST API — exactly like the existing HubSpotService /
// SalesforceService / QuickBooksService Dart classes already do. The
// client_secret and refresh_token that produced it never left the server.
router.get('/integrations/:provider/access-token', requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.has(provider)) return res.status(400).json({ error: `Unknown provider: ${provider}` });

  try {
    const result = await getValidAccessToken(req.uid, provider);
    if (!result) return res.status(404).json({ error: `${provider} is not connected for this user.` });
    return res.status(200).json(result);
  } catch (err) {
    console.error(`[integrations/${provider}/access-token]`, err?.response?.data || err.message);
    return res.status(500).json({ error: `Could not refresh ${provider} access token. You may need to reconnect.` });
  }
});

// POST /integrations/:provider/disconnect  (requireAuth)
router.post('/integrations/:provider/disconnect', requireAuth, async (req, res) => {
  const { provider } = req.params;
  if (!VALID_PROVIDERS.has(provider)) return res.status(400).json({ error: `Unknown provider: ${provider}` });
  await connectedChannelRef(req.uid, provider).delete();
  return res.status(200).json({ success: true });
});

module.exports = router;
