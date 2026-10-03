// routes/ai-app.js
//
// POST /ai/app — builds / revises a small, installable MOBILE APP as ONE
// self-contained index.html (screens live inside it; tab bar / bottom-nav
// navigation, data in localStorage). Same two modes, same credit model and
// same refund-on-failure behaviour as routes/ai-website.js, but billed from
// users/{uid}/appStudio/credits.
//
// NOTE: this produces a web app that runs full-screen on Android/iOS (and
// can be wrapped into an .apk by a separate build step) — it does NOT
// compile native Android code.
const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { resolveOrgBilling } = require('../services/ai');
const { TIERS, tierByBudget } = require('../services/appTiers');
const { validateAttachments, toPromptBlock } = require('../services/docValidator');
const { sanitizeBackendConfig, readConfig, applyConfig } = require('../services/backendConfig');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tier limits (screens, cost, backend wiring) come from services/appTiers.js.
// The client only sends a tier NAME (or, for older app versions, a tokenBudget
// that is mapped back to a tier) — arbitrary costs are never trusted.

const BUILD_SYSTEM_PROMPT = `You generate complete, polished, installable mobile apps as ONE self-contained HTML file, returned as JSON.

Output JSON matching exactly: {"name": string, "pageOrder": ["index.html"], "files": {"index.html": "<full HTML document>"}}

Rules:
- "name": a short 1-3 word app name based on the request (e.g. "Habit Tracker").
- Exactly ONE file, "index.html": a complete HTML document, <!DOCTYPE html> through </html>, no markdown fences. All CSS in one <style> tag, all JS in one <script> tag. No external files except optionally a Google Fonts <link>. No frameworks or CDNs.
- It must behave like a native mobile app, not a website: fixed app bar, bottom tab bar (or a drawer) to switch between screens, full-height screens with no page scrolling of the whole document, touch-sized targets (min 44px), <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">, respect safe-area insets with env(safe-area-inset-*), \`-webkit-tap-highlight-color: transparent\`, smooth screen transitions.
- Screens are <section> elements inside the same file, switched with JS. Build the screen-count range given in the user message — no fewer than the minimum, no more than the maximum.
- It must actually WORK: real interactions (add/edit/delete/toggle, forms, counters, timers, calculators - whatever the request needs), with state persisted via localStorage wrapped in try/catch. No dead buttons, no TODO stubs, no fake "coming soon" screens.
- Include <meta name="theme-color">, a sensible <title>, and an emoji-based or inline-SVG app icon in the app bar. Add <link rel="manifest"> only via a data: URL if you include one.
- Real, specific, on-topic content and labels for what the user describes - never lorem ipsum. Seed 2-3 realistic example items where an empty list would look broken.
- A real, cohesive visual design: considered palette, spacing, typography, light+dark via prefers-color-scheme, subtle motion. Mobile-first at 360-430px wide; it should still be centered and usable if opened on a wider screen (max-width ~480px container).
- Unless the user message explicitly adds a BACKEND INTEGRATION section, make no network requests. Images: CSS gradients, emoji or inline SVG only.
- Be decisive about ambiguous requests - pick one reasonable interpretation and build it, rather than asking a clarifying question back.
- Do not pad output: no repeated boilerplate, no unused CSS, no filler.`;

const REVISE_SYSTEM_PROMPT = `You make a targeted edit to an existing single-file mobile app and return it as JSON.

You will be given the app's current files (filename -> full HTML) and a change request.

Output JSON matching exactly: {"files": {"index.html": "<full updated HTML document>"}}

Rules:
- Return the COMPLETE updated index.html (full <!DOCTYPE html> through </html>), not a diff.
- Preserve the app's existing visual language, navigation and saved-data format (localStorage keys) unless the request asks to change them, so users don't lose their data.
- If the app contains a line with /*ASTRIC_CONFIG*/, keep that line and its three keys exactly as they are.
- Same constraints as the original build: one file, inline CSS/JS, no frameworks/CDNs, native-app feel, everything must really work.
- Be decisive about ambiguous requests rather than asking a clarifying question back.`;


// Added only to Pro builds. The app is a single HTML file, so Firebase is
// reached through its REST APIs (no SDK/CDN needed) and every call is wrapped
// so the app still works offline on localStorage until real keys are filled in.
const BACKEND_SECTION = `
BACKEND INTEGRATION (Pro tier — required):
- At the top of the <script>, write EXACTLY this one line, keeping the /*ASTRIC_CONFIG*/ marker and the three keys, with empty strings (the platform fills them in afterwards):
  const CONFIG = /*ASTRIC_CONFIG*/{"firebaseApiKey":"","firebaseProjectId":"","apiBaseUrl":""};
  Never invent keys, project ids or URLs. Only if the user's request or documents explicitly contain a Firebase web apiKey, a Firebase projectId or an https API base URL, you may put those exact values in. NEVER use or copy a service-account key, private key or secret from them.
- Add a small async data layer \`store\` with list/get/add/update/remove(collection, ...) used by EVERY screen for its data.
  * If CONFIG.firebaseProjectId and CONFIG.firebaseApiKey are set: use the Firestore REST API (https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents/{collection}?key={apiKey}) with fetch, converting to/from Firestore's typed-value format.
  * Else if CONFIG.apiBaseUrl is set: fetch against {apiBaseUrl}/{collection} (JSON REST: GET list, POST create, PUT /:id, DELETE /:id).
  * Else: fall back to localStorage so the app is fully usable offline.
- If the app needs accounts, add a login/register screen using the Firebase Auth REST API (identitytoolkit.googleapis.com accounts:signInWithPassword / accounts:signUp) when Firebase is configured, and a local-only profile otherwise. Keep the id token in memory + localStorage and send it as a Bearer token to apiBaseUrl calls.
- Show a small, clear status (offline / syncing / connected / error) and wrap every fetch in try/catch — never leave a blank screen.
- If reference documents define a data model or endpoints, follow them exactly for collection names, field names and routes.
`;

