'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { admin, db } = require('../config/firebase');
const { META_VERIFY_TOKEN, META_APP_SECRET } = require('../config/env');

// ── Webhook handshake (GET) ──────────────────────────────────────────────
function metaVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[webhook] Meta verification success');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

// ── Signature verification (POST) ────────────────────────────────────────
// SECURITY FIX: the live server never checked this, despite META_APP_SECRET
// existing specifically for it. Without this check, anyone who learns a
// connected phoneNumberId/igAccountId/pageId can POST forged messages
// straight into that user's conversation inbox. Meta signs every webhook
// POST body with HMAC-SHA256 using your app secret — this recomputes that
// signature over the raw request body and rejects anything that doesn't
// match.
function verifyMetaSignature(req, res, next) {
  if (!META_APP_SECRET) {
    console.warn('[meta] META_APP_SECRET not configured — webhook signature check skipped. Set it in Render env.');
    return next();
  }
  const signature = req.headers['x-hub-signature-256'] || '';
  const expected = 'sha256=' + crypto
    .createHmac('sha256', META_APP_SECRET)
    .update(req.rawBody || Buffer.from(''))
    .digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[meta] Webhook signature mismatch — rejecting.');
    return res.sendStatus(403);
  }
  next();
}

// ── Firestore helpers ─────────────────────────────────────────────────────
async function saveIncomingMessage({ uid, channel, contactId, contactName, text, mediaUrl }) {
  const now = new Date().toISOString();
  const convoId = `${channel}_${contactId}`;
  const convoRef = db.collection('users').doc(uid).collection('conversations').doc(convoId);
  const msgRef = convoRef.collection('messages').doc();
  const batch = db.batch();

  batch.set(convoRef, {
    channel, contactId, contactName: contactName || contactId,
    lastMessage: text || '📎 Media', lastMessageAt: now, isResolved: false,
  }, { merge: true });
  batch.set(convoRef, { unreadCount: admin.firestore.FieldValue.increment(1) }, { merge: true });
  batch.set(msgRef, {
    conversationId: convoId, text: text || '', mediaUrl: mediaUrl || null,
    isOutbound: false, sentAt: now, isRead: false, channel, status: 'received',
  });

  await batch.commit();
  console.log(`[messaging] Saved incoming ${channel} msg from ${contactId} → uid ${uid}`);
}

async function findUidForChannel(channelType, channelAccountId) {
  try {
    const snap = await db.collection('appConfig').doc('channelIndex').get();
    if (!snap.exists) return null;
    return snap.data()[`${channelType}_${channelAccountId}`] || null;
  } catch (_) {
    return null;
  }
}

async function getChannelCreds(uid, channelType) {
  try {
    const snap = await db.collection('users').doc(uid)
      .collection('connectedChannels').doc(channelType).get();
    return snap.exists ? snap.data().credentials : null;
  } catch (_) {
    return null;
  }
}

async function updateMessageStatus(uid, convoId, msgId, status) {
  try {
    await db.collection('users').doc(uid)
      .collection('conversations').doc(convoId)
      .collection('messages').doc(msgId)
      .update({ status });
  } catch (_) { /* non-fatal */ }
}

// ── Senders ────────────────────────────────────────────────────────────
async function sendWhatsApp({ accessToken, phoneNumberId, to, text }) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function sendInstagram({ accessToken, igAccountId, to, text }) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/messages`,
    { recipient: { id: to }, message: { text } },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function sendMessenger({ accessToken, to, text }) {
  const res = await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    { recipient: { id: to }, message: { text } },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

module.exports = {
  metaVerify, verifyMetaSignature, saveIncomingMessage,
  findUidForChannel, getChannelCreds, updateMessageStatus,
  sendWhatsApp, sendInstagram, sendMessenger,
};
