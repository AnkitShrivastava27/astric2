// routes/app-credits.js
//
// App Studio credit packs — same flow as routes/website-credits.js, crediting
// users/{uid}/appStudio/credits.tokensRemaining. Prices: pricing_config/plans
// app_trial_price / app_standard_price / app_pro_price (admin panel).
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { CF_ENV, CF_BASE_URL, cfHeaders } = require('../services/cashfree');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// Tier table lives in services/appTiers.js (single source of truth).
const { TIERS } = require('../services/appTiers');

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
// POST /create-app-credit-order
// ─────────────────────────────────────────────────────────────────────────
router.post('/create-app-credit-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `create-app-credit-order:${r.uid}` }), async (req, res) => {
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
    const orderId = `APP_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

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
      order_note: `App Studio - ${tierName} pack — ${CF_ENV}`,
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
    await db.collection('appCreditOrders').doc(orderId).set({
      orderId, uid, tier: tierName, tokenBudget: tier.tokenBudget, amountINR,
      status: 'pending', environment: CF_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ orderId, paymentSessionId, amountINR, environment: CF_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-app-credit-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-app-credit-order
// Same uid-ownership + idempotent-transaction pattern as
// /fulfill-token-order and /verify-plan-order.
// ─────────────────────────────────────────────────────────────────────────
router.post('/verify-app-credit-order', requireAuth, async (req, res) => {
  try {
    const orderId = req.body && req.body.orderId;
    const uid = req.uid;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const orderRef = db.collection('appCreditOrders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Unknown order' });
    }
    const orderData = orderSnap.data();

    if (orderData.uid !== uid) {
      console.warn(`verify-app-credit-order: uid mismatch. order.uid=${orderData.uid} req.uid=${uid} orderId=${orderId}`);
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

    const creditsRef = db.collection('users').doc(orderData.uid).collection('appStudio').doc('credits');

    await db.runTransaction(async (tx) => {
      const freshOrder = await tx.get(orderRef);
      if (freshOrder.data().status === 'paid') return; // race guard

      const creditsSnap = await tx.get(creditsRef);
      const current = (creditsSnap.exists && creditsSnap.data().tokensRemaining) || 0;
      tx.set(creditsRef, { tokensRemaining: current + orderData.tokenBudget, purchased: true, lastPurchaseAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.update(orderRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), cfOrderData: cfRes.data });
    });

    console.log(`App Studio credits fulfilled: uid=${orderData.uid} tier=${orderData.tier} tokens=${orderData.tokenBudget} orderId=${orderId}`);
    return res.status(200).json({ status: 'PAID' });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Verification failed.';
    console.error('verify-app-credit-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// Shared with routes/payments.paypal.products.js so a PayPal payment credits
// the SAME balance, through the SAME idempotent transaction, as Cashfree.
async function fulfilAppOrder(orderRef, extraOrderFields = {}) {
  return db.runTransaction(async (tx) => {
    const freshOrder = await tx.get(orderRef);
    if (!freshOrder.exists || freshOrder.data().status === 'paid') return false; // race guard
    const orderData = freshOrder.data();
    const creditsRef = db.collection('users').doc(orderData.uid).collection('appStudio').doc('credits');
    const creditsSnap = await tx.get(creditsRef);
    const current = (creditsSnap.exists && creditsSnap.data().tokensRemaining) || 0;
    tx.set(creditsRef, { tokensRemaining: current + orderData.tokenBudget, purchased: true, lastPurchaseAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.update(orderRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), ...extraOrderFields });
    return true;
  });
}

router.TIERS = TIERS;
router.priceForTier = priceForTier;
router.fulfilAppOrder = fulfilAppOrder;
module.exports = router;
