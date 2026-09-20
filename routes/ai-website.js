// routes/ai-website.js
//
// New endpoint for the Website Studio feature: POST /ai/website
// { prompt: string } -> { html: string }
//
// Unlike the rest of this app's AI features (Grok-backed, see /ai/image
// and friends in routes/ai.js), this one specifically uses OpenAI's
// ChatGPT per the product decision for Website Studio. It's kept as its
// own route file rather than folded into ai.js so the two AI providers
// stay clearly separated.
//
// ── SETUP ────────────────────────────────────────────────────────────────
// 1. `npm install openai` (official OpenAI Node SDK) in your backend.
// 2. Add an OPENAI_API_KEY environment variable / secret wherever the rest
//    of this server's secrets live (e.g. alongside whatever holds the
//    Grok/xAI key already).
// 3. Mount this router in server.js the same way routes/ai.js is mounted,
//    e.g.: `app.use('/ai', require('./routes/ai-website'));`
//    (adjust the require path/mount prefix to match your actual server.js)
// 4. Wire in your EXISTING auth-verification and quota-check middleware —
//    two clearly marked TODOs below show where. This file intentionally
//    doesn't guess at your quota helper's exact name/signature; copy
//    however /ai/image in routes/ai.js does it.
//
// ── WHY A SINGLE HTML STRING ─────────────────────────────────────────────
// The Flutter side renders this directly in a preview pane (an iframe on
// web, a WebView on mobile) and offers "Export" to save/share it as a
// standalone .html file — so the model is instructed to produce one
// complete, self-contained document: inline <style> and <script>, no
// external file dependencies except optionally Google Fonts (which every
// browser and both preview surfaces can load directly).

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are a senior front-end developer generating complete, polished, production-quality single-page websites.

Rules — follow all of them:
- Output ONE complete HTML document: <!DOCTYPE html> through </html>. Nothing before or after it — no markdown fences, no commentary.
- All CSS must be inline in a single <style> tag in <head>. All JavaScript must be inline in <script> tags. No external CSS/JS files, no build tooling, no frameworks that require a bundler.
- You may load Google Fonts via a <link> tag — that's the one exception to "no external files".
- Write real, specific, on-topic copy for whatever the user describes (headlines, body text, prices, names) — never lorem ipsum or "[placeholder]" text.
- Use CSS Grid/Flexbox for layout and make it genuinely responsive: it must look good from a 375px-wide phone up to a 1440px+ desktop, using media queries as needed. Do not build a fixed-width layout.
- Use a real, cohesive visual design: a considered color palette (not default browser styling), decent spacing/typography, hover states on interactive elements, and at least one subtle visual flourish (a gradient, a shadow, a transition) — this should look like a real, launchable website, not a wireframe.
- For images, use CSS gradients, SVG, or well-known royalty-free placeholder image services (e.g. https://picsum.photos/...) — never reference local files that don't exist.
- Keep any JavaScript purely for light interactivity (mobile nav toggle, smooth scroll, simple form validation feedback) — no backend calls, no external APIs.`;

router.post('/website', async (req, res) => {
  try {
    // TODO: verify the Firebase ID token the Flutter app sends in the
    // Authorization header, the same way /ai/image does in routes/ai.js —
    // this endpoint currently has no auth check of its own.
    // const uid = await verifyFirebaseToken(req);

    // TODO: check + decrement this user's monthly AI-generation quota
    // here, using the same helper /ai/image uses, and respond exactly
    // like that endpoint does on exhaustion — the Flutter side already
    // expects HTTP 402 to mean "quota exceeded"
    // (see WebsiteGenException.quotaExceeded in website_gen_service.dart):
    //
    // const allowed = await checkAndDecrementQuota(uid, 'website');
    // if (!allowed) {
    //   return res.status(402).json({ error: { message: "You've reached this month's generation limit." } });
    // }

    const prompt = (req.body && req.body.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: { message: 'prompt is required' } });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.8,
      max_tokens: 8000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Build this website: ${prompt}` },
      ],
    });

    let html = completion.choices[0]?.message?.content || '';

    // Models sometimes wrap output in ```html fences despite instructions
    // not to — strip that defensively rather than trusting compliance.
    html = html.trim();
    if (html.startsWith('```')) {
      html = html.replace(/^```(?:html)?\n?/, '').replace(/```$/, '').trim();
    }

    if (!html.toLowerCase().includes('<html')) {
      return res.status(502).json({ error: { message: 'The AI did not return a valid HTML document. Please try again.' } });
    }

    return res.json({ html });

  } catch (err) {
    console.error('POST /ai/website failed:', err);
    return res.status(500).json({
      error: { message: err.message || 'Website generation failed.' },
    });
  }
});

module.exports = router;
