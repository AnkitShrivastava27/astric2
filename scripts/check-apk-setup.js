#!/usr/bin/env node
// Run from the server folder BEFORE adding the variables on Render:
//   GITHUB_APK_REPO=you/astric-apk-builder GITHUB_APK_TOKEN=github_pat_xxx APK_LINK_SECRET=long-random \
//     node scripts/check-apk-setup.js
// Prints a plain-language ✅/❌ list. Read-only: it never starts a build.
'use strict';
const axios = require('axios');

const REPO = process.env.GITHUB_APK_REPO;
const TOKEN = process.env.GITHUB_APK_TOKEN;
const SECRET = process.env.APK_LINK_SECRET;
const BRANCH = process.env.GITHUB_APK_BRANCH || 'main';
let bad = 0;
const ok  = (m) => console.log('✅', m);
const no  = (m) => { bad++; console.log('❌', m); };

(async () => {
  if (!REPO || !/^[\w.-]+\/[\w.-]+$/.test(REPO)) no('GITHUB_APK_REPO must look like "owner/astric-apk-builder".'); else ok(`GITHUB_APK_REPO = ${REPO}`);
  if (!TOKEN) no('GITHUB_APK_TOKEN is not set.'); else ok('GITHUB_APK_TOKEN is set');
  if (!SECRET || SECRET.length < 16) no('APK_LINK_SECRET must be at least 16 random characters.'); else ok('APK_LINK_SECRET is set');
  if (bad) return finish();

  const api = axios.create({
    baseURL: 'https://api.github.com', timeout: 20000, validateStatus: () => true,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'astric-check' },
  });

  const repo = await api.get(`/repos/${REPO}`);
  if (repo.status === 401) return (no('GitHub rejected the token (expired or mistyped).'), finish());
  if (repo.status === 404) return (no('Repo not found, or the token has no access to it. Token → "Only select repositories" must include it.'), finish());
  if (repo.status !== 200) return (no(`Unexpected GitHub answer ${repo.status} reading the repo.`), finish());
  ok('Token can see the repo');
  repo.data.private ? ok('Repo is private') : no('Repo is PUBLIC — generated apps would be visible to everyone. Make it private.');

  const wf = await api.get(`/repos/${REPO}/actions/workflows/build-apk.yml`);
  wf.status === 200 ? ok('Workflow build-apk.yml exists') : no('Workflow build-apk.yml not found — upload the .github folder to the repo (hidden folder!).');

  const shell = await api.get(`/repos/${REPO}/contents/android/app/src/main/java/com/astric/shell/MainActivity.java`, { params: { ref: BRANCH } });
  shell.status === 200 ? ok(`Android shell found on branch "${BRANCH}"`) : no(`Android shell missing on branch "${BRANCH}".`);

  const runs = await api.get(`/repos/${REPO}/actions/workflows/build-apk.yml/runs`, { params: { per_page: 5 } });
  if (runs.status === 200) {
    const done = (runs.data.workflow_runs || []).find((r) => r.status === 'completed');
    if (!done) no('No finished run yet — do the smoke test first (Actions → Build APK → Run workflow).');
    else done.conclusion === 'success' ? ok('A build has completed successfully') : no(`Latest finished run ended "${done.conclusion}" — open it in the Actions tab and read the red step.`);
  } else no('Token cannot read Actions runs — give it "Actions: Read and write".');

  finish();
})().catch((e) => { no(`Could not reach GitHub: ${e.message}`); finish(); });

function finish() {
  console.log(bad ? `\n${bad} problem(s) above — fix them and run this again.` : '\nAll good — add the three variables on Render.');
  process.exit(bad ? 1 : 0);
}
