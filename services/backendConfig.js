'use strict';
// services/backendConfig.js
//
// Pro apps carry ONE editable settings line that the app's data layer reads:
//
//   const CONFIG = /*ASTRIC_CONFIG*/{"firebaseApiKey":"","firebaseProjectId":"","apiBaseUrl":""};
//
// The customer can fill it three ways: (1) before the build, in the form;
// (2) after the build, with the Backend button (no AI call, no credits);
// (3) by pasting the values into their prompt / an attached doc, in which case
// the model is told to put them there. Whatever the path, THIS file is what
// writes the values into the HTML, and it only accepts strictly-shaped values,
// so nothing can be smuggled into the page's <script>.
//
// Firebase web API keys and project ids are public identifiers (they ship in
// every Firebase web app); access is protected by Firestore security rules, not
// by hiding them. Service-account keys are rejected elsewhere (docValidator).

const MARKER_RE = /\/\*ASTRIC_CONFIG\*\/\s*\{[^}]*\}/;

const RULES = {
  firebaseApiKey:     { re: /^[A-Za-z0-9_-]{20,80}$/,            msg: 'Firebase API key looks wrong (letters, digits, - and _ only).' },
  firebaseProjectId:  { re: /^[a-z][a-z0-9-]{3,28}[a-z0-9]$/,    msg: 'Firebase project ID looks wrong (lowercase letters, digits, dashes).' },
  apiBaseUrl:         { re: /^https:\/\/[A-Za-z0-9.-]+(?::\d{2,5})?(?:\/[A-Za-z0-9._~\-\/]*)?$/, msg: 'API base URL must start with https:// and contain no spaces or quotes.' },
};

/** @returns {{ok:boolean, config:object, errors:string[]}} — empty strings are fine (= not set). */
function sanitizeBackendConfig(raw) {
  const config = { firebaseApiKey: '', firebaseProjectId: '', apiBaseUrl: '' };
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const key of Object.keys(config)) {
    let v = typeof src[key] === 'string' ? src[key].trim() : '';
    if (key === 'apiBaseUrl') v = v.replace(/\/+$/, '');
    if (!v) continue;
    if (v.length > 200 || !RULES[key].re.test(v)) { errors.push(RULES[key].msg); continue; }
    config[key] = v;
  }
  // A Firestore connection needs both halves.
  if (!!config.firebaseApiKey !== !!config.firebaseProjectId) {
    errors.push('Enter both the Firebase API key and the project ID, or neither.');
  }
  return { ok: errors.length === 0, config, errors };
}

function readConfig(html) {
  const m = typeof html === 'string' ? MARKER_RE.exec(html) : null;
  if (!m) return null;
  try { return JSON.parse(m[0].replace(/^\/\*ASTRIC_CONFIG\*\/\s*/, '')); } catch (_) { return null; }
}

/** @returns {{html:string, applied:boolean}} */
function applyConfig(html, config) {
  if (typeof html !== 'string' || !MARKER_RE.test(html)) return { html, applied: false };
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return { html: html.replace(MARKER_RE, () => `/*ASTRIC_CONFIG*/${json}`), applied: true };
}

module.exports = { sanitizeBackendConfig, readConfig, applyConfig };
