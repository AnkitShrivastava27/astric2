// routes/billing-history.js
//
// GET /billing/purchases — the signed-in user's add-on purchase history
// (Website Studio packs, App Studio packs, WhatsApp subscriptions), newest
// first. Powers the "Track" section of the app's Billing → Top-ups tab.
//
// Reads the three order collections server-side so the app never needs
// Firestore rules for them. Filtering is by req.uid (verified token), and
// sorting is done in memory so no composite index is required.
'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const SOURCES = [
  { collection: 'websiteCreditOrders',        product: 'website',  title: (o) => `Website Studio — ${o.tier || 'pack'}` },
  { collection: 'appCreditOrders',            product: 'app',      title: (o) => `App Studio — ${o.tier || 'pack'}` },
  { collection: 'whatsappSubscriptionOrders', product: 'whatsapp', title: (o) => `WhatsApp Automation — ${o.plan || 'plan'}` },
];

router.get('/billing/purchases', requireAuth, rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `billing-history:${r.uid}` }), async (req, res) => {
  try {
    const perSource = await Promise.all(SOURCES.map(async (src) => {
      const snap = await db.collection(src.collection).where('uid', '==', req.uid).limit(50).get();
      return snap.docs.map((d) => {
        const o = d.data();
        const ts = o.paidAt || o.createdAt;
        return {
          orderId: d.id,
          product: src.product,
          title: src.title(o),
          status: o.status === 'paid' ? 'paid' : (o.status || 'pending'),
          amount: o.amountINR != null ? o.amountINR : (o.amountUSD != null ? o.amountUSD : null),
          currency: o.amountINR != null ? 'INR' : (o.amountUSD != null ? 'USD' : null),
          gateway: o.gateway || (String(d.id).startsWith('PP') ? 'paypal' : 'cashfree'),
          at: ts && ts.toDate ? ts.toDate().toISOString() : null,
        };
      });
    }));
    const purchases = perSource.flat().sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 60);
    return res.json({ purchases });
  } catch (err) {
    console.error('GET /billing/purchases failed:', err);
    return res.status(500).json({ error: 'Could not load purchase history.' });
  }
});

module.exports = router;
