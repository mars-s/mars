import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

/**
 * Web search and page reading through the owner's signed-in subscriptions.
 * Provider-native server tools (Anthropic web_search/web_fetch, OpenAI Responses web_search)
 * are injected with onPayload, so pi-ai keeps owning OAuth refresh, identity headers and budget.
 */
export const DEFAULT_SEARCH_MODELS = ['anthropic/claude-haiku-4-5', 'openai/gpt-5.6-luna'];
const FETCH_BETA = 'web-fetch-2025-09-10';
const MAX_BODY = 5 * 1024 * 1024;
const output = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value });
const text = message => (message.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
const today = () => new Date().toISOString().slice(0, 10);

export function parseModelList(value) {
  if (!value) return DEFAULT_SEARCH_MODELS;
  const rows = value.split(',').map(s => s.trim()).filter(Boolean);
  for (const row of rows) if (!/^[a-z0-9-]+\/\S+$/.test(row)) throw Error('Invalid web search model ' + row);
  return rows;
}

export function extractSources(answer) {
  const seen = new Set();
  for (const match of answer.matchAll(/https?:\/\/[^\s<>()\[\]"'\x60]+/g)) {
    let url = match[0].replace(/[.,;:!?*_]+$/, '');
    try { const u = new URL(url); u.searchParams.delete('utm_source'); url = u.toString(); } catch { continue; }
    seen.add(url);
  }
  return [...seen].slice(0, 20);
}

function nativeTool(provider, args) {
  if (provider === 'anthropic') {
    const tool = { type: 'web_search_20250305', name: 'web_search', max_uses: args.max_searches ?? 5 };
    if (args.allowed_domains?.length) tool.allowed_domains = args.allowed_domains;
    else if (args.blocked_domains?.length) tool.blocked_domains = args.blocked_domains;
    return tool;
  }
  const tool = { type: 'web_search' };
  if (args.allowed_domains?.length) tool.filters = { allowed_domains: args.allowed_domains };
  return tool;
}

function searchPrompt(provider, args) {
  const rules = [
    'You are a web research service answering for another AI agent. Today is ' + today() + '.',
    'Always use web search; never answer from memory alone. Prefer primary sources (official docs, release notes, registries).',
    'Do not narrate your process or write anything before searching; output only the final answer.',
    'Return a concise factual answer with concrete names, versions, dates and numbers. Say so plainly if sources disagree or nothing reliable was found.',
    'Finish with a line "Sources:" followed by one full URL per line for every page you relied on.',
  ];
  if (provider !== 'anthropic' && args.blocked_domains?.length) rules.push('Do not use sources from: ' + args.blocked_domains.join(', ') + '.');
  if (provider === 'anthropic' && args.allowed_domains?.length && args.blocked_domains?.length) rules.push('Do not use sources from: ' + args.blocked_domains.join(', ') + '.');
  return rules.join('\n');
}

export function isPrivateAddress(address) {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const s = address.toLowerCase();
    if (s.startsWith('::ffff:')) return isPrivateAddress(s.slice(7));
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true;
}

async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Only http and https URLs can be fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.ts\.net)$/i.test(host)) throw Error('Private hosts are not fetched by web_fetch; use the shell for local services');
  const rows = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!rows.length || rows.some(row => isPrivateAddress(row.address))) throw Error('Private network addresses are not fetched by web_fetch; use the shell for local services');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m);

export function htmlToText(html, base) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  let body = html.match(/<(main|article)\b[^>]*>([\s\S]*)<\/\1>/i)?.[2] || html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] || html;
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const inner = label.replace(/<[^>]+>/g, '').trim();
      if (!inner) return '';
      try { return '[' + inner + '](' + new URL(decode(href), base).toString() + ')'; } catch { return inner; }
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(pre)\b[^>]*>/gi, '\n\x60\x60\x60\n').replace(/<\/pre>/gi, '\n\x60\x60\x60\n')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|tr|blockquote|header|main)>/gi, '\n\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  const textBody = decode(body).replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: textBody };
}

