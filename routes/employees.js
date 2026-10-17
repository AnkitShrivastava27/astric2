// routes/employees.js
//
// Server-authoritative employee management. Why this exists:
//
//   The Flutter app used to (1) create a Firebase Auth user, (2) write users/{uid},
//   and only THEN (3) write users/{admin}/employees/{uid}. When step 3 was refused
//   (Firestore permission denied — e.g. the plan limit was already reached) the
//   Auth user and users/{uid} were left behind as an orphan, so the same email could
//   never be used again, even after upgrading.
//
//   Here the plan limit is checked FIRST, on the server, from the real Firestore data
//   (never from a client-side cached list). Nothing is created when the limit is
//   reached, and if anything fails half-way everything that was created is rolled
//   back. Deleting an employee removes the Auth login too, so the email is reusable.
//
// All routes need `Authorization: Bearer <Firebase ID token>` of the ADMIN.
//
//   GET    /employees/limit        -> { plan, count, max, unlimited, canAdd }
//   POST   /employees              -> create (checks limit, creates login + records)
//   PATCH  /employees/:id          -> edit details (optionally email / password)
//   DELETE /employees/:id          -> remove login + records + every reference (chat, leads, tasks...)
//   POST   /employees/cleanup-orphans -> repair leftovers from employees deleted earlier
//   POST   /employees/sync-team-chat -> make sure every employee is in the team group chat
'use strict';

const express = require('express');
const router = express.Router();
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const teamChat = require('../services/teamChat');
const { purgeEmployee, repairOrphans } = require('../services/employeeCleanup');

const DEFAULT_LIMITS = { basic: 3, standard: 10, premium: 20 };
const EMP_TYPES = ['fullTime', 'partTime', 'contractor', 'intern'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(status, error, code, extra = {}) { super(error); this.status = status; this.code = code; this.extra = extra; }
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.extra });
    console.error('[employees]', e);
    return res.status(500).json({ error: 'Something went wrong. Please try again.', code: 'server_error' });
  }
};

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function requireAdminUser(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) throw new HttpError(403, 'No account found for this login.', 'no_account');
  const u = snap.data();
  if (u.role === 'employee') throw new HttpError(403, 'Only the account admin can manage employees.', 'not_admin');
  return u;
}

// The plan the admin is on RIGHT NOW (an expired paid plan counts as basic, like the app does).
function currentPlan(user) {
  const s = user.subscription;
  if (!s || !s.plan || s.plan === 'basic') return 'basic';
  if (!s.active) return 'basic';
  const exp = s.expiresAt && s.expiresAt.toDate ? s.expiresAt.toDate() : null;
  if (exp && exp.getTime() <= Date.now()) return 'basic';
  return ['standard', 'premium'].includes(s.plan) ? s.plan : 'basic';
}

async function limitFor(plan) {
  let limits = DEFAULT_LIMITS;
  try {
    const g = await db.collection('appConfig').doc('planGating').get();
    const sl = g.exists ? (g.data().screenLimits || {}) : {};
    limits = {
      basic: sl.max_employees_basic ?? DEFAULT_LIMITS.basic,
      standard: sl.max_employees_standard ?? DEFAULT_LIMITS.standard,
      premium: sl.max_employees_premium ?? DEFAULT_LIMITS.premium,
    };
  } catch (e) { console.warn('[employees] planGating unreadable, using defaults:', e.message); }
  const n = Number(limits[plan]);
  return Number.isFinite(n) ? n : DEFAULT_LIMITS[plan];
}

async function countEmployees(adminId) {
  const c = await db.collection('users').doc(adminId).collection('employees').count().get();
  return c.data().count;
}

async function limitInfo(adminId, user) {
  const plan = currentPlan(user);
  const max = await limitFor(plan);
  const count = await countEmployees(adminId);
  const unlimited = max < 0;
  return { plan, count, max, unlimited, canAdd: unlimited || count < max };
}

const limitError = (info) => new HttpError(403,
  `Your ${info.plan[0].toUpperCase() + info.plan.slice(1)} plan allows ${info.max} team member${info.max === 1 ? '' : 's'} and you have already added ${info.count}. ` +
  'Upgrade your plan to add more.', 'limit_reached', { plan: info.plan, count: info.count, max: info.max });

