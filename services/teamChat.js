// services/teamChat.js
//
// Server-side maintenance of each organisation's "Team — <company>" group chat.
//
// WHY THIS EXISTS: the room used to be created/synced only by the ADMIN'S APP, and only
// when the admin happened to open the Team Chat screen — with a member list built from
// whatever employees the admin's phone had loaded at that moment. A new employee stayed
// out of the room's `memberIds` (so their `memberIds arrayContains <uid>` query returned
// nothing) until that exact sequence happened. Here the server (Admin SDK, bypasses
// rules) adds people at the moment they are created, from the real employees collection.
//
// DATA SHAPE IS UNCHANGED — same collection, same fields the app already reads/writes
// (users/{admin}/chat_rooms/{id}: type, isTeamGroup, name, memberIds, lastMessage,
// lastMessageAt, lastSenderId, unreadCounts). Everything here is ADDITIVE
// (arrayUnion): it can add members but can never wipe the list. Old Android builds keep
// working exactly as before.
'use strict';

const { admin, db } = require('../config/firebase');

const FV = admin.firestore.FieldValue;
const rooms = (adminId) => db.collection('users').doc(adminId).collection('chat_rooms');

/** The org's team room ref, or null. Flagged room first, legacy name match second. */
async function findTeamRoom(adminId, orgName) {
  const flagged = await rooms(adminId).where('isTeamGroup', '==', true).limit(1).get();
  if (!flagged.empty) return flagged.docs[0].ref;
  const name = (orgName || '').trim();
  if (name) {
    const byName = await rooms(adminId).where('name', '==', `Team — ${name}`).limit(1).get();
    if (!byName.empty) {
      await byName.docs[0].ref.update({ isTeamGroup: true });   // legacy room: adopt the flag
      return byName.docs[0].ref;
    }
  }
  return null;
}

/** Find the team room, creating it (once) when missing and the company has a name. */
async function ensureTeamRoom(adminId, orgName) {
  const existing = await findTeamRoom(adminId, orgName);
  if (existing) return existing;
  const name = (orgName || '').trim();
  if (!name) return null;                       // never create a blank-named group (same rule as the app)
  const ref = rooms(adminId).doc('team_group'); // fixed id: two racing callers can't create two rooms
  try {
    await ref.create({
      type: 'group', isTeamGroup: true, name: `Team — ${name}`, memberIds: [adminId],
      lastMessage: null, lastMessageAt: FV.serverTimestamp(), lastSenderId: null, unreadCounts: {},
    });
  } catch (e) {
    if (e.code !== 6 && !/already exists/i.test(e.message || '')) throw e;   // 6 = ALREADY_EXISTS
  }
  return ref;
}

/** Add people to the team room (always includes the admin). Returns the room ref or null. */
async function addMembers(adminId, orgName, uids) {
  const ref = await ensureTeamRoom(adminId, orgName);
  if (!ref) return null;
  const all = [...new Set([adminId, ...uids].filter(Boolean))];
  await ref.update({ memberIds: FV.arrayUnion(...all) });
  return ref;
}

/** Remove one person (deleted employee) from the team room. No-op if there is no room. */
async function removeMember(adminId, uid) {
  const ref = await findTeamRoom(adminId, '');
  if (!ref) return;
  await ref.update('memberIds', FV.arrayRemove(uid), new admin.firestore.FieldPath('unreadCounts', uid), FV.delete());
}

module.exports = { findTeamRoom, ensureTeamRoom, addMembers, removeMember };
