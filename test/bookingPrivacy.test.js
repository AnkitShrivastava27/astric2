const test = require('node:test');
const assert = require('node:assert');
const { make } = require('./fakeFirestore');

const fake = make();
const fbPath = require.resolve('../config/firebase');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { db: fake.db, admin: fake.admin } };
const router = require('../routes/booking');
const { slotsFor, normalize } = router._test;

const ORG = 'boss';
const DAY = new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10);          // a day well inside the booking window
const settings = normalize({ durationMin: 30, bufferMin: 0, minNoticeHours: 0, maxDaysAhead: 30, timezone: 'UTC',
  weekly: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, [{ start: '09:00', end: '12:00' }]])) });
const has = (slots, hhmm) => JSON.stringify(slots).includes(`T${hhmm}`) || slots.some((x) => String(x.time || x.start || x).includes(hhmm));
const evAt = (hh) => ({ title: 'x', startTime: `${DAY}T${hh}:00:00.000`, endTime: `${DAY}T${hh === '10' ? '10:30' : '11:30'}:00.000`, isAllDay: false });

test('a restricted event that includes the owner blocks the time; one that does not, does not', async () => {
  const org = fake.db.collection('users').doc(ORG);
  const base = await slotsFor(ORG, settings, DAY);
  assert.ok(base.length >= 5, 'sanity: the day has free slots');
  await org.collection('calendar_private').doc('a').set({ ...evAt('10'), visibleTo: [ORG, 'emp1'], createdBy: ORG });        // the owner is in it
  await org.collection('calendar_private').doc('b').set({ ...evAt('11'), visibleTo: ['emp1', 'emp2'], createdBy: 'emp1' });  // two employees only
  const after = await slotsFor(ORG, settings, DAY);
  assert.strictEqual(after.length, base.length - 1, 'exactly the owner\'s private meeting removed one slot');
});
test('shared events still block, exactly as before', async () => {
  const before = await slotsFor(ORG, settings, DAY);
  await fake.db.collection('users').doc(ORG).collection('calendar_events').doc('s1').set(evAt('11'));
  assert.strictEqual((await slotsFor(ORG, settings, DAY)).length, before.length - 1);
});
