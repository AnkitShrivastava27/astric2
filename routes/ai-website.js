// routes/ai-website.js
//
// POST /ai/website - two modes, both returning JSON (not a single HTML
// blob, per the redesign):
//
//   mode: 'build'
//     body:   { prompt, maxPages, tokenBudget }
//     result: { name, pageOrder: [...], files: { "index.html": "...", ... } }
//
//   mode: 'revise'
//     body:   { prompt, existingFiles: {...}, pageOrder: [...] }
//     result: { files: { <only the changed/new pages> } }
//
// The 'revise' mode is the whole point of the "only regenerate what
// changed" requirement: the model is given every existing page as context
// and explicitly instructed to return ONLY the pages it actually touched,
// which is what keeps a follow-up prompt materially cheaper than a full
// rebuild.
//
// 🔧 WIRED UP — two fixes vs the placeholder version of this file:
//
// 1. "openai" was require()'d here but missing from package.json. Since
//    server.js loads every route file unconditionally at boot, a fresh
//    `npm install` (e.g. a new Render deploy) would have thrown
//    "Cannot find module 'openai'" and crashed the ENTIRE server, not
//    just this route — added to package.json.
//
// 2. This endpoint had NO auth check and NO server-side credit check —
//    literally anyone with the URL could generate unlimited websites for
//    free with a bare curl request, bypassing the Cashfree-purchased
//    credit system entirely (the credit deduction only ever happened
//    client-side in the Flutter app, which is trivial to skip). Added
//    requireAuth (same as /ai/chat, /ai/image) plus a real, transactional
//    deduction from the SAME users/{uid}/websiteStudio/credits.tokensRemaining
//    balance the client already uses, for 'build' mode. 'revise' mode is
//    left as-is (governed by a project's own revisionsRemaining, which
//    lives only in the client's Firestore document — this endpoint has no
//    projectId to check that against; tightening that further would need
//    a slightly bigger change and is worth a follow-up if it matters to
//    you).
const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { admin, db } = require('../config/firebase');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Must match WebsiteTier.tokenBudget in website_project_model.dart exactly.
// Only these three amounts are ever accepted as a build's cost — an
// arbitrary client-supplied tokenBudget is never trusted directly, or a
// caller could claim a cheap cost for an expensive build.
const VALID_BUILD_TOKEN_BUDGETS = [1000, 4500, 9000];

const BUILD_SYSTEM_PROMPT = `You generate complete, polished, multi-page websites as JSON.

Output JSON matching exactly: {"name": string, "pageOrder": string[], "files": {"<filename>.html": "<full HTML document>"}}

Rules:
- "name": a short 2-4 word site name based on the request (e.g. "Iron Forge Fitness").
- "pageOrder": filenames in the order they should appear as tabs (e.g. ["index.html","about.html","contact.html"]). Respect the page-count limit given in the user message.
- Each file's value is ONE complete HTML document: <!DOCTYPE html> through </html>, no markdown fences.
- All CSS inline in one <style> tag per page (identical <style> content across pages of the same site is fine and expected - keep the design system consistent). All JS inline in <script> tags. No external files except optionally a Google Fonts <link>.
- Real, specific, on-topic copy (headlines, body text, prices, names) for what the user describes - never lorem ipsum.
- Genuinely responsive: CSS Grid/Flexbox + media queries, must work from 375px to 1440px+ wide. Not a fixed-width layout.
- A real, cohesive visual design: considered color palette, real spacing/typography, hover states, at least one subtle flourish (gradient/shadow/transition) - a launchable site, not a wireframe.
- Images: CSS gradients, SVG, or https://picsum.photos/... placeholders only.
- Internal links between pages use plain relative hrefs (e.g. href="about.html") even though the preview may render pages one at a time.
- Be decisive about ambiguous requests - make a single reasonable interpretation and build it, rather than asking a clarifying question back.
- Do not pad output: no repeated boilerplate comments, no unused CSS, no filler paragraphs added just to look "complete". Write only what the design needs.`;

const REVISE_SYSTEM_PROMPT = `You make a targeted edit to an existing multi-page website and return ONLY what changed, as JSON.

You will be given the site's current pages (as filename -> full HTML) and a change request.

Output JSON matching exactly: {"files": {"<filename>.html": "<full updated HTML document>"}}

Rules:
- Include ONLY pages you actually changed, plus any brand-new page the request requires. Do NOT include unchanged pages in the output - this is the single most important rule; omitting untouched pages is what keeps revisions cheap.
- Each included file's value is the COMPLETE updated HTML document (not a diff/patch) - full <!DOCTYPE html> through </html>.
- Preserve the site's existing visual language (colors, fonts, layout system) in anything you touch unless the request specifically asks to change the design.
- Same technical constraints as the original build: inline CSS/JS only, no external files except optional Google Fonts, genuinely responsive, real copy not placeholders.
- Be decisive about ambiguous requests rather than asking a clarifying question back.`;

function stripJsonFences(text) {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  }
  return t;
}

router.post('/website', requireAuth, rateLimit({ windowMs: 60_000, max: 10, keyFn: r => `ai-website:${r.uid}` }), async (req, res) => {
  const uid = req.uid;
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
      const creditsRef = db.collection('users').doc(uid).collection('websiteStudio').doc('credits');
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
      const maxPages = Math.max(1, Math.min(12, Number(req.body && req.body.maxPages) || 4));
      tokenBudget = Number(req.body && req.body.tokenBudget) || 4000;
      if (!VALID_BUILD_TOKEN_BUDGETS.includes(tokenBudget)) {
        return res.status(400).json({ error: { message: 'Invalid tokenBudget for a build.' } });
      }
      maxTokens = Math.min(16000, Math.max(2000, tokenBudget * 2));

      // Deduct BEFORE calling the model — same balance, same transactional
      // check-then-decrement the Flutter client already does at
      // spendForNewBuild(), just also enforced here so the credit system
      // can't be bypassed by calling this endpoint directly. Responds 402
      // on exhaustion, which WebsiteGenService on the client already
      // treats as "quota exceeded".
      const creditsRef = db.collection('users').doc(uid).collection('websiteStudio').doc('credits');
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(creditsRef);
          const current = (snap.data()?.tokensRemaining) || 0;
          if (current < tokenBudget) {
            const err = new Error('Not enough Website Studio credits for this build.');
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
        { role: 'user', content: `Build this website (max ${maxPages} pages): ${prompt}` },
      ];
    } else {
      const existingFiles = req.body && req.body.existingFiles;
      if (!existingFiles || typeof existingFiles !== 'object' || Object.keys(existingFiles).length === 0) {
        return res.status(400).json({ error: { message: 'existingFiles is required for revise mode' } });
      }
      maxTokens = 6000;

      messages = [
        { role: 'system', content: REVISE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Current site pages:\n${JSON.stringify(existingFiles)}\n\nChange requested: ${prompt}`,
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
      console.error('Website Studio: model did not return valid JSON:', raw.slice(0, 500));
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
    console.error('POST /ai/website failed:', err);
    await refundIfSpent();
    return res.status(500).json({
      error: { message: err.message || 'Website generation failed.' },
    });
  }
});

module.exports = router;
