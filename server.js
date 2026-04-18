/**
 * Cashfree + PayPal Payment Server
 * Deploy on Render (or any Node host).
 *
 * ENVIRONMENT VARIABLES — set in Render Dashboard → Environment:
 * ──────────────────────────────────────────────────────────────
 *  CASHFREE_APP_ID        Your Cashfree App ID
 *  CASHFREE_SECRET_KEY    Your Cashfree Secret Key
 *  CASHFREE_ENV           "TEST"  or  "PROD"
 *  FIREBASE_PROJECT_ID    Your Firebase project ID
 *  FIREBASE_CLIENT_EMAIL  From Firebase service account JSON
 *  FIREBASE_PRIVATE_KEY   From Firebase service account JSON (keep the \n characters)
 *  ADMIN_API_KEY          A secret string you choose — required for /update-pricing
 *  PAYPAL_CLIENT_ID       Your PayPal REST app Client ID
 *  PAYPAL_CLIENT_SECRET   Your PayPal REST app Secret
 *  PAYPAL_ENV             "SANDBOX" or "LIVE"
 *  SERVER_BASE_URL        e.g. https://astricserver.onrender.com  ← NO trailing slash
 *  PORT                   Set automatically by Render — don't set manually
 */

const express = require('express');
const axios   = require('axios');
const admin   = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// Firebase Admin SDK
// ─────────────────────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// Cashfree config
// ─────────────────────────────────────────────────────────────────────────────
const CF_ENV        = (process.env.CASHFREE_ENV || 'TEST').toUpperCase();
const CF_APP_ID     = process.env.CASHFREE_APP_ID     || '';
const CF_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || '';

const CF_BASE_URL = CF_ENV === 'PROD'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

