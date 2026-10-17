'use strict';

const { db } = require('../config/firebase');
const {
  DEEPSEEK_API_KEY, GROK_API_KEY, OPENAI_API_KEY, DEFAULT_AI_LIMITS,
} = require('../config/env');

const AI_CHAT_PROVIDERS = {
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', key: DEEPSEEK_API_KEY, defaultModel: 'deepseek-chat' },
  grok: { url: 'https://api.x.ai/v1/chat/completions', key: GROK_API_KEY, defaultModel: 'grok-4' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', key: OPENAI_API_KEY, defaultModel: 'gpt-4o' },
};
const GROK_IMAGE_URL = 'https://api.x.ai/v1/images/generations';

// 🐞 FIX (AI token limit "not refreshing" / resetting itself):
// This used to return an UNPADDED month ("2026-9") while the Flutter client
// (AiLimitsNotifier._thisMonth) used a PADDED one ("2026-09"). For Jan–Sep
// the two never matched, so every time the app opened it saw a "new month",
// reset tokensUsedThisMonth to 0 in Firestore, and the server then saw a
// different key again and reset too — the counter was being zeroed by the
// two sides fighting each other. Both now use zero-padded "YYYY-MM", and
// any legacy unpadded value already stored is normalised before comparing.
function currentMonthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function normalizeMonthKey(key) {
  if (typeof key !== 'string') return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(key);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}` : key;
}

async function getAiLimitsConfig() {
  const snap = await db.collection('ai_limits').doc('config').get();
  return snap.exists ? { ...DEFAULT_AI_LIMITS, ...snap.data() } : { ...DEFAULT_AI_LIMITS };
}

async function getImageLimitsConfig() {
  const snap = await db.collection('config').doc('ai_limits').get();
  const defaults = { basic_images: 0, standard_images: 20, premium_images: 100 };
  return snap.exists ? { ...defaults, ...snap.data() } : defaults;
}

// -----------------------------------------------------------------------------
// Quota helpers shared by /ai/chat, /ai/agent and /ai/image.
//
// The SERVER is the single source of truth for usage. The Flutter client only
// reads users/{orgOwner}/ai/usage — it no longer writes token counts (it used
// to, which double-counted every message and overwrote the server's number
// with a stale local copy).
// -----------------------------------------------------------------------------

// The plan an organisation is on RIGHT NOW, from users/{owner}.subscription.
// An inactive or expired paid plan counts as Basic (this is what the Flutter app already does).
// Also returns the admin panel's per-company overrides ("special plan"):
//   subscription.customLimits.aiTokens / .images  -> that company's own monthly limits.
// Overrides stop applying once the plan has expired.
function effectiveSubscription(sub) {
  const s = sub || {};
  const stored = ['basic', 'standard', 'premium'].includes(s.plan) ? s.plan : 'basic';
  const exp = s.expiresAt && typeof s.expiresAt.toDate === 'function' ? s.expiresAt.toDate() : null;
  const expired = stored !== 'basic' && (s.active !== true || (exp && exp.getTime() <= Date.now()));
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Math.max(0, Math.floor(Number(v))));
  return {
    plan: expired ? 'basic' : stored,
    cycle: s.cycle === 'annual' ? 'annual' : 'monthly',
    expired: !!expired,
    custom: expired ? { aiTokens: null, images: null } : { aiTokens: num(s.customLimits?.aiTokens), images: num(s.customLimits?.images) },
  };
}

// Annual plans get a small bonus — mirrors AiLimitsNotifier.monthlyTokenAllocation.
// `customAiTokens` (admin-set per-company limit) wins over the plan table when present.
function planTokenLimit(plan, cycle, limits, customAiTokens = null) {
  if (customAiTokens !== null && customAiTokens !== undefined) return customAiTokens;
  const base = {
    basic: limits.basic_tokens_limit,
    standard: limits.standard_tokens_limit,
    premium: limits.premium_tokens_limit,
  }[plan] ?? limits.basic_tokens_limit;
  if (cycle === 'annual' && plan === 'standard') return Math.floor(base * 1.1);
  if (cycle === 'annual' && plan === 'premium') return Math.floor(base * 1.05);
  return Number(base) || 0;
}

// Rough prompt-size estimate (~4 chars/token) used only to decide how much
// completion budget to allow BEFORE the real usage numbers come back.
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part?.type === 'text') chars += (part.text || '').length;
        else if (part?.type === 'image_url') chars += 3000; // ~750 tokens per image
      }
    }
  }
  return Math.ceil(chars / 4) + 8 * (messages?.length || 0);
}

/**
 * Atomically checks the quota and RESERVES `reserve` tokens so two parallel
 * requests can't both slip under the limit (the old code checked outside the
 * transaction, then wrote afterwards).
 *
 * Returns { ok:false } when exhausted, otherwise { ok:true, remaining } where
 * `remaining` is what was available *before* the reservation.
 */
async function reserveTokens({ orgOwnerUid, plan, cycle, reserve, minimum = 1 }) {
  const { db, admin } = require('../config/firebase');
  const limits = await getAiLimitsConfig();
  const userRef = db.collection('users').doc(orgOwnerUid);
  const usageRef = userRef.collection('ai').doc('usage');
  const curMonth = currentMonthKey();

  return db.runTransaction(async (tx) => {
    const [userSnap, usageSnap] = await Promise.all([tx.get(userRef), tx.get(usageRef)]);
    // Limit from the owner's CURRENT subscription (expiry + admin overrides), not the caller's copy.
    const eff = effectiveSubscription(userSnap.data()?.subscription);
    const planLimit = planTokenLimit(eff.plan, eff.cycle, limits, eff.custom.aiTokens);
    const usage = usageSnap.exists ? usageSnap.data() : {};
    const addon = Number(userSnap.data()?.addonTokens || 0);
    const used = normalizeMonthKey(usage.lastResetMonth) === curMonth
      ? Number(usage.tokensUsedThisMonth || 0) : 0;

    const monthlyLeft = Math.max(0, planLimit - used);
    const remaining = monthlyLeft + addon;
    if (remaining < minimum) return { ok: false, remaining, planLimit };

    // Reserve: monthly allowance first, then add-on packs.
    const take = Math.min(reserve, remaining);
    const fromMonthly = Math.min(take, monthlyLeft);
    const fromAddon = take - fromMonthly;

    const rolled = normalizeMonthKey(usage.lastResetMonth) !== curMonth;
    tx.set(usageRef, {
      tokensUsedThisMonth: used + fromMonthly,
      lastResetMonth: curMonth,
      ...(rolled ? { imageGensThisMonth: 0 } : {}),   // stamping the new month must roll the image counter too
      addonTokensLeft: Math.max(0, addon - fromAddon),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (fromAddon > 0) tx.update(userRef, { addonTokens: Math.max(0, addon - fromAddon) });

    return { ok: true, remaining, planLimit, reserved: take, fromMonthly, fromAddon };
  });
}

/**
 * Replaces the reservation with the REAL token count once the model has
 * answered (or refunds it all when the upstream call failed: actual = 0).
 * Never lets a bookkeeping error bubble up into the user's response.
 */
async function settleTokens({ orgOwnerUid, plan, cycle, reservation, actual }) {
  if (!reservation?.ok) return;
  const { db, admin } = require('../config/firebase');
  const diff = actual - reservation.reserved; // >0 = owe more, <0 = refund
  if (diff === 0) return;
  const limits = await getAiLimitsConfig();
  const userRef = db.collection('users').doc(orgOwnerUid);
  const usageRef = userRef.collection('ai').doc('usage');
  const curMonth = currentMonthKey();
  try {
    await db.runTransaction(async (tx) => {
      const [userSnap, usageSnap] = await Promise.all([tx.get(userRef), tx.get(usageRef)]);
      const eff = effectiveSubscription(userSnap.data()?.subscription);
      const planLimit = planTokenLimit(eff.plan, eff.cycle, limits, eff.custom.aiTokens);
      const usage = usageSnap.exists ? usageSnap.data() : {};
      let used = normalizeMonthKey(usage.lastResetMonth) === curMonth
        ? Number(usage.tokensUsedThisMonth || 0) : 0;
      let addon = Number(userSnap.data()?.addonTokens || 0);

      if (diff > 0) {
        // Charge the overshoot: monthly allowance first, then add-ons.
        const monthlyLeft = Math.max(0, planLimit - used);
        const fromMonthly = Math.min(diff, monthlyLeft);
        used += fromMonthly;
        addon = Math.max(0, addon - (diff - fromMonthly));
      } else {
        // Refund: put it back where it came from (add-on first if it was
        // taken from there, otherwise the monthly counter).
        let refund = -diff;
        const backToAddon = Math.min(refund, reservation.fromAddon || 0);
        addon += backToAddon;
        refund -= backToAddon;
        used = Math.max(0, used - refund);
      }

      const rolled = normalizeMonthKey(usage.lastResetMonth) !== curMonth;
      tx.set(usageRef, {
        tokensUsedThisMonth: used,
        lastResetMonth: curMonth,
        ...(rolled ? { imageGensThisMonth: 0 } : {}),
        addonTokensLeft: addon,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (addon !== Number(userSnap.data()?.addonTokens || 0)) tx.update(userRef, { addonTokens: addon });
    });
  } catch (err) {
    console.error('settleTokens failed:', err.message);
  }
}

// 🐞 FIX: /ai/chat used to read the plan + usage from the CALLER's own user
// doc. Employees have no subscription of their own (they use their org
// owner's), so every employee was treated as "basic" with a separate,
// empty usage counter — while the Flutter client showed the owner's pool.
// Plan, cycle, add-on tokens and usage all belong to the org owner.
async function resolveOrgBilling(uid) {
  const { db } = require('../config/firebase');
  const userSnap = await db.collection('users').doc(uid).get();
  if (!userSnap.exists) return null;
  const u = userSnap.data();
  // Employees created by routes/employees.js are marked role:'employee' (older ones isEmployee:true).
  const orgOwnerUid = ((u.isEmployee || u.role === 'employee') && u.adminId) ? u.adminId : uid;
  const ownerSnap = orgOwnerUid === uid ? userSnap : await db.collection('users').doc(orgOwnerUid).get();
  if (!ownerSnap.exists) return null;
  const eff = effectiveSubscription(ownerSnap.data().subscription);
  return { uid, orgOwnerUid, plan: eff.plan, cycle: eff.cycle, customLimits: eff.custom };
}

// Plan gating written by the admin panel (appConfig/planGating). Used so the
// server enforces the SAME rules the app shows, instead of a hard-coded copy.
const PLAN_ORDER = ['basic', 'standard', 'premium'];
// Only a FALLBACK for when the admin panel hasn't saved a value for the feature yet (mirrors the app's defaults).
const DEFAULT_SCREEN_ACCESS = { image_studio: 'standard', ai_chat: 'standard', website_studio: 'standard', app_studio: 'standard', team_chat: 'standard' };

async function canAccessFeature(featureKey, plan) {
  const { db } = require('../config/firebase');
  let required = DEFAULT_SCREEN_ACCESS[featureKey] || 'basic';
  try {
    const snap = await db.collection('appConfig').doc('planGating').get();
    const v = snap.exists ? snap.data()?.screenAccess?.[featureKey] : null;
    if (typeof v === 'string' && PLAN_ORDER.includes(v)) required = v;
  } catch (_) { /* fall back to the defaults above */ }
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(required);
}

module.exports = {
  AI_CHAT_PROVIDERS, GROK_API_KEY, OPENAI_API_KEY, GROK_IMAGE_URL,
  currentMonthKey, normalizeMonthKey, getAiLimitsConfig, getImageLimitsConfig,
  planTokenLimit, effectiveSubscription, estimateTokens, reserveTokens, settleTokens, canAccessFeature, resolveOrgBilling,
};