async function readLimited(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); break; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createWebSearchExtension({ models, searchModels = parseModelList(process.env.MARS_WEB_SEARCH_MODELS), fetchImpl = fetch, resolvePublic = assertPublic } = {}) {
  if (!models) throw Error('models are required');

  async function complete(provider, modelId, systemPrompt, user, payload, signal) {
    const model = models.getModel(provider, modelId);
    if (!model) throw Error('Model ' + provider + '/' + modelId + ' is not available');
    if (!(await models.getAuth(provider))) throw Error(provider + ' is not signed in');
    const stream = models.streamSimple(model, { systemPrompt, messages: [{ role: 'user', content: user, timestamp: Date.now() }] }, { maxTokens: 4000, signal, onPayload: payload });
    const result = await stream.result();
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw Error(result.errorMessage || 'Request ' + result.stopReason);
    const answer = text(result);
    if (!answer) throw Error('The model returned no answer');
    return answer;
  }

  async function search(args, signal) {
    if (args.allowed_domains?.length && args.blocked_domains?.length && args.provider === 'openai') throw Error('Use allowed_domains or blocked_domains, not both');
    const candidates = searchModels.map(row => { const i = row.indexOf('/'); return [row.slice(0, i), row.slice(i + 1)]; })
      .filter(([provider]) => !args.provider || args.provider === 'auto' || provider === args.provider);
    if (!candidates.length) throw Error('No web search model is configured for ' + args.provider);
    const failures = [];
    for (const [provider, modelId] of candidates) {
      signal?.throwIfAborted();
      try {
        const tool = nativeTool(provider, args);
        const answer = await complete(provider, modelId, searchPrompt(provider, args), args.query, p => ({ ...p, tools: [...(p.tools || []), tool] }), signal);
        return { query: args.query, provider, model: modelId, answer, sources: extractSources(answer), ...(failures.length ? { fallbackFrom: failures } : {}) };
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push({ provider, model: modelId, error: String(error?.message || error).slice(0, 300) });
      }
    }
    throw Error('Web search failed: ' + failures.map(f => f.provider + ': ' + f.error).join('; '));
  }

  async function localFetch(args, signal) {
    let url = new URL(args.url);
    let response;
    for (let hop = 0; hop <= 5; hop++) {
      if (!['http:', 'https:'].includes(url.protocol)) throw Error('Only http and https URLs can be fetched');
      await resolvePublic(url);
      response = await fetchImpl(url, {
        redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)].filter(Boolean)),
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 MarsPi-web_fetch', accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5' },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        url = new URL(response.headers.get('location'), url);
        await response.body?.cancel();
        continue;
      }
      break;
    }
    if (response.status >= 300 && response.status < 400) throw Error('Too many redirects');
    const type = (response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok) { await response.body?.cancel(); throw Error('HTTP ' + response.status); }
    if (type && !/(text\/|json|xml|javascript)/.test(type)) { await response.body?.cancel(); throw Error('Unsupported content type ' + type.split(';')[0]); }
    const raw = await readLimited(response, signal);
    const page = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw, url) : { title: '', text: raw };
    if (page.text.length < 200 && /html/.test(type)) throw Error('Page has almost no readable text (likely needs JavaScript)');
    return { finalUrl: url.toString(), status: response.status, contentType: type.split(';')[0], title: page.title, content: page.text, method: 'direct' };
  }

  async function providerFetch(args, signal) {
    const [provider, modelId] = (searchModels.find(row => row.startsWith('anthropic/')) || '').split(/\/(.*)/s);
    if (provider !== 'anthropic') throw Error('No Anthropic model is configured for fetch fallback');
    const tool = { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: 20000 };
    const content = await complete(provider, modelId,
      'You are a page reader for another AI agent. Fetch the given URL with web_fetch and return its main content faithfully as Markdown: headings, lists, code, tables and important links. Do not summarise unless asked. If the fetch fails, reply exactly FETCH_FAILED and the reason.' + (args.prompt ? '\nFocus: ' + args.prompt : ''),
      args.url, p => ({ ...p, betas: [...new Set([...(p.betas || []), FETCH_BETA])], tools: [...(p.tools || []), tool] }), signal);
    if (/^FETCH_FAILED/.test(content)) throw Error(content.slice(0, 300));
    return { finalUrl: args.url, status: 200, contentType: 'text/markdown', title: '', content, method: 'anthropic' };
  }

  async function read(args, signal) {
    let page; let directError;
    try { page = await localFetch(args, signal); } catch (error) {
      if (signal?.aborted || /Private|Only http/.test(error.message) || args.fallback === false) throw error;
      directError = String(error.message).slice(0, 200);
      page = await providerFetch(args, signal);
    }
    const start = args.start ?? 0, max = args.max_chars ?? 20000;
    const slice = page.content.slice(start, start + max);
    const end = start + slice.length;
    return { url: args.url, ...page, content: slice, totalChars: page.content.length, ...(end < page.content.length ? { truncated: true, nextStart: end } : {}), ...(directError ? { directError } : {}) };
  }

  const domains = (what) => Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 20, description: `Domains to ${what}, e.g. ["github.com", "nodejs.org"]. Up to 20.` }));
  return defineExtension({
    name: 'web-search',
    marsPlugin: { title: 'Web Search', version: '1.0.0', description: 'Search the web and read pages through your signed-in Claude and ChatGPT subscriptions. Uses Anthropic first, then OpenAI. No extra API key.' },
    tools: [
      defineTool({
        name: 'web_search',
        description: `Search the web and get an answer with its sources.
Use it for anything current or outside what you know: news, releases, prices, docs, facts after your training data. Write query as a full question for the best answer. It returns a written answer plus the source URLs it used; to read one of those pages in full, call web_fetch with its URL.
Example: const { answer, sources } = await tools.web_search({ query: "What is the latest stable Node.js version?" })`,
        parameters: Type.Object({
          query: Type.String({ minLength: 2, maxLength: 1000, description: 'A question or search terms, e.g. "When does the next Ubuntu LTS release?"' }),
          allowed_domains: domains('search only'),
          blocked_domains: domains('leave out'),
          provider: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('anthropic'), Type.Literal('openai')], { default: 'auto', description: 'Which subscription searches. "auto" (default) tries Anthropic first, then OpenAI.' })),
          max_searches: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: 'Most web searches the provider may run for this answer, 1 to 10. Higher is slower but more thorough.' })),
        }),
        replay: 'safe', executionMode: 'parallel', outputLimits: { maxBytes: 24000, maxLines: 400 },
        structuredOutputSchema: Type.Object({
          query: Type.String({ description: 'The query asked.' }),
          provider: Type.String({ description: 'Which provider answered.' }),
          model: Type.String({ description: 'The model used.' }),
          answer: Type.String({ description: 'The written answer, with source links inline.' }),
          sources: Type.Array(Type.String(), { description: 'Source URLs found in the answer. Pass one to web_fetch to read it.' }),
          fallbackFrom: Type.Optional(Type.Array(Type.Any(), { description: 'Providers that failed first, when a fallback answered.' })),
        }),
        execute: async (args, _api, context) => output(await search(args, context?.abortSignal)),
      }),
      defineTool({
        name: 'web_fetch',
        description: `Read a web page by its URL (http:// or https://) and get its text.
Use it for any web address: a doc page, an article, a JSON or text file, or a source from web_search. For files on disk use host_read instead. Pages come back as readable text with links. Long pages arrive in parts: when truncated is true, call again with start set to nextStart. Local and private network addresses are refused; use host_exec with curl for those.
Example: const page = await tools.web_fetch({ url: "https://nodejs.org/en/about/previous-releases" })`,
        parameters: Type.Object({
          url: Type.String({ minLength: 8, maxLength: 4000, description: 'Full http(s) URL, e.g. "https://example.com/docs".' }),
          start: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: 'Character position to read from. Use nextStart from the previous call for the next part.' })),
          max_chars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, default: 20000, description: "Most characters to return in this part, 1000 to 60000." })),
          prompt: Type.Optional(Type.String({ maxLength: 500, description: 'What to focus on if the page has to be read through a provider because direct access is blocked.' })),
          fallback: Type.Optional(Type.Boolean({ default: true, description: 'false stops the provider fallback when direct access is blocked.' })),
        }),
        replay: 'safe', executionMode: 'parallel', outputLimits: { maxBytes: 70000, maxLines: 2000 },
        structuredOutputSchema: Type.Object({
          url: Type.String({ description: 'The URL asked for.' }),
          finalUrl: Type.String({ description: 'The URL after redirects.' }),
          status: Type.Integer({ description: 'HTTP status.' }),
          contentType: Type.String({ description: 'e.g. "text/html".' }),
          title: Type.String({ description: 'Page title, when it has one.' }),
          method: Type.String({ description: '"direct", or the provider used as fallback.' }),
          content: Type.String({ description: 'The readable text of this part.' }),
          totalChars: Type.Integer({ description: 'Length of the whole page text.' }),
          truncated: Type.Optional(Type.Boolean({ description: 'True when there is more; call again with start: nextStart.' })),
          nextStart: Type.Optional(Type.Integer({ description: 'Pass as start to read the next part.' })),
          directError: Type.Optional(Type.String({ description: 'Why direct access failed, when a fallback was used.' })),
        }),
        execute: async (args, _api, context) => output(await read(args, context?.abortSignal)),
      }),
    ],
  });
}
