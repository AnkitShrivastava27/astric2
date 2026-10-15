#!/usr/bin/env node
// READ-ONLY report: which admin accounts have no company name, or only the "My Company" placeholder,
// and how they signed up / when. It never writes anything.
//
//   node scripts/report-users-missing-company.js
//
// Why: the app lets a person leave "Company name" blank when signing up (it silently stores
// "My Company" instead), and Google sign-up never asks for one at all. Accounts created by older
// app versions, or outside the app (console/scripts), can have the field missing entirely. This
// shows which is which so you can decide what to do (e.g. ask those users to set a name).
'use strict';
const { admin, db } = require('../config/firebase');

(async () => {
  const buckets = { missing: [], empty: [], placeholder: [] };
  let scanned = 0, last = null;
  for (;;) {
    let q = db.collection('users').where('role', '==', 'admin').orderBy(admin.firestore.FieldPath.documentId()).limit(300);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    for (const d of page.docs) {
      scanned++; last = d;
      const u = d.data();
      const name = u.organizationName;
      const row = {
        uid: d.id, name: u.name || '', email: u.email || '',
        created: u.createdAt && u.createdAt.toDate ? u.createdAt.toDate().toISOString().slice(0, 10) : '(none)',
      };
      if (name === undefined || name === null) buckets.missing.push(row);
      else if (String(name).trim() === '') buckets.empty.push(row);
      else if (String(name).trim() === 'My Company') buckets.placeholder.push(row);
    }
    if (page.size < 300) break;
  }
  const show = (title, rows) => {
    console.log(`\n${title}: ${rows.length}`);
    rows.slice(0, 50).forEach((r) => console.log(`  ${r.created}  ${r.email.padEnd(38)} ${r.name}  [${r.uid}]`));
    if (rows.length > 50) console.log(`  … and ${rows.length - 50} more`);
  };
  console.log(`Admin accounts scanned: ${scanned}`);
  show('Field MISSING entirely (older app version / created outside the app)', buckets.missing);
  show('Field present but EMPTY', buckets.empty);
  show('Placeholder "My Company" (left blank at sign-up, or Google sign-up)', buckets.placeholder);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
