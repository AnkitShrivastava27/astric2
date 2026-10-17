// services/employeeCleanup.js
//
// Removes every trace of a deleted employee from an organisation's data, so nothing
// keeps showing them (chat lists, lead/customer owners, task assignees, file shares...).
//
// Two entry points:
//   purgeEmployee(adminId, empId, { name })  – run right after an employee is deleted.
//   repairOrphans(adminId)                   – finds references to people who are no longer
//                                              employees (deleted before this code existed)
//                                              and cleans them. Idempotent, safe to re-run.
//
// Everything is best-effort per step: one failing step is logged and reported but never
// stops the others, and never fails the delete that already succeeded.
'use strict';

const { admin, db } = require('../config/firebase');

const FV = admin.firestore.FieldValue;
const userDoc = (id) => db.collection('users').doc(id);

async function recursiveDelete(ref) {
  if (typeof db.recursiveDelete === 'function') return db.recursiveDelete(ref);
  await ref.delete();
}

async function commitInChunks(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((fn) => fn(batch));
    await batch.commit();
  }
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// ── leads / customers ───────────────────────────────────────────────────────
// Owner → unassigned, creator → the admin, removed from sharedWith / visibleTo.
async function cleanOwnedCollection(adminId, collName, deadIds) {
  const col = userDoc(adminId).collection(collName);
  const docs = new Map();
  for (const id of deadIds) {
    for (const [field, op] of [['visibleTo', 'array-contains'], ['ownerId', '=='], ['createdBy', '=='], ['sharedWith', 'array-contains']]) {
      try { (await col.where(field, op, id).get()).forEach((d) => docs.set(d.id, d)); }
      catch (e) { console.warn(`[cleanup] ${collName}.${field} query failed:`, e.message); }
    }
  }
  const dead = new Set(deadIds);
  const ops = [];
  for (const d of docs.values()) {
    const x = d.data();
    const ownerGone = dead.has(x.ownerId);
    const ownerId = ownerGone ? '' : (x.ownerId || '');
    const createdBy = dead.has(x.createdBy) ? adminId : (x.createdBy || '');
    const sharedWith = (x.sharedWith || []).filter((u) => !dead.has(u));
    const upd = {
      createdBy, sharedWith,
      visibleTo: uniq([ownerId, createdBy, ...sharedWith]),
    };
    if (ownerGone) { upd.ownerId = ''; upd.ownerName = ''; upd.assignedTo = ''; }
    ops.push((b) => b.update(d.ref, upd));
  }
  await commitInChunks(ops);
  return ops.length;
}

// ── tasks (assigned by display NAME) ────────────────────────────────────────
async function cleanTasks(adminId, deadNames, liveNames) {
  const names = uniq(deadNames).filter((n) => !liveNames.has(n)); // never touch a name a live employee shares
  let n = 0;
  for (const name of names) {
    const snap = await userDoc(adminId).collection('tasks').where('assignedTo', '==', name).get();
    await commitInChunks(snap.docs.map((d) => (b) => b.update(d.ref, { assignedTo: 'Unassigned' })));
    n += snap.size;
  }
  return n;
}

// ── chat ────────────────────────────────────────────────────────────────────
// DMs with a deleted person are deleted (with their messages); group rooms just lose the member.
async function cleanChat(adminId, deadIds) {
  const rooms = userDoc(adminId).collection('chat_rooms');
  const seen = new Map();
  for (const id of deadIds) {
    (await rooms.where('memberIds', 'array-contains', id).get()).forEach((d) => seen.set(d.id, d));
  }
  const dead = new Set(deadIds);
  let removed = 0; let updated = 0;
  for (const d of seen.values()) {
    const x = d.data();
    if (x.type === 'direct') { await recursiveDelete(d.ref); removed++; continue; }
    const upd = { memberIds: FV.arrayRemove(...deadIds) };
    for (const id of dead) upd[`unreadCounts.${id}`] = FV.delete();
    await d.ref.update(upd);
    updated++;
  }
  return { directRoomsDeleted: removed, groupsUpdated: updated };
}

// ── file shares ─────────────────────────────────────────────────────────────
async function cleanFileShares(adminId, deadIds) {
  const col = userDoc(adminId).collection('fileShares');
  const seen = new Map();
  for (const id of deadIds) {
    for (const f of ['senderId', 'recipientId']) (await col.where(f, '==', id).get()).forEach((d) => seen.set(d.id, d));
  }
  for (const d of seen.values()) await recursiveDelete(d.ref);
  return seen.size;
}

