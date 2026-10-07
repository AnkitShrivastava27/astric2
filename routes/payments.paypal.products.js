'use strict';
// PayPal for Website Studio credit packs and the WhatsApp Automation
// subscription (previously Cashfree-only). Same flow as the existing
// plan / token PayPal purchases in payments.paypal.js:
//   1. POST  create-order   (requireAuth)  -> approveUrl
//   2. user approves in PayPal; PayPal redirects the browser to
//   3. GET   capture-*      (no auth header possible on a redirect) which
//      trusts ONLY our stored order record + PayPal's own response
//   4. GET   /paypal/order-status (requireAuth) lets the client confirm
//      (the web build opens PayPal in a new tab and polls this).
// Fulfilment reuses the exact idempotent transactions the Cashfree routes
// use, so a pack/subscription can never be credited twice.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { PP_ENV, PP_BASE_URL, getPayPalAccessToken, ppHeaders } = require('../services/paypal');
const { getPaypalUsd } = require('../services/pricing');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { SERVER_BASE_URL } = require('../config/env');
const websiteRoute = require('./website-credits');
const whatsappRoute = require('./whatsapp-subscription');
const appRoute = require('./app-credits');

const MIN_PAYPAL_USD = 1.00;

const PRODUCTS = {
  website: {
    collection: 'websiteCreditOrders',
    prefix: 'PPWEB',
    fulfil: (ref, extra) => websiteRoute.fulfilWebsiteOrder(ref, extra),
  },
  app: {
    collection: 'appCreditOrders',
    prefix: 'PPAPP',
    fulfil: (ref, extra) => appRoute.fulfilAppOrder(ref, extra),
  },
  whatsapp: {
    collection: 'whatsappSubscriptionOrders',
    prefix: 'PPWA',
    fulfil: (ref, extra) => whatsappRoute.fulfilWhatsappOrder(ref, extra),
  },
};

function extractPaypalError(err) {
  const data = err?.response?.data;
  if (!data) return err.message || 'PayPal request failed.';
  const details = Array.isArray(data.details)
    ? data.details.map(d => d.description || d.issue).filter(Boolean).join('; ') : '';
  if (Array.isArray(data.details) && data.details.some(d => d.issue === 'PAYEE_ACCOUNT_RESTRICTED')) {
    return 'PayPal payments are temporarily unavailable. Please use Cashfree, or try again later.';
  }
  return details ? `${data.message || data.name || 'PayPal error'}: ${details}` : (data.message || err.message);
}