function cfHeaders() {
  return {
    'x-client-id':     CF_APP_ID,
    'x-client-secret': CF_SECRET_KEY,
    'x-api-version':   '2023-08-01',
    'Content-Type':    'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PayPal config
// ─────────────────────────────────────────────────────────────────────────────
const PP_ENV           = (process.env.PAYPAL_ENV || 'SANDBOX').toUpperCase();
const PP_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     || '';
const PP_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

const PP_BASE_URL = PP_ENV === 'LIVE'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Strip any trailing slash from SERVER_BASE_URL so URLs never get //
const SERVER_BASE_URL = (process.env.SERVER_BASE_URL || 'https://astricserver.onrender.com').replace(/\/+$/, '');

const FALLBACK_USD_INR_RATE = 83.5;

// PayPal OAuth token cache (expires after ~9 hours)
let _ppTokenCache = { token: '', expiresAt: 0 };

async function getPayPalAccessToken() {
  const now = Date.now();
  if (_ppTokenCache.token && now < _ppTokenCache.expiresAt - 60_000) {
    return _ppTokenCache.token;
  }
  const creds = Buffer.from(`${PP_CLIENT_ID}:${PP_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `${PP_BASE_URL}/v1/oauth2/token`,
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  _ppTokenCache = {
    token: res.data.access_token,
    expiresAt: now + res.data.expires_in * 1000,
  };
  return _ppTokenCache.token;
}

function ppHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'PayPal-Request-Id': uuidv4(),
  };
}

async function inrToUsd(inrAmount) {
  const snap = await db.collection('pricing_config').doc('plans').get();
  const rate = snap.exists
    ? Number(snap.data().usd_inr_rate ?? FALLBACK_USD_INR_RATE)
    : FALLBACK_USD_INR_RATE;
  return Math.round((inrAmount / rate) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch canonical price from Firestore
// ─────────────────────────────────────────────────────────────────────────────
async function getCanonicalPrice(planType, cycle) {
  const snap = await db.collection('pricing_config').doc('plans').get();
  const defaults = {
    standard_monthly: 830,
    standard_annual:  664,
    premium_monthly:  1660,
    premium_annual:   1245,
    token_pack_price: 10,
  };
  if (!snap.exists) return defaults[`${planType}_${cycle}`] ?? null;
  const data  = snap.data();
  const key   = `${planType}_${cycle}`;
  const price = data[key];
  if (price === undefined || price === null) return defaults[key] ?? null;
  return Number(price);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — Default route
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => {
  res.status(200).json({
    service:     'Astric Payment Server',
    status:      'ok',
    environment: CF_ENV,
    timestamp:   new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.status(200).json({
    status:      'ok',
    environment: CF_ENV,
    timestamp:   new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /create-order   (Cashfree plan)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    const { planType, cycle, userEmail, userName, userPhone, uid } = req.body;

    if (!['standard', 'premium'].includes(planType)) {
      return res.status(400).json({ error: `Invalid planType: ${planType}` });
    }
    if (!['monthly', 'annual'].includes(cycle)) {
      return res.status(400).json({ error: `Invalid cycle: ${cycle}` });
    }
    if (!uid || !userEmail) {
      return res.status(400).json({ error: 'uid and userEmail are required.' });
    }

    const amountINR = await getCanonicalPrice(planType, cycle);
    if (!amountINR || amountINR <= 0) {
      return res.status(500).json({ error: 'Could not determine plan price. Contact support.' });
    }

    const orderId = `CF_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    const cfPayload = {
      order_id:       orderId,
      order_amount:   amountINR,
      order_currency: 'INR',
      customer_details: {
        customer_id:    uid,
        customer_email: userEmail,
        customer_name:  userName  || 'Customer',
        customer_phone: userPhone || '9999999999',
      },
      order_meta: {
        notify_url: '',
      },
      order_note: `${planType} plan (${cycle}) — ${CF_ENV}`,
    };

    const cfRes = await axios.post(
      `${CF_BASE_URL}/orders`,
      cfPayload,
      { headers: cfHeaders() }
    );

    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    await db.collection('orders').doc(orderId).set({
      orderId,
      uid,
      userEmail,
      planType,
      cycle,
      amountINR,
      status:      'pending',
      environment: CF_ENV,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      orderId,
      paymentSessionId,
      amountINR,
      environment: CF_ENV,
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /create-token-order   (Cashfree token pack — creates order only)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/create-token-order', async (req, res) => {
  try {
    const { tokenPacks, userEmail, userName, userPhone, uid } = req.body;

    const packs = parseInt(tokenPacks, 10);
    if (!packs || packs < 1 || packs > 100) {
      return res.status(400).json({ error: 'tokenPacks must be between 1 and 100.' });
    }
    if (!uid || !userEmail) {
      return res.status(400).json({ error: 'uid and userEmail are required.' });
    }

    const snap = await db.collection('pricing_config').doc('plans').get();
    const tokenPackPrice = snap.exists
      ? Number(snap.data().token_pack_price ?? 10)
      : 10;

    const amountINR = tokenPackPrice * packs;
    if (amountINR <= 0) {
      return res.status(500).json({ error: 'Token pack price not configured.' });
    }

    const orderId = `TOK_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    const cfPayload = {
      order_id:       orderId,
      order_amount:   amountINR,
      order_currency: 'INR',
      customer_details: {
        customer_id:    uid,
        customer_email: userEmail,
        customer_name:  userName  || 'Customer',
        customer_phone: userPhone || '9999999999',
      },
      order_note: `${packs * 10000} AI tokens (${packs} pack${packs > 1 ? 's' : ''}) — ${CF_ENV}`,
    };

    const cfRes = await axios.post(
      `${CF_BASE_URL}/orders`,
      cfPayload,
      { headers: cfHeaders() }
    );

    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    // Store order with status 'pending' — tokens are NOT credited here.
    // /fulfill-token-order (called by Flutter after SDK success) does the credit.
    await db.collection('orders').doc(orderId).set({
      orderId,
      uid,
      userEmail,
      orderType:   'tokens',
      tokenPacks:  packs,
      amountINR,
      status:      'pending',
      environment: CF_ENV,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      orderId,
      paymentSessionId,
      amountINR,
      environment: CF_ENV,
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Token order creation failed.';
    console.error('create-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /fulfill-token-order   (Cashfree token fulfillment)
//
// Flutter calls this AFTER the Cashfree SDK fires onSuccess.
// This endpoint:
//   1. Checks our orders doc to prevent double-crediting (idempotency guard)
//   2. Verifies payment status with Cashfree API
//   3. Marks order as paid
//   4. Increments addonTokens on the root user doc (same field _load() reads)
//
// This is the ONLY place addonTokens gets incremented for Cashfree purchases.
// Flutter must NOT call addAddonTokens() — just call reload() after this.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/fulfill-token-order', async (req, res) => {
  try {
    const { orderId, uid } = req.body;
    if (!orderId || !uid) {
      return res.status(400).json({ error: 'orderId and uid are required.' });
    }

    // 1. Load our order record
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    const orderData = orderSnap.data();

    if (orderData.orderType !== 'tokens') {
      return res.status(400).json({ error: 'Not a token order.' });
    }

    // 2. Idempotency guard — already fulfilled, return success so Flutter
    //    reload() picks up the correct value without double-crediting.
    if (orderData.status === 'paid') {
      console.log(`fulfill-token-order: already fulfilled, skipping credit. orderId=${orderId}`);
      return res.status(200).json({
        success:        true,
        alreadyCredited: true,
        tokensAdded:    orderData.tokenPacks * 10000,
      });
    }

    // 3. Verify with Cashfree that payment actually succeeded
    const cfRes = await axios.get(
      `${CF_BASE_URL}/orders/${orderId}`,
      { headers: cfHeaders() }
    );
    const orderStatus = cfRes.data?.order_status;

    if (orderStatus !== 'PAID') {
      console.warn(`fulfill-token-order: Cashfree status not PAID (${orderStatus}) for orderId=${orderId}`);
      return res.status(400).json({ error: `Payment not complete. Cashfree status: ${orderStatus}` });
    }

    const tokensAdded = orderData.tokenPacks * 10000;

    // 4. Mark paid FIRST (prevents a race condition if Flutter taps twice)
    await db.collection('orders').doc(orderId).update({
      status:      'paid',
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      cfOrderData: cfRes.data,
    });

    // 5. Increment addonTokens on root user doc — single source of truth
    await db.collection('users').doc(uid).update({
      addonTokens: admin.firestore.FieldValue.increment(tokensAdded),
    });

    console.log(`Cashfree tokens fulfilled: uid=${uid} tokens=${tokensAdded} orderId=${orderId}`);
    return res.status(200).json({ success: true, tokensAdded });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Token fulfillment failed.';
    console.error('fulfill-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /verify-payment   (Cashfree webhook / manual check)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });

    const cfRes = await axios.get(
      `${CF_BASE_URL}/orders/${orderId}`,
      { headers: cfHeaders() }
    );

    const orderStatus = cfRes.data?.order_status;

    if (orderStatus === 'PAID') {
      await db.collection('orders').doc(orderId).update({
        status:      'paid',
        paidAt:      admin.firestore.FieldValue.serverTimestamp(),
        cfOrderData: cfRes.data,
      });
    }

    return res.status(200).json({ status: orderStatus });
  } catch (err) {
    console.error('verify-payment error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Verification failed.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /update-pricing
// ─────────────────────────────────────────────────────────────────────────────
app.post('/update-pricing', async (req, res) => {
  const token    = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const adminKey = process.env.ADMIN_API_KEY || '';

  if (!adminKey) {
    return res.status(500).json({ error: 'ADMIN_API_KEY not configured on server.' });
  }
  if (token !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const priceFields = [
      'basic_monthly', 'basic_annual',
      'standard_monthly', 'standard_annual',
      'premium_monthly',  'premium_annual',
      'token_pack_price',
    ];

    const update = {};

    for (const key of priceFields) {
      if (req.body[key] !== undefined) {
        const val = Number(req.body[key]);
        if (isNaN(val) || val < 0) {
          return res.status(400).json({ error: `${key} must be a non-negative number.` });
        }
        update[key] = val;
      }
    }

    if (req.body.vercel_api_url !== undefined) {
      update.vercel_api_url = String(req.body.vercel_api_url).trim();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided.' });
    }

    update.updated_at = admin.firestore.FieldValue.serverTimestamp();
    update.updated_by = req.body.updatedBy || 'admin';

    await db.collection('pricing_config').doc('plans').set(update, { merge: true });

    const updatedFields = Object.keys(update).filter(
      k => k !== 'updated_at' && k !== 'updated_by'
    );

    console.log(`Pricing updated by "${update.updated_by}":`, updatedFields);

    return res.status(200).json({
      success: true,
      updated: updatedFields,
      message: 'Done. Flutter app reflects changes within ~1 second.',
    });

  } catch (err) {
    console.error('update-pricing error:', err.message);
    return res.status(500).json({ error: 'Failed to update pricing.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /paypal/create-order   (PayPal plan purchase)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/paypal/create-order', async (req, res) => {
  try {
    const { planType, cycle, userEmail, userName, uid } = req.body;

    if (!['standard', 'premium'].includes(planType)) {
      return res.status(400).json({ error: `Invalid planType: ${planType}` });
    }
    if (!['monthly', 'annual'].includes(cycle)) {
      return res.status(400).json({ error: `Invalid cycle: ${cycle}` });
    }
    if (!uid || !userEmail) {
      return res.status(400).json({ error: 'uid and userEmail are required.' });
    }

    const amountINR = await getCanonicalPrice(planType, cycle);
    if (!amountINR || amountINR <= 0) {
      return res.status(500).json({ error: 'Could not determine plan price.' });
    }

    const amountUSD = await inrToUsd(amountINR);
    const token     = await getPayPalAccessToken();
    const orderId   = `PP_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    const ppPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: orderId,
          description: `${planType} plan (${cycle})`,
          amount: {
            currency_code: 'USD',
            value: amountUSD.toFixed(2),
          },
          custom_id: JSON.stringify({ uid, planType, cycle, internalOrderId: orderId }),
        },
      ],
      application_context: {
        brand_name:   'Astric',
        locale:       'en-US',
        landing_page: 'NO_PREFERENCE',
        user_action:  'PAY_NOW',
        return_url: `${SERVER_BASE_URL}/paypal/capture-order?internalOrderId=${orderId}&uid=${uid}&planType=${planType}&cycle=${cycle}`,
        cancel_url: `${SERVER_BASE_URL}/paypal/cancel?orderId=${orderId}`,
      },
    };

    const ppRes      = await axios.post(`${PP_BASE_URL}/v2/checkout/orders`, ppPayload, { headers: ppHeaders(token) });
    const ppOrderId  = ppRes.data.id;
    const approveUrl = ppRes.data.links?.find(l => l.rel === 'approve')?.href;

    if (!approveUrl) {
      return res.status(500).json({ error: 'PayPal did not return an approve URL.' });
    }

    await db.collection('orders').doc(orderId).set({
      orderId,
      uid,
      userEmail,
      planType,
      cycle,
      amountINR,
      amountUSD,
      gateway:     'paypal',
      ppOrderId,
      status:      'pending',
      environment: PP_ENV,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      paypalOrderId:   ppOrderId,
      internalOrderId: orderId,
      approveUrl,
      amountUSD,
      amountINR,
      environment:     PP_ENV,
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'PayPal order creation failed.';
    console.error('paypal/create-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /paypal/capture-order
// PayPal redirects here after user approves. Server captures payment and
// writes subscription to Firestore. Flutter WebView detects this URL and closes.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/capture-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId, uid, planType, cycle } = req.query;

  if (!ppOrderId || !internalOrderId || !uid) {
    return res.status(400).json({ error: 'Missing required query params.' });
  }

  try {
    const accessToken = await getPayPalAccessToken();

    const captureRes = await axios.post(
      `${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`,
      {},
      { headers: ppHeaders(accessToken) }
    );

    const captureStatus = captureRes.data.status;
    const captureId     = captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    if (captureStatus !== 'COMPLETED') {
      await db.collection('orders').doc(internalOrderId).update({
        status:          'capture_failed',
        ppCaptureStatus: captureStatus,
        updatedAt:       admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(400).json({ error: `PayPal capture status: ${captureStatus}` });
    }

    const now    = new Date();
    const expiry = cycle === 'monthly'
      ? new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
      : new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    const subscriptionData = {
      plan:            planType,
      cycle,
      active:          true,
      purchasedAt:     admin.firestore.Timestamp.fromDate(now),
      expiresAt:       admin.firestore.Timestamp.fromDate(expiry),
      paypalOrderId:   internalOrderId,
      paypalPaymentId: captureId || ppOrderId,
      gateway:         'paypal',
    };

    await db.collection('users').doc(uid).update({ subscription: subscriptionData });

    await db.collection('orders').doc(internalOrderId).update({
      status:          'paid',
      ppCaptureId:     captureId,
      ppCaptureStatus: captureStatus,
      activatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`PayPal plan activated: uid=${uid} plan=${planType}/${cycle} captureId=${captureId}`);

    return res.status(200).json({
      success: true,
      plan:    planType,
      cycle,
      activatedUntil: expiry.toISOString(),
      captureId,
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Capture failed.';
    console.error('paypal/capture-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /paypal/cancel
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/cancel', (req, res) => {
  const { orderId } = req.query;
  if (orderId) {
    db.collection('orders').doc(orderId).update({
      status:      'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  return res.status(200).json({ cancelled: true, orderId });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /paypal/create-token-order
// ─────────────────────────────────────────────────────────────────────────────
app.post('/paypal/create-token-order', async (req, res) => {
  try {
    const { tokenPacks, userEmail, userName, uid } = req.body;
    const packs = parseInt(tokenPacks, 10);

    if (!packs || packs < 1 || packs > 100) {
      return res.status(400).json({ error: 'tokenPacks must be 1–100.' });
    }
    if (!uid || !userEmail) {
      return res.status(400).json({ error: 'uid and userEmail are required.' });
    }

    const snap           = await db.collection('pricing_config').doc('plans').get();
    const tokenPackPrice = snap.exists ? Number(snap.data().token_pack_price ?? 10) : 10;
    const amountINR      = tokenPackPrice * packs;
    const amountUSD      = await inrToUsd(amountINR);

    const token   = await getPayPalAccessToken();
    const orderId = `PPTOK_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 8)}`.toUpperCase();

    const ppPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: orderId,
          description:  `${packs * 10000} AI tokens (${packs} pack${packs > 1 ? 's' : ''})`,
          amount: { currency_code: 'USD', value: amountUSD.toFixed(2) },
          custom_id: JSON.stringify({ uid, tokenPacks: packs, internalOrderId: orderId }),
        },
      ],
      application_context: {
        brand_name:  'Astric',
        user_action: 'PAY_NOW',
        return_url: `${SERVER_BASE_URL}/paypal/capture-token-order?internalOrderId=${orderId}&uid=${uid}&tokenPacks=${packs}`,
        cancel_url: `${SERVER_BASE_URL}/paypal/cancel?orderId=${orderId}`,
      },
    };

    const ppRes      = await axios.post(`${PP_BASE_URL}/v2/checkout/orders`, ppPayload, { headers: ppHeaders(token) });
    const ppOrderId  = ppRes.data.id;
    const approveUrl = ppRes.data.links?.find(l => l.rel === 'approve')?.href;

    if (!approveUrl) {
      return res.status(500).json({ error: 'PayPal did not return an approve URL.' });
    }

    await db.collection('orders').doc(orderId).set({
      orderId, uid, userEmail, orderType: 'tokens',
      tokenPacks: packs, amountINR, amountUSD,
      gateway: 'paypal', ppOrderId,
      status: 'pending', environment: PP_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      paypalOrderId:   ppOrderId,
      internalOrderId: orderId,
      approveUrl,
      amountUSD,
      amountINR,
      environment:     PP_ENV,
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'PayPal token order failed.';
    console.error('paypal/create-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /paypal/capture-token-order
// PayPal redirects here after token-pack approval.
// Idempotency guard prevents double-credit if WebView reloads the URL.
// Flutter WebView detects this URL and closes.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/capture-token-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId, uid, tokenPacks } = req.query;
  const packs = parseInt(tokenPacks, 10);

  if (!ppOrderId || !internalOrderId || !uid || !packs) {
    return res.status(400).json({ error: 'Missing required query params.' });
  }

  try {
    // Idempotency guard — if already paid don't capture or credit again
    const existingSnap = await db.collection('orders').doc(internalOrderId).get();
    if (existingSnap.exists && existingSnap.data().status === 'paid') {
      console.log(`paypal/capture-token-order: already paid, skipping. orderId=${internalOrderId}`);
      return res.status(200).json({
        success:         true,
        alreadyCredited: true,
        tokensAdded:     packs * 10000,
      });
    }

    const accessToken = await getPayPalAccessToken();
    const captureRes  = await axios.post(
      `${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`,
      {},
      { headers: ppHeaders(accessToken) }
    );

    const captureStatus = captureRes.data.status;
    const captureId     = captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    if (captureStatus !== 'COMPLETED') {
      await db.collection('orders').doc(internalOrderId).update({
        status:          'capture_failed',
        ppCaptureStatus: captureStatus,
      });
      return res.status(400).json({ error: `Capture status: ${captureStatus}` });
    }

    const tokensAdded = packs * 10000;

    // Mark paid FIRST — prevents race condition on double navigation
    await db.collection('orders').doc(internalOrderId).update({
      status:          'paid',
      ppCaptureId:     captureId,
      ppCaptureStatus: captureStatus,
      activatedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // Increment addonTokens on root user doc — single source of truth
    await db.collection('users').doc(uid).update({
      addonTokens: admin.firestore.FieldValue.increment(tokensAdded),
    });

    console.log(`PayPal tokens added: uid=${uid} tokens=${tokensAdded} captureId=${captureId}`);

    return res.status(200).json({ success: true, tokensAdded, captureId });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Token capture failed.';
    console.error('paypal/capture-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /paypal/config  — Flutter fetches clientId (secret never leaves server)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/config', (_, res) => {
  res.status(200).json({
    environment: PP_ENV,
    clientId:    PP_CLIENT_ID,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Debug endpoints
// ─────────────────────────────────────────────────────────────────────────────
app.get('/debug-paypal', (_, res) => {
  res.json({
    PP_ENV,
    SERVER_BASE_URL,
    clientId_set:     PP_CLIENT_ID.length > 0,
    secret_set:       PP_CLIENT_SECRET.length > 0,
    clientId_preview: PP_CLIENT_ID.substring(0, 10) + '...',
    base_url:         PP_BASE_URL,
  });
});

app.get('/debug-paypal-token', async (_, res) => {
  try {
    const token = await getPayPalAccessToken();
    res.json({ success: true, token_preview: token.substring(0, 20) + '...' });
  } catch (err) {
    res.json({
      success: false,
      status:  err?.response?.status,
      data:    err?.response?.data,
      message: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Astric Payment Server listening on port ${PORT}`);
  console.log(`    Cashfree    : ${CF_ENV}  →  ${CF_BASE_URL}`);
  console.log(`    PayPal      : ${PP_ENV}  →  ${PP_BASE_URL}`);
  console.log(`    Server URL  : ${SERVER_BASE_URL}`);
  console.log(`    Firebase    : ${process.env.FIREBASE_PROJECT_ID}\n`);
});