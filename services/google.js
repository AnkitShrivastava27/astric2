/**
 * services/google.js — Google OAuth + the three Google APIs Astric uses (People/Contacts, Drive, Calendar).
 *
 * BRING YOUR OWN GOOGLE APP: each company registers its own OAuth client in Google Cloud and pastes the Client ID +
 * Secret into Astric (admin only). The secret is stored encrypted (users/{org}/google_app/main) and never leaves the
 * server. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in the server env are only an optional fallback for a company
 * that has not set its own.
 *
 * Each person connects THEIR OWN Google account (contacts and calendars are personal). Tokens live in
 * users/{uid}/google_connection/main, encrypted (services/secretBox); the app never sees them.
 *
 * Scopes (asked per feature, added one at a time as the person connects each):
 *   contacts → contacts.readonly   (read only: Astric can never change your Google contacts)
 *   calendar → calendar.events     (read + create events)
 *   drive    → drive.readonly      (read only; lets the person link folders to browse inside Astric)
 */
'use strict';

const axios = require('axios');
const { admin, db } = require('../config/firebase');
const { encrypt, mask, encryptFields, decryptFields } = require('./secretBox');
const env = require('../config/env');

const deps = { http: axios };
const SCOPES = {
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
};
const BASE_SCOPES = ['openid', 'email'];
const SECRET_FIELDS = ['accessToken', 'refreshToken'];

class GoogleError extends Error {
  constructor(message, { status = 502, reconnect = false, setup = false, code = 'google' } = {}) { super(message); this.status = status; this.reconnect = reconnect; this.setup = setup; this.code = code; }
}

// Server-only collection: no Firestore rule matches it, so the app can never read the (encrypted) tokens.
const channelRef = (uid) => db.collection('users').doc(uid).collection('google_connection').doc('main');
const redirectUri = () => `${env.SERVER_BASE_URL}/integrations/google/callback`;

// ── The company's own Google app (Client ID + Secret) ───────────────────────────────────────────────────
const appRef = (org) => db.collection('users').doc(org).collection('google_app').doc('main');
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/;

async function orgOf(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw new GoogleError('User not found.', { status: 404 });
  const u = snap.data();
  return { org: (u.role === 'employee' && u.adminId) ? u.adminId : uid, isAdmin: u.role === 'admin' || !u.role };
}

/** The credentials this person's company registered, else the optional server-wide pair, else null. */
async function appCreds(uid) {
  const { org } = await orgOf(uid);
  const s = await appRef(org).get();
  if (s.exists) {
    const d = decryptFields(s.data(), ['clientSecret']);
    if (d.clientId && d.clientSecret) return { clientId: d.clientId, clientSecret: d.clientSecret, source: 'company' };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, source: 'server' };
  return null;
}
async function needCreds(uid) {
  const c = await appCreds(uid);
  if (!c) throw new GoogleError('Your company has not set up its Google app yet. An admin can do this under Integrations → Google.', { status: 400, setup: true, code: 'not_configured' });
  return c;
}
const configured = async (uid) => !!(await appCreds(uid));

async function tokenCall(creds, params) {
  try {
    const r = await deps.http.post('https://oauth2.googleapis.com/token', new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, ...params }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 });
    return r.data;
  } catch (e) {
    const d = e.response && e.response.data;
    const code = d && d.error;
    if (code === 'invalid_client') throw new GoogleError("Google rejected your company's app credentials (Client ID / Secret). An admin should check them under Integrations → Google.", { status: 400, setup: true, code: 'invalid_client' });
    if (code === 'invalid_grant' || code === 'unauthorized_client') throw new GoogleError('Your Google connection expired. Please connect again.', { status: 401, reconnect: true, code: 'invalid_grant' });
    throw new GoogleError('Could not reach Google. Please try again.', { status: 502 });
  }
}

/**
 * Checks a Client ID / Secret pair with Google BEFORE we save it. A throw-away code is sent: a real client answers
 * "invalid_grant" (bad code), a wrong ID or secret answers "invalid_client". Nothing is created at Google.
 */
