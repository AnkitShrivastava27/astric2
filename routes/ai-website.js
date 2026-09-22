// routes/ai-website.js
//
// POST /ai/website
//
// Modes:
//
//   build
//     body:
//     {
//       mode: "build",
//       prompt: "...",
//       maxPages: 4,
//       tokenBudget: 10000
//     }
//
//     result:
//     {
//       name: "...",
//       pageOrder: ["index.html", "about.html", ...],
//       files: {
//         "index.html": "<!DOCTYPE html>...</html>",
//         ...
//       }
//     }
//
//   revise
//     body:
//     {
//       mode: "revise",
//       prompt: "...",
//       existingFiles: {...},
//       pageOrder: [...]
//     }
//
//     result:
//     {
//       files: {
//         "index.html": "<!DOCTYPE html>...</html>"
//       }
//     }

const express = require('express');
const router = express.Router();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Uses your Render environment variable if present.
// Otherwise automatically uses GPT-5.4 Mini.
const WEBSITE_MODEL =
  process.env.OPENAI_WEBSITE_MODEL || 'gpt-5.4-mini';

/* -------------------------------------------------------------------------- */
/* BUILD PROMPT                                                               */
/* -------------------------------------------------------------------------- */

const BUILD_SYSTEM_PROMPT = `
You generate complete, polished, responsive multi-page websites as JSON.

Output JSON matching EXACTLY:

{
  "name": "string",
  "pageOrder": ["index.html", "about.html"],
  "files": {
    "index.html": "<full HTML document>",
    "about.html": "<full HTML document>"
  }
}

IMPORTANT OUTPUT LIMITS:
- Maximum 4 pages.
- Only create the number of pages actually useful for the request.
- Prefer 3-4 pages for a normal business website.
- Do not create unnecessary pages.
- Each page must be a complete HTML document.
- Keep each HTML page reasonably compact.
- Do not repeat unnecessarily large sections of CSS or JavaScript.
- Do not add huge amounts of text merely to increase content.
- Do not create massive SVGs.
- Do not embed base64 images.
- Do not generate enormous JavaScript libraries.

RULES:

1. "name"
- Short 2-4 word website name.
- Based on the user's request.

2. "pageOrder"
- Contains the HTML filenames in navigation order.
- Example:
  ["index.html", "about.html", "services.html", "contact.html"]

3. HTML
- Every file must be a complete document:
  <!DOCTYPE html>
  ...
  </html>
- No Markdown code fences.
- No explanations outside the JSON.

4. CSS
- CSS must be inside a <style> tag.
- Use modern CSS.
- Use Flexbox and/or Grid.
- Must be responsive.
- Support approximately 375px through 1440px+.
- Include mobile media queries.
- Use a cohesive visual system.
- Include hover states and subtle transitions.
- Avoid unnecessary CSS.

5. JavaScript
- JavaScript must be inside <script> tags.
- Only add JavaScript when useful.
- Do not include external JavaScript libraries.

6. Images
- Do not use base64 images.
- Do not embed binary image data.
- You may use:
  - CSS gradients
  - inline SVG
  - https://picsum.photos/... placeholders
- Keep SVG reasonably small.

7. Content
- Use realistic, specific content based on the request.
- Never use lorem ipsum.
- Do not create excessively long paragraphs.
- Keep the copy concise and useful.

8. Navigation
- Internal links must use relative HTML filenames.
- Example:
  href="about.html"
  href="contact.html"

9. Design
- Produce a real polished website.
- Use appropriate spacing.
- Use a professional typography hierarchy.
- Use cards/sections where appropriate.
- Include responsive navigation.
- Make reasonable decisions without asking questions.

10. JSON
- Return VALID JSON only.
- No Markdown fences.
- No comments outside JSON.
`;

/* -------------------------------------------------------------------------- */
/* REVISE PROMPT                                                              */
/* -------------------------------------------------------------------------- */

const REVISE_SYSTEM_PROMPT = `
You make targeted edits to an existing multi-page website.

You will receive:
1. The existing HTML files.
2. A change request.

Return ONLY the files that actually changed.

Output JSON EXACTLY:

{
  "files": {
    "filename.html": "<complete updated HTML document>"
  }
}

RULES:

1. Only return changed/new pages.
2. Do not return unchanged pages.
3. Every returned page must be a COMPLETE HTML document.
4. Preserve the existing visual language unless the user asks to change it.
5. Keep CSS and JavaScript compact.
6. Do not add unnecessary content.
7. Do not embed base64 images.
8. Do not generate huge SVGs.
9. Keep the site responsive.
10. Return valid JSON only.
11. No Markdown fences.
12. No explanations outside JSON.
`;

