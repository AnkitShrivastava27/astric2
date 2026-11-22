'use strict';

const { CF_ENV, CF_APP_ID, CF_SECRET_KEY } = require('../config/env');

const CF_BASE_URL = CF_ENV === 'PROD'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

function cfHeaders() {
  return {
    'x-client-id': CF_APP_ID,
    'x-client-secret': CF_SECRET_KEY,
    'x-api-version': '2023-08-01',
    'Content-Type': 'application/json',
  };
}

// Cashfree sometimes returns a payment_session_id ending in "paymentpayment".
// Native SDKs tolerate it, but the browser checkout rejects it with
// {"code":"payment_session_id_invalid"}. Strip the duplicated suffix once,
// here, so every create-order route hands clients a clean id.
function cleanSessionId(id) {
  let s = String(id || '').trim();
  while (s.endsWith('paymentpayment')) s = s.slice(0, -'payment'.length);
  return s;
}

module.exports = { CF_ENV, CF_BASE_URL, cfHeaders, cleanSessionId };