async function verifyCreds(clientId, clientSecret) {
  try {
    await deps.http.post('https://oauth2.googleapis.com/token', new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: 'astric-check', grant_type: 'authorization_code', redirect_uri: redirectUri() }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12_000 });
    return { ok: true };
  } catch (e) {
    const code = e.response && e.response.data && e.response.data.error;
    if (code === 'invalid_client') return { ok: false, reason: 'Google does not accept this Client ID and Secret. Check you copied both from the same OAuth client.' };
    if (e.response) return { ok: true };            // invalid_grant / invalid_request: the client itself was recognised
    return { ok: null, reason: 'Could not reach Google to check them.' };
  }
}

async function getApp(uid) {
  const { org, isAdmin } = await orgOf(uid);
  const s = await appRef(org).get();
  const d = s.exists ? s.data() : {};
  let masked = '';
  try { masked = d.clientSecret ? mask(d.clientSecret) : ''; } catch (_) { masked = '••••••••'; }
  const c = await appCreds(uid);
  return { configured: !!c, source: c ? c.source : '', clientId: d.clientId || '', secretMasked: masked, redirectUri: redirectUri(), canEdit: isAdmin };
}

async function saveApp(uid, clientId, clientSecret) {
  const { org, isAdmin } = await orgOf(uid);
  if (!isAdmin) throw new GoogleError('Only an admin can change the Google app credentials.', { status: 403 });
  clientId = String(clientId || '').trim(); clientSecret = String(clientSecret || '').trim();
  if (!CLIENT_ID_RE.test(clientId)) throw new GoogleError('That does not look like a Google Client ID. It ends with ".apps.googleusercontent.com".', { status: 400 });
  if (clientSecret.length < 10 || clientSecret.length > 200 || /\s/.test(clientSecret)) throw new GoogleError('That does not look like a Google Client Secret.', { status: 400 });
  const v = await verifyCreds(clientId, clientSecret);
  if (v.ok === false) throw new GoogleError(v.reason, { status: 400, code: 'invalid_client' });
  if (v.ok === null) throw new GoogleError(`${v.reason} Check your connection and try again.`, { status: 502 });
  await appRef(org).set({ clientId, clientSecret: encrypt(clientSecret), updatedAt: admin.firestore.Timestamp.now(), updatedBy: uid });
}

async function removeApp(uid) {
  const { org, isAdmin } = await orgOf(uid);
  if (!isAdmin) throw new GoogleError('Only an admin can remove the Google app credentials.', { status: 403 });
  await appRef(org).delete();
}