/* -------------------------------------------------------------------------- */
/* JSON CLEANUP                                                               */
/* -------------------------------------------------------------------------- */

function stripJsonFences(text) {
  if (!text) {
    return '';
  }

  let result = String(text).trim();

  if (result.startsWith('```')) {
    result = result
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* BASIC VALIDATION                                                           */
/* -------------------------------------------------------------------------- */

function validateFiles(files) {
  if (!files || typeof files !== 'object') {
    return false;
  }

  const keys = Object.keys(files);

  if (keys.length === 0) {
    return false;
  }

  for (const filename of keys) {
    if (!filename.toLowerCase().endsWith('.html')) {
      continue;
    }

    const html = files[filename];

    if (typeof html !== 'string') {
      return false;
    }

    if (!html.toLowerCase().includes('<!doctype html>')) {
      return false;
    }

    if (!html.toLowerCase().includes('</html>')) {
      return false;
    }
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/* ROUTE                                                                      */
/* -------------------------------------------------------------------------- */

router.post('/website', async (req, res) => {
  try {
    const mode = req.body && req.body.mode;

    if (mode !== 'build' && mode !== 'revise') {
      return res.status(400).json({
        error: {
          message: "mode must be 'build' or 'revise'",
        },
      });
    }

    const prompt = ((req.body && req.body.prompt) || '').trim();

    if (!prompt) {
      return res.status(400).json({
        error: {
          message: 'prompt is required',
        },
      });
    }

    let messages;
    let maxTokens;

    /* ---------------------------------------------------------------------- */
    /* BUILD                                                                   */
    /* ---------------------------------------------------------------------- */

    if (mode === 'build') {
      // Website Studio intentionally limits a single build to 4 pages.
      // This prevents giant JSON responses and truncated HTML.
      const requestedPages = Number(
        req.body && req.body.maxPages
      ) || 4;

      const maxPages = Math.max(
        1,
        Math.min(4, requestedPages)
      );

      // Default 10k budget.
      // Maximum completion allowance is 30k.
      const tokenBudget =
        Number(req.body && req.body.tokenBudget) || 10000;

      maxTokens = Math.min(
        30000,
        Math.max(8000, tokenBudget * 2)
      );

      messages = [
        {
          role: 'system',
          content: BUILD_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content:
            `Build this website with a maximum of ${maxPages} pages.\n\n` +
            `User request:\n${prompt}`,
        },
      ];
    }

    /* ---------------------------------------------------------------------- */
    /* REVISE                                                                  */
    /* ---------------------------------------------------------------------- */

    else {
      const existingFiles =
        req.body && req.body.existingFiles;

      const pageOrder =
        req.body && req.body.pageOrder;

      if (
        !existingFiles ||
        typeof existingFiles !== 'object' ||
        Object.keys(existingFiles).length === 0
      ) {
        return res.status(400).json({
          error: {
            message:
              'existingFiles is required for revise mode',
          },
        });
      }

      // Revisions normally affect one or two pages.
      // 16k is enough for a targeted revision while avoiding
      // unnecessarily huge responses.
      maxTokens = 16000;

      messages = [
        {
          role: 'system',
          content: REVISE_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content:
            `Current page order:\n${JSON.stringify(pageOrder || [])}\n\n` +
            `Current site files:\n${JSON.stringify(existingFiles)}\n\n` +
            `Change requested:\n${prompt}`,
        },
      ];
    }

    /* ---------------------------------------------------------------------- */
    /* OPENAI REQUEST                                                          */
    /* ---------------------------------------------------------------------- */

    console.log('Website Studio request:', {
      mode,
      model: WEBSITE_MODEL,
      maxTokens,
      promptLength: prompt.length,
    });

    const completion =
      await openai.chat.completions.create({
        model: WEBSITE_MODEL,

        // GPT-5.4 Mini should be allowed to focus on
        // generating the requested HTML.
        temperature: 0.7,

        max_completion_tokens: maxTokens,

        response_format: {
          type: 'json_object',
        },

        messages,
      });

    /* ---------------------------------------------------------------------- */
    /* RESPONSE INFORMATION                                                    */
    /* ---------------------------------------------------------------------- */

    const choice =
      completion.choices &&
      completion.choices.length > 0
        ? completion.choices[0]
        : null;

    const raw =
      choice &&
      choice.message &&
      typeof choice.message.content === 'string'
        ? choice.message.content
        : '';

    console.log(
      'Website Studio OpenAI response:',
      JSON.stringify({
        model: WEBSITE_MODEL,
        finish_reason: choice
          ? choice.finish_reason
          : null,
        response_length: raw.length,
        usage: completion.usage || null,
      })
    );

    /* ---------------------------------------------------------------------- */
    /* EMPTY RESPONSE                                                          */
    /* ---------------------------------------------------------------------- */

    if (!raw.trim()) {
      console.error(
        'Website Studio: OpenAI returned an empty response.'
      );

      return res.status(502).json({
        error: {
          message:
            'The AI returned an empty response. Please try again.',
        },
      });
    }

    /* ---------------------------------------------------------------------- */
    /* TRUNCATED RESPONSE                                                      */
    /* ---------------------------------------------------------------------- */

    if (choice && choice.finish_reason === 'length') {
      console.error(
        'Website Studio: response reached the completion limit.'
      );

      return res.status(502).json({
        error: {
          message:
            'The AI response was too large. Please try a shorter website request or fewer pages.',
          code: 'RESPONSE_TOO_LARGE',
        },
      });
    }

    /* ---------------------------------------------------------------------- */
    /* JSON PARSING                                                            */
    /* ---------------------------------------------------------------------- */

    let parsed;

    try {
      const cleaned = stripJsonFences(raw);
      parsed = JSON.parse(cleaned);
    } catch (error) {
      console.error(
        'Website Studio: invalid JSON from OpenAI.',
        {
          finish_reason: choice
            ? choice.finish_reason
            : null,
          response_length: raw.length,
          raw: raw.slice(0, 3000),
        }
      );

      return res.status(502).json({
        error: {
          message:
            'The AI returned an invalid website response. Please try again.',
          code: 'INVALID_AI_JSON',
        },
      });
    }

    /* ---------------------------------------------------------------------- */
    /* BUILD RESPONSE                                                          */
    /* ---------------------------------------------------------------------- */

    if (mode === 'build') {
      if (!validateFiles(parsed.files)) {
        console.error(
          'Website Studio: build response did not contain valid files.'
        );

        return res.status(502).json({
          error: {
            message:
              'The AI did not return valid website files. Please try again.',
            code: 'INVALID_WEBSITE_FILES',
          },
        });
      }

      let pageOrder;

      if (Array.isArray(parsed.pageOrder)) {
        pageOrder = parsed.pageOrder
          .map((item) => String(item))
          .filter((item) =>
            Object.prototype.hasOwnProperty.call(
              parsed.files,
              item
            )
          );
      } else {
        pageOrder = Object.keys(parsed.files);
      }

      // If the model returned an invalid/empty pageOrder,
      // fall back to the returned files.
      if (pageOrder.length === 0) {
        pageOrder = Object.keys(parsed.files);
      }

      return res.json({
        name:
          typeof parsed.name === 'string'
            ? parsed.name.trim()
            : '',

        pageOrder,

        files: parsed.files,
      });
    }

    /* ---------------------------------------------------------------------- */
    /* REVISE RESPONSE                                                         */
    /* ---------------------------------------------------------------------- */

    if (!validateFiles(parsed.files)) {
      console.error(
        'Website Studio: revision response did not contain valid files.'
      );

      return res.status(502).json({
        error: {
          message:
            'The AI did not return valid changed files. Please try again.',
          code: 'INVALID_REVISION_FILES',
        },
      });
    }

    return res.json({
      files: parsed.files,
    });
  } catch (err) {
    console.error(
      'POST /ai/website failed:',
      err
    );

    const status =
      err &&
      err.status &&
      Number.isInteger(err.status)
        ? err.status
        : 500;

    return res.status(status).json({
      error: {
        message:
          err &&
          err.message
            ? err.message
            : 'Website generation failed.',
      },
    });
  }
});

module.exports = router;