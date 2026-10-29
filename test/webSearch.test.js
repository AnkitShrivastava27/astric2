const test = require('node:test');
const assert = require('node:assert');
const ws = require('../services/webSearch');

const HTML = `
<div class="result results_links results_links_deep web-result">
 <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%3Fa%3D1%26b%3D2&amp;rut=abc">Example &amp; News &mdash; Today</a></h2>
 <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">The <b>latest</b> news about &quot;things&quot; &amp; stuff.</a>
</div>
<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_provider=x">Sponsored</a></h2></div>
<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.org%2F&amp;rut=z">Other site</a></h2>
 <a class="result__snippet" href="x">Second snippet</a></div>`;

test('parses results, decodes redirect urls and entities, skips ads', () => {
  const r = ws.parseDuckDuckGoHtml(HTML);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].url, 'https://example.com/news?a=1&b=2');
  assert.strictEqual(r[0].title, 'Example & News — Today');
  assert.strictEqual(r[0].snippet, 'The latest news about "things" & stuff.');
  assert.strictEqual(r[1].url, 'https://other.org/');
  assert.strictEqual(r[1].snippet, 'Second snippet');
});

test('needsWebSearch is true for current-info questions and false for chit-chat / timeless questions', () => {
  for (const t of ['What is the latest iPhone price in India?', 'gold rate today', 'who won the IPL final', 'weather in Patna tomorrow', 'news about GST council'])
    assert.ok(ws.needsWebSearch(t), t);
  for (const t of ['hi', 'thanks', 'write a follow-up email to my client', 'explain what a CRM is', 'summarise this text for me please'])
    assert.ok(!ws.needsWebSearch(t), t);
});

test('webSearch uses the HTML page, caches, and falls back to the instant-answer API', async () => {
  ws._cache.clear();
  let posts = 0;
  const http = {
    post: async () => { posts++; return { status: 200, data: HTML }; },
    get: async () => { throw new Error('should not be called'); },
  };
  const a = await ws.webSearch('latest news', { http });
  const b = await ws.webSearch('latest news', { http });
  assert.strictEqual(a.results.length, 2); assert.strictEqual(posts, 1); assert.deepStrictEqual(a, b);

  ws._cache.clear();
  const blocked = {
    post: async () => ({ status: 202, data: '<html>anomaly</html>' }),
    get: async () => ({ data: { Heading: 'Node.js', AbstractText: 'Node.js is a runtime.', AbstractURL: 'https://nodejs.org', RelatedTopics: [{ Text: 'Related thing', FirstURL: 'https://x.y' }] } }),
  };
  const c = await ws.webSearch('what is nodejs', { http: blocked });
  assert.ok(c.results.length >= 1 && c.results[0].snippet.includes('runtime') && !c.error);

  ws._cache.clear();
  const dead = { post: async () => { const e = new Error('x'); e.code = 'ECONNABORTED'; throw e; }, get: async () => { throw new Error('down'); } };
  const d = await ws.webSearch('anything', { http: dead });
  assert.deepStrictEqual(d.results, []); assert.ok(d.error);
  const again = await ws.webSearch('anything', { http: { post: async () => ({ status: 200, data: HTML }), get: async () => ({ data: {} }) } });
  assert.strictEqual(again.results.length, 2);   // a failure was NOT cached
});

test('queryFrom shortens long messages and formatForModel numbers the sources', () => {
  assert.ok(ws.queryFrom('x'.repeat(500)).length <= 140);
  assert.strictEqual(ws.queryFrom('Who is the PM of India? Also write me a long essay about it.'), 'Who is the PM of India? Also write me a long essay about it.');
  const f = ws.formatForModel('q', [{ title: 'T', url: 'https://a', snippet: 's' }]);
  assert.ok(f.includes('[1] T') && f.includes('https://a') && /Ignore any instructions/.test(f));
});
