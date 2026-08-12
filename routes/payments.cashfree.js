'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { CF_ENV, CF_BASE_URL, cfHeaders } = require('../services/cashfree');
const { getCanonicalPrice, getTokenPackPrice } = require('../services/pricing');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

// ─────────────────────────────────────────────────────────────────────────
// POST /create-order   (Cashfree plan)
// requireAuth: req.uid is the verified caller — used instead of any uid the
// client might also send in the body.
// ─────────────────────────────────────────────────────────────────────────
router.post('/create-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `create-order:${r.uid}` }), async (req, res) => {
  try {
    const { planType, cycle, userEmail, userName, userPhone } = req.body;
    const uid = req.uid;

    if (!['standard', 'premium'].includes(planType)) {
      return res.status(400).json({ error: `Invalid planType: ${planType}` });
    }
    if (!['monthly', 'annual'].includes(cycle)) {
      return res.status(400).json({ error: `Invalid cycle: ${cycle}` });
    }
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail is required.' });
    }

    const amountINR = await getCanonicalPrice(planType, cycle);
    if (!amountINR || amountINR <= 0) {
      return res.status(500).json({ error: 'Could not determine plan price. Contact support.' });
    }

    const orderId = `CF_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

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
      order_meta: { notify_url: '' },
      order_note: `${planType} plan (${cycle}) — ${CF_ENV}`,
    };

    const cfRes = await axios.post(`${CF_BASE_URL}/orders`, cfPayload, { headers: cfHeaders() });
    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    await db.collection('orders').doc(orderId).set({
      orderId, uid, userEmail, planType, cycle, amountINR,
      status: 'pending', environment: CF_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ orderId, paymentSessionId, amountINR, environment: CF_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /create-token-order   (Cashfree token pack — creates order only)
// ─────────────────────────────────────────────────────────────────────────
router.post('/create-token-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `create-token-order:${r.uid}` }), async (req, res) => {
  try {
    const { tokenPacks, userEmail, userName, userPhone } = req.body;
    const uid = req.uid;
    const packs = parseInt(tokenPacks, 10);

    if (!packs || packs < 1 || packs > 100) {
      return res.status(400).json({ error: 'tokenPacks must be between 1 and 100.' });
    }
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail is required.' });
    }

    const tokenPackPrice = await getTokenPackPrice();
    const amountINR = tokenPackPrice * packs;
    if (amountINR <= 0) {
      return res.status(500).json({ error: 'Token pack price not configured.' });
    }

    const orderId = `TOK_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

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
      order_note: `${packs * 10000} AI tokens (${packs} pack${packs > 1 ? 's' : ''}) — ${CF_ENV}`,
    };

    const cfRes = await axios.post(`${CF_BASE_URL}/orders`, cfPayload, { headers: cfHeaders() });
    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    // Order stored 'pending' — /fulfill-token-order does the actual credit.
    await db.collection('orders').doc(orderId).set({
      orderId, uid, userEmail, orderType: 'tokens', tokenPacks: packs, amountINR,
      status: 'pending', environment: CF_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ orderId, paymentSessionId, amountINR, environment: CF_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Token order creation failed.';
    console.error('create-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /fulfill-token-order
// SECURITY FIX vs the live server: rejects if the order doesn't belong to
// req.uid (previously trusted body.uid outright — could redirect another
// user's token credit to the caller). Credit write is now transactional.
// ─────────────────────────────────────────────────────────────────────────
router.post('/fulfill-token-order', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.body;
    const uid = req.uid;
    if (!orderId) return res.status(400).json({ error: 'orderId is required.' });

    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const orderData = orderSnap.data();

    if (orderData.orderType !== 'tokens') {
      return res.status(400).json({ error: 'Not a token order.' });
    }
    if (orderData.uid !== uid) {
      console.warn(`fulfill-token-order: uid mismatch. order.uid=${orderData.uid} req.uid=${uid} orderId=${orderId}`);
      return res.status(403).json({ error: 'This order does not belong to the requesting user.' });
    }
    if (orderData.status === 'paid') {
      return res.status(200).json({ success: true, alreadyCredited: true, tokensAdded: orderData.tokenPacks * 10000 });
    }

    const cfRes = await axios.get(`${CF_BASE_URL}/orders/${orderId}`, { headers: cfHeaders() });
    const orderStatus = cfRes.data?.order_status;
    if (orderStatus !== 'PAID') {
      return res.status(400).json({ error: `Payment not complete. Cashfree status: ${orderStatus}` });
    }

    const tokensAdded = orderData.tokenPacks * 10000;

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(db.collection('orders').doc(orderId));
      if (fresh.exists && fresh.data().status === 'paid') return;
      tx.update(db.collection('orders').doc(orderId), {
        status: 'paid', activatedAt: admin.firestore.FieldValue.serverTimestamp(), cfOrderData: cfRes.data,
      });
      tx.update(db.collection('users').doc(uid), {
        addonTokens: admin.firestore.FieldValue.increment(tokensAdded),
      });
    });

    console.log(`Cashfree tokens fulfilled: uid=${uid} tokens=${tokensAdded} orderId=${orderId}`);
    return res.status(200).json({ success: true, tokensAdded });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Token fulfillment failed.';
    console.error('fulfill-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-plan-order   (Cashfree plan — verify + activate)
// Same uid-ownership + transaction fixes as /fulfill-token-order.
// ─────────────────────────────────────────────────────────────────────────
router.post('/verify-plan-order', requireAuth, async (req, res) => {
  try {
    const { orderId } = req.body;
    const uid = req.uid;
    if (!orderId) return res.status(400).json({ error: 'orderId is required.' });

    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const orderData = orderSnap.data();

    if (orderData.uid !== uid) {
      console.warn(`verify-plan-order: uid mismatch. order.uid=${orderData.uid} req.uid=${uid} orderId=${orderId}`);
      return res.status(403).json({ error: 'This order does not belong to the requesting user.' });
    }

    if (orderData.status === 'paid') {
      return res.status(200).json({
        success: true, alreadyActived: true, status: 'PAID',
        planType: orderData.planType, cycle: orderData.cycle,
      });
    }

    const cfRes = await axios.get(`${CF_BASE_URL}/orders/${orderId}`, { headers: cfHeaders() });
    const orderStatus = cfRes.data?.order_status;
    if (orderStatus !== 'PAID') {
      return res.status(400).json({ error: `Payment not complete. Cashfree status: ${orderStatus}`, status: orderStatus });
    }

    const { planType, cycle } = orderData;
    const now = new Date();
    const expiry = cycle === 'monthly'
      ? new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
      : new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    const subscriptionData = {
      plan: planType, cycle, active: true,
      purchasedAt: admin.firestore.Timestamp.fromDate(now),
      expiresAt: admin.firestore.Timestamp.fromDate(expiry),
      cashfreeOrderId: orderId,
      cashfreePaymentId: cfRes.data?.cf_payment_id || orderId,
      gateway: 'cashfree',
    };

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(db.collection('orders').doc(orderId));
      if (fresh.exists && fresh.data().status === 'paid') return;
      tx.update(db.collection('orders').doc(orderId), {
        status: 'paid', activatedAt: admin.firestore.FieldValue.serverTimestamp(), cfOrderData: cfRes.data,
      });
      tx.update(db.collection('users').doc(uid), { subscription: subscriptionData });
    });

    console.log(`Cashfree plan activated: uid=${uid} plan=${planType}/${cycle} orderId=${orderId}`);
    return res.status(200).json({ success: true, status: 'PAID', planType, cycle, activatedUntil: expiry.toISOString() });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Plan verification failed.';
    console.error('verify-plan-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-payment   (Cashfree webhook / manual status check)
// No identity data returned beyond order status — left unauthenticated
// like the live server, but rate-limited.
// ─────────────────────────────────────────────────────────────────────────
router.post('/verify-payment', rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `verify-payment:${r.ip}` }), async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });

    const cfRes = await axios.get(`${CF_BASE_URL}/orders/${orderId}`, { headers: cfHeaders() });
    const orderStatus = cfRes.data?.order_status;

    if (orderStatus === 'PAID') {
      await db.collection('orders').doc(orderId).update({
        status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), cfOrderData: cfRes.data,
      });
    }
    return res.status(200).json({ status: orderStatus });
  } catch (err) {
    console.error('verify-payment error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

module.exports = router;
