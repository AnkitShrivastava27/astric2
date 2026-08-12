'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const {
  metaVerify, verifyMetaSignature, saveIncomingMessage,
  findUidForChannel, getChannelCreds, updateMessageStatus,
  sendWhatsApp, sendInstagram, sendMessenger,
} = require('../services/meta');
const { getTelegramBotUsername, sendTelegram } = require('../services/telegram');

// ─────────────────────────────────────────────────────────────────────────
// POST /messaging/send
// SECURITY FIX: uid now comes from the verified Firebase token (req.uid),
// not the request body — previously anyone could dispatch a message
// through ANY connected user's WhatsApp/Instagram/Messenger/Telegram
// credentials just by naming their uid.
// ─────────────────────────────────────────────────────────────────────────
router.post('/messaging/send', requireAuth, async (req, res) => {
  const uid = req.uid;
  const { conversationId, messageId, channel, contactId, text } = req.body;

  // CORRECTNESS FIX: these three early-return error paths (missing fields,
  // no credentials, unknown channel) previously never touched the
  // message's status — only the catch block below did. A message that
  // failed for one of these reasons stayed 'pending' in Firestore forever
  // (the client shows that as "sending…" indefinitely). All error exits
  // now mark it 'failed' too, whenever a messageId was given.
  const failMessage = async () => {
    if (messageId && conversationId) {
      try { await updateMessageStatus(uid, conversationId, messageId, 'failed'); } catch (_) {}
    }
  };

  if (!conversationId || !channel || !contactId || !text) {
    await failMessage();
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const creds = await getChannelCreds(uid, channel);
    if (!creds) {
      await failMessage();
      return res.status(404).json({ error: `No credentials found for ${channel}` });
    }

    switch (channel) {
      case 'whatsapp':
        await sendWhatsApp({ accessToken: creds.accessToken, phoneNumberId: creds.phoneNumberId, to: contactId, text });
        break;
      case 'instagram':
        await sendInstagram({ accessToken: creds.accessToken, igAccountId: creds.igAccountId, to: contactId, text });
        break;
      case 'messenger':
        await sendMessenger({ accessToken: creds.accessToken, to: contactId, text });
        break;
      case 'telegram':
        await sendTelegram({ botToken: creds.botToken, chatId: contactId, text });
        break;
      default:
        await failMessage();
        return res.status(400).json({ error: `Unknown channel: ${channel}` });
    }

    if (messageId) await updateMessageStatus(uid, conversationId, messageId, 'sent');
    console.log(`[messaging] Sent ${channel} reply to ${contactId} for uid ${uid}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[messaging/send] ${channel} error:`, err.response?.data || err.message);
    if (messageId) await updateMessageStatus(uid, conversationId, messageId, 'failed');
    return res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /messaging/connect
// SECURITY FIX: uid from verified token now, not the body — previously
// anyone could overwrite the channelIndex entry for an accountId already
// connected to a different user, hijacking that user's incoming messages.
// ─────────────────────────────────────────────────────────────────────────
router.post('/messaging/connect', requireAuth, async (req, res) => {
  const uid = req.uid;
  const { channelType, accountId } = req.body;
  if (!channelType || !accountId) return res.status(400).json({ error: 'Missing channelType or accountId' });

  try {
    const indexRef = db.collection('appConfig').doc('channelIndex');
    const key = `${channelType}_${accountId}`;

    // Refuse to silently steal an accountId that's already routed to a
    // different uid. If it's already this uid's, fine (idempotent reconnect).
    const snap = await indexRef.get();
    const existingUid = snap.exists ? snap.data()[key] : null;
    if (existingUid && existingUid !== uid) {
      console.warn(`[messaging/connect] Refusing to reassign ${key} from ${existingUid} to ${uid}`);
      return res.status(409).json({ error: 'This account is already connected to a different user.' });
    }

    await indexRef.set({ [key]: uid }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /messaging/disconnect
// CORRECTNESS FIX: disconnecting a channel client-side only ever deleted
// the local connectedChannels doc — it never told the server to remove the
// appConfig/channelIndex entry (accountId -> uid). That left two problems:
//   1. A stale mapping lingers forever, even after the org disconnects.
//   2. Combined with /messaging/connect's "refuse to reassign an
//      already-connected accountId" check, reconnecting the SAME channel
//      later could incorrectly 409 against its own stale entry.
// This removes the mapping, but only if it actually belongs to the caller.
// ─────────────────────────────────────────────────────────────────────────
router.post('/messaging/disconnect', requireAuth, async (req, res) => {
  const uid = req.uid;
  const { channelType, accountId } = req.body;
  if (!channelType || !accountId) return res.status(400).json({ error: 'Missing channelType or accountId' });

  try {
    const indexRef = db.collection('appConfig').doc('channelIndex');
    const key = `${channelType}_${accountId}`;
    const snap = await indexRef.get();
    const existingUid = snap.exists ? snap.data()[key] : null;

    if (existingUid && existingUid !== uid) {
      // Don't let A's disconnect call remove B's mapping just by guessing
      // the same accountId.
      return res.status(403).json({ error: 'This account is not connected to your organization.' });
    }

    if (existingUid === uid) {
      await indexRef.update({ [key]: admin.firestore.FieldValue.delete() });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Meta webhooks (WhatsApp / Instagram / Messenger)
// GET = handshake (unchanged). POST = now signature-verified.
// ─────────────────────────────────────────────────────────────────────────
router.get('/webhook/whatsapp', metaVerify);
router.post('/webhook/whatsapp', verifyMetaSignature, async (req, res) => {
  res.sendStatus(200); // Always respond 200 immediately to Meta
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (!value?.messages?.length) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        const uid = await findUidForChannel('whatsapp', phoneNumberId);
        if (!uid) { console.warn('[whatsapp] No uid for phoneNumberId', phoneNumberId); continue; }

        for (const msg of value.messages) {
          const contactId = msg.from;
          const contactName = value.contacts?.find(c => c.wa_id === msg.from)?.profile?.name || msg.from;
          const text = msg.text?.body || msg.caption || '';
          const mediaUrl = msg.image?.id || msg.document?.id || msg.audio?.id || null;
          await saveIncomingMessage({ uid, channel: 'whatsapp', contactId, contactName, text, mediaUrl });
        }
      }
    }
  } catch (err) {
    console.error('[webhook/whatsapp]', err.message);
  }
});

router.get('/webhook/instagram', metaVerify);
router.post('/webhook/instagram', verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'instagram') return;

    for (const entry of body.entry || []) {
      const igAccountId = entry.id;
      const uid = await findUidForChannel('instagram', igAccountId);
      if (!uid) { console.warn('[instagram] No uid for igAccountId', igAccountId); continue; }

      for (const msg of entry.messaging || []) {
        if (msg.message?.is_echo) continue;
        const contactId = msg.sender?.id;
        const text = msg.message?.text || '';
        const mediaUrl = msg.message?.attachments?.[0]?.payload?.url || null;
        await saveIncomingMessage({ uid, channel: 'instagram', contactId, contactName: contactId, text, mediaUrl });
      }
    }
  } catch (err) {
    console.error('[webhook/instagram]', err.message);
  }
});

router.get('/webhook/messenger', metaVerify);
router.post('/webhook/messenger', verifyMetaSignature, async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'page') return;

    for (const entry of body.entry || []) {
      const pageId = entry.id;
      const uid = await findUidForChannel('messenger', pageId);
      if (!uid) { console.warn('[messenger] No uid for pageId', pageId); continue; }

      for (const msg of entry.messaging || []) {
        if (msg.message?.is_echo) continue;
        const contactId = msg.sender?.id;
        const text = msg.message?.text || '';
        const mediaUrl = msg.message?.attachments?.[0]?.payload?.url || null;
        await saveIncomingMessage({ uid, channel: 'messenger', contactId, contactName: contactId, text, mediaUrl });
      }
    }
  } catch (err) {
    console.error('[webhook/messenger]', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Telegram webhook — secured by the token in the URL path itself (Telegram's
// own recommended pattern), unchanged from the live server.
// ─────────────────────────────────────────────────────────────────────────
router.post('/webhook/telegram/:token', async (req, res) => {
  res.sendStatus(200);
  try {
    const { token } = req.params;
    const update = req.body;
    const msg = update.message || update.edited_message || update.channel_post;
    if (!msg?.text && !msg?.caption && !msg?.photo) return;

    let botUsername;
    try {
      botUsername = await getTelegramBotUsername(token);
    } catch (e) {
      console.error('[telegram] getMe failed — invalid or revoked token in URL:', e.message);
      return;
    }

    const uid = await findUidForChannel('telegram', botUsername);
    if (!uid) {
      console.warn(`[telegram] No uid found for bot @${botUsername}. Check appConfig/channelIndex has key "telegram_${botUsername}".`);
      return;
    }

    const contactId = String(msg.chat?.id);
    const contactName = msg.chat?.first_name
      ? `${msg.chat.first_name} ${msg.chat.last_name || ''}`.trim()
      : msg.chat?.username || contactId;
    const text = msg.text || msg.caption || '';
    const mediaUrl = msg.photo ? msg.photo[msg.photo.length - 1]?.file_id : null;

    await saveIncomingMessage({ uid, channel: 'telegram', contactId, contactName, text, mediaUrl });
  } catch (err) {
    console.error('[webhook/telegram] Unhandled error:', err.message, err.stack);
  }
});

module.exports = router;
