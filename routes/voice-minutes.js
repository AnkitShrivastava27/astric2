// routes/voice-minutes.js
//
// Astric Voice (AI calling) — prepaid MINUTES. Same structure as
// routes/whatsapp-subscription.js (Cashfree create + verify, one shared
// idempotent fulfil function that the PayPal capture route also calls), but
// what gets written on fulfilment is a minutes WALLET instead of an expiry:
//
//   users/{uid}/voice/wallet
//     minutesPurchased  ← ONLY this server ever writes it (FieldValue.increment)
//     minutesUsed       ← ONLY the Python voice backend ever writes it
//     trialClaimed, lastPurchaseAt, lastOrderId
//
//   remaining minutes = minutesPurchased − minutesUsed
//
// Two backends, two separate fields → they can never overwrite each other.
//
// Three plans, all prices/minutes admin-configurable in pricing_config/plans
// (see the whitelist in routes/admin.js):
//
//   trial  voice_trial_price (INR, default 100)  → voice_trial_minutes (default 10)
//          once per account unless voice_trial_once = 0
//   pack   voice_pack_price  (INR, default 2500) → voice_pack_minutes  (default 800)
//   payg   customer chooses an amount ≥ voice_min_recharge (default 1000);
//          minutes = floor(amount ÷ voice_rate_per_min). NO default rate — until
//          the admin sets voice_rate_per_min, pay-as-you-go is simply off.
//
// PayPal has its own USD list: paypal_voice_trial, paypal_voice_pack,
// paypal_voice_rate_per_min (USD per minute), paypal_voice_min_recharge (USD).
// Trial/pack minutes are the same whichever gateway pays.
//
// The server decides minutes from its own config. The client only ever sends
// the plan name and, for payg, the amount — never a minutes figure.
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { admin, db } = require('../config/firebase');
const { CF_ENV, CF_BASE_URL, cfHeaders } = require('../services/cashfree');
const { inrToUsd } = require('../services/pricing');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const ORDERS = 'voiceMinuteOrders';
const PLAN_NAMES = ['trial', 'pack', 'payg'];
const MAX_RECHARGE_INR = 100000;   // sanity ceiling for one pay-as-you-go order
const MAX_RECHARGE_USD = 2000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ─────────────────────────────────────────────────────────────────────────
// Pricing (read fresh on every order, like priceForPlan() in WhatsApp)
// ─────────────────────────────────────────────────────────────────────────
async function getVoicePricing() {
  const snap = await db.collection('pricing_config').doc('plans').get();
  const d = snap.exists ? snap.data() : {};
  // A positive number, else the fallback. 0 / blank / junk = "not set".
  const pos = (v, fb = null) => {
    const x = Number(v);
    return (v !== undefined && v !== null && v !== '' && Number.isFinite(x) && x > 0) ? x : fb;
  };
  // A whole number ≥ 1, else the fallback (a plan can never grant 0 minutes).
  const mins = (v, fb) => { const x = Math.floor(Number(v)); return x >= 1 ? x : fb; };
  return {
    trial: { priceINR: pos(d.voice_trial_price, 100),  minutes: mins(d.voice_trial_minutes, 10) },
    pack:  { priceINR: pos(d.voice_pack_price, 2500),  minutes: mins(d.voice_pack_minutes, 800) },
    trialOnce: (d.voice_trial_once === undefined || d.voice_trial_once === null) ? true : Number(d.voice_trial_once) !== 0,
    payg: {
      rateINR:        pos(d.voice_rate_per_min),            // no default on purpose
      minRechargeINR: pos(d.voice_min_recharge, 1000),
      rateUSD:        pos(d.paypal_voice_rate_per_min),     // no default on purpose
      minRechargeUSD: pos(d.paypal_voice_min_recharge),     // else INR minimum converted
    },
  };
}

// floor(amount ÷ rate), with a tiny epsilon so 0.3 ÷ 0.1 is 3, not 2.
const minutesFor = (amount, rate) => Math.floor(amount / rate + 1e-9);

// Only the account ADMIN buys. Employees resolve to the admin's wallet on the
// voice backend, so an employee purchase here would credit the wrong uid.
async function assertAccountOwner(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (snap.exists && snap.data().role === 'employee') {
    throw httpError(403, 'Only the account admin can buy voice minutes.');
  }
}

async function assertTrialAvailable(uid, cfg) {
  if (!cfg.trialOnce) return;
  const w = await db.collection('users').doc(uid).collection('voice').doc('wallet').get();
  if (w.exists && w.data().trialClaimed === true) {
    throw httpError(409, 'The trial pack has already been used on this account. Please choose another plan.');
  }
}