// EMP001, EMP002 … never reused or duplicated (a counter, not "count + 1", which collided after deletions).
async function nextEmpId(adminId) {
  const ref = db.collection('users').doc(adminId).collection('counters').doc('employees');
  const n = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    let next;
    if (snap.exists) next = snap.data().next;
    else {
      const all = await tx.get(db.collection('users').doc(adminId).collection('employees').select('empId'));
      next = all.docs.reduce((m, d) => Math.max(m, parseInt(String(d.data().empId || '').replace(/\D/g, ''), 10) || 0), 0) + 1;
    }
    tx.set(ref, { next: next + 1 });
    return next;
  });
  return 'EMP' + String(n).padStart(3, '0');
}

function cleanFields(b) {
  const type = EMP_TYPES.includes(b.type) ? b.type : 'fullTime';
  const designation = str(b.designation || b.role, 80);
  return {
    name: str(b.name, 60),
    phone: str(b.phone, 20),
    designation,
    role: designation,                       // the app's existing field name for the job title
    department: str(b.department, 80) || 'General',
    branch: str(b.branch, 80),
    type,
    salary: Number.isFinite(Number(b.salary)) ? Math.max(0, Number(b.salary)) : 0,
  };
}

// ── GET /employees/limit ──────────────────────────────────────────────────────
router.get('/employees/limit', requireAuth, wrap(async (req, res) => {
  const user = await requireAdminUser(req.uid);
  res.json(await limitInfo(req.uid, user));
}));

// ── POST /employees ───────────────────────────────────────────────────────────
router.post('/employees',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `emp-create:${r.uid}` }),
  wrap(async (req, res) => {
    const adminId = req.uid;
    const adminUser = await requireAdminUser(adminId);

    // 1) LIMIT FIRST — before anything exists anywhere.
    const info = await limitInfo(adminId, adminUser);
    if (!info.canAdd) throw limitError(info);

    const f = cleanFields(req.body || {});
    const email = str((req.body || {}).email, 120).toLowerCase();
    const password = typeof (req.body || {}).password === 'string' ? req.body.password : '';
    if (!f.name || !f.designation) throw new HttpError(400, 'Name and designation are required.', 'invalid');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'invalid');
    if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.', 'invalid');

    // 2) Login. An email that exists in Auth but has NO app profile is a leftover from an old failed
    //    attempt: reuse it. An email with a profile belongs to a real account: refuse.
    let uid; let createdAuth = false;
    try {
      const existing = await admin.auth().getUserByEmail(email);
      const profile = await db.collection('users').doc(existing.uid).get();
      if (profile.exists) throw new HttpError(409, 'This email is already registered to another user.', 'email_in_use');
      await admin.auth().updateUser(existing.uid, { password, displayName: f.name, disabled: false });
      uid = existing.uid;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e.code !== 'auth/user-not-found') throw e;
      const u = await admin.auth().createUser({ email, password, displayName: f.name, emailVerified: true });
      uid = u.uid; createdAuth = true;
    }

    // 3) Records, written together; undo everything if any step fails.
    const empId = await nextEmpId(adminId);
    const userRef = db.collection('users').doc(uid);
    const empRef = db.collection('users').doc(adminId).collection('employees').doc(uid);
    const now = admin.firestore.FieldValue.serverTimestamp();
    try {
      const batch = db.batch();
      batch.set(userRef, {
        name: f.name, email, organizationName: adminUser.organizationName || 'My Company',
        role: 'employee', empId, adminId, department: f.department, designation: f.designation, branch: f.branch,
        createdAt: now,
      });
      batch.set(empRef, {
        ...f, email, isActive: true, empId, joinDate: admin.firestore.Timestamp.now(),
      });
      await batch.commit();

      // Two admins' tabs adding at once could both have passed step 1: re-check and undo ours if over the limit.
      const after = await countEmployees(adminId);
      if (!info.unlimited && after > info.max) {
        await Promise.all([userRef.delete(), empRef.delete()]);
        if (createdAuth) await admin.auth().deleteUser(uid).catch(() => {});
        throw limitError({ ...info, count: after - 1 });
      }
    } catch (e) {
      if (!(e instanceof HttpError)) {
        await Promise.allSettled([userRef.delete(), empRef.delete()]);
        if (createdAuth) await admin.auth().deleteUser(uid).catch(() => {});
      }
      throw e;
    }
    // Put them in the team group chat right now (server-side, additive). Best-effort: a chat problem
    // must never undo or fail a successful employee creation.
    try { await teamChat.addMembers(adminId, adminUser.organizationName, [uid]); }
    catch (e) { console.warn('[employees] team chat add failed:', e.message); }
    res.status(201).json({ uid, empId });
  }));

