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
