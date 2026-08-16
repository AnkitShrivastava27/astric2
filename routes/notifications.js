'use strict';

const express = require('express');
const router = express.Router();

const { admin, db } = require('../config/firebase');
const { requireAdmin } = require('../middleware/adminAuth');

/*
|--------------------------------------------------------------------------
| GET /api/notifications/log
|--------------------------------------------------------------------------
| Returns the latest 50 notification broadcasts.
|
| Protected by requireAdmin because notification history is an
| admin-panel operation.
|--------------------------------------------------------------------------
*/
router.get('/log', requireAdmin, async (req, res) => {
  try {
    const snap = await db
      .collection('notifications_log')
      .orderBy('sentAt', 'desc')
      .limit(50)
      .get();

    const logs = snap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ logs });
  } catch (err) {
    console.error(
      '[notifications/log]',
      err.message
    );

    return res.status(500).json({
      error: 'Failed to load notification history.',
    });
  }
});


/*
|--------------------------------------------------------------------------
| POST /api/notifications/broadcast
|--------------------------------------------------------------------------
| Sends a push notification to users based on their plan.
|
| Protected by requireAdmin.
|--------------------------------------------------------------------------
*/
router.post('/broadcast', requireAdmin, async (req, res) => {
  const {
    title,
    body,
    type = 'broadcast',
    targetPlan,
    data = {},
  } = req.body;

  if (!title || !body) {
    return res.status(400).json({
      error: 'title and body required',
    });
  }

  try {
    let query = db
      .collection('users')
      .where('fcmTokens', '!=', null);

    if (
      targetPlan &&
      targetPlan !== 'all'
    ) {
      query = query.where(
        'plan',
        '==',
        targetPlan
      );
    }

    const snap = await query.get();

    const tokens = [];

    snap.forEach((doc) => {
      const userData = doc.data();
      const fcmTokens = userData.fcmTokens;

      if (Array.isArray(fcmTokens)) {
        tokens.push(...fcmTokens);
      }
    });

    /*
    |--------------------------------------------------------------------------
    | No devices found
    |--------------------------------------------------------------------------
    */
    if (tokens.length === 0) {
      return res.json({
        ok: true,
        sent: 0,
        total: 0,
      });
    }

    /*
    |--------------------------------------------------------------------------
    | FCM supports maximum 500 tokens per multicast request.
    |--------------------------------------------------------------------------
    */
    const chunks = [];

    for (
      let i = 0;
      i < tokens.length;
      i += 500
    ) {
      chunks.push(
        tokens.slice(i, i + 500)
      );
    }

    let sent = 0;

    for (const chunk of chunks) {
      const result =
        await admin.messaging().sendEachForMulticast({
          tokens: chunk,

          notification: {
            title,
            body,
          },

          data: {
            type,

            ...Object.fromEntries(
              Object.entries(data).map(
                ([key, value]) => [
                  key,
                  String(value),
                ]
              )
            ),
          },

          android: {
            priority: 'high',

            notification: {
              color: '#C8A96E',
              sound: 'default',
            },
          },

          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
        });

      sent += result.successCount;
    }

    /*
    |--------------------------------------------------------------------------
    | Save broadcast history
    |--------------------------------------------------------------------------
    */
    await db
      .collection('notifications_log')
      .add({
        title,
        body,
        type,
        targetPlan: targetPlan || 'all',
        totalSent: sent,
        totalTokens: tokens.length,
        sentAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(
      `[notifications] Broadcast sent to ${sent} devices`
    );

    return res.json({
      ok: true,
      sent,
      total: tokens.length,
    });

  } catch (err) {
    console.error(
      '[notifications/broadcast]',
      err.message
    );

    return res.status(500).json({
      error: err.message,
    });
  }
});


/*
|--------------------------------------------------------------------------
| POST /api/notifications/send-to-user
|--------------------------------------------------------------------------
| Sends a notification to one user.
|--------------------------------------------------------------------------
*/
router.post(
  '/send-to-user',
  requireAdmin,
  async (req, res) => {
    const {
      uid,
      title,
      body,
      type = 'system',
      data = {},
    } = req.body;

    if (!uid || !title || !body) {
      return res.status(400).json({
        error:
          'uid, title and body required',
      });
    }

    try {
      const snap = await db
        .collection('users')
        .doc(uid)
        .get();

      if (!snap.exists) {
        return res.status(404).json({
          error: 'User not found',
        });
      }

      const tokens =
        snap.data().fcmTokens || [];

      if (tokens.length === 0) {
        return res.json({
          ok: true,
          sent: 0,
        });
      }

      const result =
        await admin.messaging().sendEachForMulticast({
          tokens,

          notification: {
            title,
            body,
          },

          data: {
            type,

            ...Object.fromEntries(
              Object.entries(data).map(
                ([key, value]) => [
                  key,
                  String(value),
                ]
              )
            ),
          },

          android: {
            priority: 'high',

            notification: {
              color: '#C8A96E',
              sound: 'default',
            },
          },

          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
        });

      return res.json({
        ok: true,
        sent: result.successCount,
      });

    } catch (err) {
      console.error(
        '[notifications/send-to-user]',
        err.message
      );

      return res.status(500).json({
        error: err.message,
      });
    }
  }
);


module.exports = router;