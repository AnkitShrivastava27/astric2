'use strict';

const { db } = require('../config/firebase');
const { FALLBACK_USD_INR_RATE } = require('../config/env');

async function inrToUsd(inrAmount) {
  const snap = await db.collection('pricing_config').doc('plans').get();
  const rate = snap.exists
    ? Number(snap.data().usd_inr_rate ?? FALLBACK_USD_INR_RATE)
    : FALLBACK_USD_INR_RATE;
  return Math.round((inrAmount / rate) * 100) / 100;
}

async function getCanonicalPrice(planType, cycle) {
  const snap = await db.collection('pricing_config').doc('plans').get();
  const defaults = {
    standard_monthly: 830,
    standard_annual: 664,
    premium_monthly: 1660,
    premium_annual: 1245,
    token_pack_price: 10,
  };
  if (!snap.exists) return defaults[`${planType}_${cycle}`] ?? null;
  const data = snap.data();
  const key = `${planType}_${cycle}`;
  const price = data[key];
  if (price === undefined || price === null) return defaults[key] ?? null;
  return Number(price);
}

async function getTokenPackPrice() {
  const snap = await db.collection('pricing_config').doc('plans').get();
  return snap.exists ? Number(snap.data().token_pack_price ?? 10) : 10;
}

module.exports = { inrToUsd, getCanonicalPrice, getTokenPackPrice };
