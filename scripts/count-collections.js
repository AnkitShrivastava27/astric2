#!/usr/bin/env node
// Prints how many documents each big collection of ONE company holds, so we know where Firestore reads really go.
//
//   node scripts/count-collections.js <adminUid>
//
// Read-only. Uses count() queries, which cost about one read per 1,000 documents — so running it is practically
// free. Needs the same FIREBASE_* env vars as the server.
'use strict';
const { db } = require('../config/firebase');

const COLLECTIONS = [
  'leads', 'customers', 'tasks', 'projects', 'invoices', 'transactions', 'notes', 'products', 'employees', 'teams',
  'calendar_events', 'calendar_private', 'conversations', 'chat_rooms', 'lead_batches', 'voice_calls',
];

(async () => {
  const uid = process.argv[2];
  if (!uid) { console.error('Usage: node scripts/count-collections.js <adminUid>'); process.exit(1); }
  const base = db.collection('users').doc(uid);
  const rows = [];
  for (const name of COLLECTIONS) {
    try {
      const snap = await base.collection(name).count().get();
      rows.push([name, snap.data().count]);
    } catch (e) {
      rows.push([name, `error: ${e.message}`]);
    }
  }
  rows.sort((a, b) => (typeof b[1] === 'number' ? b[1] : -1) - (typeof a[1] === 'number' ? a[1] : -1));
  console.log(`\nDocuments under users/${uid}:\n`);
  for (const [name, n] of rows) console.log(`  ${name.padEnd(18)} ${n}`);
  console.log('\nA live listener on a collection costs one read per document each time it starts fresh.');
  process.exit(0);
})();
