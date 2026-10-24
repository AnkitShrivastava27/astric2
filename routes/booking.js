// routes/booking.js — "Book a meeting" page (Calendly-style), served by this server.
//
//   Public (no login — anyone with the link):
//     GET  /book/:orgId/:slug                 -> the booking page (pick a day, pick a time, enter details)
//     GET  /book/:orgId/:slug/info            -> page details (title, duration, weekdays, timezone…)
//     GET  /book/:orgId/:slug/slots?date=…    -> free times for one day
//     POST /book/:orgId/:slug                 -> book a slot
//
// Settings live in users/{org}/booking_settings/config (the admin edits them from Calendar → Booking page; Firestore
// rules let only the admin write). A booking creates:
//   • an event in the organisation's calendar (users/{org}/calendar_events) — so it shows up in the app and BLOCKS that
//     time for the next visitor,
//   • a lead in the CRM (source "Booking Page"), and
//   • a push notification to the owner.
// Times: calendar events are stored as the host's wall-clock time without a zone ("2026-10-27T10:00:00.000"), exactly as
// the app writes them. All slot maths therefore uses the host's timezone from the settings.
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { admin, db } = require('../config/firebase');
const { rateLimit } = require('../middleware/rateLimit');
const { mapFields, ingestLead } = require('../services/leadIngest');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_TZ = 'Asia/Kolkata';
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[booking]', req.method, req.path, e.message);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
const same = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

