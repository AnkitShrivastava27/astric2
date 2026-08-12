'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAdmin } = require('../middleware/adminAuth');

// ─────────────────────────────────────────────────────────────────────────
// SECURITY FIX: all three routes below were completely unauthenticated on
// the live server — anyone could push an arbitrary title/body notification
// to every user, or to one specific uid (a ready-made phishing vector, e.g.
// "your account was suspended, tap here"). These are operational/admin
// actions, not something the app itself should be able to trigger for
// arbitrary users, so they're now behind requireAdmin.
// ─────────────────────────────────────────────────────────────────────────

router.get('/api/notifications/log', requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('notifications_log').orderBy('sentAt', 'desc').limit(50).get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/broadcast', requireAdmin, async (req, res) => {
  const { title, body, type = 'broadcast', targetPlan, data = {} } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });

  try {
    let query = db.collection('users').where('fcmTokens', '!=', null);
    if (targetPlan && targetPlan !== 'all') query = query.where('plan', '==', targetPlan);

    const snap = await query.get();
    const tokens = [];
    snap.forEach(doc => {
      const t = doc.data().fcmTokens;
      if (Array.isArray(t)) tokens.push(...t);
    });
    if (tokens.length === 0) return res.json({ ok: true, sent: 0 });

    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

    let sent = 0;
    for (const chunk of chunks) {
      const result = await admin.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: { title, body },
        data: { type, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
        android: { priority: 'high', notification: { color: '#C8A96E', sound: 'default' } },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } },
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

router.post('/notifications/send-to-user', requireAdmin, async (req, res) => {
  const { uid, title, body, type = 'system', data = {} } = req.body;
  if (!uid || !title || !body) return res.status(400).json({ error: 'uid, title and body required' });

  try {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return res.status(404).json({ error: 'User not found' });

    const tokens = snap.data().fcmTokens || [];
    if (tokens.length === 0) return res.json({ ok: true, sent: 0 });

    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { type, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
      android: { priority: 'high', notification: { color: '#C8A96E', sound: 'default' } },
      apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    });

    res.json({ ok: true, sent: result.successCount });
  } catch (err) {
    console.error('[notifications/send-to-user]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
