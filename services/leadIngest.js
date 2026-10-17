// services/leadIngest.js
//
// ONE place that turns "something a person submitted" into a lead document, whichever way it arrived
// (webhook, hosted form / QR, Facebook Lead Ads, CSV, Google Sheets). It writes exactly the shape the
// Flutter app reads (shared/models/lead_model.dart) and uses the same duplicate rule as the app's lead
// repository: one lead per phone number, enforced by users/{org}/lead_phone_index/{phoneNorm}.
'use strict';

const crypto = require('crypto');
const { admin, db } = require('../config/firebase');

const FV = admin.firestore.FieldValue;

// ── Same normalisation as lib/shared/models/lead_utils.dart ─────────────────
function normalizePhone(raw, defaultCountryCode = '91') {
  let d = String(raw || '').replace(/[^0-9]/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = defaultCountryCode + d;
  return d;
}

const SOURCES = ['facebookAds', 'googleAds', 'websiteForm', 'whatsapp', 'referral', 'coldCall', 'linkedin', 'manualWalkIn', 'other'];
const SOURCE_ALIASES = {
  facebookads: 'facebookAds', facebook: 'facebookAds', fb: 'facebookAds', meta: 'facebookAds', instagram: 'facebookAds',
  googleads: 'googleAds', google: 'googleAds', adwords: 'googleAds',
  websiteform: 'websiteForm', website: 'websiteForm', web: 'websiteForm', form: 'websiteForm',
  whatsapp: 'whatsapp', wa: 'whatsapp',
  referral: 'referral', reference: 'referral', referred: 'referral',
  coldcall: 'coldCall', call: 'coldCall', calling: 'coldCall',
  linkedin: 'linkedin',
  manualwalkin: 'manualWalkIn', walkin: 'manualWalkIn', manual: 'manualWalkIn', event: 'manualWalkIn',
  other: 'other',
};
function normalizeSource(v) {
  const k = String(v || '').toLowerCase().replace(/[^a-z]/g, '');
  return SOURCE_ALIASES[k] || (SOURCES.includes(String(v)) ? String(v) : null);
}

// ── Flexible field mapping: accepts the many names forms / Zapier / Facebook / Sheets use ──
const ALIASES = {
  name:    ['name', 'fullname', 'contactname', 'customername', 'leadname', 'yourname', 'clientname'],
  first:   ['firstname', 'fname', 'givenname'],
  last:    ['lastname', 'lname', 'surname', 'familyname'],
  email:   ['email', 'emailaddress', 'mail', 'emailid', 'workemail', 'youremail'],
  phone:   ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'whatsapp', 'whatsappnumber', 'contactnumber', 'telephone', 'tel', 'cell', 'cellphone', 'yourphone'],
  company: ['company', 'companyname', 'organization', 'organisation', 'business', 'businessname', 'firm'],
  notes:   ['message', 'notes', 'note', 'comment', 'comments', 'requirement', 'requirements', 'enquiry', 'inquiry', 'description', 'details', 'remarks'],
  source:  ['source', 'leadsource'],
  value:   ['estimatedvalue', 'value', 'budget', 'dealvalue'],
  product: ['product', 'productname', 'productid', 'interestedproduct', 'interestedin', 'service', 'plan'],
};
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const scalar = (v) => {
  if (Array.isArray(v)) v = v[0];
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
};

