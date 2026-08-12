/**
 * services/integrations.js
 *
 * OAuth token exchange/refresh for HubSpot, Salesforce, and QuickBooks.
 *
 * Design (same for all three): the client NEVER holds a client_secret or a
 * refresh_token after the initial connect. It only ever receives a
 * short-lived access_token (from GET /integrations/:provider/access-token),
 * exactly the way every reputable mobile OAuth integration works. The
 * server stores refresh_token + client_secret in Firestore
 * (users/{uid}/connectedChannels/{provider}) and refreshes on demand.
 *
 * HubSpot uses ONE shared app (Astric's own, HUBSPOT_CLIENT_ID/SECRET in
 * server env) — that's how HubSpot's "one-tap" marketplace-style OAuth
 * works, matching what the app's UI already promises.
 *
 * Salesforce and QuickBooks require each customer to register their own
 * Connected App / Intuit App (that's inherent to those platforms for this
 * kind of integration — there's no shared-app equivalent). The user still
 * pastes their own Client ID/Secret once, but now it's sent straight to
 * the server and stored there — never used for a token exchange on-device,
 * never returned to any endpoint afterward.
 */
'use strict';

const axios = require('axios');
const { db } = require('../config/firebase');
const { HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET } = require('../config/env');

function connectedChannelRef(uid, provider) {
  return db.collection('users').doc(uid).collection('connectedChannels').doc(provider);
}

// ── HubSpot ────────────────────────────────────────────────────────────
async function exchangeHubspotCode(code, redirectUri) {
  const res = await axios.post(
    'https://api.hubapi.com/oauth/v1/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data; // { access_token, refresh_token, expires_in }
}

async function refreshHubspotToken(refreshToken) {
  const res = await axios.post(
    'https://api.hubapi.com/oauth/v1/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      refresh_token: refreshToken,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data;
}

// ── Salesforce ──────────────────────────────────────────────────────────
function salesforceBaseUrl(environment) {
  return environment === 'sandbox' ? 'https://test.salesforce.com' : 'https://login.salesforce.com';
}

async function exchangeSalesforceCode({ code, clientId, clientSecret, redirectUri, environment }) {
  const res = await axios.post(
    `${salesforceBaseUrl(environment)}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data; // { access_token, refresh_token, instance_url, ... }
}

async function refreshSalesforceToken({ refreshToken, clientId, clientSecret, environment }) {
  const res = await axios.post(
    `${salesforceBaseUrl(environment)}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data;
}

// ── QuickBooks ─────────────────────────────────────────────────────────
async function exchangeQuickBooksCode({ code, clientId, clientSecret, redirectUri }) {
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data;
}

async function refreshQuickBooksToken({ refreshToken, clientId, clientSecret }) {
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data;
}

// ── Shared: get a valid (auto-refreshed) access token for a provider ─────
async function getValidAccessToken(uid, provider) {
  const ref = connectedChannelRef(uid, provider);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();

  const stillValid = data.expiresAt && Date.now() < data.expiresAt - 60_000;
  if (stillValid) {
    return { accessToken: data.accessToken, instanceUrl: data.instanceUrl, realmId: data.realmId };
  }
  if (!data.refreshToken) return null;

  let tokens;
  if (provider === 'hubspot') {
    tokens = await refreshHubspotToken(data.refreshToken);
  } else if (provider === 'salesforce') {
    tokens = await refreshSalesforceToken({
      refreshToken: data.refreshToken, clientId: data.clientId,
      clientSecret: data.clientSecret, environment: data.environment,
    });
  } else if (provider === 'quickbooks') {
    tokens = await refreshQuickBooksToken({
      refreshToken: data.refreshToken, clientId: data.clientId, clientSecret: data.clientSecret,
    });
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const update = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || data.refreshToken, // some providers don't rotate it
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
  if (tokens.instance_url) update.instanceUrl = tokens.instance_url;
  await ref.set(update, { merge: true });

  return { accessToken: update.accessToken, instanceUrl: update.instanceUrl || data.instanceUrl, realmId: data.realmId };
}

module.exports = {
  connectedChannelRef,
  exchangeHubspotCode, refreshHubspotToken,
  exchangeSalesforceCode, refreshSalesforceToken,
  exchangeQuickBooksCode, refreshQuickBooksToken,
  getValidAccessToken,
};