async function createPayPalOrder({ kind, uid, userEmail, amountINR, usdField, description, orderFields }) {
  const product = PRODUCTS[kind];
  // Own USD price (admin panel) if set, else INR converted.
  const { usd: amountUSD } = await getPaypalUsd(usdField, amountINR);
  if (amountUSD < MIN_PAYPAL_USD) {
    const e = new Error(`Amount too small for PayPal ($${amountUSD.toFixed(2)}). Minimum is $${MIN_PAYPAL_USD.toFixed(2)}. Set a PayPal price of at least $${MIN_PAYPAL_USD.toFixed(2)} in the admin panel, or use Cashfree.`);
    e.status = 400;
    throw e;
  }
  const token = await getPayPalAccessToken();
  const orderId = `${product.prefix}_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

  const ppRes = await axios.post(`${PP_BASE_URL}/v2/checkout/orders`, {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: orderId, description,
      amount: { currency_code: 'USD', value: amountUSD.toFixed(2) },
      custom_id: JSON.stringify({ uid, kind, internalOrderId: orderId }),
    }],
    application_context: {
      brand_name: 'Astric', user_action: 'PAY_NOW',
      return_url: `${SERVER_BASE_URL}/paypal/capture-product-order?kind=${kind}&internalOrderId=${orderId}`,
      cancel_url: `${SERVER_BASE_URL}/paypal/cancel?orderId=${orderId}`,
    },
  }, { headers: ppHeaders(token) });

  const approveUrl = ppRes.data.links?.find(l => l.rel === 'approve')?.href;
  if (!approveUrl) { const e = new Error('PayPal did not return an approve URL.'); e.status = 500; throw e; }

  await db.collection(product.collection).doc(orderId).set({
    orderId, uid, userEmail, ...orderFields,
    amountINR, amountUSD, gateway: 'paypal', ppOrderId: ppRes.data.id,
    status: 'pending', environment: PP_ENV,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { paypalOrderId: ppRes.data.id, internalOrderId: orderId, approveUrl, amountUSD, amountINR, environment: PP_ENV };
}

// ── POST /paypal/create-website-order  { tier, userEmail } ───────────────
router.post('/paypal/create-website-order', requireAuth,
  rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `pp-web:${r.uid}` }), async (req, res) => {
    try {
      const tierName = req.body?.tier;
      const tier = websiteRoute.TIERS[tierName];
      if (!tier) return res.status(400).json({ error: `Unknown tier: ${tierName}` });
      if (!req.body?.userEmail) return res.status(400).json({ error: 'userEmail is required.' });
      const amountINR = await websiteRoute.priceForTier(tierName);   // price from OUR config, never the client
      const out = await createPayPalOrder({
        kind: 'website', uid: req.uid, userEmail: req.body.userEmail, amountINR, usdField: `paypal_website_${tierName}`,
        description: `Website Studio - ${tierName} pack`,
        orderFields: { tier: tierName, tokenBudget: tier.tokenBudget },
      });
      return res.status(200).json(out);
    } catch (err) {
      console.error('paypal/create-website-order error:', err?.response?.data || err.message);
      return res.status(err.status || 500).json({ error: err.status ? err.message : extractPaypalError(err) });
    }
  });

// ── POST /paypal/create-app-order  { tier, userEmail } ───────────────────
router.post('/paypal/create-app-order', requireAuth,
  rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `pp-app:${r.uid}` }), async (req, res) => {
    try {
      const tierName = req.body?.tier;
      const tier = appRoute.TIERS[tierName];
      if (!tier) return res.status(400).json({ error: `Unknown tier: ${tierName}` });
      if (!req.body?.userEmail) return res.status(400).json({ error: 'userEmail is required.' });
      const amountINR = await appRoute.priceForTier(tierName);
      const out = await createPayPalOrder({
        kind: 'app', uid: req.uid, userEmail: req.body.userEmail, amountINR, usdField: `paypal_app_${tierName}`,
        description: `App Studio - ${tierName} pack`,
        orderFields: { tier: tierName, tokenBudget: tier.tokenBudget },
      });
      return res.status(200).json(out);
    } catch (err) {
      console.error('paypal/create-app-order error:', err?.response?.data || err.message);
      return res.status(err.status || 500).json({ error: err.status ? err.message : extractPaypalError(err) });
    }
  });

// ── POST /paypal/create-whatsapp-order  { plan, userEmail } ──────────────
router.post('/paypal/create-whatsapp-order', requireAuth,
  rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `pp-wa:${r.uid}` }), async (req, res) => {
    try {
      const planName = req.body?.plan;
      const plan = whatsappRoute.PLANS[planName];
      if (!plan) return res.status(400).json({ error: `Unknown plan: ${planName} (expected "monthly" or "annual")` });
      if (!req.body?.userEmail) return res.status(400).json({ error: 'userEmail is required.' });
      const amountINR = await whatsappRoute.priceForPlan(planName);
      const out = await createPayPalOrder({
        kind: 'whatsapp', uid: req.uid, userEmail: req.body.userEmail, amountINR, usdField: `paypal_whatsapp_${planName}`,
        description: `WhatsApp Automation - ${planName} plan`,
        orderFields: { plan: planName, months: plan.months },
      });
      return res.status(200).json(out);
    } catch (err) {
      console.error('paypal/create-whatsapp-order error:', err?.response?.data || err.message);
      return res.status(err.status || 500).json({ error: err.status ? err.message : extractPaypalError(err) });
    }
  });

// ── GET /paypal/capture-product-order  (PayPal redirect target) ──────────
router.get('/paypal/capture-product-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId, kind } = req.query;
  const product = PRODUCTS[kind];
  if (!product || !ppOrderId || !internalOrderId) return res.status(400).json({ error: 'Missing required query params.' });

  try {
    const orderRef = db.collection(product.collection).doc(internalOrderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Order not found.' });
    const orderData = orderSnap.data();
    if (orderData.gateway !== 'paypal') return res.status(400).json({ error: 'Not a PayPal order.' });
    if (orderData.status === 'paid') return res.status(200).json({ success: true, alreadyActivated: true });
    if (orderData.ppOrderId !== ppOrderId) return res.status(400).json({ error: 'Order/token mismatch.' });

    const accessToken = await getPayPalAccessToken();
    const cap = await axios.post(`${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`, {}, { headers: ppHeaders(accessToken) });
    const status = cap.data.status;
    const captureId = cap.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (status !== 'COMPLETED') {
      await orderRef.update({ status: 'capture_failed', ppCaptureStatus: status });
      return res.status(400).json({ error: `PayPal capture status: ${status}` });
    }
    await product.fulfil(orderRef, { ppCaptureId: captureId || null, ppCaptureStatus: status });
    console.log(`PayPal ${kind} order fulfilled: uid=${orderData.uid} order=${internalOrderId} capture=${captureId}`);
    return res.status(200).json({ success: true, captureId });
  } catch (err) {
    console.error('paypal/capture-product-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: err?.response?.data?.message || err.message || 'Capture failed.' });
  }
});

// ── GET /paypal/order-status?kind=&orderId=  (requireAuth) ───────────────
// Used by the web build, which can't watch a redirect inside a webview.
router.get('/paypal/order-status', requireAuth, async (req, res) => {
  // Product orders live in their own collections; plan + AI-token orders
  // share the 'orders' collection (kind = 'plan' | 'token').
  const collections = { website: PRODUCTS.website.collection, app: PRODUCTS.app.collection, whatsapp: PRODUCTS.whatsapp.collection, plan: 'orders', token: 'orders' };
  const collection = collections[req.query.kind];
  if (!collection || !req.query.orderId) return res.status(400).json({ error: 'kind and orderId are required.' });
  const snap = await db.collection(collection).doc(String(req.query.orderId)).get();
  if (!snap.exists || snap.data().uid !== req.uid) return res.status(404).json({ error: 'Order not found.' });
  return res.status(200).json({ status: snap.data().status });
});

module.exports = router;
