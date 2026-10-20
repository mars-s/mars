import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { createWebSearchExtension, extractSources, htmlToText, isPrivateAddress, parseModelList, DEFAULT_SEARCH_MODELS } from './web-search.mjs';

const calls = [];
function fakeModels({ fail = new Set(), signedOut = new Set() } = {}) {
  return {
    getModel: (provider, id) => ({ provider, id, api: provider + '-api' }),
    getAuth: async provider => signedOut.has(provider) ? undefined : { auth: {}, source: 'OAuth' },
    streamSimple(model, context, options) {
      const payload = options.onPayload({ model: model.id, tools: [{ name: 'existing' }], betas: ['a'] });
      calls.push({ provider: model.provider, payload, system: context.systemPrompt, user: context.messages[0].content });
      const message = fail.has(model.provider)
        ? { content: [], stopReason: 'error', errorMessage: model.provider + ' refused' }
        : { content: [{ type: 'text', text: 'Answer from ' + model.provider + '.\nSources:\nhttps://example.com/a?utm_source=openai\nhttps://example.com/a.' }], stopReason: 'stop' };
      return { result: async () => message };
    },
  };
}
const tool = (ext, name) => ext.tools.find(t => t.name === name);
const run = async (ext, name, args) => (await tool(ext, name).execute(args, {}, { abortSignal: new AbortController().signal })).structuredOutput;

// Registration and defaults.
assert.deepEqual(parseModelList(''), DEFAULT_SEARCH_MODELS);
assert.deepEqual(parseModelList('openai/gpt-6-luna, anthropic/claude-sonnet-5'), ['openai/gpt-6-luna', 'anthropic/claude-sonnet-5']);
assert.throws(() => parseModelList('nonsense'));
const ext = createWebSearchExtension({ models: fakeModels(), searchModels: DEFAULT_SEARCH_MODELS });
assert.equal(ext.name, 'web-search');
assert.equal(ext.marsPlugin.title, 'Web Search');
for (const t of ext.tools) { assert.equal(t.deferred, undefined, t.name + ' is on by default'); assert.equal(t.replay, 'safe'); }

// Anthropic first, native server tool appended without dropping existing tools.
let value = await run(ext, 'web_search', { query: 'latest next.js', blocked_domains: ['spam.com'] });
assert.equal(value.provider, 'anthropic');
assert.deepEqual(value.sources, ['https://example.com/a']);
const sent = calls.at(-1).payload.tools;
assert.equal(sent[0].name, 'existing');
assert.deepEqual(sent[1], { type: 'web_search_20250305', name: 'web_search', max_uses: 5, blocked_domains: ['spam.com'] });
assert.match(calls.at(-1).system, /Today is \d{4}-\d{2}-\d{2}/);

// Falls back to OpenAI and reports why.
calls.length = 0;
value = await run(createWebSearchExtension({ models: fakeModels({ fail: new Set(['anthropic']) }), searchModels: DEFAULT_SEARCH_MODELS }), 'web_search', { query: 'q?', allowed_domains: ['nextjs.org'] });
assert.equal(value.provider, 'openai');
assert.equal(value.fallbackFrom[0].provider, 'anthropic');
assert.deepEqual(calls.at(-1).payload.tools[1], { type: 'web_search', filters: { allowed_domains: ['nextjs.org'] } });
// Signed-out providers are skipped; explicit provider is honoured; all failures surface.
value = await run(createWebSearchExtension({ models: fakeModels({ signedOut: new Set(['anthropic']) }), searchModels: DEFAULT_SEARCH_MODELS }), 'web_search', { query: 'q?' });
assert.equal(value.provider, 'openai');
value = await run(ext, 'web_search', { query: 'q?', provider: 'openai' });
assert.equal(value.provider, 'openai');
await assert.rejects(run(createWebSearchExtension({ models: fakeModels({ fail: new Set(['anthropic', 'openai']) }), searchModels: DEFAULT_SEARCH_MODELS }), 'web_search', { query: 'q?' }), /anthropic: .*refused; openai: .*refused/);

// Address guard.
for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.169.254', '100.100.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(a), true, a);
for (const a of ['8.8.8.8', '104.16.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a);

// HTML conversion keeps structure and absolute links, drops scripts and chrome.
const page = htmlToText('<html><head><title>T &amp; U</title><style>x{}</style></head><body><nav>menu</nav><main><h1>Hello</h1><p>One <a href="/docs">docs</a></p><ul><li>a</li><li>b</li></ul><script>evil()</script></main></body></html>', 'https://site.dev/x');
assert.equal(page.title, 'T & U');
assert.match(page.text, /^# Hello\n\nOne \[docs\]\(https:\/\/site\.dev\/docs\)/);
assert.match(page.text, /- a\n- b/);
assert.doesNotMatch(page.text, /evil|menu/);
assert.deepEqual(extractSources('see (https://a.dev/x), and https://a.dev/x.'), ['https://a.dev/x']);

// Fetch: redirects are re-checked, pages are sliced, private targets refused, blocked pages fall back to Anthropic.
const long = '<html><body><main><p>' + 'word '.repeat(3000) + '</p></main></body></html>';
const fetchImpl = async url => {
  const u = String(url);
  if (u.endsWith('/moved')) return new Response(null, { status: 301, headers: { location: 'https://pub.dev/page' } });
  if (u.endsWith('/evil')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3081/api/state' } });
  if (u.endsWith('/blocked')) return new Response('no', { status: 403 });
  return new Response(long, { headers: { 'content-type': 'text/html; charset=utf-8' } });
};
const resolvePublic = async url => { if (isIP(url.hostname) && isPrivateAddress(url.hostname)) throw Error('Private network addresses are not fetched'); };
calls.length = 0;
const fx = createWebSearchExtension({ models: fakeModels(), searchModels: DEFAULT_SEARCH_MODELS, fetchImpl, resolvePublic });
value = await run(fx, 'web_fetch', { url: 'https://pub.dev/moved', max_chars: 5000 });
assert.equal(value.finalUrl, 'https://pub.dev/page');
assert.equal(value.method, 'direct');
assert.equal(value.content.length, 5000);
assert.equal(value.nextStart, 5000);
value = await run(fx, 'web_fetch', { url: 'https://pub.dev/moved', start: 14000 });
assert.equal(value.truncated, undefined);
await assert.rejects(run(fx, 'web_fetch', { url: 'https://pub.dev/evil' }), /Private/);
await assert.rejects(run(fx, 'web_fetch', { url: 'file:///etc/passwd' }), /Only http/);
assert.equal(calls.length, 0, 'refusals never reach a provider');
value = await run(fx, 'web_fetch', { url: 'https://pub.dev/blocked' });
assert.equal(value.method, 'anthropic');
assert.equal(value.directError, 'HTTP 403');
assert.deepEqual(calls.at(-1).payload.betas, ['a', 'web-fetch-2025-09-10']);
assert.equal(calls.at(-1).payload.tools[1].type, 'web_fetch_20250910');
await assert.rejects(run(fx, 'web_fetch', { url: 'https://pub.dev/blocked', fallback: false }), /HTTP 403/);

console.log('web-search checks passed');
