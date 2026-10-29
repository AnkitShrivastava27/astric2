/**
 * services/sheetFetch.js — reads a Google Sheet that is shared as "Anyone with the link" and returns it as CSV text.
 *
 * Why this exists: the old importer only tried the /export?format=csv URL and answered every failure with the same
 * "make the link public" message, even when the sheet WAS public. It also mis-read "Publish to web" links
 * (/d/e/2PACX-…) as sheet id "e". This version:
 *   - understands normal links, /u/0/ links, "Publish to web" links, links with #gid=, and a bare sheet id;
 *   - tries the gviz CSV endpoint first (works for link-shared sheets without extra redirects), then /export;
 *   - tells the user the REAL reason: restricted sharing, Excel file (not a native Google Sheet), rate limit, not found.
 */
'use strict';

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class SheetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MESSAGES = {
  badLink: "That doesn't look like a Google Sheets link. Copy the address from your browser while the sheet is open (it contains /spreadsheets/d/…).",
  private: 'Google says this sheet is not shared publicly yet. In Google Sheets click Share → under "General access" change "Restricted" to '
    + '"Anyone with the link" (role: Viewer) → Done, then try again. If you use a company Google Workspace account your admin may block public links; '
    + 'in that case use File → Share → Publish to web → choose CSV → Publish, and paste that link here instead.',
  notNative: 'This link opens an Excel/other file stored in Google Drive, not a Google Sheet, so it cannot be read. Open it and choose '
    + 'File → Save as Google Sheets, share the new sheet with "Anyone with the link", and paste the new link.',
  rate: 'Google is temporarily limiting requests from our server. Please try again in a minute.',
  notFound: 'Sheet not found. Check that the link is complete and the sheet has not been deleted.',
  generic: 'Google did not return the sheet data. Check that the link is correct and shared as "Anyone with the link" (Viewer), then try again.',
  network: 'Could not reach Google Sheets. Try again in a moment.',
};

/** -> { kind: 'doc'|'pub', id, gid } or null */
function parseSheetUrl(raw) {
  const s = String(raw || '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!s) return null;
  if (/^[a-zA-Z0-9_-]{25,}$/.test(s)) return { kind: 'doc', id: s, gid: '0' };               // a bare sheet id
  const gid = (s.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  const pub = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/e\/([a-zA-Z0-9_-]+)/);                 // "Publish to web" link
  if (pub) return { kind: 'pub', id: pub[1], gid, single: /[?&]single=true/.test(s) };
  const doc = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (doc && doc[1] !== 'e') return { kind: 'doc', id: doc[1], gid };
  return null;
}

const looksHtml = (b) => /^\s*<(!doctype|html|head|body)/i.test(String(b || ''));

/** Why a non-CSV answer came back. */
function classify(r, body) {
  const finalUrl = String((r.request && r.request.res && r.request.res.responseUrl) || (r.request && r.request.path) || '');
  const text = String(body || '').slice(0, 4000);
  if (r.status === 429) return 'rate';
  if (r.status === 404) return 'notFound';
  if (/accounts\.google\.com|ServiceLogin|Sign in - Google|signin\/v2/i.test(finalUrl + ' ' + text) || r.status === 401 || r.status === 403) return 'private';
  if (r.status === 400 || /unable to open the file|not supported for this document|This operation is not supported/i.test(text)) return 'notNative';
  return 'generic';
}

const PRIORITY = ['private', 'notNative', 'rate', 'notFound', 'generic'];

async function fetchSheetCsv(rawUrl, { http = axios } = {}) {
  const p = parseSheetUrl(rawUrl);
  if (!p) throw new SheetError('badLink', MESSAGES.badLink);

  const attempts = p.kind === 'pub'
    ? [{ url: `https://docs.google.com/spreadsheets/d/e/${p.id}/pub`, params: { output: 'csv', ...(p.single ? { single: 'true' } : {}), gid: p.gid } }]
    : [
        { url: `https://docs.google.com/spreadsheets/d/${p.id}/gviz/tq`, params: { tqx: 'out:csv', gid: p.gid } },
        { url: `https://docs.google.com/spreadsheets/d/${p.id}/export`, params: { format: 'csv', gid: p.gid } },
      ];

  const failures = [];
  let networkErrors = 0;
  for (const a of attempts) {
    try {
      const r = await http.get(a.url, {
        params: a.params, responseType: 'text', timeout: 20_000, maxContentLength: 5 * 1024 * 1024, maxRedirects: 5,
        headers: { 'User-Agent': UA, Accept: 'text/csv,text/plain,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
        transformResponse: (d) => d, validateStatus: () => true,
      });
      const body = r.data;
      if (r.status === 200 && !looksHtml(body) && String(body).trim()) return { csv: String(body), via: a.url.includes('gviz') ? 'gviz' : a.url.includes('/pub') ? 'pub' : 'export' };
      failures.push(classify(r, body));
    } catch (e) { networkErrors++; }
  }
  if (networkErrors === attempts.length) throw new SheetError('network', MESSAGES.network);
  const code = PRIORITY.find((c) => failures.includes(c)) || 'generic';
  throw new SheetError(code, MESSAGES[code]);
}

module.exports = { fetchSheetCsv, parseSheetUrl, SheetError, MESSAGES, _classify: classify };