// ── time helpers (host timezone) ────────────────────────────────────────────
function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch (_) { return DEFAULT_TZ; }
}
function wallParts(utcMs, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  const g = (t) => parseInt(p.find((x) => x.type === t).value, 10);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
}
// "wall-clock ms": the wall time written as if it were UTC. Only ever compared with other wall-clock ms.
const wallMs = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
function nowWallMs(tz) { const p = wallParts(Date.now(), tz); return wallMs(p.y, p.mo, p.d, p.h, p.mi); }
function tzOffsetMs(utcMs, tz) { const p = wallParts(utcMs, tz); return wallMs(p.y, p.mo, p.d, p.h, p.mi) - Math.floor(utcMs / 60000) * 60000; }
function wallToUtc(wall, tz) { const guess = wall - tzOffsetMs(wall, tz); return wall - tzOffsetMs(guess, tz); }
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const fmtWall = (ms) => { const d = new Date(ms); return `${fmtDate(ms)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
function parseWall(str) {                       // "2026-10-27T10:00:00.000" (zone suffix, if any, is ignored)
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(str || ''));
  return m ? wallMs(+m[1], +m[2], +m[3], +m[4], +m[5]) : null;
}
const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null; };

// ── settings ────────────────────────────────────────────────────────────────
const settingsRef = (orgId) => db.collection('users').doc(orgId).collection('booking_settings').doc('config');

function normalize(s) {
  const weekly = {};
  for (const d of DAYS) {
    const list = Array.isArray(s.weekly?.[d]) ? s.weekly[d] : [];
    weekly[d] = list.map((w) => ({ a: hhmm(w.start), b: hhmm(w.end) }))
      .filter((w) => w.a !== null && w.b !== null && w.b > w.a)
      .map((w) => ({ a: w.a, b: w.b }));
  }
  return {
    title: String(s.title || 'Meeting').slice(0, 80),
    description: String(s.description || '').slice(0, 600),
    location: String(s.location || '').slice(0, 300),
    hostName: String(s.hostName || '').slice(0, 80),
    durationMin: clampInt(s.durationMin, 10, 240, 30),
    bufferMin: clampInt(s.bufferMin, 0, 120, 0),
    minNoticeHours: clampInt(s.minNoticeHours, 0, 720, 4),
    maxDaysAhead: clampInt(s.maxDaysAhead, 1, 180, 30),
    timezone: validTz(s.timezone || DEFAULT_TZ),
    weekly,
  };
}

async function load(orgId, slug) {
  const snap = await settingsRef(orgId).get();
  if (!snap.exists) return null;
  const raw = snap.data();
  if (raw.enabled !== true || !same(slug, raw.slug)) return null;
  return normalize(raw);
}

async function orgName(orgId) {
  const s = await db.collection('users').doc(orgId).get();
  const u = s.exists ? s.data() : {};
  return u.organizationName || u.companyName || u.name || 'Our team';
}

// ── free slots for one host-local date ──────────────────────────────────────
async function slotsFor(orgId, s, dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return [];
  const dayMs = wallMs(+m[1], +m[2], +m[3]);
  if (fmtDate(dayMs) !== dateStr) return [];                       // e.g. 2026-02-31
  const windows = s.weekly[DAYS[new Date(dayMs).getUTCDay()]] || [];
  if (!windows.length) return [];

  const now = nowWallMs(s.timezone);
  const earliest = now + s.minNoticeHours * 3600e3;
  const todayStart = Math.floor(now / 86400e3) * 86400e3;
  if (dayMs > todayStart + s.maxDaysAhead * 86400e3 || dayMs + 86400e3 <= earliest) return [];

  // Everything already in the calendar around that day blocks the time (all-day events block the whole day).
  const snap = await db.collection('users').doc(orgId).collection('calendar_events')
    .where('startTime', '>=', `${fmtDate(dayMs - 86400e3)}T00:00`)
    .where('startTime', '<', `${fmtDate(dayMs + 2 * 86400e3)}T00:00`).get();
  const busy = [];
  snap.forEach((d) => {
    const e = d.data();
    const a = parseWall(e.startTime); let b = parseWall(e.endTime);
    if (a === null) return;
    if (e.isAllDay === true) { busy.push([Math.floor(a / 86400e3) * 86400e3, Math.floor((b ?? a) / 86400e3) * 86400e3 + 86400e3]); return; }
    busy.push([a, b === null || b <= a ? a + 30 * 60e3 : b]);
  });

  const dur = s.durationMin * 60e3; const buf = s.bufferMin * 60e3;
  const out = [];
  for (const w of windows) {
    for (let t = dayMs + w.a * 60e3; t + dur <= dayMs + w.b * 60e3; t += dur) {
      if (t < earliest) continue;
      if (busy.some(([x, y]) => x - buf < t + dur && y + buf > t)) continue;
      out.push({ start: fmtWall(t), utc: new Date(wallToUtc(t, s.timezone)).toISOString() });
    }
  }
  return out;
}

// ── push to the owner ───────────────────────────────────────────────────────
async function notifyHost(orgId, title, body) {
  try {
    const snap = await db.collection('users').doc(orgId).get();
    if (!snap.exists) return;
    const u = snap.data();
    if (u.pushNotifications === false) return;
    const tokens = Array.isArray(u.fcmTokens) ? u.fcmTokens : [];
    if (!tokens.length) return;
    const res = await admin.messaging().sendEachForMulticast({
      tokens, notification: { title, body }, data: { type: 'calendar' },
      android: { priority: 'high', notification: { channelId: 'astric_main', color: '#C8A96E' } },
    });
    const dead = tokens.filter((_, i) => !res.responses[i].success &&
      ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(res.responses[i].error?.code));
    if (dead.length) await db.collection('users').doc(orgId).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) });
  } catch (e) { console.warn('[booking] notify failed:', e.message); }
}

// ── the page ────────────────────────────────────────────────────────────────
function page(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f5f6fa;--card:#fff;--tx:#14161f;--mut:#6b7080;--bd:#dfe2ec;--ac:#b8903f;--ok:#1a9d63}
@media(prefers-color-scheme:dark){:root{--bg:#0e0f14;--card:#171922;--tx:#f1f2f6;--mut:#9aa0b3;--bd:#2a2d3a;--ac:#c8a96e}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx);display:flex;min-height:100vh;align-items:flex-start;justify-content:center;padding:18px}
.card{width:100%;max-width:860px;background:var(--card);border:1px solid var(--bd);border-radius:18px;overflow:hidden;display:flex;flex-wrap:wrap}
.side{flex:1 1 260px;padding:26px;border-right:1px solid var(--bd)}.main{flex:2 1 380px;padding:26px}
h1{margin:0 0 6px;font-size:1.3rem}h2{margin:0 0 14px;font-size:1.05rem}.m{color:var(--mut);font-size:.9rem;line-height:1.5}
.pill{display:inline-block;margin:10px 8px 0 0;padding:5px 10px;border:1px solid var(--bd);border-radius:20px;font-size:.8rem;color:var(--mut)}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;text-align:center}
.cal .h{font-size:.72rem;color:var(--mut);padding:4px 0}
.cal button{aspect-ratio:1;border:0;border-radius:50%;background:transparent;color:var(--tx);font:inherit;font-size:.9rem;cursor:pointer}
.cal button.on{background:color-mix(in srgb,var(--ac) 16%,transparent);color:var(--ac);font-weight:700}
.cal button.sel{background:var(--ac);color:#fff}.cal button:disabled{opacity:.28;cursor:default}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-weight:700}
.nav button{border:1px solid var(--bd);background:transparent;color:var(--tx);border-radius:8px;padding:4px 12px;cursor:pointer;font-size:1rem}
.slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-top:6px}
.slots button{padding:11px 6px;border:1px solid var(--ac);background:transparent;color:var(--ac);border-radius:10px;font-weight:700;cursor:pointer;font:inherit}
.slots button:hover{background:var(--ac);color:#fff}
label{display:block;font-size:.8rem;font-weight:600;margin:14px 0 6px}
input,textarea{width:100%;padding:12px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:var(--tx);font:inherit}
textarea{min-height:80px;resize:vertical}input:focus,textarea:focus{outline:2px solid var(--ac);border-color:transparent}
.go{margin-top:18px;width:100%;padding:13px;border:0;border-radius:10px;background:var(--ac);color:#fff;font-weight:700;font-size:1rem;cursor:pointer}
.go:disabled{opacity:.6}.back{background:none;border:0;color:var(--ac);cursor:pointer;padding:0;margin-bottom:12px;font:inherit}
.err{color:#d33;font-size:.85rem;margin-top:12px;min-height:1em}.hp{position:absolute;left:-9999px;opacity:0;width:1px;height:1px}
.ok{text-align:center;padding:30px 10px}.ok .t{font-size:2.6rem;color:var(--ok)}a.ics{color:var(--ac);font-weight:600}
</style></head><body><div class="card">
<div class="side"><div class="m" id="org"></div><h1 id="title">&nbsp;</h1><div id="pills"></div><p class="m" id="desc"></p></div>
<div class="main" id="main"><div class="m">Loading…</div></div></div>
<script>
const $=id=>document.getElementById(id),base=location.pathname.replace(/\\/$/,'');
const myTz=Intl.DateTimeFormat().resolvedOptions().timeZone;let info,viewY,viewM,chosen,slot;
const J=async(u,o)=>{const r=await fetch(u,o);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Something went wrong.');return j};
const two=n=>String(n).padStart(2,'0'),key=(y,m,d)=>y+'-'+two(m+1)+'-'+two(d);
const when=s=>new Date(s.utc).toLocaleString([],{weekday:'long',day:'numeric',month:'long',hour:'numeric',minute:'2-digit'});
function pills(){const p=$('pills');p.innerHTML='';[info.durationMin+' min',info.location||'',info.timezone.replace(/_/g,' ')].filter(Boolean).forEach(t=>{const s=document.createElement('span');s.className='pill';s.textContent=t;p.appendChild(s)})}
function drawCal(){const first=new Date(Date.UTC(viewY,viewM,1)),days=new Date(Date.UTC(viewY,viewM+1,0)).getUTCDate(),lead=first.getUTCDay();
const names=['Su','Mo','Tu','We','Th','Fr','Sa'];let h='<h2>Pick a day</h2><div class="nav"><button id="pv">‹</button><span>'+first.toLocaleString([],{month:'long',year:'numeric',timeZone:'UTC'})+'</span><button id="nx">›</button></div><div class="cal">';
names.forEach(n=>h+='<div class="h">'+n+'</div>');for(let i=0;i<lead;i++)h+='<div></div>';
for(let d=1;d<=days;d++){const k=key(viewY,viewM,d),dow=new Date(Date.UTC(viewY,viewM,d)).getUTCDay(),ok=info.weekdays[dow]&&k>=info.minDate&&k<=info.maxDate;
h+='<button data-d="'+k+'" class="'+(ok?'on':'')+(chosen===k?' sel':'')+'"'+(ok?'':' disabled')+'>'+d+'</button>'}
h+='</div><div id="slots"></div>';$('main').innerHTML=h;
$('pv').onclick=()=>{viewM--;if(viewM<0){viewM=11;viewY--}drawCal()};$('nx').onclick=()=>{viewM++;if(viewM>11){viewM=0;viewY++}drawCal()};
document.querySelectorAll('.cal button.on').forEach(b=>b.onclick=()=>pickDay(b.dataset.d));if(chosen)pickDay(chosen,true)}
async function pickDay(k,keep){chosen=k;document.querySelectorAll('.cal button').forEach(b=>b.classList.toggle('sel',b.dataset.d===k));
const box=$('slots');box.innerHTML='<p class="m">Loading times…</p>';
try{const j=await J(base+'/slots?date='+k);box.innerHTML='<p class="m" style="margin-top:16px">Times in your timezone ('+myTz.replace(/_/g,' ')+')</p>';
if(!j.slots.length){box.innerHTML+='<p class="m">No free times on this day.</p>';return}
const g=document.createElement('div');g.className='slots';j.slots.forEach(s=>{const b=document.createElement('button');b.textContent=new Date(s.utc).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});b.onclick=()=>form(s);g.appendChild(b)});box.appendChild(g)}
catch(e){box.innerHTML='<p class="err">'+e.message+'</p>'}}
function form(s){slot=s;$('main').innerHTML='<button class="back" id="bk">‹ Back</button><h2>Enter your details</h2><p class="m" id="wh"></p>'+
'<form id="f" novalidate><label>Your name *</label><input id="n" autocomplete="name"><label>Email *</label><input id="e" type="email" autocomplete="email"><label>Phone / WhatsApp</label><input id="p" type="tel" autocomplete="tel">'+
'<label>Anything we should know?</label><textarea id="t"></textarea><input class="hp" id="hp" tabindex="-1" autocomplete="off"><div class="err" id="er"></div><button class="go" id="go" type="submit">Confirm booking</button></form>';
$('wh').textContent=when(s);$('bk').onclick=drawCal;
$('f').onsubmit=async ev=>{ev.preventDefault();$('er').textContent='';const n=$('n').value.trim(),e=$('e').value.trim(),p=$('p').value.trim();
if(!n){$('er').textContent='Please enter your name.';return}if(!e&&!p){$('er').textContent='Please enter an email or phone number.';return}
$('go').disabled=true;$('go').textContent='Booking…';
try{await J(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:s.start,name:n,email:e,phone:p,notes:$('t').value,hp:$('hp').value})});done(s)}
catch(x){$('er').textContent=x.message;$('go').disabled=false;$('go').textContent='Confirm booking'}}}
function done(s){const st=new Date(s.utc),en=new Date(st.getTime()+info.durationMin*60000),z=d=>d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
const ics='BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nPRODID:-//Astric//Booking//EN\\r\\nBEGIN:VEVENT\\r\\nUID:'+s.start+'@astric\\r\\nDTSTAMP:'+z(new Date())+'\\r\\nDTSTART:'+z(st)+'\\r\\nDTEND:'+z(en)+'\\r\\nSUMMARY:'+info.title.replace(/[,;\\n]/g,' ')+'\\r\\nLOCATION:'+(info.location||'').replace(/[,;\\n]/g,' ')+'\\r\\nEND:VEVENT\\r\\nEND:VCALENDAR';
$('main').innerHTML='<div class="ok"><div class="t">✅</div><h1>You are booked!</h1><p class="m" id="w2"></p><p class="m"></p><p><a class="ics" id="ic" download="meeting.ics">Add to my calendar</a></p></div>';
$('w2').textContent=when(s);$('ic').href='data:text/calendar;charset=utf-8,'+encodeURIComponent(ics);
if(info.location){const p=document.createElement('p');p.className='m';p.textContent='Where: '+info.location;$('w2').after(p)}}
(async()=>{try{info=await J(base+'/info');$('org').textContent=info.orgName;$('title').textContent=info.title;$('desc').textContent=info.description;pills();
const n=new Date();viewY=+info.minDate.slice(0,4);viewM=+info.minDate.slice(5,7)-1;drawCal()}
catch(e){$('main').innerHTML='<h2>This booking link is not active</h2><p class="m">Please ask for a new link.</p>'}})();
</script></body></html>`;
}

