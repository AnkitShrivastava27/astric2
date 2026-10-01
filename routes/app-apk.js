// routes/app-apk.js
//
// App Studio → installable .apk.
//
// WHY THIS DOESN'T COMPILE ON RENDER: building an Android app needs the
// Android SDK + Gradle (~2 GB of tools, 1-2 GB RAM, minutes of CPU). Render's
// free instance has 512 MB and a throttled CPU. So this server only
// ORCHESTRATES: it commits the generated app into a private GitHub repo,
// triggers a GitHub Actions workflow (free hosted runners already have the
// Android SDK), and hands the finished .apk back to the app.
//
//   POST /ai/app/apk/build            { html, appName }  -> { buildId, cost }
//   GET  /ai/app/apk/status/:id                          -> { status, downloadUrl? }
//   GET  /ai/app/apk/download/:id?exp=&sig=   (signed link, streams the .apk)
//
// Required env vars (see apk_builder_repo/README.md):
//   GITHUB_APK_REPO   "owner/astric-apk-builder"  (PRIVATE repo)
//   GITHUB_APK_TOKEN  fine-grained PAT: Contents RW + Actions RW on that repo
//   APK_LINK_SECRET   long random string (signs download links)
// Optional: GITHUB_APK_BRANCH (default main), APK_BUILD_COST_TOKENS (default 1000)
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { SERVER_BASE_URL } = require('../config/env');
const { resolveOrgBilling } = require('../services/ai');
const { sanitizeAppName, makeBuildId, makeAppId, makeSignedParams, verifySignedParams } = require('../services/apk');

const REPO   = process.env.GITHUB_APK_REPO;
const TOKEN  = process.env.GITHUB_APK_TOKEN;
const SECRET = process.env.APK_LINK_SECRET;
const BRANCH = process.env.GITHUB_APK_BRANCH || 'main';
const WORKFLOW = 'build-apk.yml';
const BUILD_COST = Number(process.env.APK_BUILD_COST_TOKENS) || 1000; // keep = kApkBuildCost in the Flutter app
const GIVE_UP_MS = 20 * 60 * 1000;

const configured = () => Boolean(REPO && TOKEN && SECRET);

const gh = () => axios.create({
  baseURL: 'https://api.github.com',
  timeout: 25_000,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'astric-server',
  },
});

const creditsRef = (ownerUid) =>
  db.collection('users').doc(ownerUid).collection('appStudio').doc('credits');
const buildRef = (id) => db.collection('appApkBuilds').doc(id);
const srcPath = (id) => `builds/${id}/index.html`;

// Best-effort: the source file is only needed until the runner has copied it.
async function deleteSource(id) {
  try {
    const api = gh();
    const f = await api.get(`/repos/${REPO}/contents/${srcPath(id)}`, { params: { ref: BRANCH } });
    await api.delete(`/repos/${REPO}/contents/${srcPath(id)}`, {
      data: { message: `cleanup ${id}`, sha: f.data.sha, branch: BRANCH },
    });
  } catch (_) { /* already gone */ }
}

// Marks a build failed and refunds the credits exactly once (idempotent).
async function failBuild(id, reason) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(buildRef(id));
    if (!snap.exists) return;
    const b = snap.data();
    if (b.refunded) return;
    const cRef = creditsRef(b.creditUid);
    const cSnap = await tx.get(cRef);
    const cur = (cSnap.data()?.tokensRemaining) || 0;
    tx.set(cRef, { tokensRemaining: cur + b.cost }, { merge: true });
    tx.update(buildRef(id), { status: 'failed', refunded: true, failReason: String(reason).slice(0, 300) });
  });
  await deleteSource(id);
}

// ── POST /ai/app/apk/build ─────────────────────────────────────────────────
router.post('/ai/app/apk/build', requireAuth,
  rateLimit({ windowMs: 10 * 60_000, max: 4, keyFn: r => `apk-build:${r.uid}` }), async (req, res) => {
    if (!configured()) {
      return res.status(503).json({ error: 'APK builds are not set up on the server yet (GITHUB_APK_REPO / GITHUB_APK_TOKEN / APK_LINK_SECRET).' });
    }
    const uid = req.uid;
    const html = req.body?.html;
    if (typeof html !== 'string' || html.length < 200 || html.length > 1_500_000 || !/<html[\s>]/i.test(html)) {
      return res.status(400).json({ error: 'A complete HTML app is required.' });
    }
    const appName = sanitizeAppName(req.body?.appName);
    const buildId = makeBuildId();
    const appId = makeAppId(buildId);

    const billing = await resolveOrgBilling(uid);
    const creditUid = billing?.orgOwnerUid || uid;

    // 1) Charge first (transactional) — refunded automatically on any failure below.
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(creditsRef(creditUid));
        const cur = (snap.data()?.tokensRemaining) || 0;
        if (cur < BUILD_COST) {
          const e = new Error(`Not enough App Studio credits (an APK build costs ${BUILD_COST}).`);
          e.insufficient = true; throw e;
        }
        tx.set(creditsRef(creditUid), { tokensRemaining: cur - BUILD_COST }, { merge: true });
        tx.set(buildRef(buildId), {
          uid, creditUid, appName, appId, cost: BUILD_COST, status: 'queued', refunded: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(), createdAtMs: Date.now(),
        });
      });
    } catch (e) {
      if (e.insufficient) return res.status(402).json({ error: e.message, limitReached: true });
      console.error('apk build charge failed:', e.message);
      return res.status(500).json({ error: 'Could not start the build.' });
    }

    // 2) Hand the app to GitHub and start the workflow.
    try {
      const api = gh();
      await api.put(`/repos/${REPO}/contents/${srcPath(buildId)}`, {
        message: `app ${buildId}`,
        content: Buffer.from(html, 'utf8').toString('base64'),
        branch: BRANCH,
      });
      await api.post(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
        ref: BRANCH,
        inputs: { build_id: buildId, app_name: appName, app_id: appId },
      });
      return res.status(200).json({ buildId, cost: BUILD_COST });
    } catch (e) {
      console.error('apk build dispatch failed:', e?.response?.data || e.message);
      await failBuild(buildId, 'dispatch failed');
      return res.status(502).json({ error: 'Could not reach the build service. Your credits were refunded.' });
    }
  });

