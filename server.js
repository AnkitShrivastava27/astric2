/**
 * Cashfree Payment Server
 * Deploy on Render (or any Node host).
 *
 * ENVIRONMENT VARIABLES — set in Render Dashboard → Environment:
 * ──────────────────────────────────────────────────────────────
 *  CASHFREE_APP_ID        Your Cashfree App ID
 *  CASHFREE_SECRET_KEY    Your Cashfree Secret Key
 *  CASHFREE_ENV           "TEST"  or  "PROD"  ← flip this to go live, zero rebuild
 *  FIREBASE_PROJECT_ID    Your Firebase project ID
 *  FIREBASE_CLIENT_EMAIL  From Firebase service account JSON
 *  FIREBASE_PRIVATE_KEY   From Firebase service account JSON (keep the \n characters)
 *  ADMIN_API_KEY          A secret string you choose — required for /update-pricing
 *  PORT                   Set automatically by Render — don't set manually
 */

const express = require('express');
const axios   = require('axios');
const admin   = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// CORS — Flutter hits the server from a mobile device (no browser origin),
// but Render's free tier can return an HTML splash page on cold start.
// Setting explicit JSON Content-Type on every response prevents the Flutter
// client from seeing unexpected HTML and showing "wait 30 sec" errors.
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
    // Render stores \n as literal \\n in env vars — this fixes it:
    privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// Cashfree config — reads from env vars at runtime, no rebuild needed
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
// Fetch canonical price from Firestore
// Flutter only sends planType + cycle. Price is always verified server-side.
// ─────────────────────────────────────────────────────────────────────────────
async function getCanonicalPrice(planType, cycle) {
  const snap = await db.collection('pricing_config').doc('plans').get();

  // Fallback defaults if admin hasn't configured pricing yet
  const defaults = {
    standard_monthly: 830,
    standard_annual:  664,
    premium_monthly:  1660,
    premium_annual:   1245,
    token_pack_price: 10,
  };

  if (!snap.exists) return defaults[`${planType}_${cycle}`] ?? null;

  const data  = snap.data();
  const key   = `${planType}_${cycle}`;  // e.g. "standard_monthly"
  const price = data[key];

  if (price === undefined || price === null) return defaults[key] ?? null;
  return Number(price);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /create-order
// Flutter plan_screen.dart calls this to start a Cashfree payment session.
//
// Request body:
//   planType   "standard" | "premium"
//   cycle      "monthly"  | "annual"
//   userEmail  string
//   userName   string
//   userPhone  string
//   uid        Firebase UID
//
// Response:
//   { orderId, paymentSessionId, amountINR, environment }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  try {
    const { planType, cycle, userEmail, userName, userPhone, uid } = req.body;

    // Validate
    if (!['standard', 'premium'].includes(planType)) {
      return res.status(400).json({ error: `Invalid planType: ${planType}` });
    }
    if (!['monthly', 'annual'].includes(cycle)) {
      return res.status(400).json({ error: `Invalid cycle: ${cycle}` });
    }
    if (!uid || !userEmail) {
      return res.status(400).json({ error: 'uid and userEmail are required.' });
    }

    // Fetch server-side canonical price — client-sent amount is ignored
    const amountINR = await getCanonicalPrice(planType, cycle);
    if (!amountINR || amountINR <= 0) {
      return res.status(500).json({ error: 'Could not determine plan price. Contact support.' });
    }

    // Unique order ID
    const orderId = `CF_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    // Create Cashfree order
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
        notify_url: '', // Add your webhook URL here if you want server callbacks
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

    // Log pending order to Firestore for audit trail
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
      environment: CF_ENV,  // Flutter can show "TEST MODE" badge if CF_ENV === 'TEST'
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /create-token-order
// Flutter calls this to buy add-on AI token packs (10,000 tokens each).
//
// Request body:
//   tokenPacks  number  (how many 10k packs — always 1 from ai_chat_screen)
//   userEmail   string
//   userName    string
//   userPhone   string
//   uid         Firebase UID
//
// Response:
//   { orderId, paymentSessionId, amountINR, environment }
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

    // Fetch token pack price server-side from Firestore
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

    // Log to Firestore for audit
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
// POST /verify-payment   (optional — for webhook or manual verification)
// Cashfree calls this after payment, OR Flutter can call it to double-check.
// Set as webhook URL in Cashfree Dashboard → Developers → Webhooks.
//
// Request body: { orderId: string }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/verify-payment', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId required.' });

    // Fetch status directly from Cashfree — never trust client
    const cfRes = await axios.get(
      `${CF_BASE_URL}/orders/${orderId}`,
      { headers: cfHeaders() }
    );

    const orderStatus = cfRes.data?.order_status; // PAID | ACTIVE | EXPIRED

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
// Your MERN backend calls this to update plan prices in Firestore.
// Flutter listens on a real-time stream — changes appear in ~1 second.
//
// Headers:
//   Authorization: Bearer <ADMIN_API_KEY>
//
// Body (all fields optional — only include what you want to change):
//   {
//     "standard_monthly": 830,
//     "standard_annual":  664,
//     "premium_monthly":  1660,
//     "premium_annual":   1245,
//     "token_pack_price": 10,
//     "vercel_api_url":   "https://your-server.onrender.com/create-order",
//     "updatedBy":        "admin@yourcompany.com"
//   }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/update-pricing', async (req, res) => {
  // Auth check
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

    // Validate and collect numeric price fields
    for (const key of priceFields) {
      if (req.body[key] !== undefined) {
        const val = Number(req.body[key]);
        if (isNaN(val) || val < 0) {
          return res.status(400).json({ error: `${key} must be a non-negative number.` });
        }
        update[key] = val;
      }
    }

    // The API URL field is a string
    if (req.body.vercel_api_url !== undefined) {
      update.vercel_api_url = String(req.body.vercel_api_url).trim();
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided.' });
    }

    // Audit trail
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
// GET /  — Default route so Render never serves its HTML splash page.
//          Flutter parses content-type: application/json; an HTML response
//          was triggering the "wait 30 sec" cold-start error in the app.
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
// GET /health  — Render pings this to check the server is alive
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.status(200).json({
    status:      'ok',
    environment: CF_ENV,
    timestamp:   new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Cashfree server listening on port ${PORT}`);
  console.log(`    Mode        : ${CF_ENV}`);
  console.log(`    Firebase    : ${process.env.FIREBASE_PROJECT_ID}`);
  console.log(`    Base URL    : ${CF_BASE_URL}\n`);
});
// ═══════════════════════════════════════════════════════════════════════════════
// PAYPAL ADDON — paste these blocks into your existing server.js
//
// NEW ENVIRONMENT VARIABLES (add to Render Dashboard → Environment):
//   PAYPAL_CLIENT_ID       Your PayPal REST app Client ID
//   PAYPAL_CLIENT_SECRET   Your PayPal REST app Secret
//   PAYPAL_ENV             "SANDBOX" or "LIVE"
//
// HOW PRICES WORK:
//   PayPal charges in USD. The server converts from INR → USD at a rate stored
//   in Firestore at pricing_config/plans → field: usd_inr_rate  (e.g. 83.5)
//   If that field is absent it falls back to the FALLBACK_USD_INR_RATE constant.
//   Update the rate in Firestore (via your React admin) whenever you need — no
//   redeploy required.
//
// NEW ENDPOINTS:
//   POST /paypal/create-order       → creates a PayPal order, returns { paypalOrderId }
//   POST /paypal/capture-order      → captures (charges) after user approves in WebView
//   POST /paypal/create-token-order → same but for token packs
//   POST /paypal/capture-token-order
// ═══════════════════════════════════════════════════════════════════════════════

