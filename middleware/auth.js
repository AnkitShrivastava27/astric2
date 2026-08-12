/**
 * middleware/auth.js
 *
 * Verifies a real Firebase ID token from `Authorization: Bearer <idToken>`
 * and sets req.uid to the verified uid.
 *
 * THIS IS THE FIX for every "trusts uid from the request body" bug that was
 * found across payments, AI, messaging, and referral endpoints: those
 * routes must now read req.uid (set here, from a cryptographically verified
 * token) instead of req.body.uid / req.query.uid. A client can still SEND a
 * uid in the body for logging/debugging, but it is never used for identity
 * or authorization decisions once this middleware is applied.
 *
 * Client side: get the token with
 *   FirebaseAuth.instance.currentUser!.getIdToken()
 * and send it as `Authorization: Bearer <token>` on every protected call.
 * Firebase ID tokens are short-lived (~1hr) and getIdToken() auto-refreshes,
 * so this is safe to call on every request.
 *
 * NOT used on:
 *  - PayPal capture-order / capture-token-order: these are hit by a browser
 *    redirect (PayPal → your server), which cannot attach a custom header.
 *    Those routes are secured differently — see routes/payments.paypal.js,
 *    which validates against the order record stored at creation time
 *    instead of trusting the query string.
 *  - Meta/Telegram webhooks: those are secured by signature verification /
 *    a token in the URL path, not a Firebase session — see routes/messaging.js.
 *  - Admin routes: secured by middleware/adminAuth.js instead.
 */
'use strict';

const { admin } = require('../config/firebase');

async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!idToken) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <Firebase ID token>.' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    console.warn('requireAuth: token verification failed:', err.message);
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

module.exports = { requireAuth };
