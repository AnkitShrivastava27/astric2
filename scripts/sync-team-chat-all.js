#!/usr/bin/env node
// One-time backfill: put EVERY existing employee of EVERY organisation into their
// company's "Team — …" group chat. Fixes "employee can't see the group chat" for
// accounts that already exist, without anyone having to update the app.
//
//   node scripts/sync-team-chat-all.js            # DRY RUN — prints what it would do, writes nothing
//   node scripts/sync-team-chat-all.js --apply    # actually does it
//
// Safe for production data: ADDITIVE only (arrayUnion on the team room's memberIds). It never
// removes members, never edits messages, never touches any other field, and it is idempotent —
// running it twice changes nothing the second time. Needs the same FIREBASE_* env vars as the server.
'use strict';
const { admin, db } = require('../config/firebase');
const teamChat = require('../services/teamChat');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(APPLY ? '▶ APPLY mode — writing changes' : '▶ DRY RUN — nothing will be written (add --apply to do it)');
  let orgs = 0, withEmployees = 0, wouldAdd = 0, failed = 0;

  let last = null;
  for (;;) {                                           // page through admins, 200 at a time
    let q = db.collection('users').where('role', '==', 'admin').orderBy(admin.firestore.FieldPath.documentId()).limit(200);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      orgs++; last = doc;
      const adminId = doc.id;
      const orgName = (doc.data().organizationName || '').trim();
      try {
        const emps = await db.collection('users').doc(adminId).collection('employees').select().get();
        if (emps.empty) continue;
        withEmployees++;
        const ids = emps.docs.map((d) => d.id);
        const room = await teamChat.findTeamRoom(adminId, orgName);
        const have = room ? new Set(((await room.get()).data() || {}).memberIds || []) : new Set();
        const missing = [adminId, ...ids].filter((id) => !have.has(id));
        if (!missing.length) continue;
        wouldAdd += missing.length;
        console.log(`${APPLY ? '✔' : '•'} ${orgName || '(no org name)'} [${adminId}]: ${room ? 'adds' : 'creates room +'} ${missing.length} member(s)`);
        if (APPLY) await teamChat.addMembers(adminId, orgName, ids);
      } catch (e) {
        failed++; console.error(`✖ ${adminId}: ${e.message}`);
      }
    }
    if (page.size < 200) break;
  }
  console.log(`\nOrganisations scanned: ${orgs} · with employees: ${withEmployees} · member slots ${APPLY ? 'added' : 'to add'}: ${wouldAdd} · errors: ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
