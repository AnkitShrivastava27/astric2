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
  const creds = Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `${PP_BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    { headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  _tokenCache = { token: res.data.access_token, expiresAt: now + res.data.expires_in * 1000 };
  return _tokenCache.token;
}

function ppHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': uuidv4(),
  };
}

module.exports = { PP_ENV, PP_CLIENT_ID, PP_BASE_URL, getPayPalAccessToken, ppHeaders };