// ── voice calls: only the access list needs fixing, the call record stays ───
async function cleanVoiceCalls(adminId, deadIds) {
  const col = userDoc(adminId).collection('voice_calls');
  let n = 0;
  for (const id of deadIds) {
    const snap = await col.where('visibleTo', 'array-contains', id).get();
    await commitInChunks(snap.docs.map((d) => (b) => b.update(d.ref, { visibleTo: FV.arrayRemove(id) })));
    n += snap.size;
  }
  return n;
}

async function step(report, key, fn) {
  try { report[key] = await fn(); }
  catch (e) { console.warn(`[cleanup] ${key} failed:`, e.message); report[key] = { error: e.message }; }
}

async function purgeReferences(adminId, deadIds, deadNames) {
  const report = {};
  const live = await userDoc(adminId).collection('employees').select('name').get();
  const liveNames = new Set(live.docs.map((d) => d.data().name).filter(Boolean));
  await step(report, 'leads', () => cleanOwnedCollection(adminId, 'leads', deadIds));
  await step(report, 'customers', () => cleanOwnedCollection(adminId, 'customers', deadIds));
  await step(report, 'tasks', () => cleanTasks(adminId, deadNames, liveNames));
  await step(report, 'chat', () => cleanChat(adminId, deadIds));
  await step(report, 'fileShares', () => cleanFileShares(adminId, deadIds));
  await step(report, 'voiceCalls', () => cleanVoiceCalls(adminId, deadIds));
  for (const id of deadIds) {
    await step(report, `personal_${id}`, () => recursiveDelete(userDoc(adminId).collection('employeePersonal').doc(id)));
  }
  return report;
}

/** Run after an employee's login + employee record were deleted. */
async function purgeEmployee(adminId, empId, { name = '' } = {}) {
  const report = await purgeReferences(adminId, [empId], [name]);
  // The employee's own profile + all its subcollections (notes, fcm tokens, ...).
  await step(report, 'profile', () => recursiveDelete(userDoc(empId)));
  return report;
}

/**
 * Cleans references to anyone who is NOT the admin and NOT a current employee.
 * Finds them from the data itself (leads, customers, chat members, file shares).
 */
async function repairOrphans(adminId) {
  const emps = await userDoc(adminId).collection('employees').select().get();
  const valid = new Set([adminId, ...emps.docs.map((d) => d.id)]);

  const found = new Set();
  const rooms = await userDoc(adminId).collection('chat_rooms').get();
  rooms.forEach((d) => (d.data().memberIds || []).forEach((m) => { if (!valid.has(m)) found.add(m); }));
  for (const c of ['leads', 'customers']) {
    const snap = await userDoc(adminId).collection(c).select('ownerId', 'sharedWith').get();
    snap.forEach((d) => {
      const x = d.data();
      if (x.ownerId && !valid.has(x.ownerId)) found.add(x.ownerId);
      (x.sharedWith || []).forEach((m) => { if (!valid.has(m)) found.add(m); });
    });
  }
  const shares = await userDoc(adminId).collection('fileShares').select('senderId', 'recipientId').get();
  shares.forEach((d) => [d.data().senderId, d.data().recipientId].forEach((m) => { if (m && !valid.has(m)) found.add(m); }));

  const deadIds = [...found];
  if (!deadIds.length) return { orphans: 0 };

  // A person who still has a profile belonging to ANOTHER company is not ours to touch.
  const safe = [];
  for (const id of deadIds) {
    const p = await userDoc(id).get();
    if (p.exists && p.data().adminId && p.data().adminId !== adminId) continue;
    safe.push(id);
  }
  // Names for task clean-up come from whatever profile docs are still around.
  const names = [];
  for (const id of safe) { const p = await userDoc(id).get(); if (p.exists && p.data().name) names.push(p.data().name); }
  const report = await purgeReferences(adminId, safe, names);
  // Leftover profiles of ex-employees of THIS company (their employee record is already gone).
  for (const id of safe) {
    const p = await userDoc(id).get();
    if (p.exists && p.data().adminId === adminId && p.data().role === 'employee') {
      await admin.auth().deleteUser(id).catch(() => {});
      await step(report, `profile_${id}`, () => recursiveDelete(userDoc(id)));
    }
  }
  return { orphans: safe.length, report };
}

module.exports = { purgeEmployee, repairOrphans };