// ── PATCH /employees/:id ──────────────────────────────────────────────────────
router.patch('/employees/:id', requireAuth, wrap(async (req, res) => {
  const adminId = req.uid; const id = req.params.id;
  await requireAdminUser(adminId);
  const empRef = db.collection('users').doc(adminId).collection('employees').doc(id);
  const empSnap = await empRef.get();
  if (!empSnap.exists) throw new HttpError(404, 'Employee not found.', 'not_found');

  const b = req.body || {};
  const f = cleanFields({ ...empSnap.data(), ...b });
  if (!f.name || !f.designation) throw new HttpError(400, 'Name and designation are required.', 'invalid');
  const upd = { ...f };
  if (typeof b.isActive === 'boolean') upd.isActive = b.isActive;

  const authUpd = {};
  const newEmail = b.email ? str(b.email, 120).toLowerCase() : '';
  if (newEmail && newEmail !== empSnap.data().email) {
    if (!EMAIL_RE.test(newEmail)) throw new HttpError(400, 'Enter a valid email address.', 'invalid');
    try { await admin.auth().getUserByEmail(newEmail); throw new HttpError(409, 'This email is already registered to another user.', 'email_in_use'); }
    catch (e) { if (e instanceof HttpError) throw e; if (e.code !== 'auth/user-not-found') throw e; }
    authUpd.email = newEmail; upd.email = newEmail;
  }
  if (typeof b.password === 'string' && b.password) {
    if (b.password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.', 'invalid');
    authUpd.password = b.password;
  }
  authUpd.displayName = f.name;
  if (typeof b.isActive === 'boolean') authUpd.disabled = !b.isActive;
  await admin.auth().updateUser(id, authUpd).catch((e) => { if (e.code !== 'auth/user-not-found') throw e; });

  const batch = db.batch();
  batch.update(empRef, upd);
  batch.set(db.collection('users').doc(id), {
    name: f.name, department: f.department, designation: f.designation, branch: f.branch,
    ...(upd.email ? { email: upd.email } : {}),
  }, { merge: true });
  await batch.commit();
  res.json({ ok: true });
}));

// ── DELETE /employees/:id ─────────────────────────────────────────────────────
router.delete('/employees/:id', requireAuth, wrap(async (req, res) => {
  const adminId = req.uid; const id = req.params.id;
  await requireAdminUser(adminId);
  const empRef = db.collection('users').doc(adminId).collection('employees').doc(id);
  const empSnap = await empRef.get();
  if (!empSnap.exists) throw new HttpError(404, 'Employee not found.', 'not_found');
  const prof = await db.collection('users').doc(id).get();
  if (prof.exists && prof.data().adminId !== adminId) throw new HttpError(403, 'This is not your employee.', 'forbidden');

  await admin.auth().deleteUser(id).catch((e) => { if (e.code !== 'auth/user-not-found') throw e; });
  await empRef.delete();
  // Remove them EVERYWHERE: profile + subcollections, chat rooms/DMs, lead & customer owners,
  // task assignees, file shares. Best-effort: a clean-up hiccup never fails a delete that worked.
  let cleanup = null;
  try { cleanup = await purgeEmployee(adminId, id, { name: empSnap.data().name || (prof.exists ? prof.data().name : '') }); }
  catch (e) { console.warn('[employees] cleanup failed:', e.message); }
  res.json({ ok: true, cleanup });
}));

// ── POST /employees/cleanup-orphans ───────────────────────────────────────────
// Repairs data left behind by employees deleted BEFORE the full clean-up existed (stale chat
// members, DMs, lead/customer owners, shares). Idempotent; called by the admin app on start.
router.post('/employees/cleanup-orphans',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 4, keyFn: r => `emp-orphans:${r.uid}` }),
  wrap(async (req, res) => {
    await requireAdminUser(req.uid);
    res.json({ ok: true, ...(await repairOrphans(req.uid)) });
  }));

// ── POST /employees/sync-team-chat ────────────────────────────────────────────
// Idempotent, additive. Reads the REAL employees collection (not any app's cached list) and makes
// sure each one — plus the admin — is in the team group chat. Safe to call on every admin app start.
router.post('/employees/sync-team-chat',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 6, keyFn: r => `team-sync:${r.uid}` }),
  wrap(async (req, res) => {
    const adminUser = await requireAdminUser(req.uid);
    const snap = await db.collection('users').doc(req.uid).collection('employees').select().get();
    const ids = snap.docs.map((d) => d.id);
    const ref = await teamChat.addMembers(req.uid, adminUser.organizationName, ids);
    res.json({ ok: !!ref, members: ids.length + 1 });
  }));

module.exports = router;
module.exports._test = { currentPlan, limitFor, cleanFields };
