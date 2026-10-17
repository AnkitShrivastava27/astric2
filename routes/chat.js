// routes/chat.js
//
//   POST /chat/notify   { roomId }   -> push notification to the OTHER members of a chat room.
//
// Why a server route: there are no Cloud Functions here, so nothing reacts to a Firestore write on its
// own. The app calls this right after it saves a message. The server does NOT trust the client for
// anything that matters: it checks the caller really is a member of the room, takes the message preview
// from the room document itself (what the caller just wrote), applies the same plan gating as the Team
// Chat screen, and skips people who switched "Team Messages" off in their notification settings.
'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { canAccessFeature, resolveOrgBilling } = require('../services/ai');

const BAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

router.post('/chat/notify',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 120, keyFn: r => `chat-notify:${r.uid}` }),
  async (req, res) => {
    try {
      const senderId = req.uid;
      const roomId = String((req.body || {}).roomId || '');
      if (!roomId || roomId.includes('/')) return res.status(400).json({ error: 'roomId is required.' });

      // Same organisation + plan the Team Chat screen is gated by.
      const billing = await resolveOrgBilling(senderId);
      if (!billing) return res.status(404).json({ error: 'User not found.' });
      if (!(await canAccessFeature('team_chat', billing.plan))) return res.json({ ok: true, sent: 0, reason: 'plan' });

      const roomRef = db.collection('users').doc(billing.orgOwnerUid).collection('chat_rooms').doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists) return res.status(404).json({ error: 'Room not found.' });
      const room = roomSnap.data();
      const members = Array.isArray(room.memberIds) ? room.memberIds : [];
      if (!members.includes(senderId)) return res.status(403).json({ error: 'Not a member of this room.' });
      if (room.lastSenderId !== senderId || !room.lastMessage) return res.json({ ok: true, sent: 0, reason: 'no_message' });

      const senderSnap = await db.collection('users').doc(senderId).get();
      const senderName = (senderSnap.exists && senderSnap.data().name) || 'Someone';
      const isGroup = room.type !== 'direct';
      const title = isGroup ? (room.name || 'Team chat') : senderName;
      const body = isGroup ? `${senderName}: ${room.lastMessage}` : room.lastMessage;

      const recipients = members.filter((m) => m && m !== senderId);
      const docs = await Promise.all(recipients.map((id) => db.collection('users').doc(id).get()));
      const tokens = []; const owners = [];
      docs.forEach((d, i) => {
        if (!d.exists) return;                                  // deleted employee
        const u = d.data();
        if (u.notifyChat === false || u.pushNotifications === false) return;  // switched off in Profile → Notifications
        (Array.isArray(u.fcmTokens) ? u.fcmTokens : []).forEach((t) => { tokens.push(t); owners.push(recipients[i]); });
      });
      if (!tokens.length) return res.json({ ok: true, sent: 0 });

      let sent = 0;
      const dead = new Map();
      for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        const result = await admin.messaging().sendEachForMulticast({
          tokens: chunk,
          notification: { title, body },
          data: { type: 'chat', roomId, roomName: String(room.name || ''), isGroup: String(isGroup), orgId: billing.orgOwnerUid },
          android: { priority: 'high', notification: { channelId: 'astric_main', color: '#C8A96E', sound: 'default', tag: roomId } },
          apns: { headers: { 'apns-collapse-id': roomId.slice(0, 64) }, payload: { aps: { sound: 'default', 'thread-id': roomId } } },
        });
        sent += result.successCount;
        result.responses.forEach((r, j) => {
          if (!r.success && BAD_TOKEN.has(r.error && r.error.code)) {
            const owner = owners[i + j];
            dead.set(owner, [...(dead.get(owner) || []), chunk[j]]);
          }
        });
      }
      // Drop tokens FCM says no longer exist, so they stop being tried.
      await Promise.allSettled([...dead].map(([uid, ts]) =>
        db.collection('users').doc(uid).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...ts) })));

      return res.json({ ok: true, sent });
    } catch (err) {
      console.error('[chat/notify]', err.message);
      return res.status(500).json({ error: 'Could not send notification.' });
    }
  });

module.exports = router;