/**
 * Turns (plan, amount, gateway) into what the customer will pay and get.
 * Throws httpError(4xx) with a message that is safe to show to the user.
 *
 * @returns {{plan, minutes, amountINR: number|null, amountUSD?: number, usdField?: string}}
 *   gateway 'cashfree': amountINR is what is charged.
 *   gateway 'paypal'  : trial/pack → amountINR + usdField (the USD is resolved
 *                       by createPayPalOrder, own USD price else converted);
 *                       payg → amountUSD is the exact USD charged, amountINR null.
 */
async function quoteVoice({ uid, plan, amount, gateway }) {
  if (!PLAN_NAMES.includes(plan)) {
    throw httpError(400, `Unknown plan: ${plan} (expected "trial", "pack" or "payg")`);
  }
  await assertAccountOwner(uid);
  const cfg = await getVoicePricing();

  if (plan === 'trial' || plan === 'pack') {
    if (plan === 'trial') await assertTrialAvailable(uid, cfg);
    const offer = cfg[plan];
    return gateway === 'paypal'
      ? { plan, minutes: offer.minutes, amountINR: offer.priceINR, usdField: `paypal_voice_${plan}` }
      : { plan, minutes: offer.minutes, amountINR: offer.priceINR };
  }

  // ── payg ──────────────────────────────────────────────────────────────
  if (gateway === 'paypal') {
    const rate = cfg.payg.rateUSD;
    if (!rate) throw httpError(400, 'Pay-as-you-go is not available with PayPal right now.');
    const minUSD = cfg.payg.minRechargeUSD || await inrToUsd(cfg.payg.minRechargeINR);
    const usd = Math.round(Number(amount) * 100) / 100;
    if (!Number.isFinite(usd) || usd <= 0) throw httpError(400, 'Enter the amount you want to add.');
    if (usd < minUSD) throw httpError(400, `The minimum recharge is $${minUSD.toFixed(2)}.`);
    if (usd > MAX_RECHARGE_USD) throw httpError(400, `The maximum single recharge is $${MAX_RECHARGE_USD}.`);
    const minutes = minutesFor(usd, rate);
    if (minutes < 1) throw httpError(400, 'That amount is too small to buy a minute.');
    return { plan, minutes, amountINR: null, amountUSD: usd };
  }

  const rate = cfg.payg.rateINR;
  if (!rate) throw httpError(400, 'Pay-as-you-go is not available right now.');
  const inr = Number(amount);
  if (!Number.isInteger(inr)) throw httpError(400, 'Enter a whole number of rupees.');
  if (inr < cfg.payg.minRechargeINR) throw httpError(400, `The minimum recharge is ₹${cfg.payg.minRechargeINR}.`);
  if (inr > MAX_RECHARGE_INR) throw httpError(400, `The maximum single recharge is ₹${MAX_RECHARGE_INR}.`);
  const minutes = minutesFor(inr, rate);
  if (minutes < 1) throw httpError(400, 'That amount is too small to buy a minute.');
  return { plan, minutes, amountINR: inr };
}