// ── routes ──────────────────────────────────────────────────────────────────
const NOT_FOUND = { error: 'This booking link is not active.' };

router.get('/book/:orgId/:slug', wrap(async (req, res) => {
  const s = await load(req.params.orgId, req.params.slug);
  res.set('Cache-Control', 'no-cache').status(s ? 200 : 404).type('html').send(page(s ? s.title : 'Booking'));
}));

router.get('/book/:orgId/:slug/info',
  rateLimit({ windowMs: 60_000, max: 60, keyFn: (r) => `book-info:${r.ip}` }),
  wrap(async (req, res) => {
    const s = await load(req.params.orgId, req.params.slug);
    if (!s) return res.status(404).json(NOT_FOUND);
    const today = nowWallMs(s.timezone);
    res.json({
      orgName: s.hostName || await orgName(req.params.orgId),
      title: s.title, description: s.description, location: s.location,
      durationMin: s.durationMin, timezone: s.timezone,
      weekdays: DAYS.map((d) => s.weekly[d].length > 0),
      minDate: fmtDate(today), maxDate: fmtDate(today + s.maxDaysAhead * 86400e3),
    });
  }));

router.get('/book/:orgId/:slug/slots',
  rateLimit({ windowMs: 60_000, max: 60, keyFn: (r) => `book-slots:${r.ip}` }),
  wrap(async (req, res) => {
    const s = await load(req.params.orgId, req.params.slug);
    if (!s) return res.status(404).json(NOT_FOUND);
    res.json({ slots: await slotsFor(req.params.orgId, s, String(req.query.date || '')) });
  }));