/** obj -> { name, email, phone, company, notes, source, value, extra:{unmapped} } */
function mapFields(obj) {
  const out = { name: '', email: '', phone: '', company: '', notes: '', source: '', value: '', product: '', first: '', last: '', extra: {} };
  const lookup = {};
  for (const [field, names] of Object.entries(ALIASES)) names.forEach((n) => { lookup[n] = field; });
  for (const [rawKey, rawVal] of Object.entries(obj || {})) {
    const v = scalar(rawVal);
    if (!v) continue;
    const field = lookup[norm(rawKey)];
    if (field) { if (!out[field]) out[field] = v; }
    else if (Object.keys(out.extra).length < 20) out.extra[String(rawKey).slice(0, 40)] = v.slice(0, 300);
  }
  if (!out.name) out.name = [out.first, out.last].filter(Boolean).join(' ');
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Products (users/{org}/products) ─────────────────────────────────────────
/** Loads the organisation's products once so many rows can be matched without a read each. */
async function loadProducts(orgId) {
  const snap = await db.collection('users').doc(orgId).collection('products').get();
  const list = snap.docs.map((d) => ({ id: d.id, name: String(d.data().name || ''), active: d.data().active !== false }));
  const byId = new Map(list.map((p) => [p.id, p]));
  const byName = new Map(list.map((p) => [p.name.trim().toLowerCase(), p]));
  return {
    list,
    /** Match by id or (case-insensitive) name. Archived products never match for new leads. */
    find(ref) {
      const k = String(ref || '').trim();
      if (!k) return null;
      const p = byId.get(k) || byName.get(k.toLowerCase());
      return p && p.active ? { id: p.id, name: p.name } : null;
    },
  };
}

/**
 * Decide the product for one incoming lead: a product named in the data wins if it matches one of the
 * organisation's products; otherwise the channel's / import's chosen product is used. A submitted name that
 * matches nothing is kept on the lead as extra info instead of being dropped.
 */
function applyProduct(f, products, fallback) {
  const m = f.product ? products.find(f.product) : null;
  if (f.product && !m) f.extra['Product (as submitted)'] = f.product;
  const chosen = m || (fallback && fallback.id ? fallback : null);
  return { matched: !!m, productId: chosen ? chosen.id : '', productName: chosen ? chosen.name : '' };
}

/** A named batch so a whole import can be found, assigned or dialled together. Returns its id. */
async function createBatch(orgId, name, createdBy) {
  const ref = db.collection('users').doc(orgId).collection('lead_batches').doc();
  await ref.set({
    name: String(name).trim().slice(0, 80) || 'Imported leads',
    createdBy, assignedTo: '', assignedToName: '', mode: 'manual',
    createdAt: FV.serverTimestamp(),
  });
  return ref.id;
}
async function deleteBatch(orgId, batchId) {
  await db.collection('users').doc(orgId).collection('lead_batches').doc(batchId).delete().catch(() => {});
}

/**
 * Create one lead.
 * @returns {{status:'created'|'duplicate'|'invalid', id?:string, reason?:string}}
 */
async function ingestLead(orgId, f, { createdBy = '', defaultSource = 'websiteForm', sourceLabel = 'Capture', extraCustom = {}, productId = '', productName = '', batchId = '' } = {}) {
  const email = EMAIL_RE.test(f.email || '') ? f.email.toLowerCase() : '';
  let phone = String(f.phone || '').trim();
  let phoneNorm = normalizePhone(phone);
  if (phoneNorm && phoneNorm.length < 8) { phone = ''; phoneNorm = ''; }    // not a real number
  const name = (f.name || '').trim() || (email ? email.split('@')[0] : '') || phone;
  if (!name) return { status: 'invalid', reason: 'needs at least a name, phone or email' };

  const source = normalizeSource(f.source) || defaultSource;
  const orgRef = db.collection('users').doc(orgId);
  const leadRef = orgRef.collection('leads').doc();
  const idxRef = phoneNorm ? orgRef.collection('lead_phone_index').doc(phoneNorm) : null;

  // ── duplicate check — same rule as the app: one lead per phone ──
  if (idxRef) {
    try {
      await idxRef.create({ leadId: leadRef.id, createdBy, createdAt: FV.serverTimestamp() });
    } catch (e) {
      if (!(e.code === 6 || e.code === 'already-exists')) throw e;
      const idx = await idxRef.get();
      const existingId = idx.exists ? idx.data().leadId : null;
      const stillThere = existingId ? (await orgRef.collection('leads').doc(existingId).get()).exists : false;
      if (stillThere) return { status: 'duplicate', id: existingId };
      await idxRef.set({ leadId: leadRef.id, createdBy, createdAt: FV.serverTimestamp() });   // index pointed at a deleted lead
    }
  } else if (email) {
    const dup = await orgRef.collection('leads').where('email', '==', email).limit(1).get();
    if (!dup.empty) return { status: 'duplicate', id: dup.docs[0].id };
  }

  const custom = {};
  for (const [k, v] of Object.entries({ ...(f.extra || {}), ...extraCustom })) {
    if (Object.keys(custom).length >= 25) break;
    custom[String(k).slice(0, 40)] = String(v).slice(0, 300);
  }
  const value = Number(String(f.value || '').replace(/[^0-9.]/g, ''));

  const doc = {
    name: name.slice(0, 120), email, phone, company: String(f.company || '').slice(0, 120),
    stage: 'new_', priority: 'warm', assignedTo: '',
    estimatedValue: Number.isFinite(value) && value > 0 ? value : null,
    notes: String(f.notes || '').slice(0, 2000),
    source, sourceCustom: sourceLabel,
    activities: [{
      id: crypto.randomUUID(), note: `Captured via ${sourceLabel}`, type: 'source',
      createdBy: 'System', createdAt: admin.firestore.Timestamp.now(),
    }],
    followUps: [], sentEmails: [], customFields: custom, categories: [],
    ownerId: '', ownerName: '', createdBy, batchId, sharedWith: [],
    // Which of the company's products this lead is for ('' = none). Mirrors LeadModel.productId/productName.
    productId, productName,
    // Unassigned leads are visible to the admin only; a person importing their own sees them too.
    visibleTo: createdBy ? [createdBy] : [],
    phoneNorm, createdAt: FV.serverTimestamp(),
  };

  try {
    await leadRef.set(doc);
  } catch (e) {
    if (idxRef) await idxRef.delete().catch(() => {});   // don't leave a phone reserved for a lead that was never saved
    throw e;
  }
  return { status: 'created', id: leadRef.id };
}

/** Many rows, a few at a time. rows: array of plain objects (any field naming). */
async function ingestMany(orgId, rows, opts, { max = 5000, concurrency = 8 } = {}) {
  const result = { created: 0, duplicates: 0, invalid: 0, unmatchedProducts: 0, errors: [] };
  const products = await loadProducts(orgId);
  const list = rows.slice(0, max);
  if (rows.length > max) result.errors.push(`Only the first ${max} rows were processed.`);
  for (let i = 0; i < list.length; i += concurrency) {
    await Promise.all(list.slice(i, i + concurrency).map(async (raw, j) => {
      const rowNo = i + j + 2;                       // +2: row 1 is the header
      try {
        const f = mapFields(raw);
        // A "product" column in the file wins for that row when it matches one of your products;
        // otherwise the product chosen for the whole import is used.
        const pr = applyProduct(f, products, { id: opts.productId, name: opts.productName });
        if (f.product && !pr.matched) result.unmatchedProducts++;
        const r = await ingestLead(orgId, f, { ...opts, productId: pr.productId, productName: pr.productName });
        if (r.status === 'created') result.created++;
        else if (r.status === 'duplicate') result.duplicates++;
        else { result.invalid++; if (result.errors.length < 25) result.errors.push(`Row ${rowNo}: ${r.reason}`); }
      } catch (e) {
        result.invalid++;
        if (result.errors.length < 25) result.errors.push(`Row ${rowNo}: ${e.message}`);
      }
    }));
  }
  return result;
}

// ── Push to the organisation admin when a lead arrives on its own (best-effort) ──
async function notifyNewLead(orgId, lead, sourceLabel) {
  try {
    const snap = await db.collection('users').doc(orgId).get();
    if (!snap.exists) return;
    const u = snap.data();
    if (u.pushNotifications === false || u.notifyNewLeads === false) return;
    const tokens = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    if (!tokens.length) return;
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title: '🎯 New lead', body: `${lead.name || 'Someone'} · ${sourceLabel}` },
      data: { type: 'lead' },
      android: { priority: 'high', notification: { channelId: 'astric_main', color: '#C8A96E' } },
    });
    const dead = tokens.filter((_, i) => !res.responses[i].success &&
      ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(res.responses[i].error?.code));
    if (dead.length) await db.collection('users').doc(orgId).update({ fcmTokens: FV.arrayRemove(...dead) });
  } catch (e) { console.warn('[leadCapture] notify failed:', e.message); }
}

module.exports = { normalizePhone, normalizeSource, mapFields, ingestLead, ingestMany, notifyNewLead, loadProducts, applyProduct, createBatch, deleteBatch, SOURCES };