function buildTierBrief(tier, maxScreens, minScreens) {
  return `Build this app. Screens: between ${minScreens} and ${maxScreens} (inclusive).` + (TIERS[tier].backend ? BACKEND_SECTION : '');
}

// Strips ``` fences and, if the model wrapped the JSON in extra words, keeps
// only the outermost {...}.
function parseModelJson(text) {
  const t = stripJsonFences(text);
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('no JSON object found');
}

function stripJsonFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  }
  return t;
}

// POST /ai/app/validate-docs — checks attachments WITHOUT spending credits, so
// the app can show per-file results the moment a file is picked.
router.post('/ai/app/validate-docs', requireAuth, rateLimit({ windowMs: 60_000, max: 20, keyFn: r => `ai-app-validate:${r.uid}` }), async (req, res) => {
  try {
    const v = await validateAttachments(req.body && req.body.attachments);
    return res.json({
      ok: v.ok,
      files: v.files.map((f) => ({ name: f.name, bytes: f.bytes, chars: f.chars, truncated: f.truncated, warnings: f.warnings })),
      errors: v.errors,
    });
  } catch (err) {
    console.error('POST /ai/app/validate-docs failed:', err);
    return res.status(500).json({ error: 'Could not check the documents.' });
  }
});

// POST /ai/app/backend-config — checks backend settings typed into the app's
// "Backend" dialog. No credits, no AI: the app then writes them into the HTML itself.
router.post('/ai/app/backend-config', requireAuth, rateLimit({ windowMs: 60_000, max: 30, keyFn: r => `ai-app-bc:${r.uid}` }), (req, res) => {
  const bc = sanitizeBackendConfig(req.body && req.body.backendConfig);
  if (!bc.ok) return res.status(400).json({ ok: false, errors: bc.errors });
  return res.json({ ok: true, config: bc.config });
});

