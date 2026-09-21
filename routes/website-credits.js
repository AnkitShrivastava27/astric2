// routes/website-credits.js
//
// Two new endpoints for the Website Studio pricing tiers:
//   POST /create-website-credit-order  -> { orderId, paymentSessionId }
//   POST /verify-website-credit-order  -> { status: 'PAID' | ... }
//
// This is deliberately the SAME shape as your existing
// /create-token-order + fulfil-on-success pattern (see plan_screen.dart's
// _buyCashfree / _onCfSuccess for the client side of that existing flow) -
// just a different Firestore field being credited and different
// price/quantity math, since Website Studio's three tiers (Trial/
// Standard/Pro) aren't "N packs of a fixed token amount" the way the
// existing token top-up is.
//
// IMPORTANT: this file does NOT invent new Cashfree credentials or SDK
// setup - it assumes your existing Cashfree order-creation code (whatever
// creates orders for /create-order and /create-token-order today) is
// available to import here. Copy however those handlers actually call
// Cashfree's Orders API in your codebase into createCashfreeOrder()
// below rather than trusting this file's placeholder to match your real
// setup - every real Cashfree integration has slightly different
// credential/env-var plumbing, and guessing wrong here would silently
// break payments rather than just being a formatting issue.

const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp();
}

// Mirrors WebsiteTier in website_project_model.dart for the FIXED parts
// (what each tier gets) — these don't change without a product decision.
// Price is intentionally NOT here: it's read live from pricing_config/plans
// below, matching the "amount always from Firestore, never trust a
// hardcoded constant" pattern this app's other Cashfree flows already use
// (see Pricing.jsx / routes/pricing.js in the admin panel, which write
// website_trial_price / website_standard_price / website_pro_price into
// that same doc when an admin updates pricing).
const TIERS = {
  trial:    { tokenBudget: 1000, priceField: 'website_trial_price' },
  standard: { tokenBudget: 4500, priceField: 'website_standard_price' },
  pro:      { tokenBudget: 9000, priceField: 'website_pro_price' },
};

// Same doc the rest of this app's pricing already lives in.
async function getWebsiteTierPriceINR(tierName) {
  const tier = TIERS[tierName];
  const snap = await admin.firestore().collection('pricing_config').doc('plans').get();
  const price = snap.exists ? snap.data()[tier.priceField] : undefined;
  // Fallback only for local/dev safety if the admin hasn't set a price
  // yet — production should always have real values here via Pricing.jsx.
  const fallback = { trial: 9, standard: 39, pro: 99 }[tierName];
  return typeof price === 'number' ? price : fallback;
}

// TODO: replace this with your ACTUAL existing Cashfree order-creation
// call - copy the body of whatever function /create-order or
// /create-token-order use today. It needs to return
// { orderId, paymentSessionId } on success.
async function createCashfreeOrder(opts) {
  throw new Error(
    'createCashfreeOrder() is a placeholder - wire this to your existing ' +
    'Cashfree order-creation code (the same one /create-token-order uses).'
  );
}

// TODO: replace this with your ACTUAL existing "check this order's status
// with Cashfree" call - copy the body of whatever /verify-plan-order uses
// today. It needs to return Cashfree's order status string, e.g. 'PAID'.
async function fetchCashfreeOrderStatus(orderId) {
  throw new Error(
    'fetchCashfreeOrderStatus() is a placeholder - wire this to your ' +
    'existing Cashfree order-status check (the same one /verify-plan-order uses).'
  );
}

// TODO: verify the Firebase ID token the same way your other authenticated
// routes do, and set req.uid from it. Both endpoints below assume req.uid
// is already populated by middleware mounted ahead of this router.
// const requireAuth = require('../middleware/require-auth');
// router.use(requireAuth);

router.post('/create-website-credit-order', async (req, res) => {
  try {
    const tierName = req.body && req.body.tier;
    const tier = TIERS[tierName];
    if (!tier) {
      return res.status(400).json({ error: 'Unknown tier: ' + tierName });
    }

    const uid = req.uid; // set by your auth middleware - see TODO above
    if (!uid) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const priceINR = await getWebsiteTierPriceINR(tierName);

    const order = await createCashfreeOrder({
      amountINR: priceINR,
      userEmail: req.body.userEmail,
      userName:  req.body.userName,
      userPhone: req.body.userPhone,
      orderNote: 'Website Studio - ' + tierName + ' pack',
    });

    // Record what this order is FOR, so verify can credit the right
    // amount without trusting anything the client sends back at verify
    // time (the client only ever sends orderId to /verify).
    await admin.firestore().collection('websiteCreditOrders').doc(order.orderId).set({
      uid: uid, tier: tierName, tokenBudget: tier.tokenBudget, priceINR: priceINR,
      status: 'CREATED',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      orderId: order.orderId,
      paymentSessionId: order.paymentSessionId,
      amountINR: priceINR,
    });
  } catch (err) {
    console.error('POST /create-website-credit-order failed:', err);
    return res.status(500).json({ error: err.message || 'Order creation failed' });
  }
});

router.post('/verify-website-credit-order', async (req, res) => {
  try {
    const orderId = req.body && req.body.orderId;
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const orderRef = admin.firestore().collection('websiteCreditOrders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      return res.status(404).json({ error: 'Unknown order' });
    }
    const orderData = orderSnap.data();

    // Idempotency guard - same principle as your existing
    // /verify-plan-order: never credit the same order twice.
    if (orderData.status === 'FULFILLED') {
      return res.json({ status: 'PAID' });
    }

    const cfStatus = await fetchCashfreeOrderStatus(orderId);
    if (cfStatus !== 'PAID') {
      return res.json({ status: cfStatus, error: 'Payment not completed.' });
    }

    const creditsRef = admin.firestore()
      .collection('users').doc(orderData.uid)
      .collection('websiteStudio').doc('credits');

    await admin.firestore().runTransaction(async (txn) => {
      const freshOrder = await txn.get(orderRef);
      if (freshOrder.data().status === 'FULFILLED') return; // race guard

      const creditsSnap = await txn.get(creditsRef);
      const current = (creditsSnap.exists && creditsSnap.data().tokensRemaining) || 0;
      txn.set(creditsRef, { tokensRemaining: current + orderData.tokenBudget }, { merge: true });
      txn.update(orderRef, { status: 'FULFILLED', fulfilledAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    return res.json({ status: 'PAID' });
  } catch (err) {
    console.error('POST /verify-website-credit-order failed:', err);
    return res.status(500).json({ error: err.message || 'Verification failed' });
  }
});

module.exports = router;
