'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { PP_ENV, PP_CLIENT_ID, PP_CLIENT_SECRET } = require('../config/env');

const PP_BASE_URL = PP_ENV === 'LIVE'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

let _tokenCache = { token: '', expiresAt: 0 };

async function getPayPalAccessToken() {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  // FIX: a 401 here (invalid_client) was previously left to bubble up as
  // axios's generic "Request failed with status code 401", which the route
  // handlers then wrapped in a 500 — so the app just showed "401" with no
  // clue what it meant. Give a specific, actionable message instead.
  if (!PP_CLIENT_ID || !PP_CLIENT_SECRET) {
    throw new Error(
      `PayPal is not configured: PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are missing on the server (PP_ENV=${PP_ENV}).`
    );
  }

  const creds = Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString('base64');
  try {
    const res = await axios.post(
      `${PP_BASE_URL}/v1/oauth2/token`,
      'grant_type=client_credentials',
      { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    _tokenCache = { token: res.data.access_token, expiresAt: now + res.data.expires_in * 1000 };
    return _tokenCache.token;
  } catch (err) {
    if (err?.response?.status === 401) {
      throw new Error(
        `PayPal rejected the client credentials (401 invalid_client) against ${PP_BASE_URL}. ` +
        `PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET do not match PAYPAL_ENV=${PP_ENV} — ` +
        `SANDBOX credentials will not work against LIVE (or vice versa), and a client id/secret ` +
        `copied from the wrong PayPal app will fail the same way.`
      );
    }
    throw err;
  }
}

function ppHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': uuidv4(),
  };
}

module.exports = { PP_ENV, PP_CLIENT_ID, PP_BASE_URL, getPayPalAccessToken, ppHeaders };