router.post('/ai/app', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `ai-app:${r.uid}` }), async (req, res) => {
  const uid = req.uid;
  // Credits belong to the org owner (the Flutter app reads them from there).
  let creditUid = uid;
  try { creditUid = (await resolveOrgBilling(uid))?.orgOwnerUid || uid; } catch (_) {}
  // Hoisted above the try block (not just inside it) so the outer catch —
  // which handles the OpenAI call itself throwing — can still see whether
  // a build already spent credits and needs a refund.
  let tokenBudget;          // only set (and only spent) for 'build'
  let backendCfgForBuild = null;
  let existingFilesForConfig = null;
  let creditsSpent = false; // true once the deduction transaction succeeds

  // Refunds the just-spent build cost — called from every failure path
  // after the deduction succeeds, so a model/parsing/network failure
  // doesn't quietly cost the person credits for a site they never got.
  const refundIfSpent = async () => {
    if (!creditsSpent) return;
    try {
      const creditsRef = db.collection('users').doc(creditUid).collection('appStudio').doc('credits');
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(creditsRef);
        const current = (snap.data()?.tokensRemaining) || 0;
        tx.set(creditsRef, { tokensRemaining: current + tokenBudget }, { merge: true });
      });
      creditsSpent = false;
    } catch (refundErr) {
      console.error('Failed to refund App Studio credits after generation failure:', refundErr);
    }
  };

  try {
    const mode = req.body && req.body.mode;
    if (mode !== 'build' && mode !== 'revise') {
      return res.status(400).json({ error: { message: "mode must be 'build' or 'revise'" } });
    }

    const prompt = ((req.body && req.body.prompt) || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt is required' } });
    }

    let messages;
    let maxTokens;

    // Validate attached documents FIRST, before any credits are touched.
    const docs = await validateAttachments(req.body && req.body.attachments);
    if (!docs.ok) {
      return res.status(400).json({
        error: { message: 'Some attached documents were rejected: ' + docs.errors.map((e) => (e.name ? e.name + ' — ' : '') + e.reason).join(' | ') },
        documentErrors: docs.errors,
      });
    }
    const docBlock = toPromptBlock(docs.files);

    if (mode === 'build') {
      const tierName = TIERS[req.body && req.body.tier] ? req.body.tier : tierByBudget(req.body && req.body.tokenBudget);
      if (!tierName) {
        return res.status(400).json({ error: { message: 'Unknown App Studio tier.' } });
      }
      const tier = TIERS[tierName];
      // Optional backend settings typed into the build form (Pro only).
      let backendCfg = null;
      if (tier.backend && req.body && req.body.backendConfig) {
        const bc = sanitizeBackendConfig(req.body.backendConfig);
        if (!bc.ok) return res.status(400).json({ error: { message: bc.errors.join(' ') } });
        backendCfg = bc.config;
      }
      backendCfgForBuild = backendCfg;
      tokenBudget = tier.tokenBudget;
      // Output ceiling only (NOT the credit cost). Was tokenBudget*2 = 4,000 for the
      // Trial pack, too small for a 2-3 screen app, so replies were cut off mid-file.
      maxTokens = { trial: 9000, standard: 13000, pro: 16000 }[tierName] || 13000;

      // Deduct BEFORE calling the model — same balance, same transactional
      // check-then-decrement the Flutter client already does at
      // spendForNewBuild(), just also enforced here so the credit system
      // can't be bypassed by calling this endpoint directly. Responds 402
      // on exhaustion, which WebsiteGenService on the client already
      // treats as "quota exceeded".
      const creditsRef = db.collection('users').doc(creditUid).collection('appStudio').doc('credits');
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(creditsRef);
          const current = (snap.data()?.tokensRemaining) || 0;
          if (current < tokenBudget) {
            const err = new Error('Not enough App Studio credits for this build.');
            err.insufficientCredits = true;
            throw err;
          }
          tx.set(creditsRef, { tokensRemaining: current - tokenBudget }, { merge: true });
        });
        creditsSpent = true;
      } catch (creditErr) {
        if (creditErr.insufficientCredits) {
          return res.status(402).json({ error: { message: creditErr.message }, limitReached: true });
        }
        throw creditErr;
      }

      messages = [
        { role: 'system', content: BUILD_SYSTEM_PROMPT },
        { role: 'user', content: `${buildTierBrief(tierName, tier.maxScreens, tier.minScreens)}\n\nApp request: ${prompt}${docBlock}` },
      ];
    } else {
      const existingFiles = req.body && req.body.existingFiles;
      if (!existingFiles || typeof existingFiles !== 'object' || Object.keys(existingFiles).length === 0) {
        return res.status(400).json({ error: { message: 'existingFiles is required for revise mode' } });
      }
      // Revisions don't spend credits, so they must still be locked to accounts
      // that have bought App Studio — otherwise anyone could use the AI for free.
      const accessSnap = await db.collection('users').doc(creditUid).collection('appStudio').doc('credits').get();
      if (!accessSnap.exists) {
        return res.status(402).json({
          error: { message: 'App Studio is locked. Buy a pack in Billing → Top-ups to unlock it.' },
          locked: true,
        });
      }
      maxTokens = 12000;
      existingFilesForConfig = existingFiles;

      messages = [
        { role: 'system', content: REVISE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Current app files:\n${JSON.stringify(existingFiles)}\n\nChange requested: ${prompt}${docBlock}`,
        },
      ];
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.7,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages,
    });

    const finish = completion.choices[0] && completion.choices[0].finish_reason;
    const raw = (completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content) || '';
    let parsed;
    try {
      parsed = parseModelJson(raw);
    } catch (e) {
      console.error('App Studio: model did not return valid JSON:', raw.slice(0, 500));
      await refundIfSpent();
      if (finish === 'length') {
        return res.status(502).json({ error: { message: 'That app was too large to finish in one go. Try a simpler description or fewer screens — your credits were not used.' } });
      }
      return res.status(502).json({ error: { message: 'The AI did not return a valid response. Please try again — your credits were not used.' } });
    }

    if (!parsed.files || typeof parsed.files !== 'object' || Object.keys(parsed.files).length === 0) {
      await refundIfSpent();
      return res.status(502).json({ error: { message: 'The AI did not return any files. Please try again.' } });
    }

    if (mode === 'build') {
      let backendApplied = null;
      if (backendCfgForBuild && parsed.files['index.html']) {
        const out = applyConfig(String(parsed.files['index.html']), backendCfgForBuild);
        parsed.files['index.html'] = out.html;
        backendApplied = out.applied;
      }
      return res.json({
        backendApplied,
        name: parsed.name || '',
        pageOrder: Array.isArray(parsed.pageOrder) ? parsed.pageOrder : Object.keys(parsed.files),
        files: parsed.files,
      });
    }
    // Carry the app's saved backend settings across the edit, whatever the model wrote.
    const prevHtml = existingFilesForConfig && existingFilesForConfig['index.html'];
    const prevCfg = readConfig(prevHtml);
    if (prevCfg && parsed.files['index.html']) {
      parsed.files['index.html'] = applyConfig(String(parsed.files['index.html']), prevCfg).html;
    }
    return res.json({ files: parsed.files });

  } catch (err) {
    console.error('POST /ai/app failed:', err);
    await refundIfSpent();
    return res.status(500).json({
      error: { message: err.message || 'App generation failed.' },
    });
  }
});

module.exports = router;