// ─────────────────────────────────────────────────────────────────────────
// Shared fulfilment — used by Cashfree verify (below) AND by the PayPal
// capture route (payments.paypal.products.js). Idempotent: an order can
// never credit twice, however many times it is verified/captured.
// ─────────────────────────────────────────────────────────────────────────
async function fulfilVoiceOrder(orderRef, extraOrderFields = {}) {
  return db.runTransaction(async (tx) => {
    const freshOrder = await tx.get(orderRef);
    if (!freshOrder.exists || freshOrder.data().status === 'paid') return false; // race guard
    const o = freshOrder.data();

    const minutes = Number(o.minutes);
    if (!Number.isInteger(minutes) || minutes < 1) {
      throw new Error(`Order ${o.orderId} has no valid minutes to credit.`);
    }

    const walletRef = db.collection('users').doc(o.uid).collection('voice').doc('wallet');
    const walletSnap = await tx.get(walletRef);   // all reads before any write
    // Two trial orders both paid before either was fulfilled: the customer
    // has paid, so credit both — but flag it so it is visible in Firestore.
    const duplicateTrial = o.plan === 'trial' && walletSnap.exists && walletSnap.data().trialClaimed === true;

    tx.set(walletRef, {
      minutesPurchased: admin.firestore.FieldValue.increment(minutes),
      lastPurchaseAt: admin.firestore.FieldValue.serverTimestamp(),
      lastOrderId: o.orderId,
      ...(o.plan === 'trial' ? { trialClaimed: true } : {}),
    }, { merge: true });

    tx.update(orderRef, {
      status: 'paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      minutesCredited: minutes,
      ...(duplicateTrial ? { duplicateTrial: true } : {}),
      ...extraOrderFields,
    });
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// POST /create-voice-order   { plan, amount?, userEmail, userName?, userPhone? }
//   amount (whole rupees) is only read for plan "payg".
// ─────────────────────────────────────────────────────────────────────────
router.post('/create-voice-order', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `create-voice-order:${r.uid}` }), async (req, res) => {
  try {
    const uid = req.uid; // verified by requireAuth — never trust req.body.uid
    const { plan, amount, userEmail, userName, userPhone } = req.body || {};
    if (!userEmail) return res.status(400).json({ error: 'userEmail is required.' });

    const quote = await quoteVoice({ uid, plan, amount, gateway: 'cashfree' });
    const orderId = `VOX_${uid.substring(0, 6)}_${uuidv4().replace(/-/g, '').substring(0, 10)}`.toUpperCase();

    const cfPayload = {
      order_id: orderId,
      order_amount: quote.amountINR,
      order_currency: 'INR',
      customer_details: {
        customer_id: uid,
        customer_email: userEmail,
        customer_name: userName || 'Customer',
        customer_phone: userPhone || '9999999999',
      },
      order_note: `Astric Voice - ${plan} (${quote.minutes} min) — ${CF_ENV}`,
    };

    const cfRes = await axios.post(`${CF_BASE_URL}/orders`, cfPayload, { headers: cfHeaders() });
    const paymentSessionId = cfRes.data?.payment_session_id;
    if (!paymentSessionId) {
      console.error('Cashfree did not return payment_session_id:', cfRes.data);
      return res.status(500).json({ error: 'Cashfree did not return a payment session.' });
    }

    // Record what this order is FOR, so verify credits the right minutes
    // without trusting anything the client sends back (it only sends orderId).
    await db.collection(ORDERS).doc(orderId).set({
      orderId, uid, plan, minutes: quote.minutes, amountINR: quote.amountINR,
      gateway: 'cashfree', status: 'pending', environment: CF_ENV,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ orderId, paymentSessionId, amountINR: quote.amountINR, minutes: quote.minutes, environment: CF_ENV });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    const msg = err?.response?.data?.message || err.message || 'Order creation failed.';
    console.error('create-voice-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /verify-voice-order   { orderId }
// Same uid-ownership + idempotent-transaction pattern as /verify-whatsapp-order.
// ─────────────────────────────────────────────────────────────────────────
router.post('/verify-voice-order', requireAuth, async (req, res) => {
  try {
    const orderId = req.body && req.body.orderId;
    const uid = req.uid;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });

    const orderRef = db.collection(ORDERS).doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Unknown order' });
    const orderData = orderSnap.data();

    if (orderData.uid !== uid) {
      console.warn(`verify-voice-order: uid mismatch. order.uid=${orderData.uid} req.uid=${uid} orderId=${orderId}`);
      return res.status(403).json({ error: 'This order does not belong to the requesting user.' });
    }
    if (orderData.gateway !== 'cashfree') return res.status(400).json({ error: 'Not a Cashfree order.' });

    // Idempotency guard — never credit the same order twice.
    if (orderData.status === 'paid') return res.status(200).json({ status: 'PAID', minutes: orderData.minutes });

    const cfRes = await axios.get(`${CF_BASE_URL}/orders/${orderId}`, { headers: cfHeaders() });
    const orderStatus = cfRes.data?.order_status;
    if (orderStatus !== 'PAID') {
      return res.status(400).json({ status: orderStatus, error: `Payment not complete. Cashfree status: ${orderStatus}` });
    }
    // Belt and braces: what Cashfree says was charged must equal what we
    // priced this order at. Never credit minutes against a different amount.
    const charged = Number(cfRes.data?.order_amount);
    if (!Number.isFinite(charged) || Math.abs(charged - Number(orderData.amountINR)) > 0.01) {
      console.error(`verify-voice-order: amount mismatch order=${orderId} cashfree=${charged} stored=${orderData.amountINR}`);
      return res.status(400).json({ error: 'Paid amount does not match this order. Please contact support.' });
    }

    await fulfilVoiceOrder(orderRef, { cfOrderStatus: orderStatus });
    console.log(`Astric Voice minutes credited: uid=${orderData.uid} plan=${orderData.plan} minutes=${orderData.minutes} orderId=${orderId}`);
    return res.status(200).json({ status: 'PAID', minutes: orderData.minutes });
  } catch (err) {
    const msg = err?.response?.data?.message || err.message || 'Verification failed.';
    console.error('verify-voice-order error:', err?.response?.data || err.message);
    return res.status(500).json({ error: msg });
  }
});

router.ORDERS = ORDERS;
router.PLAN_NAMES = PLAN_NAMES;
router.getVoicePricing = getVoicePricing;
router.quoteVoice = quoteVoice;
router.fulfilVoiceOrder = fulfilVoiceOrder;
module.exports = router;
