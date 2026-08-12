'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { PP_ENV, PP_CLIENT_ID, PP_BASE_URL, getPayPalAccessToken, ppHeaders } = require('../services/paypal');
const { getCanonicalPrice, inrToUsd, getTokenPackPrice } = require('../services/pricing');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { SERVER_BASE_URL } = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────
// POST /paypal/create-order   (PayPal plan purchase) — requireAuth
// ─────────────────────────────────────────────────────────────────────────
router.post('/paypal/create-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `pp-create-order:${r.uid}` }), async (req, res) => {
  try {
    const { planType, cycle, userEmail } = req.body;
    const uid = req.uid;

    if (!['standard', 'premium'].includes(planType)) return res.status(400).json({ error: `Invalid planType: ${planType}` });
    if (!['monthly', 'annual'].includes(cycle)) return res.status(400).json({ error: `Invalid cycle: ${cycle}` });
    if (!userEmail) return res.status(400).json({ error: 'userEmail is required.' });

    const amountINR = await getCanonicalPrice(planType, cycle);
    if (!amountINR || amountINR <= 0) return res.status(500).json({ error: 'Could not determine plan price.' });

    const amountUSD = await inrToUsd(amountINR);
    const token = await getPayPalAccessToken();
    const orderId = `PP_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    const ppPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: orderId,
        description: `${planType} plan (${cycle})`,
        amount: { currency_code: 'USD', value: amountUSD.toFixed(2) },
        // custom_id is echoed back UNMODIFIED by PayPal on capture — this is
        // what the capture route trusts, NOT the return-URL query string
        // (which the client's browser/webview can edit).
        custom_id: JSON.stringify({ uid, planType, cycle, internalOrderId: orderId }),
      }],
      application_context: {
        brand_name: 'Astric', locale: 'en-US', landing_page: 'NO_PREFERENCE', user_action: 'PAY_NOW',
        return_url: `${SERVER_BASE_URL}/paypal/capture-order?internalOrderId=${orderId}`,
        cancel_url: `${SERVER_BASE_URL}/paypal/cancel?orderId=${orderId}`,
      },
    };

    const ppRes = await axios.post(`${PP_BASE_URL}/v2/checkout/orders`, ppPayload, { headers: ppHeaders(token) });
    const ppOrderId = ppRes.data.id;
    const approveUrl = ppRes.data.links?.find(l => l.rel === 'approve')?.href;
    if (!approveUrl) return res.status(500).json({ error: 'PayPal did not return an approve URL.' });

    await db.collection('orders').doc(orderId).set({
      orderId, uid, userEmail, planType, cycle, amountINR, amountUSD,
      gateway: 'paypal', ppOrderId, status: 'pending', environment: PP_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ paypalOrderId: ppOrderId, internalOrderId: orderId, approveUrl, amountUSD, amountINR, environment: PP_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'PayPal order creation failed.';
    console.error('paypal/create-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /paypal/capture-order
// PayPal redirects here — a browser navigation, so it CANNOT carry an
// Authorization header. Secured instead by validating ppOrderId against
// what we stored at creation time, and trusting plan/cycle/uid only from
// PayPal's own custom_id (set server-side, echoed back unmodified) — never
// from the query string.
// ─────────────────────────────────────────────────────────────────────────
router.get('/paypal/capture-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId } = req.query;
  if (!ppOrderId || !internalOrderId) return res.status(400).json({ error: 'Missing required query params.' });

  try {
    const orderSnap = await db.collection('orders').doc(internalOrderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const orderData = orderSnap.data();

    if (orderData.status === 'paid') {
      return res.status(200).json({ success: true, alreadyActivated: true, plan: orderData.planType, cycle: orderData.cycle });
    }
    if (orderData.ppOrderId !== ppOrderId) {
      console.warn(`paypal/capture-order: ppOrderId mismatch for internalOrderId=${internalOrderId}`);
      return res.status(400).json({ error: 'Order/token mismatch.' });
    }

    const accessToken = await getPayPalAccessToken();
    const captureRes = await axios.post(`${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`, {}, { headers: ppHeaders(accessToken) });
    const captureStatus = captureRes.data.status;
    const captureId = captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    if (captureStatus !== 'COMPLETED') {
      await db.collection('orders').doc(internalOrderId).update({
        status: 'capture_failed', ppCaptureStatus: captureStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(400).json({ error: `PayPal capture status: ${captureStatus}` });
    }

    let custom = {};
    try {
      custom = JSON.parse(captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
        || captureRes.data.purchase_units?.[0]?.custom_id || '{}');
    } catch (_) { /* fall through to orderData */ }

    const uid = orderData.uid;
    const planType = custom.planType || orderData.planType;
    const cycle = custom.cycle || orderData.cycle;

    if (custom.internalOrderId && custom.internalOrderId !== internalOrderId) {
      console.warn(`paypal/capture-order: custom_id internalOrderId mismatch for ${internalOrderId}`);
      return res.status(400).json({ error: 'Order data mismatch.' });
    }

    const now = new Date();
    const expiry = cycle === 'monthly'
      ? new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
      : new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    const subscriptionData = {
      plan: planType, cycle, active: true,
      purchasedAt: admin.firestore.Timestamp.fromDate(now),
      expiresAt: admin.firestore.Timestamp.fromDate(expiry),
      paypalOrderId: internalOrderId,
      paypalPaymentId: captureId || ppOrderId,
      gateway: 'paypal',
    };

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(db.collection('orders').doc(internalOrderId));
      if (fresh.exists && fresh.data().status === 'paid') return;
      tx.update(db.collection('users').doc(uid), { subscription: subscriptionData });
      tx.update(db.collection('orders').doc(internalOrderId), {
        status: 'paid', ppCaptureId: captureId, ppCaptureStatus: captureStatus,
        activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log(`PayPal plan activated: uid=${uid} plan=${planType}/${cycle} captureId=${captureId}`);
    return res.status(200).json({ success: true, plan: planType, cycle, activatedUntil: expiry.toISOString(), captureId });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Capture failed.';
    console.error('paypal/capture-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /paypal/cancel
// ─────────────────────────────────────────────────────────────────────────
router.get('/paypal/cancel', (req, res) => {
  const { orderId } = req.query;
  if (orderId) {
    db.collection('orders').doc(orderId).update({
      status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  return res.status(200).json({ cancelled: true, orderId });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /paypal/create-token-order — requireAuth
// ─────────────────────────────────────────────────────────────────────────
router.post('/paypal/create-token-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `pp-create-token-order:${r.uid}` }), async (req, res) => {
  try {
    const { tokenPacks, userEmail } = req.body;
    const uid = req.uid;
    const packs = parseInt(tokenPacks, 10);

    if (!packs || packs < 1 || packs > 100) return res.status(400).json({ error: 'tokenPacks must be 1–100.' });
    if (!userEmail) return res.status(400).json({ error: 'userEmail is required.' });

    const tokenPackPrice = await getTokenPackPrice();
    const amountINR = tokenPackPrice * packs;
    const amountUSD = await inrToUsd(amountINR);

    const token = await getPayPalAccessToken();
    const orderId = `PPTOK_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 8)}`.toUpperCase();

    const ppPayload = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: orderId,
        description: `${packs * 10000} AI tokens (${packs} pack${packs > 1 ? 's' : ''})`,
        amount: { currency_code: 'USD', value: amountUSD.toFixed(2) },
        custom_id: JSON.stringify({ uid, tokenPacks: packs, internalOrderId: orderId }),
      }],
      application_context: {
        brand_name: 'Astric', user_action: 'PAY_NOW',
        return_url: `${SERVER_BASE_URL}/paypal/capture-token-order?internalOrderId=${orderId}`,
        cancel_url: `${SERVER_BASE_URL}/paypal/cancel?orderId=${orderId}`,
      },
    };

    const ppRes = await axios.post(`${PP_BASE_URL}/v2/checkout/orders`, ppPayload, { headers: ppHeaders(token) });
    const ppOrderId = ppRes.data.id;
    const approveUrl = ppRes.data.links?.find(l => l.rel === 'approve')?.href;
    if (!approveUrl) return res.status(500).json({ error: 'PayPal did not return an approve URL.' });

    await db.collection('orders').doc(orderId).set({
      orderId, uid, userEmail, orderType: 'tokens', tokenPacks: packs, amountINR, amountUSD,
      gateway: 'paypal', ppOrderId, status: 'pending', environment: PP_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ paypalOrderId: ppOrderId, internalOrderId: orderId, approveUrl, amountUSD, amountINR, environment: PP_ENV });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'PayPal token order failed.';
    console.error('paypal/create-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /paypal/capture-token-order — same custom_id-trust fix as capture-order
// ─────────────────────────────────────────────────────────────────────────
router.get('/paypal/capture-token-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId } = req.query;
  if (!ppOrderId || !internalOrderId) return res.status(400).json({ error: 'Missing required query params.' });

  try {
    const orderSnap = await db.collection('orders').doc(internalOrderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const orderData = orderSnap.data();

    if (orderData.status === 'paid') {
      return res.status(200).json({ success: true, alreadyCredited: true, tokensAdded: orderData.tokenPacks * 10000 });
    }
    if (orderData.ppOrderId !== ppOrderId) {
      console.warn(`paypal/capture-token-order: ppOrderId mismatch for internalOrderId=${internalOrderId}`);
      return res.status(400).json({ error: 'Order/token mismatch.' });
    }

    const accessToken = await getPayPalAccessToken();
    const captureRes = await axios.post(`${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`, {}, { headers: ppHeaders(accessToken) });
    const captureStatus = captureRes.data.status;
    const captureId = captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    if (captureStatus !== 'COMPLETED') {
      await db.collection('orders').doc(internalOrderId).update({ status: 'capture_failed', ppCaptureStatus: captureStatus });
      return res.status(400).json({ error: `Capture status: ${captureStatus}` });
    }

    // Pack count from OUR stored order, never from the query string.
    const uid = orderData.uid;
    const tokensAdded = orderData.tokenPacks * 10000;

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(db.collection('orders').doc(internalOrderId));
      if (fresh.exists && fresh.data().status === 'paid') return;
      tx.update(db.collection('orders').doc(internalOrderId), {
        status: 'paid', ppCaptureId: captureId, ppCaptureStatus: captureStatus,
        activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(db.collection('users').doc(uid), { addonTokens: admin.firestore.FieldValue.increment(tokensAdded) });
    });

    console.log(`PayPal tokens added: uid=${uid} tokens=${tokensAdded} captureId=${captureId}`);
    return res.status(200).json({ success: true, tokensAdded, captureId });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Token capture failed.';
    console.error('paypal/capture-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /paypal/config — non-secret (clientId is meant to be public)
// ─────────────────────────────────────────────────────────────────────────
router.get('/paypal/config', (_, res) => {
  res.status(200).json({ environment: PP_ENV, clientId: PP_CLIENT_ID });
});

module.exports = router;
