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
 *  PORT                   Set automatically by Render -- don't set manually
 *
 *  -- EmailJS (moved OFF Flutter client - never expose in app source) --------
 *  EMAILJS_SERVICE_ID     Your EmailJS service ID  (e.g. Astricservice)
 *  EMAILJS_TEMPLATE_ID    Your EmailJS template ID (e.g. AstricTemp)
 *  EMAILJS_PUBLIC_KEY     Your EmailJS public key  (e.g. D4bKTz9ziK50VZa7W)
 *
 *  -- AI --------------------------------------------------------------------
 *  DEEPSEEK_API_KEY       DeepSeek API key -- Flutter fetches via GET /config
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

// -----------------------------------------------------------------------------
// EmailJS config (read from env -- never hardcode in Flutter source)
// -----------------------------------------------------------------------------
const EMAILJS_SERVICE_ID  = process.env.EMAILJS_SERVICE_ID  || '';
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || '';
const EMAILJS_PUBLIC_KEY  = process.env.EMAILJS_PUBLIC_KEY  || '';

// -----------------------------------------------------------------------------
// DeepSeek / AI config
// -----------------------------------------------------------------------------
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY  || '';
const GROK_API_KEY      = process.env.GROK_API_KEY      || '';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Default AI token limits per plan (overridden by Firestore ai_limits/config)
const DEFAULT_AI_LIMITS = {
  basic_tokens_limit:    5000,
  standard_tokens_limit: 50000,
  premium_tokens_limit:  200000,
  token_pack_size:       10000,   // tokens per addon pack purchase
};

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
// POST /verify-plan-order   (Cashfree plan — verify + activate)
//
// Flutter calls this AFTER the Cashfree SDK fires onSuccess for a PLAN purchase.
// Flow mirrors /fulfill-token-order:
//   1. Idempotency guard  — already activated → return success, skip re-write
//   2. Verify with Cashfree API that order_status === 'PAID'
//   3. Mark order as paid
//   4. Write subscription to users/{uid}.subscription in Firestore
//
// Flutter must NOT activate the plan client-side. It calls this endpoint,
// awaits a 200 with status:'PAID', then calls reload() to refresh local state.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-plan-order', async (req, res) => {
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

    // 2. Idempotency guard — already activated, just return success
    if (orderData.status === 'paid') {
      console.log(`verify-plan-order: already activated, skipping. orderId=${orderId}`);
      return res.status(200).json({
        success:        true,
        alreadyActived: true,
        status:         'PAID',
        planType:       orderData.planType,
        cycle:          orderData.cycle,
      });
    }

    // 3. Verify with Cashfree that payment actually succeeded
    const cfRes = await axios.get(
      `${CF_BASE_URL}/orders/${orderId}`,
      { headers: cfHeaders() }
    );
    const orderStatus = cfRes.data?.order_status;

    if (orderStatus !== 'PAID') {
      console.warn(`verify-plan-order: Cashfree status not PAID (${orderStatus}) for orderId=${orderId}`);
      return res.status(400).json({
        error:  `Payment not complete. Cashfree status: ${orderStatus}`,
        status: orderStatus,
      });
    }

    const { planType, cycle } = orderData;

    // 4. Mark order paid FIRST (prevents race if Flutter calls this twice)
    await db.collection('orders').doc(orderId).update({
      status:      'paid',
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      cfOrderData: cfRes.data,
    });

    // 5. Write subscription to Firestore — single source of truth
    const now    = new Date();
    const expiry = cycle === 'monthly'
      ? new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
      : new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());

    const subscriptionData = {
      plan:              planType,
      cycle,
      active:            true,
      purchasedAt:       admin.firestore.Timestamp.fromDate(now),
      expiresAt:         admin.firestore.Timestamp.fromDate(expiry),
      cashfreeOrderId:   orderId,
      cashfreePaymentId: cfRes.data?.cf_payment_id || orderId,
      gateway:           'cashfree',
    };

    await db.collection('users').doc(uid).update({ subscription: subscriptionData });

    console.log(`Cashfree plan activated: uid=${uid} plan=${planType}/${cycle} orderId=${orderId}`);

    return res.status(200).json({
      success:        true,
      status:         'PAID',
      planType,
      cycle,
      activatedUntil: expiry.toISOString(),
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Plan verification failed.';
    console.error('verify-plan-order error:', err?.response?.data || err.message);
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
    // ── Idempotency guard — WebView can fire onPageFinished twice for the
    //    same capture URL. If already paid, return success without re-capturing.
    const existingSnap = await db.collection('orders').doc(internalOrderId).get();
    if (existingSnap.exists && existingSnap.data().status === 'paid') {
      console.log(`paypal/capture-order: already paid, skipping. orderId=${internalOrderId}`);
      return res.status(200).json({
        success:         true,
        alreadyCredited: true,
        plan:            existingSnap.data().planType,
        cycle:           existingSnap.data().cycle,
      });
    }

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


// =============================================================================
// GET /config
// Flutter calls this ONCE on startup to fetch all non-secret runtime config:
// EmailJS creds, DeepSeek key, Cashfree/PayPal env, AI token limits,
// and plan gating (screenAccess + screenLimits from appConfig/planGating).
// =============================================================================
app.get('/config', async (_, res) => {
  try {
    // ── AI limits ─────────────────────────────────────────────────────────────
    const limitsSnap = await db.collection('ai_limits').doc('config').get();
    const limits = limitsSnap.exists
      ? { ...DEFAULT_AI_LIMITS, ...limitsSnap.data() }
      : { ...DEFAULT_AI_LIMITS };

    // ── Screen access / plan gating ───────────────────────────────────────────
    const DEFAULT_SCREEN_ACCESS = {
      finance: 'basic', invoices: 'basic', customers: 'basic', leads: 'basic',
      projects: 'basic', tasks: 'basic', employees: 'basic', sales: 'basic',
      currency: 'basic', files: 'basic', notes: 'basic', calendar: 'basic',
      reports: 'standard', kpis: 'standard', ai_chat: 'standard',
      email: 'standard', team_chat: 'standard', unified_inbox: 'standard',
      integrations: 'standard', data_storage: 'standard',
      pdf_analyst: 'premium',
    };
    const DEFAULT_SCREEN_LIMITS = {
      max_employees_basic: 3,    max_employees_standard: 10,  max_employees_premium: 20,
      max_integrations_basic: 2, max_integrations_standard: 6, max_integrations_premium: -1,
      max_storage_mb_basic: 500, max_storage_mb_standard: 5120, max_storage_mb_premium: -1,
      ai_tokens_basic: 10000,    ai_tokens_standard: 50000,   ai_tokens_premium: 200000,
    };

    let screenAccess = DEFAULT_SCREEN_ACCESS;
    let screenLimits = DEFAULT_SCREEN_LIMITS;

    try {
      const gatingSnap = await db.collection('appConfig').doc('planGating').get();
      if (gatingSnap.exists) {
        const gatingData = gatingSnap.data();
        if (gatingData.screenAccess) screenAccess = { ...DEFAULT_SCREEN_ACCESS, ...gatingData.screenAccess };
        if (gatingData.screenLimits) screenLimits = { ...DEFAULT_SCREEN_LIMITS, ...gatingData.screenLimits };
      }
    } catch (gatingErr) {
      // Don't break the whole /config response if this read fails
      console.warn('[config] Could not read appConfig/planGating:', gatingErr.message);
    }

    return res.status(200).json({
      emailjs: {
        serviceId:  EMAILJS_SERVICE_ID,
        templateId: EMAILJS_TEMPLATE_ID,
        publicKey:  EMAILJS_PUBLIC_KEY,
      },
      deepseekApiKey:  DEEPSEEK_API_KEY,
      grokApiKey:      GROK_API_KEY,
      openaiApiKey:    OPENAI_API_KEY,
      anthropicApiKey: ANTHROPIC_API_KEY,
      cashfreeEnv:    CF_ENV,
      paypalEnv:      PP_ENV,
      aiLimits: {
        basicTokensLimit:    limits.basic_tokens_limit,
        standardTokensLimit: limits.standard_tokens_limit,
        premiumTokensLimit:  limits.premium_tokens_limit,
        tokenPackSize:       limits.token_pack_size,
      },
      screenAccess,
      screenLimits,
    });
  } catch (err) {
    console.error('/config error:', err.message);
    return res.status(500).json({ error: 'Failed to load config.' });
  }
});

// =============================================================================
// GET /ai-limits
// Returns current per-plan token limits from Firestore.
// Flutter aiLimitsProvider calls this to get live limits without a full /config.
// =============================================================================
app.get('/ai-limits', async (_, res) => {
  try {
    const snap = await db.collection('ai_limits').doc('config').get();
    const limits = snap.exists
      ? { ...DEFAULT_AI_LIMITS, ...snap.data() }
      : { ...DEFAULT_AI_LIMITS };

    return res.status(200).json({
      basicTokensLimit:    limits.basic_tokens_limit,
      standardTokensLimit: limits.standard_tokens_limit,
      premiumTokensLimit:  limits.premium_tokens_limit,
      tokenPackSize:       limits.token_pack_size,
      source:              snap.exists ? 'firestore' : 'defaults',
    });
  } catch (err) {
    console.error('/ai-limits error:', err.message);
    return res.status(500).json({ error: 'Failed to load AI limits.' });
  }
});

// =============================================================================
// POST /update-ai-limits
// Admin-only. Update per-plan token limits stored in Firestore ai_limits/config.
// Same auth as /update-pricing: Bearer ADMIN_API_KEY header.
//
// Writable fields (all optional, must be non-negative integers):
//   basic_tokens_limit      -- tokens/month for Basic plan
//   standard_tokens_limit   -- tokens/month for Standard plan
//   premium_tokens_limit    -- tokens/month for Premium plan
//   token_pack_size         -- tokens credited per addon pack purchase
//
// Example:
//   curl -X POST https://yourserver.onrender.com/update-ai-limits \
//     -H "Authorization: Bearer YOUR_ADMIN_KEY" \
//     -H "Content-Type: application/json" \
//     -d '{"standard_tokens_limit": 75000, "premium_tokens_limit": 300000}'
// =============================================================================
app.post('/update-ai-limits', async (req, res) => {
  const token    = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const adminKey = process.env.ADMIN_API_KEY || '';

  if (!adminKey) {
    return res.status(500).json({ error: 'ADMIN_API_KEY not configured on server.' });
  }
  if (token !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const limitFields = [
      'basic_tokens_limit',
      'standard_tokens_limit',
      'premium_tokens_limit',
      'token_pack_size',
    ];

    const update = {};

    for (const key of limitFields) {
      if (req.body[key] !== undefined) {
        const val = Number(req.body[key]);
        if (!Number.isInteger(val) || val < 0) {
          return res.status(400).json({ error: `${key} must be a non-negative integer.` });
        }
        update[key] = val;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided.' });
    }

    update.updated_at = admin.firestore.FieldValue.serverTimestamp();
    update.updated_by = req.body.updatedBy || 'admin';

    await db.collection('ai_limits').doc('config').set(update, { merge: true });

    const updatedFields = Object.keys(update).filter(
      k => k !== 'updated_at' && k !== 'updated_by'
    );

    console.log(`AI limits updated by "${update.updated_by}":`, updatedFields);

    return res.status(200).json({
      success: true,
      updated: updatedFields,
      message: 'Done. Flutter app reflects new limits within ~1 second.',
    });

  } catch (err) {
    console.error('/update-ai-limits error:', err.message);
    return res.status(500).json({ error: 'Failed to update AI limits.' });
  }
});

// =============================================================================
// UNIFIED MESSAGING SYSTEM
// Handles incoming webhooks from WhatsApp, Instagram, Messenger, Telegram
// and outbound reply sending for all platforms.
//
// Required ENV vars (add to Render):
//   META_VERIFY_TOKEN       — any string you choose, same for all Meta webhooks
//   META_APP_SECRET         — from Meta App → Settings → Basic → App Secret
//   TELEGRAM_BOT_TOKEN      — from @BotFather
//
// Per-user credentials (stored in Firestore users/{uid}/connectedChannels/*)
// are fetched dynamically so each user has their own API keys.
// =============================================================================

const crypto = require('crypto');

const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'astric_verify_token';
const META_APP_SECRET   = process.env.META_APP_SECRET   || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Write an incoming message to Firestore under the org owner's uid
async function saveIncomingMessage({ uid, channel, contactId, contactName, text, mediaUrl }) {
  const now    = new Date().toISOString();
  const convoId = `${channel}_${contactId}`;

  const convoRef = db
    .collection('users').doc(uid)
    .collection('conversations').doc(convoId);

  const msgRef = convoRef.collection('messages').doc();

  const batch = db.batch();

  // Upsert conversation doc
  batch.set(convoRef, {
    channel,
    contactId,
    contactName:   contactName || contactId,
    lastMessage:   text || '📎 Media',
    lastMessageAt: now,
    isResolved:    false,
  }, { merge: true });

  // Increment unread count
  batch.set(convoRef, {
    unreadCount: admin.firestore.FieldValue.increment(1),
  }, { merge: true });

  // Write message
  batch.set(msgRef, {
    conversationId: convoId,
    text:           text || '',
    mediaUrl:       mediaUrl || null,
    isOutbound:     false,
    sentAt:         now,
    isRead:         false,
    channel,
    status:         'received',
  });

  await batch.commit();
  console.log(`[messaging] Saved incoming ${channel} msg from ${contactId} → uid ${uid}`);
}

// Find which org-owner uid has a connected channel matching contactId/pageId
// For simplicity we store a reverse-lookup: channelType → uid in appConfig/channelIndex
// When a user connects a channel, we write their uid there so webhooks can route correctly.
async function findUidForChannel(channelType, channelAccountId) {
  try {
    const snap = await db
      .collection('appConfig')
      .doc('channelIndex')
      .get();

    if (!snap.exists) return null;
    const data = snap.data();
    // Structure: { 'whatsapp_<phoneNumberId>': uid, 'telegram_<botUsername>': uid, ... }
    return data[`${channelType}_${channelAccountId}`] || null;
  } catch (_) {
    return null;
  }
}

// Fetch a user's channel credentials from Firestore
async function getChannelCreds(uid, channelType) {
  try {
    const snap = await db
      .collection('users').doc(uid)
      .collection('connectedChannels').doc(channelType)
      .get();
    return snap.exists ? snap.data().credentials : null;
  } catch (_) {
    return null;
  }
}

// Mark outbound message as sent or failed
async function updateMessageStatus(uid, convoId, msgId, status) {
  try {
    await db
      .collection('users').doc(uid)
      .collection('conversations').doc(convoId)
      .collection('messages').doc(msgId)
      .update({ status });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform senders — called when Flutter writes a pending outbound message
// ─────────────────────────────────────────────────────────────────────────────

async function sendWhatsApp({ accessToken, phoneNumberId, to, text }) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type:    'individual',
      to,
      type:              'text',
      text:              { body: text },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function sendInstagram({ accessToken, igAccountId, to, text }) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/messages`,
    {
      recipient: { id: to },
      message:   { text },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function sendMessenger({ accessToken, to, text }) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    {
      recipient: { id: to },
      message:   { text },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function sendTelegram({ botToken, chatId, text }) {
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'HTML' }
  );
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound reply dispatcher
// Called by POST /messaging/send — Flutter triggers this after writing to Firestore
// ─────────────────────────────────────────────────────────────────────────────
app.post('/messaging/send', async (req, res) => {
  const { uid, conversationId, messageId, channel, contactId, text } = req.body;

  if (!uid || !conversationId || !channel || !contactId || !text) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const creds = await getChannelCreds(uid, channel);
    if (!creds) {
      return res.status(404).json({ error: `No credentials found for ${channel}` });
    }

    switch (channel) {
      case 'whatsapp':
        await sendWhatsApp({
          accessToken:   creds.accessToken,
          phoneNumberId: creds.phoneNumberId,
          to:            contactId,
          text,
        });
        break;

      case 'instagram':
        await sendInstagram({
          accessToken: creds.accessToken,
          igAccountId: creds.igAccountId,
          to:          contactId,
          text,
        });
        break;

      case 'messenger':
        await sendMessenger({
          accessToken: creds.accessToken,
          to:          contactId,
          text,
        });
        break;

      case 'telegram':
        await sendTelegram({
          botToken: creds.botToken,
          chatId:   contactId,
          text,
        });
        break;

      default:
        return res.status(400).json({ error: `Unknown channel: ${channel}` });
    }

    // Mark message as sent in Firestore
    if (messageId) {
      await updateMessageStatus(uid, conversationId, messageId, 'sent');
    }

    console.log(`[messaging] Sent ${channel} reply to ${contactId} for uid ${uid}`);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error(`[messaging/send] ${channel} error:`, err.response?.data || err.message);
    if (messageId) {
      await updateMessageStatus(uid, conversationId, messageId, 'failed');
    }
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Channel connect — saves reverse-lookup index so webhooks can route to uid
// Called by Flutter after user saves credentials
// ─────────────────────────────────────────────────────────────────────────────
app.post('/messaging/connect', async (req, res) => {
  const { uid, channelType, accountId } = req.body;
  if (!uid || !channelType || !accountId) {
    return res.status(400).json({ error: 'Missing uid, channelType or accountId' });
  }
  try {
    await db.collection('appConfig').doc('channelIndex').set(
      { [`${channelType}_${accountId}`]: uid },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// META WEBHOOK VERIFICATION (GET) — WhatsApp + Instagram + Messenger share this
// ─────────────────────────────────────────────────────────────────────────────
function metaVerify(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[webhook] Meta verification success');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Webhook
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/whatsapp', metaVerify);

app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately to Meta
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages?.length) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const uid = await findUidForChannel('whatsapp', phoneNumberId);
        if (!uid) { console.warn('[whatsapp] No uid for phoneNumberId', phoneNumberId); continue; }

        for (const msg of value.messages) {
          const contactId   = msg.from; // sender's phone number
          const contactName = value.contacts?.find(c => c.wa_id === msg.from)?.profile?.name || msg.from;
          const text        = msg.text?.body || msg.caption || '';
          const mediaUrl    = msg.image?.id || msg.document?.id || msg.audio?.id || null;

          await saveIncomingMessage({ uid, channel: 'whatsapp', contactId, contactName, text, mediaUrl });
        }
      }
    }
  } catch (err) {
    console.error('[webhook/whatsapp]', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Instagram Webhook
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/instagram', metaVerify);

app.post('/webhook/instagram', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      const igAccountId = entry.id;
      const uid = await findUidForChannel('instagram', igAccountId);
      if (!uid) { console.warn('[instagram] No uid for igAccountId', igAccountId); continue; }

      for (const msg of entry.messaging || []) {
        if (msg.message?.is_echo) continue; // skip our own sent messages
        const contactId   = msg.sender?.id;
        const text        = msg.message?.text || '';
        const mediaUrl    = msg.message?.attachments?.[0]?.payload?.url || null;

        await saveIncomingMessage({ uid, channel: 'instagram', contactId, contactName: contactId, text, mediaUrl });
      }
    }
  } catch (err) {
    console.error('[webhook/instagram]', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Messenger Webhook
// ─────────────────────────────────────────────────────────────────────────────
app.get('/webhook/messenger', metaVerify);

app.post('/webhook/messenger', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      const pageId = entry.id;
      const uid = await findUidForChannel('messenger', pageId);
      if (!uid) { console.warn('[messenger] No uid for pageId', pageId); continue; }

      for (const msg of entry.messaging || []) {
        if (msg.message?.is_echo) continue;
        const contactId = msg.sender?.id;
        const text      = msg.message?.text || '';
        const mediaUrl  = msg.message?.attachments?.[0]?.payload?.url || null;

        await saveIncomingMessage({ uid, channel: 'messenger', contactId, contactName: contactId, text, mediaUrl });
      }
    }
  } catch (err) {
    console.error('[webhook/messenger]', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Webhook
// Telegram sends to: POST /webhook/telegram/<botToken>
// Using token in URL path as a security measure (Telegram best practice)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook/telegram/:token', async (req, res) => {
  res.sendStatus(200);
  try {
    const { token } = req.params;
    const update    = req.body;
    const msg       = update.message || update.edited_message || update.channel_post;
    if (!msg) return;

    // Find uid by matching bot token stored in connectedChannels
    // We index as telegram_<botUsername>
    const botInfo   = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    const botUsername = botInfo.data?.result?.username;
    const uid       = await findUidForChannel('telegram', botUsername);
    if (!uid) { console.warn('[telegram] No uid for bot', botUsername); return; }

    const contactId   = String(msg.chat?.id);
    const contactName = msg.chat?.first_name
      ? `${msg.chat.first_name} ${msg.chat.last_name || ''}`.trim()
      : msg.chat?.username || contactId;
    const text      = msg.text || msg.caption || '';
    const mediaUrl  = msg.photo ? msg.photo[msg.photo.length - 1]?.file_id : null;

    await saveIncomingMessage({ uid, channel: 'telegram', contactId, contactName, text, mediaUrl });
  } catch (err) {
    console.error('[webhook/telegram]', err.message);
  }
});

// =============================================================================
// PUSH NOTIFICATIONS — FCM Broadcast
// POST /notifications/broadcast   — send to all users or specific plan
// POST /notifications/send-to-user — send to one user by uid
// GET  /api/notifications/log     — fetch broadcast history for admin panel
// =============================================================================

app.get('/api/notifications/log', async (req, res) => {
  try {
    const snap = await db.collection('notifications_log')
      .orderBy('sentAt', 'desc').limit(50).get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/notifications/broadcast', async (req, res) => {
  const { title, body, type = 'broadcast', targetPlan, data = {} } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });

  try {
    let query = db.collection('users').where('fcmTokens', '!=', null);
    if (targetPlan && targetPlan !== 'all') {
      query = query.where('plan', '==', targetPlan);
    }
    const snap   = await query.get();
    const tokens = [];
    snap.forEach(doc => {
      const t = doc.data().fcmTokens;
      if (Array.isArray(t)) tokens.push(...t);
    });

    if (tokens.length === 0) return res.json({ ok: true, sent: 0 });

    // Send in batches of 500 (FCM limit)
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

    let sent = 0;
    for (const chunk of chunks) {
      const result = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: { type, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
        android: { priority: 'high', notification: { color: '#C8A96E', sound: 'default' } },
        apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      sent += result.successCount;
    }

    await db.collection('notifications_log').add({
      title, body, type, targetPlan: targetPlan || 'all',
      totalSent: sent, sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[notifications] Broadcast sent to ${sent} devices`);
    res.json({ ok: true, sent, total: tokens.length });
  } catch (err) {
    console.error('[notifications/broadcast]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/notifications/send-to-user', async (req, res) => {
  const { uid, title, body, type = 'system', data = {} } = req.body;
  if (!uid || !title || !body) return res.status(400).json({ error: 'uid, title and body required' });

  try {
    const snap   = await db.collection('users').doc(uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });

    const tokens = snap.data().fcmTokens || [];
    if (tokens.length === 0) return res.json({ ok: true, sent: 0 });

    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { type, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
      android: { priority: 'high', notification: { color: '#C8A96E', sound: 'default' } },
      apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
    });

    res.json({ ok: true, sent: result.successCount });
  } catch (err) {
    console.error('[notifications/send-to-user]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Start server
// =============================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Astric Payment Server listening on port ${PORT}`);
  console.log(`    Cashfree    : ${CF_ENV}  →  ${CF_BASE_URL}`);
  console.log(`    PayPal      : ${PP_ENV}  →  ${PP_BASE_URL}`);
  console.log(`    Server URL  : ${SERVER_BASE_URL}`);
  console.log(`    Firebase    : ${process.env.FIREBASE_PROJECT_ID}`);
  console.log(`    EmailJS     : serviceId=${EMAILJS_SERVICE_ID || '(not set)'}`);
  console.log(`    DeepSeek    : key_set=${DEEPSEEK_API_KEY.length > 0}`);
  console.log(`    Grok (xAI)  : key_set=${GROK_API_KEY.length > 0}`);
  console.log(`    OpenAI      : key_set=${OPENAI_API_KEY.length > 0}`);
  console.log(`    Anthropic   : key_set=${ANTHROPIC_API_KEY.length > 0}\n`);
});