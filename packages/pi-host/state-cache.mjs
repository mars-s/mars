// /api/state without redoing the heavy part every second (docs/LIVE-INTEGRATION.md "State
// caching"). A long chat's transcript is megabytes of entries the browser polls once a second;
// they only ever grow, so their browser-safe JSON is kept per conversation and rebuilt only
// when an entry is added or the last one changes. The whole answer carries an ETag, so a poll
// that finds nothing new gets 304 and no body, and large answers are gzipped.
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCallback, constants } from 'node:zlib';

const gzip = promisify(gzipCallback);
const KEEP = 24;
const GZIP_FROM = 32 * 1024;

/** The cache key of a transcript: how many entries, and the last one's id and size. */
export function entriesKey(entries) {
  const last = entries.at(-1);
  return entries.length + ':' + (last ? String(last.id) + ':' + JSON.stringify(last).length : '');
}

export function createStateCache({ browserView, keep = KEEP }) {
  const cache = new Map();
  /**
   * The conversation's view as browser-safe JSON text, and its docs as an object. Entries come
   * from the cache when nothing was added; docs (small, and changing while a reply runs) are
   * copied every time.
   */
  async function view(conversation, context) {
    const attached = await conversation.viewState(context);
    try {
      const value = attached.value;
      const entries = value.entries ?? [];
      const id = String(conversation.id);
      const key = entriesKey(entries);
      let hit = cache.get(id);
      if (!hit || hit.key !== key) {
        hit = { key, json: JSON.stringify(browserView({ entries: structuredClone(entries) }).entries) };
        cache.delete(id);
        cache.set(id, hit);
        while (cache.size > keep) cache.delete(cache.keys().next().value);
      } else {
        cache.delete(id);
        cache.set(id, hit);
      }
      const { entries: _entries, ...rest } = value;
      const copy = browserView(structuredClone(rest));
      const others = JSON.stringify(copy);
      const json = others === '{}' ? '{"entries":' + hit.json + '}' : '{"entries":' + hit.json + ',' + others.slice(1);
      return { json, docs: copy.docs ?? {}, value: copy };
    } finally {
      attached.dispose();
    }
  }
  return { view, size: () => cache.size };
}

/** The JSON body with view spliced in as text (it is already serialised), and view last. */
export function stateBody(payload, viewJson) {
  const head = JSON.stringify(payload);
  return head === '{}' ? '{"view":' + viewJson + '}' : head.slice(0, -1) + ',"view":' + viewJson + '}';
}

/** Send a JSON body with an ETag (304 when unchanged) and gzip when the client takes it. */
export async function sendCachedJson(req, res, body) {
  const etag = '"' + createHash('sha1').update(body).digest('base64url') + '"';
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-cache', etag, vary: 'accept-encoding' };
  if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, headers);
    res.end();
    return { status: 304, bytes: 0 };
  }
  if (body.length >= GZIP_FROM && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    const packed = await gzip(body, { level: 1, strategy: constants.Z_DEFAULT_STRATEGY });
    res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': packed.length });
    res.end(packed);
    return { status: 200, bytes: packed.length };
  }
  res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return { status: 200, bytes: Buffer.byteLength(body) };
}
