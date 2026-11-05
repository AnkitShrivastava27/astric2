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
    standard_quarterly: 2490,
    standard_annual: 664,
    premium_monthly: 1660,
    premium_quarterly: 4980,
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

// Subscription end date for a purchase made at [now]: 1, 3 or 12 months for monthly, quarterly or annual.
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };
function planExpiry(now, cycle) {
  return new Date(now.getFullYear(), now.getMonth() + (CYCLE_MONTHS[cycle] || 1), now.getDate());
}

async function getTokenPackPrice() {
  const snap = await db.collection('pricing_config').doc('plans').get();
  return snap.exists ? Number(snap.data().token_pack_price ?? 10) : 10;
}

// ── PayPal (USD) pricing ────────────────────────────────────────────────────
// PayPal has its OWN price list, set in the admin panel, stored in the same
// pricing_config/plans doc as USD fields (all optional):
//   paypal_standard_monthly / _quarterly / _annual, paypal_premium_monthly / _quarterly / _annual
//   paypal_token_pack_price  (USD per pack)
//   paypal_token_pack_size   (tokens per pack, e.g. $5 -> 500 tokens)
//   paypal_website_trial|standard|pro, paypal_app_trial|standard|pro
//   paypal_whatsapp_monthly / _annual
// If a field is NOT set we fall back to the old INR->USD conversion so
// nothing breaks before the admin fills the new fields in.
async function getPlansDoc() {
  const snap = await db.collection('pricing_config').doc('plans').get();
  return snap.exists ? snap.data() : {};
}

// Returns a USD amount (2dp) for a paypal_* field, or converts [inrFallback].
async function getPaypalUsd(field, inrFallback) {
  const data = await getPlansDoc();
  const v = data[field];
  if (v !== undefined && v !== null && !isNaN(Number(v)) && Number(v) > 0) {
    return { usd: Math.round(Number(v) * 100) / 100, custom: true };
  }
  return { usd: await inrToUsd(inrFallback), custom: false };
}

// USD token pack: { priceUSD, tokensPerPack, custom }. Falls back to the
// INR pack price converted, with the standard 10,000-token pack.
async function getPaypalTokenPack() {
  const data = await getPlansDoc();
  const price = Number(data.paypal_token_pack_price);
  const size  = parseInt(data.paypal_token_pack_size, 10);
  if (price > 0 && size > 0) return { priceUSD: Math.round(price * 100) / 100, tokensPerPack: size, custom: true };
  const inr = Number(data.token_pack_price ?? 10);
  return { priceUSD: await inrToUsd(inr), tokensPerPack: 10000, custom: false };
}

// ── Image top-up packs (Image Studio) ───────────────────────────────────────
// Admin sets, in pricing_config/plans (via POST /update-pricing):
//   image_pack_price (INR per pack)  +  image_pack_size (images per pack).
// e.g. image_pack_price=50, image_pack_size=10  ->  "Rs 50 for 10 images".
async function getImagePack() {
  const data = await getPlansDoc();
  const price = Number(data.image_pack_price);
  const size  = parseInt(data.image_pack_size, 10);
  return {
    price: price > 0 ? price : 50,
    size:  size  > 0 ? size  : 10,
    configured: price > 0 && size > 0,
  };
}

// USD image pack for PayPal: { priceUSD, imagesPerPack, custom }. Admin sets
// paypal_image_pack_price (USD) + paypal_image_pack_size; otherwise the INR pack is converted.
async function getPaypalImagePack() {
  const data = await getPlansDoc();
  const price = Number(data.paypal_image_pack_price);
  const size  = parseInt(data.paypal_image_pack_size, 10);
  if (price > 0 && size > 0) return { priceUSD: Math.round(price * 100) / 100, imagesPerPack: size, custom: true };
  const inr = await getImagePack();
  return { priceUSD: await inrToUsd(inr.price), imagesPerPack: inr.size, custom: false };
}

module.exports = { getPaypalImagePack, getImagePack, inrToUsd, getCanonicalPrice, getTokenPackPrice, getPaypalUsd, getPaypalTokenPack, planExpiry };
