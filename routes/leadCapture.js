// routes/leadCapture.js
//
// Lead capture: every way a lead can ARRIVE in the CRM without being typed in.
//
//   Signed-in (app) endpoints
//     GET  /capture/config                 -> this organisation's webhook URL + key, form URL + QR, Facebook details   (admin)
//     POST /capture/rotate  {which}        -> issue a new webhook key / form link                                       (admin)
//     POST /capture/test                   -> send a clearly-labelled test lead through the same pipeline               (admin)
//     POST /capture/import  {csv}          -> bulk-import CSV text                                                      (any member)
//     POST /capture/sheets/import {url}    -> import a Google Sheet shared as "anyone with the link"                    (any member)
//     POST /capture/facebook {pageToken, appSecret} -> validate + store Facebook credentials                            (admin)
//     POST /capture/defaults {webhookProductId, facebookProductId} -> default product per channel                       (admin)
//     POST /capture/qr {productId}         -> QR code + link of the form pre-tagged to one product                      (admin)
//   Imports accept {productId, batchName}: every imported lead gets that product and lands in one new batch.
//
//   Public endpoints (called by the outside world — protected by per-organisation secrets)
//     POST /capture/webhook/:orgId         -> website forms, Zapier/Make, Google Sheets script, any server. Key required.
//     GET  /capture/form/:orgId/:token     -> hosted lead form (the page the QR code opens)
//     POST /capture/form/:orgId/:token     -> that form's submit
//     GET/POST /capture/facebook/:orgId    -> Facebook Lead Ads webhook (verify handshake + lead events)
//
// Secrets live in users/{org}/lead_capture_secrets/config, which Firestore rules deny to every client
// (deny-all catch-all) — only this server reads them.
'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const QRCode = require('qrcode');
const router = express.Router();

const { admin, db } = require('../config/firebase');
const { SERVER_BASE_URL } = require('../config/env');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { csvToObjects } = require('../services/csvParse');
const { mapFields, ingestLead, ingestMany, notifyNewLead, loadProducts, applyProduct, createBatch, deleteBatch } = require('../services/leadIngest');

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v19.0'}`;
const urlencoded = express.urlencoded({ extended: true, limit: '200kb' });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[capture]', req.method, req.path, e.message);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ── helpers ─────────────────────────────────────────────────────────────────
const secretsRef = (orgId) => db.collection('users').doc(orgId).collection('lead_capture_secrets').doc('config');
const rand = (n) => crypto.randomBytes(n).toString('hex');
const same = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

