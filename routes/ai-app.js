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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Must match AppTier.tokenBudget in app_project_model.dart exactly.
// Only these three amounts are ever accepted as a build's cost — an
// arbitrary client-supplied tokenBudget is never trusted directly, or a
// caller could claim a cheap cost for an expensive build.
const VALID_BUILD_TOKEN_BUDGETS = [2000, 6000, 12000]; // = AppTier.tokenBudget

const BUILD_SYSTEM_PROMPT = `You generate complete, polished, installable mobile apps as ONE self-contained HTML file, returned as JSON.

Output JSON matching exactly: {"name": string, "pageOrder": ["index.html"], "files": {"index.html": "<full HTML document>"}}

Rules:
- "name": a short 1-3 word app name based on the request (e.g. "Habit Tracker").
- Exactly ONE file, "index.html": a complete HTML document, <!DOCTYPE html> through </html>, no markdown fences. All CSS in one <style> tag, all JS in one <script> tag. No external files except optionally a Google Fonts <link>. No frameworks or CDNs.
- It must behave like a native mobile app, not a website: fixed app bar, bottom tab bar (or a drawer) to switch between screens, full-height screens with no page scrolling of the whole document, touch-sized targets (min 44px), <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">, respect safe-area insets with env(safe-area-inset-*), \`-webkit-tap-highlight-color: transparent\`, smooth screen transitions.
- Screens are <section> elements inside the same file, switched with JS. Respect the screen-count limit from the user message.
- It must actually WORK: real interactions (add/edit/delete/toggle, forms, counters, timers, calculators - whatever the request needs), with state persisted via localStorage wrapped in try/catch. No dead buttons, no TODO stubs, no fake "coming soon" screens.
- Include <meta name="theme-color">, a sensible <title>, and an emoji-based or inline-SVG app icon in the app bar. Add <link rel="manifest"> only via a data: URL if you include one.
- Real, specific, on-topic content and labels for what the user describes - never lorem ipsum. Seed 2-3 realistic example items where an empty list would look broken.
- A real, cohesive visual design: considered palette, spacing, typography, light+dark via prefers-color-scheme, subtle motion. Mobile-first at 360-430px wide; it should still be centered and usable if opened on a wider screen (max-width ~480px container).
- No network requests to other sites. Images: CSS gradients, emoji or inline SVG only.
- Be decisive about ambiguous requests - pick one reasonable interpretation and build it, rather than asking a clarifying question back.
- Do not pad output: no repeated boilerplate, no unused CSS, no filler.`;

const REVISE_SYSTEM_PROMPT = `You make a targeted edit to an existing single-file mobile app and return it as JSON.

You will be given the app's current files (filename -> full HTML) and a change request.

Output JSON matching exactly: {"files": {"index.html": "<full updated HTML document>"}}

Rules:
- Return the COMPLETE updated index.html (full <!DOCTYPE html> through </html>), not a diff.
- Preserve the app's existing visual language, navigation and saved-data format (localStorage keys) unless the request asks to change them, so users don't lose their data.
- Same constraints as the original build: one file, inline CSS/JS, no frameworks/CDNs, native-app feel, everything must really work.
- Be decisive about ambiguous requests rather than asking a clarifying question back.`;

function stripJsonFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  }
  return t;
}

router.post('/ai/app', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `ai-app:${r.uid}` }), async (req, res) => {
  const uid = req.uid;
  // Credits belong to the org owner (the Flutter app reads them from there).
  let creditUid = uid;
  try { creditUid = (await resolveOrgBilling(uid))?.orgOwnerUid || uid; } catch (_) {}
  // Hoisted above the try block (not just inside it) so the outer catch —
  // which handles the OpenAI call itself throwing — can still see whether
  // a build already spent credits and needs a refund.
  let tokenBudget;          // only set (and only spent) for 'build'
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
      console.error('Failed to refund website credits after generation failure:', refundErr);
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

    if (mode === 'build') {
      const maxPages = Math.max(1, Math.min(8, Number(req.body && req.body.maxPages) || 4));
      tokenBudget = Number(req.body && req.body.tokenBudget) || 4000;
      if (!VALID_BUILD_TOKEN_BUDGETS.includes(tokenBudget)) {
        return res.status(400).json({ error: { message: 'Invalid tokenBudget for a build.' } });
      }
      maxTokens = Math.min(16000, Math.max(4000, tokenBudget * 2)); // an app is one bigger file

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
        { role: 'user', content: `Build this app (max ${maxPages} screens): ${prompt}` },
      ];
    } else {
      const existingFiles = req.body && req.body.existingFiles;
      if (!existingFiles || typeof existingFiles !== 'object' || Object.keys(existingFiles).length === 0) {
        return res.status(400).json({ error: { message: 'existingFiles is required for revise mode' } });
      }
      maxTokens = 12000;

      messages = [
        { role: 'system', content: REVISE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Current app files:\n${JSON.stringify(existingFiles)}\n\nChange requested: ${prompt}`,
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

    const raw = (completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content) || '';
    let parsed;
    try {
      parsed = JSON.parse(stripJsonFences(raw));
    } catch (e) {
      console.error('App Studio: model did not return valid JSON:', raw.slice(0, 500));
      await refundIfSpent();
      return res.status(502).json({ error: { message: 'The AI did not return a valid response. Please try again.' } });
    }

    if (!parsed.files || typeof parsed.files !== 'object' || Object.keys(parsed.files).length === 0) {
      await refundIfSpent();
      return res.status(502).json({ error: { message: 'The AI did not return any files. Please try again.' } });
    }

    if (mode === 'build') {
      return res.json({
        name: parsed.name || '',
        pageOrder: Array.isArray(parsed.pageOrder) ? parsed.pageOrder : Object.keys(parsed.files),
        files: parsed.files,
      });
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