router.post('/book/:orgId/:slug',
  rateLimit({ windowMs: 60_000, max: 6, keyFn: (r) => `book-post:${r.ip}` }),
  rateLimit({ windowMs: 60_000, max: 40, keyFn: (r) => `book-org:${r.params.orgId}` }),
  wrap(async (req, res) => {
    const { orgId, slug } = req.params;
    const s = await load(orgId, slug);
    if (!s) return res.status(404).json(NOT_FOUND);
    const b = req.body || {};
    if (String(b.hp || '').trim()) return res.json({ ok: true });            // honeypot

    const name = String(b.name || '').trim().slice(0, 100);
    const email = String(b.email || '').trim().slice(0, 150);
    const phone = String(b.phone || '').trim().slice(0, 30);
    const notes = String(b.notes || '').trim().slice(0, 1000);
    if (!name) return res.status(422).json({ error: 'Please enter your name.' });
    if (!email && !phone) return res.status(422).json({ error: 'Please enter an email or phone number.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(422).json({ error: 'That email address does not look right.' });

    const start = String(b.start || '');
    const startMs = parseWall(start);
    if (startMs === null || fmtWall(startMs) !== start) return res.status(422).json({ error: 'Please pick a time.' });
    const free = await slotsFor(orgId, s, start.slice(0, 10));
    if (!free.some((x) => x.start === start)) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another.' });

    // Lock the slot atomically so two visitors can never get the same time.
    const lockRef = db.collection('users').doc(orgId).collection('booking_slots').doc(start.replace(/[-:T]/g, ''));
    const eventRef = db.collection('users').doc(orgId).collection('calendar_events').doc();
    const endMs = startMs + s.durationMin * 60e3;
    const stamp = new Date().toISOString();
    const FV = admin.firestore.FieldValue;
    let taken = false;
    await db.runTransaction(async (tx) => {
      const lock = await tx.get(lockRef);
      if (lock.exists && lock.data().eventId) {
        const old = await tx.get(db.collection('users').doc(orgId).collection('calendar_events').doc(lock.data().eventId));
        if (old.exists) { taken = true; return; }                            // a live booking holds it
      }
      tx.set(lockRef, { eventId: eventRef.id, createdAt: FV.serverTimestamp() });
      tx.set(eventRef, {
        title: `${s.title} — ${name}`,
        description: ['Booked through your booking page.', `Name: ${name}`, email && `Email: ${email}`, phone && `Phone: ${phone}`, notes && `Notes: ${notes}`]
          .filter(Boolean).join('\n'),
        location: s.location,
        startTime: `${start}:00.000`,
        endTime: `${fmtWall(endMs)}:00.000`,
        isAllDay: false, color: 'teal', repeat: 'none', reminderMinutes: 30,
        invitedEmployeeIds: [], linkedTo: 'none', linkedId: null, linkedLabel: null, attachments: [],
        createdAt: stamp, updatedAt: stamp, source: 'booking',
      });
    });
    if (taken) return res.status(409).json({ error: 'Sorry, that time was just taken. Please pick another.' });

    // A lead for the CRM (best effort — the booking is already saved).
    try {
      const f = mapFields({ name, phone, email, message: `Booked "${s.title}" for ${start.replace('T', ' ')} (${s.timezone}).${notes ? ' ' + notes : ''}` });
      await ingestLead(orgId, f, { defaultSource: 'websiteForm', sourceLabel: 'Booking Page' });
    } catch (e) { console.warn('[booking] lead failed:', e.message); }

    notifyHost(orgId, '📅 New meeting booked', `${name} · ${start.replace('T', ' ')}`);
    res.json({ ok: true });
  }));

module.exports = router;