// ── GET /ai/app/apk/status/:id ─────────────────────────────────────────────
router.get('/ai/app/apk/status/:id', requireAuth, async (req, res) => {
  if (!configured()) return res.status(503).json({ error: 'APK builds are not set up.' });
  const id = String(req.params.id || '');
  if (!/^[0-9a-f]{8}$/.test(id)) return res.status(400).json({ error: 'Bad build id.' });
  try {
    const snap = await buildRef(id).get();
    if (!snap.exists || snap.data().uid !== req.uid) return res.status(404).json({ error: 'Build not found.' });
    const b = snap.data();

    const linkFor = () => {
      const { exp, sig } = makeSignedParams(SECRET, id);
      return `${SERVER_BASE_URL}/ai/app/apk/download/${id}?exp=${exp}&sig=${sig}`;
    };

    if (b.status === 'failed') return res.json({ status: 'failed', error: b.failReason || 'The build failed. Your credits were refunded.' });
    if (b.status === 'done')   return res.json({ status: 'done', downloadUrl: linkFor() });

    const api = gh();

    // Finished? The workflow publishes the .apk as release "build-<id>".
    try {
      await api.get(`/repos/${REPO}/releases/tags/build-${id}`);
      await buildRef(id).update({ status: 'done' });
      deleteSource(id);
      return res.json({ status: 'done', downloadUrl: linkFor() });
    } catch (e) {
      if (e?.response?.status !== 404) throw e;
    }

    // Not published yet — is the run still going, or did it fail?
    const runs = await api.get(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`,
      { params: { event: 'workflow_dispatch', per_page: 30 } });
    const run = (runs.data.workflow_runs || []).find(r => r.display_title === `build-${id}`);

    if (run && run.status === 'completed' && run.conclusion !== 'success') {
      await failBuild(id, `build ${run.conclusion}`);
      return res.json({ status: 'failed', error: 'The Android build failed. Your credits were refunded.' });
    }
    if (Date.now() - (b.createdAtMs || 0) > GIVE_UP_MS) {
      await failBuild(id, 'timed out');
      return res.json({ status: 'failed', error: 'The build timed out. Your credits were refunded.' });
    }
    return res.json({ status: run && run.status === 'in_progress' ? 'building' : 'queued' });
  } catch (err) {
    console.error('apk status error:', err?.response?.data || err.message);
    // A transient GitHub/network hiccup shouldn't kill the client's polling.
    return res.json({ status: 'queued', note: 'status check temporarily unavailable' });
  }
});

// ── GET /ai/app/apk/download/:id  (signed link; a browser navigation) ──────
router.get('/ai/app/apk/download/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!configured() || !/^[0-9a-f]{8}$/.test(id) ||
      !verifySignedParams(SECRET, id, req.query.exp, req.query.sig)) {
    return res.status(403).send('This download link is invalid or has expired. Open the app and tap Build APK again to get a fresh one.');
  }
  try {
    const snap = await buildRef(id).get();
    const name = (snap.exists ? snap.data().appName : 'app').replace(/[^A-Za-z0-9\-]+/g, '-').replace(/^-|-$/g, '') || 'app';
    const api = gh();
    const rel = await api.get(`/repos/${REPO}/releases/tags/build-${id}`);
    const asset = (rel.data.assets || []).find(a => a.name.endsWith('.apk'));
    if (!asset) return res.status(404).send('APK not found.');

    // Asset API URL + octet-stream → GitHub 302s to a signed storage URL; the
    // client library drops our Authorization header on that cross-host hop.
    const file = await axios.get(asset.url, {
      responseType: 'stream', timeout: 60_000, maxRedirects: 5,
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/octet-stream', 'User-Agent': 'astric-server' },
    });
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.apk"`);
    if (file.headers['content-length']) res.setHeader('Content-Length', file.headers['content-length']);
    file.data.pipe(res);
  } catch (err) {
    console.error('apk download error:', err?.response?.status, err.message);
    if (!res.headersSent) res.status(404).send('APK not found.');
  }
});

module.exports = router;