// ── Constants ─────────────────────────────────────────────────────────────────
const FALLBACK_USD_INR_RATE = 83.5; // used only if Firestore has no usd_inr_rate

// ── PayPal helpers ─────────────────────────────────────────────────────────────
const PP_ENV        = (process.env.PAYPAL_ENV || 'SANDBOX').toUpperCase();
const PP_CLIENT_ID  = process.env.PAYPAL_CLIENT_ID  || '';
const PP_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

const PP_BASE_URL = PP_ENV === 'LIVE'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// PayPal uses OAuth2 Bearer tokens — they expire after 9 hours.
// We cache the token in-process so we don't call /token on every request.
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
    'PayPal-Request-Id': uuidv4(), // idempotency key per request
  };
}

// Convert INR price → USD, rounded to 2 decimal places
async function inrToUsd(inrAmount) {
  const snap = await db.collection('pricing_config').doc('plans').get();
  const rate = snap.exists
    ? Number(snap.data().usd_inr_rate ?? FALLBACK_USD_INR_RATE)
    : FALLBACK_USD_INR_RATE;
  return Math.round((inrAmount / rate) * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /paypal/create-order
//
// Flutter calls this after the user selects PayPal as payment method.
// Returns { paypalOrderId, approveUrl, amountUSD, amountINR, environment }
//
// Flutter opens approveUrl in a WebView / url_launcher.
// After the user approves on PayPal's page, PayPal redirects to
// https://your-server.com/paypal/capture-order?token=<paypalOrderId>&uid=<uid>
// which captures the payment and stores the subscription in Firestore.
//
// Body: { planType, cycle, userEmail, userName, uid }
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

    const amountINR = await getCanonicalPrice(planType, cycle); // reuses existing fn
    if (!amountINR || amountINR <= 0) {
      return res.status(500).json({ error: 'Could not determine plan price.' });
    }

    const amountUSD = await inrToUsd(amountINR);

    const token = await getPayPalAccessToken();
    const orderId = `PP_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    // PayPal order payload
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
        brand_name: 'Astric',
        locale: 'en-US',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        // After approval PayPal redirects here — server captures and stores subscription
        return_url: `${process.env.SERVER_BASE_URL || 'https://your-server.onrender.com'}/paypal/capture-order?internalOrderId=${orderId}&uid=${uid}&planType=${planType}&cycle=${cycle}`,
        cancel_url: `${process.env.SERVER_BASE_URL || 'https://your-server.onrender.com'}/paypal/cancel?orderId=${orderId}`,
      },
    };

    const ppRes = await axios.post(
      `${PP_BASE_URL}/v2/checkout/orders`,
      ppPayload,
      { headers: ppHeaders(token) }
    );

    const ppOrderId  = ppRes.data.id;
    const approveUrl = ppRes.data.links?.find(l => l.rel === 'approve')?.href;

    if (!approveUrl) {
      return res.status(500).json({ error: 'PayPal did not return an approve URL.' });
    }

    // Log pending order in Firestore
    await db.collection('orders').doc(orderId).set({
      orderId,
      uid,
      userEmail,
      planType,
      cycle,
      amountINR,
      amountUSD,
      gateway: 'paypal',
      ppOrderId,
      status: 'pending',
      environment: PP_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      paypalOrderId: ppOrderId,
      internalOrderId: orderId,
      approveUrl,
      amountUSD,
      amountINR,
      environment: PP_ENV,
    });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'PayPal order creation failed.';
    console.error('paypal/create-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /paypal/capture-order
// PayPal redirects the user's browser here after they approve the payment.
// The server captures the payment, activates the subscription in Firestore,
// and returns a JSON response (Flutter WebView detects this URL and closes).
//
// Query params: token (PayPal order ID), internalOrderId, uid, planType, cycle
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/capture-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId, uid, planType, cycle } = req.query;

  if (!ppOrderId || !internalOrderId || !uid) {
    return res.status(400).json({ error: 'Missing required query params.' });
  }

  try {
    const accessToken = await getPayPalAccessToken();

    // Capture (charge) the PayPal order
    const captureRes = await axios.post(
      `${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`,
      {},
      { headers: ppHeaders(accessToken) }
    );

    const captureStatus = captureRes.data.status; // COMPLETED | PAYER_ACTION_REQUIRED | etc.
    const captureId = captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    if (captureStatus !== 'COMPLETED') {
      await db.collection('orders').doc(internalOrderId).update({
        status: 'capture_failed',
        ppCaptureStatus: captureStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(400).json({ error: `PayPal capture status: ${captureStatus}` });
    }

    // Activate subscription in Firestore
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
      paypalOrderId:     internalOrderId,
      paypalPaymentId:   captureId || ppOrderId,
      gateway:           'paypal',
    };

    await db.collection('users').doc(uid).update({ subscription: subscriptionData });

    // Mark order as paid
    await db.collection('orders').doc(internalOrderId).update({
      status:          'paid',
      ppCaptureId:      captureId,
      ppCaptureStatus:  captureStatus,
      activatedAt:      admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`PayPal plan activated: uid=${uid} plan=${planType}/${cycle} captureId=${captureId}`);

    // Return JSON — Flutter WebView detects this URL pattern and closes the sheet,
    // then calls subscriptionProvider.reload() to pick up the new Firestore state.
    return res.status(200).json({
      success: true,
      plan: planType,
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
// PayPal redirects here if the user closes the PayPal window without paying.
// Flutter WebView detects this URL and shows a cancellation message.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/cancel', (req, res) => {
  const { orderId } = req.query;
  // Mark as cancelled (fire and forget — non-critical)
  if (orderId) {
    db.collection('orders').doc(orderId).update({
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  return res.status(200).json({ cancelled: true, orderId });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /paypal/create-token-order
//
// Body: { tokenPacks, userEmail, userName, uid }
// Response: { paypalOrderId, internalOrderId, approveUrl, amountUSD, amountINR, environment }
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

    const snap = await db.collection('pricing_config').doc('plans').get();
    const tokenPackPrice = snap.exists ? Number(snap.data().token_pack_price ?? 10) : 10;
    const amountINR = tokenPackPrice * packs;
    const amountUSD = await inrToUsd(amountINR);

    const token   = await getPayPalAccessToken();
    const orderId = `PPTOK_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 8)}`.toUpperCase();

    const ppPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: orderId,
          description: `${packs * 10000} AI tokens (${packs} pack${packs > 1 ? 's' : ''})`,
          amount: { currency_code: 'USD', value: amountUSD.toFixed(2) },
          custom_id: JSON.stringify({ uid, tokenPacks: packs, internalOrderId: orderId }),
        },
      ],
      application_context: {
        brand_name: 'Astric',
        user_action: 'PAY_NOW',
        return_url: `${process.env.SERVER_BASE_URL || 'https://your-server.onrender.com'}/paypal/capture-token-order?internalOrderId=${orderId}&uid=${uid}&tokenPacks=${packs}`,
        cancel_url: `${process.env.SERVER_BASE_URL || 'https://your-server.onrender.com'}/paypal/cancel?orderId=${orderId}`,
      },
    };

    const ppRes     = await axios.post(`${PP_BASE_URL}/v2/checkout/orders`, ppPayload, { headers: ppHeaders(token) });
    const ppOrderId = ppRes.data.id;
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

    return res.status(200).json({ paypalOrderId: ppOrderId, internalOrderId: orderId, approveUrl, amountUSD, amountINR, environment: PP_ENV });

  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'PayPal token order failed.';
    console.error('paypal/create-token-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /paypal/capture-token-order
// PayPal redirect after token-pack purchase approval.
// Adds tokens to Firestore: users/{uid}.addonTokens += packs * 10000
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/capture-token-order', async (req, res) => {
  const { token: ppOrderId, internalOrderId, uid, tokenPacks } = req.query;
  const packs = parseInt(tokenPacks, 10);

  if (!ppOrderId || !internalOrderId || !uid || !packs) {
    return res.status(400).json({ error: 'Missing required query params.' });
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const captureRes  = await axios.post(
      `${PP_BASE_URL}/v2/checkout/orders/${ppOrderId}/capture`,
      {},
      { headers: ppHeaders(accessToken) }
    );

    const captureStatus = captureRes.data.status;
    const captureId     = captureRes.data.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    if (captureStatus !== 'COMPLETED') {
      await db.collection('orders').doc(internalOrderId).update({ status: 'capture_failed', ppCaptureStatus: captureStatus });
      return res.status(400).json({ error: `Capture status: ${captureStatus}` });
    }

    const tokensAdded = packs * 10000;

    // Atomic increment of addonTokens
    await db.collection('users').doc(uid).update({
      addonTokens: admin.firestore.FieldValue.increment(tokensAdded),
    });

    await db.collection('orders').doc(internalOrderId).update({
      status: 'paid', ppCaptureId: captureId, ppCaptureStatus: captureStatus,
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
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
// GET /paypal/config  — Flutter fetches this to get the PayPal env + client ID.
// The client ID is public; the secret never leaves the server.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/paypal/config', (_, res) => {
  res.status(200).json({
    environment: PP_ENV,
    clientId: PP_CLIENT_ID,
  });
});
const PP_CLIENT_ID     = process.env.PAYPAL_CLIENT_ID     || '';  // empty!
const PP_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';  // empty!
app.get('/debug-paypal', (_, res) => {
  res.json({
    PP_ENV,
    clientId_set:     PP_CLIENT_ID.length > 0,
    secret_set:       PP_CLIENT_SECRET.length > 0,
    clientId_preview: PP_CLIENT_ID.substring(0, 10) + '...',
    base_url:         PP_BASE_URL,
  });
});