async function getSecrets(orgId, { create = false } = {}) {
  const snap = await secretsRef(orgId).get();
  let s = snap.exists ? snap.data() : null;
  if (!s && create) {
    s = { webhookKey: `wk_${rand(18)}`, formToken: rand(9), fbVerifyToken: rand(12) };
    await secretsRef(orgId).set({ ...s, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  return s;
}

async function memberContext(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) { const e = new Error('User not found.'); e.status = 404; throw e; }
  const u = snap.data();
  const isEmployee = u.role === 'employee' && !!u.adminId;
  return { uid, orgId: isEmployee ? u.adminId : uid, isAdmin: !isEmployee, user: u };
}
async function adminContext(uid) {
  const c = await memberContext(uid);
  if (!c.isAdmin) { const e = new Error('Only the organisation admin can do this.'); e.status = 403; throw e; }
  return c;
}
const guard = (fn) => wrap(async (req, res) => {
  try { await fn(req, res); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
});

async function orgName(orgId) {
  const s = await db.collection('users').doc(orgId).get();
  const u = s.exists ? s.data() : {};
  return u.organizationName || u.companyName || u.name || 'Our team';
}

const urls = (orgId, s) => ({
  webhookUrl: `${SERVER_BASE_URL}/capture/webhook/${orgId}`,
  formUrl: `${SERVER_BASE_URL}/capture/form/${orgId}/${s.formToken}`,
  facebookCallbackUrl: `${SERVER_BASE_URL}/capture/facebook/${orgId}`,
});

// ── Imports: optional product for the whole file + one batch to keep the import together ──
async function prepareImport(orgId, uid, body) {
  const wantProduct = String(body.productId || '').trim();
  let product = null;
  if (wantProduct) {
    product = (await loadProducts(orgId)).find(wantProduct);
    if (!product) { const e = new Error('That product no longer exists or is archived. Pick another one.'); e.status = 400; throw e; }
  }
  const batchName = String(body.batchName || '').trim();
  const batchId = batchName ? await createBatch(orgId, batchName, uid) : '';
  return {
    opts: { productId: product ? product.id : '', productName: product ? product.name : '', batchId },
    batchId, batchName, productName: product ? product.name : '',
  };
}
async function finishImport(orgId, prep, result) {
  let { batchId, batchName } = prep;
  if (batchId && result.created === 0) { await deleteBatch(orgId, batchId); batchId = ''; batchName = ''; }   // never leave an empty batch behind
  return { batchId, batchName, productName: prep.productName };
}

// ─────────────────────────────────────────────────────────────────────────────
// App endpoints
// ─────────────────────────────────────────────────────────────────────────────
router.get('/capture/config', requireAuth, guard(async (req, res) => {
  const { orgId } = await adminContext(req.uid);
  const s = await getSecrets(orgId, { create: true });
  const u = urls(orgId, s);
  const qr = await QRCode.toDataURL(u.formUrl, { margin: 1, width: 480, errorCorrectionLevel: 'M' });
  res.json({
    orgId, ...u, webhookKey: s.webhookKey, formQrPng: qr,
    facebook: { verifyToken: s.fbVerifyToken, hasPageToken: !!s.fbPageToken, hasAppSecret: !!s.fbAppSecret, pageName: s.fbPageName || '' },
    defaults: { webhookProductId: s.defaultProductWebhook || '', facebookProductId: s.defaultProductFacebook || '' },
    baseUrl: SERVER_BASE_URL,
  });
}));

router.post('/capture/rotate', requireAuth, rateLimit({ windowMs: 60_000, max: 6, keyFn: (r) => `cap-rot:${r.uid}` }),
  guard(async (req, res) => {
    const { orgId } = await adminContext(req.uid);
    const which = (req.body || {}).which;
    await getSecrets(orgId, { create: true });
    if (which === 'webhook') await secretsRef(orgId).update({ webhookKey: `wk_${rand(18)}` });
    else if (which === 'form') await secretsRef(orgId).update({ formToken: rand(9) });
    else return res.status(400).json({ error: 'which must be "webhook" or "form".' });
    res.json({ ok: true });
  }));

router.post('/capture/test', requireAuth, rateLimit({ windowMs: 60_000, max: 6, keyFn: (r) => `cap-test:${r.uid}` }),
  guard(async (req, res) => {
    const { orgId, uid } = await adminContext(req.uid);
    const stamp = Date.now();
    const r = await ingestLead(orgId, mapFields({
      name: 'Test Lead (safe to delete)', email: `test+${stamp}@example.com`, company: 'Astric capture test',
      message: 'Sent from the Test button in Lead Capture.',
    }), { createdBy: uid, defaultSource: 'other', sourceLabel: 'Capture test' });
    res.json({ ok: r.status === 'created', ...r });
  }));

router.post('/capture/defaults', requireAuth, rateLimit({ windowMs: 60_000, max: 12, keyFn: (r) => `cap-def:${r.uid}` }),
  guard(async (req, res) => {
    const { orgId } = await adminContext(req.uid);
    const products = await loadProducts(orgId);
    const upd = {};
    for (const [bodyKey, field] of [['webhookProductId', 'defaultProductWebhook'], ['facebookProductId', 'defaultProductFacebook']]) {
      if (req.body[bodyKey] === undefined) continue;
      const id = String(req.body[bodyKey] || '').trim();
      if (id && !products.find(id)) return res.status(400).json({ error: 'That product no longer exists or is archived.' });
      upd[field] = id;
    }
    await getSecrets(orgId, { create: true });
    if (Object.keys(upd).length) await secretsRef(orgId).update(upd);
    res.json({ ok: true });
  }));

router.post('/capture/qr', requireAuth, guard(async (req, res) => {
  const { orgId } = await adminContext(req.uid);
  const s = await getSecrets(orgId, { create: true });
  const productId = String((req.body || {}).productId || '').trim();
  let url = urls(orgId, s).formUrl;
  let productName = '';
  if (productId) {
    const p = (await loadProducts(orgId)).find(productId);
    if (!p) return res.status(400).json({ error: 'That product no longer exists or is archived.' });
    url += `?product=${encodeURIComponent(p.id)}`;
    productName = p.name;
  }
  res.json({ formUrl: url, productName, formQrPng: await QRCode.toDataURL(url, { margin: 1, width: 480, errorCorrectionLevel: 'M' }) });
}));

router.post('/capture/import', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: (r) => `cap-imp:${r.uid}` }),
  guard(async (req, res) => {
    const { orgId, uid } = await memberContext(req.uid);
    const csv = String((req.body || {}).csv || '');
    if (!csv.trim()) return res.status(400).json({ error: 'No CSV data received.' });
    const { headers, records } = csvToObjects(csv);
    const known = headers.map((h) => mapFields({ [h]: 'x' })).some((m) => m.name || m.first || m.email || m.phone);
    if (!known) return res.status(400).json({ error: 'Row 1 must be a header row with at least a name, email or phone column.' });
    if (!records.length) return res.status(400).json({ error: 'The file has a header row but no leads.' });
    const prep = await prepareImport(orgId, uid, req.body || {});
    const result = await ingestMany(orgId, records, { createdBy: uid, defaultSource: 'manualWalkIn', sourceLabel: 'CSV Import', ...prep.opts });
    res.json({ ok: true, total: records.length, ...result, ...(await finishImport(orgId, prep, result)) });
  }));

router.post('/capture/sheets/import', requireAuth, rateLimit({ windowMs: 60_000, max: 6, keyFn: (r) => `cap-sh:${r.uid}` }),
  guard(async (req, res) => {
    const { orgId, uid } = await memberContext(req.uid);
    const url = String((req.body || {}).url || '').trim();
    const id = (url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
    if (!id) return res.status(400).json({ error: 'That doesn\'t look like a Google Sheets link.' });
    const gid = (url.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
    let body;
    try {
      const r = await axios.get(`https://docs.google.com/spreadsheets/d/${id}/export`, {
        params: { format: 'csv', gid }, responseType: 'text', timeout: 20_000, maxContentLength: 5 * 1024 * 1024,
        transformResponse: (d) => d, validateStatus: () => true, maxRedirects: 5,
      });
      body = r.data;
      const looksHtml = /^\s*<(!doctype|html)/i.test(String(body));
      if (r.status === 404) return res.status(400).json({ error: 'Sheet not found. Check the link.' });
      if (r.status !== 200 || looksHtml) {
        return res.status(400).json({ error: 'Google wouldn\'t let us read this sheet. Click Share → General access → "Anyone with the link" → Viewer, then try again.' });
      }
    } catch (e) {
      return res.status(502).json({ error: 'Could not reach Google Sheets. Try again in a moment.' });
    }
    const { headers, records } = csvToObjects(body);
    const known = headers.map((h) => mapFields({ [h]: 'x' })).some((m) => m.name || m.first || m.email || m.phone);
    if (!known) return res.status(400).json({ error: 'Row 1 of the sheet must be headers with a name, email or phone column.' });
    if (!records.length) return res.status(400).json({ error: 'The sheet has headers but no leads yet.' });
    const prep = await prepareImport(orgId, uid, req.body || {});
    const result = await ingestMany(orgId, records, { createdBy: uid, defaultSource: 'other', sourceLabel: 'Google Sheets', ...prep.opts });
    res.json({ ok: true, total: records.length, ...result, ...(await finishImport(orgId, prep, result)) });
  }));

router.post('/capture/facebook', requireAuth, rateLimit({ windowMs: 60_000, max: 6, keyFn: (r) => `cap-fb:${r.uid}` }),
  guard(async (req, res) => {
    const { orgId } = await adminContext(req.uid);
    const pageToken = String((req.body || {}).pageToken || '').trim();
    const appSecret = String((req.body || {}).appSecret || '').trim();
    if (!pageToken || !appSecret) return res.status(400).json({ error: 'Both the Page access token and the App secret are required.' });
    await getSecrets(orgId, { create: true });

    let page;
    try { page = (await axios.get(`${GRAPH}/me`, { params: { access_token: pageToken, fields: 'id,name' }, timeout: 15_000 })).data; }
    catch (e) {
      return res.status(400).json({ error: `Facebook rejected that token: ${e.response?.data?.error?.message || e.message}` });
    }
    let subscribed = false; let subscribeError = '';
    try {
      await axios.post(`${GRAPH}/${page.id}/subscribed_apps`, null, { params: { subscribed_fields: 'leadgen', access_token: pageToken }, timeout: 15_000 });
      subscribed = true;
    } catch (e) { subscribeError = e.response?.data?.error?.message || e.message; }

    await secretsRef(orgId).update({ fbPageToken: pageToken, fbAppSecret: appSecret, fbPageId: page.id, fbPageName: page.name });
    res.json({ ok: true, pageName: page.name, subscribed, subscribeError });
  }));

// ─────────────────────────────────────────────────────────────────────────────
// Public: webhook
// ─────────────────────────────────────────────────────────────────────────────
function keyFrom(req) {
  const h = req.headers['x-capture-key'];
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return h || bearer || req.query.key || (req.body && (req.body.key || req.body.secret)) || '';
}

router.post('/capture/webhook/:orgId', urlencoded,
  rateLimit({ windowMs: 60_000, max: 120, keyFn: (r) => `cap-wh:${r.params.orgId}` }),
  wrap(async (req, res) => {
    const { orgId } = req.params;
    const s = await getSecrets(orgId);
    if (!s || !same(keyFrom(req), s.webhookKey)) return res.status(401).json({ error: 'Invalid or missing capture key.' });

    const products = await loadProducts(orgId);
    const fallbackProduct = products.find(s.defaultProductWebhook);
    const body = req.body;
    const items = (Array.isArray(body) ? body : Array.isArray(body && body.leads) ? body.leads : [body]).slice(0, 100);
    const results = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') { results.push({ status: 'invalid', reason: 'not an object' }); continue; }
      const { key, secret, orgId: _o, ...fields } = raw;
      const f = mapFields(fields);
      const pr = applyProduct(f, products, fallbackProduct);
      const r = await ingestLead(orgId, f, { defaultSource: 'websiteForm', sourceLabel: 'Webhook', productId: pr.productId, productName: pr.productName });
      results.push(r);
      if (r.status === 'created') notifyNewLead(orgId, { name: f.name || f.email || f.phone }, 'Webhook');
    }
    if (!Array.isArray(body) && !Array.isArray(body && body.leads)) {
      const r = results[0];
      if (r.status === 'invalid') return res.status(422).json({ success: false, error: r.reason });
      return res.json({ success: true, status: r.status, duplicate: r.status === 'duplicate', id: r.id });
    }
    res.json({
      success: true,
      created: results.filter((r) => r.status === 'created').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      invalid: results.filter((r) => r.status === 'invalid').length,
    });
  }));

// ─────────────────────────────────────────────────────────────────────────────
// Public: hosted form (what the QR code opens)
// ─────────────────────────────────────────────────────────────────────────────
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formPage(company, product = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Contact ${esc(company)}</title>
<style>
:root{--bg:#f5f6fa;--card:#fff;--tx:#14161f;--mut:#6b7080;--bd:#dfe2ec;--ac:#b8903f}
@media(prefers-color-scheme:dark){:root{--bg:#0e0f14;--card:#171922;--tx:#f1f2f6;--mut:#9aa0b3;--bd:#2a2d3a;--ac:#c8a96e}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx);display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--bd);border-radius:18px;padding:26px}
h1{margin:0 0 4px;font-size:1.3rem}p.s{margin:0 0 20px;color:var(--mut);font-size:.9rem}
label{display:block;font-size:.8rem;font-weight:600;margin:14px 0 6px}
input,textarea{width:100%;padding:12px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:var(--tx);font:inherit}
input:focus,textarea:focus{outline:2px solid var(--ac);border-color:transparent}
textarea{min-height:90px;resize:vertical}
button{margin-top:20px;width:100%;padding:13px;border:0;border-radius:10px;background:var(--ac);color:#fff;font-weight:700;font-size:1rem;cursor:pointer}
button:disabled{opacity:.6}.err{color:#d33;font-size:.85rem;margin-top:12px;min-height:1em}
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.ok{text-align:center;padding:24px 0}.ok .t{font-size:2.4rem}
</style></head><body><div class="card" id="c">
<form id="f" novalidate><h1>Get in touch with ${esc(company)}</h1>${product ? `<p class="s" style="margin-top:-2px;font-weight:600">About: ${esc(product)}</p>` : ''}<p class="s">Leave your details and we'll contact you shortly.</p>
<label for="name">Your name *</label><input id="name" name="name" autocomplete="name" required>
<label for="phone">Phone / WhatsApp *</label><input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email">
<label for="company">Company</label><input id="company" name="company" autocomplete="organization">
<label for="message">How can we help?</label><textarea id="message" name="message"></textarea>
<input class="hp" name="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
<div class="err" id="e"></div><button id="b" type="submit">Submit</button></form></div>
<script>
const f=document.getElementById('f'),e=document.getElementById('e'),b=document.getElementById('b');
f.addEventListener('submit',async ev=>{ev.preventDefault();e.textContent='';
const d=Object.fromEntries(new FormData(f).entries());
if(!d.name.trim()){e.textContent='Please enter your name.';return}
if(!d.phone.trim()&&!d.email.trim()){e.textContent='Please enter a phone number or email.';return}
b.disabled=true;b.textContent='Sending…';
try{const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
const j=await r.json().catch(()=>({}));
if(!r.ok)throw new Error(j.error||'Could not send. Please try again.');
document.getElementById('c').innerHTML='<div class="ok"><div class="t">✅</div><h1>Thank you!</h1><p class="s">We\\'ve received your details and will be in touch soon.</p></div>';
}catch(x){e.textContent=x.message;b.disabled=false;b.textContent='Submit'}});
</script></body></html>`;
}

const notFoundPage = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;text-align:center;padding:48px 16px"><h2>This form link is no longer active</h2><p>Please ask the business for a new link or QR code.</p>';

router.get('/capture/form/:orgId/:token', wrap(async (req, res) => {
  const s = await getSecrets(req.params.orgId);
  if (!s || !same(req.params.token, s.formToken)) return res.status(404).type('html').send(notFoundPage);
  const wanted = String(req.query.product || '').trim();
  const product = wanted ? (await loadProducts(req.params.orgId)).find(wanted) : null;
  res.set('Cache-Control', 'no-cache').type('html').send(formPage(await orgName(req.params.orgId), product ? product.name : ''));
}));

router.post('/capture/form/:orgId/:token',
  rateLimit({ windowMs: 60_000, max: 8, keyFn: (r) => `cap-form:${r.ip}` }),
  rateLimit({ windowMs: 60_000, max: 60, keyFn: (r) => `cap-form-org:${r.params.orgId}` }),
  wrap(async (req, res) => {
    const { orgId, token } = req.params;
    const s = await getSecrets(orgId);
    if (!s || !same(token, s.formToken)) return res.status(404).json({ error: 'This form link is no longer active.' });
    const b = req.body || {};
    if (String(b.hp || '').trim()) return res.json({ ok: true });                 // honeypot: bots fill hidden fields
    const f = mapFields({ name: b.name, phone: b.phone, email: b.email, company: b.company, message: b.message });
    // The product comes from the QR link itself (?product=<id>) — a visitor can't pick or fake a name.
    const wanted = String(req.query.product || '').trim();
    const product = wanted ? (await loadProducts(orgId)).find(wanted) : null;
    const r = await ingestLead(orgId, f, { defaultSource: 'websiteForm', sourceLabel: 'QR Form', productId: product ? product.id : '', productName: product ? product.name : '' });
    if (r.status === 'invalid') return res.status(422).json({ error: 'Please enter your name and a phone number or email.' });
    if (r.status === 'created') notifyNewLead(orgId, { name: f.name }, 'QR Form');
    res.json({ ok: true });                                                       // a repeat submission looks like success too
  }));

// ─────────────────────────────────────────────────────────────────────────────
// Public: Facebook Lead Ads
// ─────────────────────────────────────────────────────────────────────────────
router.get('/capture/facebook/:orgId', wrap(async (req, res) => {
  const s = await getSecrets(req.params.orgId);
  if (s && req.query['hub.mode'] === 'subscribe' && same(req.query['hub.verify_token'], s.fbVerifyToken)) {
    return res.status(200).send(String(req.query['hub.challenge'] || ''));
  }
  res.sendStatus(403);
}));

router.post('/capture/facebook/:orgId', wrap(async (req, res) => {
  const { orgId } = req.params;
  const s = await getSecrets(orgId);
  if (!s || !s.fbAppSecret || !s.fbPageToken) return res.sendStatus(403);

  const expected = 'sha256=' + crypto.createHmac('sha256', s.fbAppSecret).update(req.rawBody || Buffer.from('')).digest('hex');
  if (!same(req.headers['x-hub-signature-256'], expected)) return res.sendStatus(403);

  const products = await loadProducts(orgId);
  const fallbackProduct = products.find(s.defaultProductFacebook);
  const changes = (req.body.entry || []).flatMap((e) => e.changes || []).filter((c) => c.field === 'leadgen' && c.value && c.value.leadgen_id);
  for (const c of changes) {
    try {
      const lead = (await axios.get(`${GRAPH}/${c.value.leadgen_id}`, { params: { access_token: s.fbPageToken }, timeout: 15_000 })).data;
      const fields = {};
      (lead.field_data || []).forEach((d) => { fields[d.name] = d.values; });
      const f = mapFields(fields);
      const pr = applyProduct(f, products, fallbackProduct);
      const r = await ingestLead(orgId, f, {
        defaultSource: 'facebookAds', sourceLabel: 'Facebook Lead Ads', productId: pr.productId, productName: pr.productName,
        extraCustom: { ...(c.value.ad_id ? { adId: c.value.ad_id } : {}), ...(c.value.form_id ? { formId: c.value.form_id } : {}) },
      });
      if (r.status === 'created') notifyNewLead(orgId, { name: f.name || f.email || f.phone }, 'Facebook Lead Ads');
    } catch (e) {
      console.warn('[capture/facebook] lead fetch failed:', e.response?.data?.error?.message || e.message);
    }
  }
  res.sendStatus(200);   // always 200 once the signature is valid, so Facebook doesn't keep retrying; duplicates are ignored anyway
}));

module.exports = router;