async function authUrl({ uid, service, state, grantedScopes = [] }) {
  if (!SCOPES[service]) throw new GoogleError('Unknown Google service.', { status: 400 });
  const creds = await needCreds(uid);
  const scope = [...new Set([...BASE_SCOPES, ...grantedScopes, SCOPES[service]])].join(' ');
  const q = new URLSearchParams({
    client_id: creds.clientId, redirect_uri: redirectUri(), response_type: 'code', scope,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Exchange the code from Google's redirect and save the (encrypted) tokens. */
async function completeConnect({ uid, service, code }) {
  const t = await tokenCall(await needCreds(uid), { code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const granted = String(t.scope || '').split(' ').filter(Boolean);
  const prev = await channelRef(uid).get();
  const old = prev.exists ? decryptFields(prev.data(), SECRET_FIELDS) : {};
  const refreshToken = t.refresh_token || old.refreshToken || '';
  if (!refreshToken) throw new GoogleError('Google did not allow ongoing access. Remove Astric at myaccount.google.com/permissions and connect again.', { status: 400 });
  let email = old.email || '';
  try {
    const u = await deps.http.get('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` }, timeout: 10_000 });
    email = u.data.email || email;
  } catch (_) { /* the email is only for display */ }
  const services = { ...(old.services || {}) };
  for (const [name, scope] of Object.entries(SCOPES)) if (granted.includes(scope)) services[name] = true;
  if (!granted.includes(SCOPES[service])) throw new GoogleError('That permission was not granted, so it could not be connected.', { status: 400, code: 'scope_denied' });
  await channelRef(uid).set(encryptFields({
    accessToken: t.access_token, refreshToken, expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
    scopes: granted, services, email, connectedAt: Date.now(),
  }, SECRET_FIELDS));
  return { email, services };
}

async function getStatus(uid) {
  const snap = await channelRef(uid).get();
  const { isAdmin } = await orgOf(uid);
  const cfg = await configured(uid);
  if (!snap.exists) return { connected: false, configured: cfg, isAdmin, email: '', services: { contacts: false, drive: false, calendar: false } };
  const d = snap.data();
  return { connected: true, configured: cfg, isAdmin, email: d.email || '', services: { contacts: !!(d.services || {}).contacts, drive: !!(d.services || {}).drive, calendar: !!(d.services || {}).calendar } };
}

async function accessFor(uid, service) {
  const snap = await channelRef(uid).get();
  if (!snap.exists) throw new GoogleError('Google is not connected.', { status: 400, reconnect: true, code: 'not_connected' });
  const d = decryptFields(snap.data(), SECRET_FIELDS);
  if (service && !(d.services || {})[service]) throw new GoogleError(`Google ${service} is not connected.`, { status: 400, reconnect: true, code: 'not_connected' });
  if (d.accessToken && d.expiresAt && d.expiresAt - Date.now() > 60_000) return d.accessToken;
  let t;
  try { t = await tokenCall(await needCreds(uid), { grant_type: 'refresh_token', refresh_token: d.refreshToken }); }
  catch (e) {
    if (e.reconnect) await channelRef(uid).delete().catch(() => {});   // the grant is gone: clear it so the app shows "Connect"
    throw e;
  }
  await channelRef(uid).set(encryptFields({ accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 }, SECRET_FIELDS), { merge: true });
  return t.access_token;
}

async function api(uid, service, method, url, { params, data } = {}) {
  const token = await accessFor(uid, service);
  try {
    const r = await deps.http.request({ method, url, params, data, headers: { Authorization: `Bearer ${token}` }, timeout: 20_000 });
    return r.data;
  } catch (e) {
    const status = e.response && e.response.status;
    const reason = e.response && e.response.data && e.response.data.error && (e.response.data.error.message || e.response.data.error);
    if (status === 401) throw new GoogleError('Your Google connection expired. Please connect again.', { status: 401, reconnect: true });
    if (status === 403) throw new GoogleError(`Google refused this request${reason ? `: ${String(reason).slice(0, 120)}` : ''}. Check the ${service} API is enabled for the app and permission was granted.`, { status: 403 });
    if (status === 404) throw new GoogleError('That item was not found in Google (it may have been deleted).', { status: 404 });
    if (status === 429) throw new GoogleError('Google is limiting requests right now. Wait a minute and try again.', { status: 429 });
    throw new GoogleError('Could not reach Google. Please try again.', { status: 502 });
  }
}

async function disconnect(uid) {
  const snap = await channelRef(uid).get();
  if (snap.exists) {
    try { const d = decryptFields(snap.data(), SECRET_FIELDS); await deps.http.post(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(d.refreshToken || d.accessToken)}`, null, { timeout: 8_000 }); } catch (_) { /* revoke is best-effort */ }
  }
  await channelRef(uid).delete().catch(() => {});
}

// ── People (contacts) ────────────────────────────────────────────────────────
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,birthdays,metadata';
function normalizePerson(p) {
  const name = (p.names || [])[0] || {};
  const org = (p.organizations || [])[0] || {};
  const b = ((p.birthdays || []).find((x) => x.date) || {}).date || null;
  return {
    id: p.resourceName,
    name: (name.displayName || '').trim(),
    phone: ((p.phoneNumbers || [])[0] || {}).value || '',
    email: (((p.emailAddresses || [])[0] || {}).value || '').toLowerCase(),
    company: org.name || '',
    jobTitle: org.title || '',
    birthday: b && b.month && b.day ? { month: b.month, day: b.day, year: b.year || null } : null,
  };
}
async function listContacts(uid, { pageToken = '', pageSize = 200 } = {}) {
  const d = await api(uid, 'contacts', 'GET', 'https://people.googleapis.com/v1/people/me/connections', {
    params: { personFields: PERSON_FIELDS, pageSize: Math.min(Math.max(+pageSize || 200, 1), 1000), sortOrder: 'FIRST_NAME_ASCENDING', ...(pageToken ? { pageToken } : {}) },
  });
  return { contacts: (d.connections || []).map(normalizePerson).filter((c) => c.name || c.phone || c.email), nextPageToken: d.nextPageToken || '', totalItems: d.totalItems || d.totalPeople || 0 };
}
async function getContacts(uid, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const d = await api(uid, 'contacts', 'GET', 'https://people.googleapis.com/v1/people:batchGet', {
      params: new URLSearchParams([...chunk.map((id) => ['resourceNames', id]), ['personFields', PERSON_FIELDS]]),
    });
    for (const r of d.responses || []) if (r.person) out.push(normalizePerson(r.person));
  }
  return out;
}

// ── Calendar ─────────────────────────────────────────────────────────────────
function normalizeEvent(e) {
  const allDay = !!(e.start && e.start.date && !e.start.dateTime);
  return {
    id: e.id, title: e.summary || '(No title)', location: e.location || '', description: (e.description || '').slice(0, 500),
    allDay, start: (e.start && (e.start.dateTime || e.start.date)) || '', end: (e.end && (e.end.dateTime || e.end.date)) || '',
    link: e.htmlLink || '', meetLink: e.hangoutLink || '', status: e.status || '',
    attendees: (e.attendees || []).slice(0, 20).map((a) => a.email),
  };
}
async function listEvents(uid, { from, to, max = 250 }) {
  const d = await api(uid, 'calendar', 'GET', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    params: { timeMin: from, timeMax: to, singleEvents: true, orderBy: 'startTime', maxResults: Math.min(+max || 250, 500) },
  });
  return (d.items || []).filter((e) => e.status !== 'cancelled').map(normalizeEvent);
}
async function createEvent(uid, { title, start, end, description = '', location = '', timeZone = 'Asia/Kolkata' }) {
  const e = await api(uid, 'calendar', 'POST', 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    data: { summary: title, description, location, start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone } },
  });
  return normalizeEvent(e);
}

// ── Drive (browse only; nothing is copied into Astric) ───────────────────────
const FOLDER = 'application/vnd.google-apps.folder';
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
function normalizeFile(f) {
  return { id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, mimeType: f.mimeType, size: f.size ? +f.size : null, modified: f.modifiedTime || '', link: f.webViewLink || '', icon: f.iconLink || '' };
}
async function listDrive(uid, { parent = 'root', foldersOnly = false, pageToken = '' } = {}) {
  const q = [`'${esc(parent)}' in parents`, 'trashed = false', ...(foldersOnly ? [`mimeType = '${FOLDER}'`] : [])].join(' and ');
  const d = await api(uid, 'drive', 'GET', 'https://www.googleapis.com/drive/v3/files', {
    params: { q, pageSize: 100, orderBy: 'folder,name', fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)', supportsAllDrives: true, includeItemsFromAllDrives: true, ...(pageToken ? { pageToken } : {}) },
  });
  return { files: (d.files || []).map(normalizeFile), nextPageToken: d.nextPageToken || '' };
}
async function getDriveFile(uid, id) {
  const f = await api(uid, 'drive', 'GET', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { params: { fields: 'id,name,mimeType,parents,webViewLink,trashed', supportsAllDrives: true } });
  return { ...normalizeFile(f), parents: f.parents || [], trashed: !!f.trashed };
}
/** Is [folderId] one of the linked folders, or inside one? (walks up at most 12 levels) */
async function isInsideLinked(uid, folderId, linkedIds) {
  let cur = folderId;
  for (let i = 0; i < 12 && cur; i++) {
    if (linkedIds.has(cur)) return true;
    const f = await getDriveFile(uid, cur);
    cur = (f.parents || [])[0];
  }
  return false;
}

module.exports = {
  deps, SCOPES, GoogleError, channelRef, configured, orgOf, getApp, saveApp, removeApp, authUrl, completeConnect, getStatus, accessFor, disconnect,
  listContacts, getContacts, normalizePerson, listEvents, createEvent, normalizeEvent, listDrive, getDriveFile, isInsideLinked,
};
