// routes/whatsapp-subscription.js
//
// Two endpoints for the WhatsApp Automation subscription:
//   POST /create-whatsapp-order  -> { orderId, paymentSessionId }
//   POST /verify-whatsapp-order  -> { status: 'PAID' | ... }
//
// Copied 1:1 from the structure of routes/website-credits.js — same
// CF_BASE_URL + cfHeaders() from services/cashfree.js, same order-id
// scheme, same uid-ownership + idempotency-via-transaction guards, same
// requireAuth + rateLimit. The only real difference is WHAT gets written
// on verify: instead of crediting websiteStudio/credits.tokensRemaining,
// this writes a subscription doc with a plan + expiry date that the
// deployed PHP WhatsApp backend reads (classes/Subscription.php) before
// allowing sends/campaigns, and that the Flutter app watches live via
// waSubscriptionProvider.
//
// Only the ADMIN ever calls this (the Flutter subscription screen hides
// the buy button from employees), so req.uid here is already the
// orgOwnerId the PHP backend and Flutter app scope everything else by —
// no employee/admin resolution needed server-side.
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { CF_ENV, CF_BASE_URL, cfHeaders } = require('../services/cashfree');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const PLANS = {
  monthly: { priceField: 'whatsapp_monthly_price', fallbackPriceINR: 499, months: 1 },
  annual:  { priceField: 'whatsapp_annual_price',  fallbackPriceINR: 4999, months: 12 },
};

// Reads the admin-configurable price for a plan from pricing_config/plans
// (same doc + pattern as priceForTier() in website-credits.js), falling
// back to the built-in default if that field isn't set yet.
async function priceForPlan(planName) {
  const plan = PLANS[planName];
  const snap = await db.collection('pricing_config').doc('plans').get();
  const data = snap.exists ? snap.data() : {};
  const price = data[plan.priceField];
  return (price === undefined || price === null) ? plan.fallbackPriceINR : Number(price);
}

// ─────────────────────────────────────────────────────────────────────────
// POST /create-whatsapp-order
// ─────────────────────────────────────────────────────────────────────────
router.post('/create-whatsapp-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `create-whatsapp-order:${r.uid}` }), async (req, res) => {
  try {
    const planName = req.body && req.body.plan;
    const plan = PLANS[planName];
    if (!plan) {
      return res.status(400).json({ error: 'Unknown plan: ' + planName + ' (expected "monthly" or "annual")' });
    }

    const uid = req.uid; // verified by requireAuth — never trust req.body.uid
    const { userEmail, userName, userPhone } = req.body;
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail is required.' });
    }

    const amountINR = await priceForPlan(planName);
    const orderId = `WA_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

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
      order_note: `WhatsApp Automation - ${planName} plan — ${CF_ENV}`,
    };

    const cfRes = await axios.post(`${CF_BASE_URL}/orders`, cfPayload, { headers: cfHeaders() });
    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    // Record what this order is FOR, so verify can activate the right
    // plan without trusting anything the client sends back at verify time
    // (the client only ever sends orderId to /verify).
    await db.collection('whatsappSubscriptionOrders').doc(orderId).set({
      orderId, uid, plan: planName, months: plan.months, amountINR,
      status: 'pending', environment: CF_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ orderId, paymentSessionId, amountINR, environment: CF_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-whatsapp-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-whatsapp-order
// Same uid-ownership + idempotent-transaction pattern as
// /verify-website-credit-order.
// ─────────────────────────────────────────────────────────────────────────
router.post('/verify-whatsapp-order', requireAuth, async (req, res) => {
  try {
    const orderId = req.body && req.body.orderId;
    const uid = req.uid;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const orderRef = db.collection('whatsappSubscriptionOrders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Unknown order' });
    }
    const orderData = orderSnap.data();

    if (orderData.uid !== uid) {
      console.warn(`verify-whatsapp-order: uid mismatch. order.uid=${orderData.uid} req.uid=${uid} orderId=${orderId}`);
      return res.status(403).json({ error: 'This order does not belong to the requesting user.' });
    }

    // Idempotency guard — never re-activate/extend the same order twice.
    if (orderData.status === 'paid') {
      return res.status(200).json({ status: 'PAID' });
    }

    const cfRes = await axios.get(`${CF_BASE_URL}/orders/${orderId}`, { headers: cfHeaders() });
    const orderStatus = cfRes.data?.order_status;
    if (orderStatus !== 'PAID') {
      return res.status(400).json({ status: orderStatus, error: `Payment not complete. Cashfree status: ${orderStatus}` });
    }

    // The deployed PHP WhatsApp backend reads exactly this doc
    // (classes/Subscription.php) before allowing sends/campaigns, and the
    // Flutter app watches it live (waSubscriptionProvider).
    const subscriptionRef = db.collection('users').doc(orderData.uid).collection('whatsapp').doc('subscription');

    await db.runTransaction(async (tx) => {
      const freshOrder = await tx.get(orderRef);
      if (freshOrder.data().status === 'paid') return; // race guard

      const now = new Date();
      // Extend from the current expiry if it's still in the future
      // (renewing before expiry), otherwise start fresh from now.
      const subSnap = await tx.get(subscriptionRef);
      const currentExpiresAt = subSnap.exists && subSnap.data().expiresAt ? new Date(subSnap.data().expiresAt) : null;
      const base = (currentExpiresAt && currentExpiresAt > now) ? currentExpiresAt : now;
      const expiresAt = new Date(base);
      expiresAt.setMonth(expiresAt.getMonth() + orderData.months);

      tx.set(subscriptionRef, {
        plan: orderData.plan,
        status: 'active',
        startedAt: subSnap.exists && subSnap.data().startedAt ? subSnap.data().startedAt : now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        orderId,
      }, { merge: true });

      tx.update(orderRef, { status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), cfOrderData: cfRes.data });
    });

    console.log(`WhatsApp Automation subscription activated: uid=${orderData.uid} plan=${orderData.plan} orderId=${orderId}`);
    return res.status(200).json({ status: 'PAID' });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Verification failed.';
    console.error('verify-whatsapp-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
