'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');

async function getReferralConfig() {
  try {
    const doc = await db.collection('config').doc('referral').get();
    if (!doc.exists) return { pointsPerReferral: 100, pointsPerToken: 50, enabled: true };
    return doc.data();
  } catch (_) {
    return { pointsPerReferral: 100, pointsPerToken: 50, enabled: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /referral/apply
// SECURITY FIX: refereeUid is now ALWAYS req.uid (the authenticated caller
// applying a code to their own account) — the live server trusted whatever
// refereeUid was in the body, letting an attacker who knew other users'
// uids mark them as "referred" and collect real, redeemable points.
// ─────────────────────────────────────────────────────────────────────────
router.post('/referral/apply', requireAuth, async (req, res) => {
  const { code, refereeEmail } = req.body;
  const refereeUid = req.uid;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  try {
    const cfg = await getReferralConfig();
    if (!cfg.enabled) return res.status(400).json({ error: 'Referral system is currently disabled.' });

    const snap = await db.collection('users').where('referralCode', '==', code.trim().toUpperCase()).limit(1).get();
    if (snap.empty) return res.status(400).json({ error: 'Invalid referral code.' });

    const referrerDoc = snap.docs[0];
    const referrerUid = referrerDoc.id;
    if (referrerUid === refereeUid) return res.status(400).json({ error: 'You cannot use your own referral code.' });

    const refereeDoc = await db.collection('users').doc(refereeUid).get();
    if (!refereeDoc.exists) return res.status(400).json({ error: 'Referee not found.' });
    if (refereeDoc.data().referredBy) return res.status(400).json({ error: 'You have already used a referral code.' });

    const pts = cfg.pointsPerReferral || 100;

    await db.collection('referrals').add({
      referrerUid, refereeUid, refereeEmail: refereeEmail || '',
      pointsAwarded: pts, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection('users').doc(referrerUid).update({
      referralPoints: admin.firestore.FieldValue.increment(pts),
      referralCount: admin.firestore.FieldValue.increment(1),
    });
    await db.collection('users').doc(refereeUid).update({ referredBy: code.trim().toUpperCase() });

    try {
      const referrerData = referrerDoc.data();
      const fcmTokens = referrerData.fcmTokens || [];
      const displayEmail = refereeEmail ? refereeEmail.split('@')[0] : 'Someone';

      if (fcmTokens.length > 0) {
        await admin.messaging().sendEachForMulticast({
          tokens: fcmTokens,
          notification: { title: `🎉 You earned ${pts} points!`, body: `${displayEmail} just joined Λstric using your referral code.` },
          data: { type: 'referral_earned', pointsAwarded: String(pts), refereeEmail: refereeEmail || '', click_action: 'FLUTTER_NOTIFICATION_CLICK' },
          android: { priority: 'high', notification: { color: '#C8A96E', sound: 'default' } },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        });
        console.log(`[referral] FCM notification sent to referrer ${referrerUid}`);
      }
    } catch (fcmErr) {
      console.warn('[referral] FCM notification failed:', fcmErr.message);
    }

    console.log(`[referral] ${refereeUid} used code ${code} → referrer ${referrerUid} earned ${pts} pts`);
    return res.status(200).json({ success: true, pointsAwarded: pts });
  } catch (err) {
    console.error('[referral/apply]', err.message);
    return res.status(500).json({ error: 'Server error applying referral.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /referral/redeem
// SECURITY FIX: uid now from req.uid — previously anyone could drain
// another user's referralPoints by naming their uid in the body.
// ─────────────────────────────────────────────────────────────────────────
router.post('/referral/redeem', requireAuth, async (req, res) => {
  const uid = req.uid;
  try {
    const cfg = await getReferralConfig();
    const cost = cfg.pointsPerToken || 50;

    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found.' });

    const currentPoints = userDoc.data().referralPoints || 0;
    if (currentPoints < cost) {
      return res.status(400).json({ error: `Not enough points. You have ${currentPoints}, need ${cost}.` });
    }

    const tokensAdded = 10000;
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(userRef);
      const pts = fresh.data().referralPoints || 0;
      if (pts < cost) throw new Error('Insufficient points');
      tx.update(userRef, {
        referralPoints: admin.firestore.FieldValue.increment(-cost),
        addonTokens: admin.firestore.FieldValue.increment(tokensAdded),
      });
    });

    console.log(`[referral/redeem] ${uid} spent ${cost} pts → ${tokensAdded} tokens`);
    return res.status(200).json({ success: true, tokensAdded });
  } catch (err) {
    console.error('[referral/redeem]', err.message);
    if (err.message === 'Insufficient points') return res.status(400).json({ error: 'Insufficient points.' });
    return res.status(500).json({ error: 'Redemption failed.' });
  }
});

// GET /referral/config — public read, non-sensitive
router.get('/referral/config', async (req, res) => {
  try {
    const cfg = await getReferralConfig();
    return res.status(200).json(cfg);
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch referral config.' });
  }
});

module.exports = router;
