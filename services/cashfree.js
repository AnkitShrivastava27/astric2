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

module.exports = { CF_ENV, CF_BASE_URL, cfHeaders };
