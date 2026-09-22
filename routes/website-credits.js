// routes/website-credits.js
//
// Two endpoints for the Website Studio pricing tiers:
//   POST /create-website-credit-order  -> { orderId, paymentSessionId }
//   POST /verify-website-credit-order  -> { status: 'PAID' | ... }
//
// Same shape as the existing /create-token-order + /fulfill-token-order
// pattern in payments.cashfree.js — just crediting a different Firestore
// field (users/{uid}/websiteStudio/credits.tokensRemaining instead of
// users/{uid}.addonTokens) and different price/quantity math, since
// Website Studio's three tiers (Trial/Standard/Pro) aren't "N packs of a
// fixed token amount" the way the existing token top-up is.
//
// 🔧 WIRED UP: this previously had two placeholder functions
// (createCashfreeOrder / fetchCashfreeOrderStatus) that just threw — now
// using the real Cashfree Orders API calls, copied from
// payments.cashfree.js's /create-token-order and /fulfill-token-order
// (same CF_BASE_URL + cfHeaders() from services/cashfree.js, same
// order-id scheme, same uid-ownership + idempotency guards). Also added
// requireAuth + rateLimit, matching every other authenticated route in
// this server, instead of assuming auth middleware was mounted elsewhere.
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { CF_ENV, CF_BASE_URL, cfHeaders } = require('../services/cashfree');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// Mirrors WebsiteTier in website_project_model.dart — keep these two in
// sync if the pricing ever changes. tokenBudget must match
// WebsiteTier.tokenBudget exactly, since spendForNewBuild() on the client
// deducts that same amount for one build of that tier — a pack buys
// exactly enough for one build.
const TIERS = {
  trial:    { tokenBudget: 1000, priceField: 'website_trial_price',    fallbackPriceINR: 9 },
  standard: { tokenBudget: 4500, priceField: 'website_standard_price', fallbackPriceINR: 39 },
  pro:      { tokenBudget: 9000, priceField: 'website_pro_price',      fallbackPriceINR: 99 },
};

// Reads the admin-configurable price for a tier from pricing_config/plans
// (the same doc + field names PricingConfig.fromJson reads on the Flutter
// side), falling back to the tier's built-in default if that doc or field
// isn't set yet.
async function priceForTier(tierName) {
  const tier = TIERS[tierName];
  const snap = await db.collection('pricing_config').doc('plans').get();
  const data = snap.exists ? snap.data() : {};
  const price = data[tier.priceField];
  return (price === undefined || price === null) ? tier.fallbackPriceINR : Number(price);
}

// ─────────────────────────────────────────────────────────────────────────
// POST /create-website-credit-order
// ─────────────────────────────────────────────────────────────────────────
router.post('/create-website-credit-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `create-website-credit-order:${r.uid}` }), async (req, res) => {
  try {
    const tierName = req.body && req.body.tier;
    const tier = TIERS[tierName];
    if (!tier) {
      return res.status(400).json({ error: 'Unknown tier: ' + tierName });
    }

    const uid = req.uid; // verified by requireAuth — never trust req.body.uid
    const { userEmail, userName, userPhone } = req.body;
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail is required.' });
    }

    const amountINR = await priceForTier(tierName);
    const orderId = `WEB_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    const cfPayload = {
      order_id: orderId,
      order_amount: amountINR,
      order_currency: 'INR',
      customer_details: {
        customer_id: uid,
        customer_email: userEmail,
        customer_name: userName || 'Customer',
        customer_phone: userPhone || '9999999999',
      },
      order_note: `Website Studio - ${tierName} pack — ${CF_ENV}`,
    };

    const cfRes = await axios.post(`${CF_BASE_URL}/orders`, cfPayload, { headers: cfHeaders() });
    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    // Record what this order is FOR, so verify can credit the right
    // amount without trusting anything the client sends back at verify
    // time (the client only ever sends orderId to /verify).
    await db.collection('websiteCreditOrders').doc(orderId).set({
      orderId, uid, tier: tierName, tokenBudget: tier.tokenBudget, amountINR,
      status: 'pending', environment: CF_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ orderId, paymentSessionId, amountINR, environment: CF_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-website-credit-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-website-credit-order
// Same uid-ownership + idempotent-transaction pattern as
// /fulfill-token-order and /verify-plan-order.
// ─────────────────────────────────────────────────────────────────────────
router.post('/verify-website-credit-order', requireAuth, async (req, res) => {
  try {
    const orderId = req.body && req.body.orderId;
    const uid = req.uid;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const orderRef = db.collection('websiteCreditOrders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Unknown order' });
    }
    const orderData = orderSnap.data();

    if (orderData.uid !== uid) {
      console.warn(`verify-website-credit-order: uid mismatch. order.uid=${orderData.uid} req.uid=${uid} orderId=${orderId}`);
      return res.status(403).json({ error: 'This order does not belong to the requesting user.' });
    }

    // Idempotency guard — never credit the same order twice.
    if (orderData.status === 'paid') {
      return res.status(200).json({ status: 'PAID' });
    }

    const cfRes = await axios.get(`${CF_BASE_URL}/orders/${orderId}`, { headers: cfHeaders() });
    const orderStatus = cfRes.data?.order_status;
    if (orderStatus !== 'PAID') {
      return res.status(400).json({ status: orderStatus, error: `Payment not complete. Cashfree status: ${orderStatus}` });
    }

    const creditsRef = db.collection('users').doc(orderData.uid).collection('websiteStudio').doc('credits');

    await db.runTransaction(async (tx) => {
      const freshOrder = await tx.get(orderRef);
      if (freshOrder.data().status === 'paid') return; // race guard

      const creditsSnap = await tx.get(creditsRef);
      const current = (creditsSnap.exists && creditsSnap.data().tokensRemaining) || 0;
      tx.set(creditsRef, { tokensRemaining: current + orderData.tokenBudget }, { merge: true });
      tx.update(orderRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), cfOrderData: cfRes.data });
    });

    console.log(`Website Studio credits fulfilled: uid=${orderData.uid} tier=${orderData.tier} tokens=${orderData.tokenBudget} orderId=${orderId}`);
    return res.status(200).json({ status: 'PAID' });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Verification failed.';
    console.error('verify-website-credit-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
