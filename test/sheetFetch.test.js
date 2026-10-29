const test = require('node:test');
const assert = require('node:assert');
const { fetchSheetCsv, parseSheetUrl, SheetError } = require('../services/sheetFetch');

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc';
const CSV = 'Name,Phone,Email\nAsha,9800000001,asha@x.com\n';
const resp = (status, data, finalUrl) => ({ status, data, request: { res: { responseUrl: finalUrl || '' } } });

test('parseSheetUrl understands every link shape people paste', () => {
  assert.deepStrictEqual(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`), { kind: 'doc', id: ID, gid: '0' });
  assert.deepStrictEqual(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=1234`), { kind: 'doc', id: ID, gid: '1234' });
  assert.deepStrictEqual(parseSheetUrl(`https://docs.google.com/spreadsheets/u/0/d/${ID}/edit?gid=77`), { kind: 'doc', id: ID, gid: '77' });
  assert.deepStrictEqual(parseSheetUrl(`  "https://docs.google.com/spreadsheets/d/${ID}/view"  `), { kind: 'doc', id: ID, gid: '0' });
  assert.deepStrictEqual(parseSheetUrl(ID), { kind: 'doc', id: ID, gid: '0' });
  const pub = parseSheetUrl('https://docs.google.com/spreadsheets/d/e/2PACX-1vQabc_DEF/pubhtml?gid=5&single=true');
  assert.strictEqual(pub.kind, 'pub'); assert.strictEqual(pub.id, '2PACX-1vQabc_DEF'); assert.strictEqual(pub.gid, '5');   // was mis-read as id "e" before
  assert.strictEqual(parseSheetUrl('https://example.com/x'), null);
  assert.strictEqual(parseSheetUrl(''), null);
});

test('uses the gviz endpoint first and returns the csv', async () => {
  const urls = [];
  const http = { get: async (url, o) => { urls.push(url); return resp(200, CSV); } };
  const r = await fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http });
  assert.strictEqual(r.csv, CSV); assert.strictEqual(r.via, 'gviz'); assert.strictEqual(urls.length, 1); assert.match(urls[0], /gviz\/tq$/);
});

test('falls back to /export when gviz fails', async () => {
  const http = { get: async (url) => (url.includes('gviz') ? resp(400, '<html>Sorry</html>') : resp(200, CSV)) };
  const r = await fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http });
  assert.strictEqual(r.via, 'export');
});

test('published-to-web links use the pub endpoint', async () => {
  let seen;
  const http = { get: async (url, o) => { seen = { url, params: o.params }; return resp(200, CSV); } };
  const r = await fetchSheetCsv('https://docs.google.com/spreadsheets/d/e/2PACX-1vQabc/pubhtml', { http });
  assert.strictEqual(r.via, 'pub'); assert.match(seen.url, /\/d\/e\/2PACX-1vQabc\/pub$/); assert.strictEqual(seen.params.output, 'csv');
});

test('tells the user the real reason it failed', async () => {
  const priv = { get: async () => resp(200, '<!DOCTYPE html><html>Sign in</html>', 'https://accounts.google.com/ServiceLogin?x') };
  await assert.rejects(() => fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http: priv }), (e) => e instanceof SheetError && e.code === 'private' && /Anyone with the link/.test(e.message) && /Publish to web/.test(e.message));

  const xlsx = { get: async () => resp(400, '<html>Sorry, unable to open the file at present.</html>') };
  await assert.rejects(() => fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http: xlsx }), (e) => e.code === 'notNative' && /Save as Google Sheets/.test(e.message));

  const rate = { get: async () => resp(429, 'Too Many Requests') };
  await assert.rejects(() => fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http: rate }), (e) => e.code === 'rate');

  const nf = { get: async () => resp(404, 'nope') };
  await assert.rejects(() => fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http: nf }), (e) => e.code === 'notFound');

  const down = { get: async () => { throw new Error('ENOTFOUND'); } };
  await assert.rejects(() => fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http: down }), (e) => e.code === 'network');

  await assert.rejects(() => fetchSheetCsv('not a link', { http: priv }), (e) => e.code === 'badLink');
});

test('a private-sheet answer beats a generic one when the two attempts disagree', async () => {
  const http = { get: async (url) => (url.includes('gviz') ? resp(302, '', 'https://accounts.google.com/x') : resp(500, 'oops')) };
  await assert.rejects(() => fetchSheetCsv(`https://docs.google.com/spreadsheets/d/${ID}/edit`, { http }), (e) => e.code === 'private');
});
