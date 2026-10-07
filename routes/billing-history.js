// routes/billing-history.js
//
// GET /billing/purchases — the signed-in user's ENTIRE purchase history,
// newest first, across every kind of payment:
//   plan     monthly/annual subscription plans          (orders)
//   tokens   AI token top-ups                           (orders, orderType 'tokens')
//   website  Website Studio packs                       (websiteCreditOrders)
//   app      App Studio packs                           (appCreditOrders)
//   whatsapp WhatsApp Automation subscriptions          (whatsappSubscriptionOrders)
//
// Powers the Billing → History tab. Reads server-side, filtered by the
// verified uid; sorting is done in memory so no composite index is needed.
'use strict';

const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const num = (n) => Number(n || 0).toLocaleString('en-US');

const SOURCES = [
  {
    collection: 'orders',
    product: (o) => (o.orderType === 'tokens' ? 'tokens' : 'plan'),
    title: (o) => (o.orderType === 'tokens'
      ? `AI tokens — ${num(o.tokensToAdd || (o.tokenPacks || 0) * 10000)}`
      : `${cap(o.planType) || 'Plan'} plan — ${o.cycle === 'annual' ? 'Annual' : 'Monthly'}`),
  },
  { collection: 'websiteCreditOrders',        product: () => 'website',  title: (o) => `Website Studio — ${cap(o.tier) || 'pack'}` },
  { collection: 'appCreditOrders',            product: () => 'app',      title: (o) => `App Studio — ${cap(o.tier) || 'pack'}` },
  { collection: 'whatsappSubscriptionOrders', product: () => 'whatsapp', title: (o) => `WhatsApp Automation — ${cap(o.plan) || 'plan'}` },
];

router.get('/billing/purchases', requireAuth, rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `billing-history:${r.uid}` }), async (req, res) => {
  try {
    const perSource = await Promise.all(SOURCES.map(async (src) => {
      const snap = await db.collection(src.collection).where('uid', '==', req.uid).limit(100).get();
      return snap.docs.map((d) => {
        const o = d.data();
        const ts = o.activatedAt || o.paidAt || o.createdAt;
        return {
          orderId: d.id,
          product: src.product(o),
          title: src.title(o),
          status: o.status === 'paid' ? 'paid' : (o.status || 'pending'),
          amount: o.amountINR != null ? o.amountINR : (o.amountUSD != null ? o.amountUSD : null),
          currency: o.amountINR != null ? 'INR' : (o.amountUSD != null ? 'USD' : null),
          amountUSD: o.amountUSD != null ? o.amountUSD : null,
          gateway: o.gateway || (String(d.id).toUpperCase().startsWith('PP') ? 'paypal' : 'cashfree'),
          at: ts && ts.toDate ? ts.toDate().toISOString() : null,
        };
      });
    }));
    const purchases = perSource.flat()
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, 250);
    return res.json({ purchases });
  } catch (err) {
    console.error('GET /billing/purchases failed:', err);
    return res.status(500).json({ error: 'Could not load purchase history.' });
  }
});

module.exports = router;
