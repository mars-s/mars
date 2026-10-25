// /api/state caching (state-cache.mjs): the transcript's JSON is rebuilt only when entries are
// added or the last one changes; the spliced body equals plain JSON.stringify; an unchanged
// answer is 304 with no body; large answers are gzipped for clients that accept it.
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createStateCache, entriesKey, sendCachedJson, stateBody } from './state-cache.mjs';

const passed = [];
try {
  let copies = 0;
  const browserView = (value) => { copies++; return JSON.parse(JSON.stringify(value, (k, v) => (k === 'data' && typeof v === 'string' ? undefined : v))); };
  const cache = createStateCache({ browserView, keep: 2 });
  const value = { entries: [{ id: 1, model: [{ role: 'user', content: 'hi' }] }, { id: 2, image: { type: 'image', data: 'AAAA' } }], docs: { 'pi.live': { run: null } } };
  const conversation = (id, v) => ({ id, viewState: async () => ({ value: v, dispose() {} }) });
  const first = await cache.view(conversation(7, value), {});
  assert.deepEqual(JSON.parse(first.json), { entries: [{ id: 1, model: [{ role: 'user', content: 'hi' }] }, { id: 2, image: { type: 'image' } }], docs: { 'pi.live': { run: null } } });
  assert.deepEqual(first.docs, { 'pi.live': { run: null } });
  const entryCopies = copies;
  value.docs['pi.live'] = { run: { taskId: 3 } };
  const second = await cache.view(conversation(7, value), {});
  assert.equal(copies, entryCopies + 1, 'unchanged entries are not copied again (only the docs are)');
  assert.deepEqual(JSON.parse(second.json).docs, { 'pi.live': { run: { taskId: 3 } } }, 'docs are always fresh');
  value.entries.push({ id: 3, model: [{ role: 'assistant', content: 'yo' }] });
  const third = await cache.view(conversation(7, value), {});
  assert.equal(JSON.parse(third.json).entries.length, 3, 'a new entry rebuilds the cache');
  value.entries[2] = { id: 3, model: [{ role: 'assistant', content: 'yo, edited' }] };
  assert.equal(JSON.parse((await cache.view(conversation(7, value), {})).json).entries[2].model[0].content, 'yo, edited', 'a changed last entry rebuilds it');
  await cache.view(conversation(8, { entries: [] }), {});
  await cache.view(conversation(9, { entries: [] }), {});
  assert.equal(cache.size(), 2, 'bounded');
  assert.notEqual(entriesKey([{ id: 1 }]), entriesKey([{ id: 1 }, { id: 2 }]));
  passed.push('transcript JSON cached');

  const payload = { a: 1, conversations: [{ id: '1' }] };
  const body = stateBody(payload, third.json);
  assert.deepEqual(JSON.parse(body), { ...payload, view: JSON.parse(third.json) });
  assert.deepEqual(JSON.parse(stateBody({}, '{"entries":[]}')), { view: { entries: [] } });
  passed.push('spliced body is valid JSON');

  const big = stateBody({ pad: 'x'.repeat(100000) }, third.json);
  const server = http.createServer((req, res) => void sendCachedJson(req, res, req.url === '/big' ? big : body));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (path, headers = {}) => new Promise((resolve, reject) => http.get(base + path, { headers }, (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }).on('error', reject));
  const one = await get('/small');
  assert.equal(one.status, 200);
  assert.ok(one.headers.etag);
  assert.equal(one.body.toString(), body);
  const again = await get('/small', { 'if-none-match': one.headers.etag });
  assert.equal(again.status, 304, 'unchanged: 304');
  assert.equal(again.body.length, 0, 'and no body');
  const packed = await get('/big', { 'accept-encoding': 'gzip, br' });
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.ok(packed.body.length < big.length / 10, 'much smaller: ' + packed.body.length);
  assert.equal(gunzipSync(packed.body).toString(), big);
  assert.equal((await get('/big')).headers['content-encoding'], undefined, 'plain for clients without gzip');
  server.close();
  passed.push('ETag 304 and gzip');
  console.log('PASS state cache: ' + passed.join(', '));
} catch (error) {
  console.error('passed so far: ' + passed.join(', '));
  console.error(error);
  process.exitCode = 1;
}
