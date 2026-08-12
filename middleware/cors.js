/**
 * middleware/cors.js
 * Unchanged from the live server — wildcard origin, no cookies/credentials
 * involved anywhere in this API (auth is a Bearer header, not a cookie), so
 * this is safe as-is for both the mobile app and the upcoming web build.
 */
'use strict';

module.exports = function cors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};
