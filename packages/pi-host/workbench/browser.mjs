import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { access, constants } from "node:fs/promises";
import http from "node:http";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const PROBE_MS = 1500;
const CACHE_MS = 10_000;
// A listener that did not answer HTTP is not asked again for this long (per pid and
// port), so databases on loopback are not sent a stray "GET /" every 10 seconds.
const NOT_HTTP_MS = 5 * 60_000;
const TITLE_SCAN = 64 * 1024;
const HEADERS_MS = 30_000;
const KEY_IDLE_MS = 15 * 60_000;
const KEY_LIFE_MS = 8 * 60 * 60_000;
const MAX_KEYS = 32;
export const BODY_CAP = 20 * 1024 * 1024;
// HTML, CSS and JS are buffered for rewriting; larger ones stream through unrewritten.
export const REWRITE_CAP = 2 * 1024 * 1024;
const MAX_ACTIVE = 24; // proxied requests in flight across all keys
const MAX_ACTIVE_PER_PORT = 12;
// An upstream that goes quiet mid-body is cut off (overridable for checks).
const BODY_IDLE_MS = Number(process.env.MARS_WORKBENCH_BODY_IDLE_MS) || 30_000;
export const SANDBOX = "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'";

const HOP = ["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
const DROP_REQUEST = new Set([...HOP, "host", "cookie", "authorization", "origin", "referer", "accept-encoding", "content-length"]);
// Response headers are forwarded from an allow list; Mars sets the security headers.
const KEEP_RESPONSE = new Set([
  "content-type", "content-length", "content-language", "content-disposition", "content-range", "content-encoding",
  "cache-control", "expires", "last-modified", "etag", "vary", "accept-ranges", "age", "date", "location",
  "access-control-expose-headers",
]);
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOO_BIG = "The response is larger than the workbench browser's 20 MiB limit.";

function listener(address, port, pid) {
  const host = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const number = Number(port);
  return Number.isInteger(number) && number > 0 && number < 65536 ? [{ host, port: number, pid: pid ?? null }] : [];
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` field output: p<pid>, c<command>, n<address:port>. */
export function parseLsof(text) {
  let pid = null;
  return text.split("\n").flatMap((line) => {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || null;
    if (!line.startsWith("n")) return [];
    const at = line.lastIndexOf(":");
    return at > 1 ? listener(line.slice(1, at), line.slice(at + 1), pid) : [];
  });
}

/** `ss -Hltnp`: State Recv-Q Send-Q Local:Port Peer:Port [users:(("name",pid=1,fd=3))]. */
export function parseSs(text) {
  return text.split("\n").flatMap((line) => {
    const local = line.trim().split(/\s+/)[3];
    const at = local ? local.lastIndexOf(":") : -1;
    const pid = /pid=(\d+)/.exec(line)?.[1];
    return at > 0 ? listener(local.slice(0, at), local.slice(at + 1), pid ? Number(pid) : null) : [];
  });
}

/**
 * Ports bound on loopback or a wildcard, minus `excluded`, each with the loopback
 * addresses to try in order (IPv4 first when it is bound).
 */
export function loopbackPorts(listeners, excluded = new Set()) {
  const ports = new Map();
  for (const { host, port, pid } of listeners) {
    if (excluded.has(port)) continue;
    const wildcard = host === "*" || host === "0.0.0.0" || host === "::";
    const v4 = wildcard || host === "127.0.0.1" || host === "localhost";
    const v6 = wildcard || host === "::1";
    if (!v4 && !v6) continue;
    const row = ports.get(port) ?? { port, pid, v4: false, v6: false };
    row.v4 ||= v4;
    row.v6 ||= v6;
    row.pid ??= pid;
    ports.set(port, row);
  }
  return [...ports.values()]
    .sort((a, b) => a.port - b.port)
    .map(({ port, pid, v4, v6 }) => ({ port, pid, addresses: [...(v4 ? ["127.0.0.1"] : []), ...(v6 ? ["::1"] : [])] }));
}

/** MARS_WORKBENCH_PORTS are probed too, for listeners lsof or ss cannot see. */
const withConfigured = (rows, ports) => [
  ...rows,
  ...ports.filter((port) => !rows.some((row) => row.port === port)).map((port) => ({ port, pid: "configured", addresses: ["127.0.0.1"] })),
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };
/** Linear scan for the first <title>; no backtracking on hostile input. */
export function htmlTitle(html) {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return "";
  const startTag = lower.indexOf(">", open);
  const close = startTag < 0 ? -1 : lower.indexOf("</title", startTag);
  if (close < 0) return "";
  return html
    .slice(startTag + 1, close)
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const hostHeader = (address, port) => `${address.includes(":") ? `[${address}]` : address}:${port}`;
const isHtml = (type = "") => /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type);

/** GET / within 1.5 s: { http: true, status, title } or { http: false, refused }. */
function probe(address, port) {
  return new Promise((rawResolve) => {
    // A hard deadline: a listener that sends headers and then trickles or stalls must
    // not hold up discovery (and with it every browse request) past 1.5 s.
    let req;
    const deadline = setTimeout(() => {
      req?.destroy();
      rawResolve({ http: false, refused: false });
    }, PROBE_MS + 100);
    const resolve = (value) => {
      clearTimeout(deadline);
      rawResolve(value);
    };
    req = http.get(
      {
        host: address,
        port,
        path: "/",
        signal: AbortSignal.timeout(PROBE_MS),
        headers: { host: hostHeader(address, port), accept: "text/html,*/*;q=0.8", "user-agent": "Mars workbench" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!isHtml(res.headers["content-type"])) {
          res.destroy();
          return resolve({ http: true, status, title: "" });
        }
        let text = "";
        const done = () => {
          res.destroy();
          resolve({ http: true, status, title: htmlTitle(text) });
        };
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length >= TITLE_SCAN || /<\/title>/i.test(text)) done();
        });
        res.on("end", done);
        res.on("error", done);
        res.on("close", done);
      },
    );
    req.on("error", (error) => resolve({ http: false, refused: error.code === "ECONNREFUSED" }));
  });
}

// lsof lives in /usr/sbin on macOS and ss in /usr/sbin or /sbin on Linux; a service
// PATH often leaves the sbin directories out, so they are always searched as well.
const searchDirs = (env) => [...String(env.PATH ?? "").split(delimiter), "/usr/sbin", "/sbin", "/usr/bin", "/bin"].filter(Boolean);
async function onPath(name, dirs) {
  for (const dir of dirs) {
    try {
      await access(join(dir, name), constants.X_OK);
      return join(dir, name);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

const portList = (value = "") =>
  String(value)
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);

/**
 * Services and browser (docs/WORKBENCH.md). Lists loopback HTTP services and reverse
 * proxies the ones it found (plus MARS_WORKBENCH_PORTS) under /api/workbench/browse/.
 */
export function createBrowser({ hostPort, uiPort, env = process.env, platform = process.platform, listerDirs = searchDirs(env) }) {
  const excluded = new Set([hostPort, uiPort, ...portList(env.MARS_WORKBENCH_EXCLUDE_PORTS)].map(Number));
  const extraPorts = portList(env.MARS_WORKBENCH_PORTS).filter((port) => !excluded.has(port));
  let lister;
  const findLister = () =>
    (lister ??= (async () => {
      for (const name of platform === "linux" ? ["ss", "lsof"] : ["lsof", "ss"]) {
        const path = await onPath(name, listerDirs);
        if (path) return { name, path };
      }
      return null;
    })());

  async function listeners() {
    const tool = await findLister();
    if (!tool) return [];
    const args = tool.name === "ss" ? ["-Hltnp"] : ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"];
    // lsof exits 1 when nothing matches; its stdout is still the answer.
    const { stdout } = await run(tool.path, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).catch((error) => ({ stdout: String(error.stdout ?? "") }));
    return tool.name === "ss" ? parseSs(stdout) : parseLsof(stdout);
  }

  const notHttp = new Map(); // `${pid}:${port}` -> when it last failed to answer HTTP
  const routes = new Map(); // port -> loopback address that answered
  let cached = { at: 0, list: Promise.resolve([]) };

  async function discover() {
    const now = Date.now();
    const found = await Promise.all(
      withConfigured(loopbackPorts(await listeners(), excluded), extraPorts).map(async ({ port, pid, addresses }) => {
        const key = `${pid}:${port}`;
        if (pid !== "configured" && now - (notHttp.get(key) ?? -Infinity) < NOT_HTTP_MS) return null;
        for (const address of addresses) {
          const result = await probe(address, port);
          if (result.http) return { port, address, pid, status: result.status, title: result.title };
          if (!result.refused) break;
        }
        notHttp.set(key, now);
        return null;
      }),
    );
    const services = found.filter(Boolean);
    routes.clear();
    for (const service of services) routes.set(service.port, { address: service.address, pid: service.pid });
    return services.map(({ port, title, status }) => ({ port, ...(title ? { title } : {}), status }));
  }

  function services() {
    if (Date.now() - cached.at >= CACHE_MS) cached = { at: Date.now(), list: discover().catch(() => []) };
    return cached.list;
  }

  async function available() {
    return (await findLister())
      ? { ok: true, reason: "" }
      : { ok: false, reason: "Neither lsof nor ss was found on the host, so local web services cannot be listed." };
  }

  /** The loopback address to proxy `port` to, or null when the port is not allowed. */
  async function target(port) {
    if (!(port > 0 && port < 65536) || excluded.has(port)) return null;
    if ((await services()).some((service) => service.port === port)) return routes.get(port)?.address ?? "127.0.0.1";
    return extraPorts.includes(port) ? "127.0.0.1" : null;
  }

  // Browse keys (docs/WORKBENCH.md "Services and browser"). A proxied page runs in an
  // opaque origin, so its own asset, link and form requests are cross-site and carry no
  // SameSite=Strict owner cookie. The owner mints a key for one port with an
  // authenticated POST; the pane loads the page under that key, and the page reaches
  // its own service through the proxy and nothing else. Keys live in memory only, are
  // never logged, expire after 30 minutes idle or 8 hours, and can be revoked.
  const keys = new Map(); // key -> { port, created, used }
  const live = (row, now = Date.now()) => now - row.used < KEY_IDLE_MS && now - row.created < KEY_LIFE_MS;
  /** The process listening on `port` now, from the last discovery (null when unknown). */
  const owner = (port) => routes.get(port)?.pid ?? null;
  function mint(port) {
    const now = Date.now();
    for (const [key, row] of keys) if (!live(row, now)) keys.delete(key);
    while (keys.size >= MAX_KEYS) keys.delete(keys.keys().next().value);
    const key = randomBytes(32).toString("base64url");
    // Bound to the listening process too: if the service exits and something else takes
    // the port, an old key does not reach the newcomer.
    keys.set(key, { port, pid: owner(port), created: now, used: now });
    return key;
  }
  function keyValid(port, key) {
    if (!key) return false;
    // Constant-time compare against every live key so timing does not reveal a prefix.
    const given = Buffer.from(key);
    let match;
    for (const [candidate, row] of keys) {
      const known = Buffer.from(candidate);
      if (known.length === given.length && timingSafeEqual(known, given)) match = row;
    }
    if (!match || match.port !== port || !live(match)) return false;
    if (match.pid !== null && owner(port) !== null && owner(port) !== match.pid) return false;
    match.used = Date.now();
    return true;
  }

  /** `keyed` means the path carried this port's valid key; otherwise the owner is authenticated. */
  async function browse(req, res, url, send, { port, key, rest = "/", keyed }) {
    // Anything this route answers may render inside the pane, errors included.
    res.setHeader("content-security-policy", SANDBOX);
    if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { error: "The workbench browser forwards GET and POST only." });
    const address = await target(port);
    if (!address) return send(res, 403, { error: `localhost:${port} is not a running local web service the workbench can open.` });
    if (Number(req.headers["content-length"]) > BODY_CAP) return send(res, 413, { error: "The request body is larger than 20 MiB." });
    await proxy(req, res, { send, port, address, key: keyed ? key : undefined, path: rest + url.search });
  }

  const parse = (url) => {
    const match = BROWSE.exec(url.pathname);
    return match && { port: Number(match[1]), key: match[2], rest: match[3], keyed: keyValid(Number(match[1]), match[2]) };
  };

  return {
    services,
    available,
    async handle(req, res, url, route, { send, jsonBody }) {
      if (route === "services" && req.method === "GET") return send(res, 200, { services: await services() }), true;
      if (route === "browse-key" && req.method === "POST") {
        const port = Number((await jsonBody(req))?.port);
        if (!(await target(port))) return send(res, 403, { error: `localhost:${port} is not a running local web service the workbench can open.` }), true;
        return send(res, 201, { key: mint(port), port }), true;
      }
      if (route === "browse-key/revoke" && req.method === "POST") {
        const key = String((await jsonBody(req))?.key ?? "");
        return send(res, 200, { revoked: keys.delete(key) }), true;
      }
      const request = parse(url);
      if (!request) return false;
      await browse(req, res, url, send, request);
      return true;
    },
    /**
     * For the server to call before owner authentication and the origin check. It
     * answers only browse paths carrying a valid key for their port and returns false
     * for everything else, which then meets the normal owner check.
     */
    async handleKeyed(req, res, url, { send }) {
      const request = parse(url);
      if (!request?.keyed) return false;
      await browse(req, res, url, send, request);
      return true;
    },
  };
}

// /api/workbench/browse/<port>[/~<key>][/<path>]
const BROWSE = /^\/api\/workbench\/browse\/(\d{1,5})(?:\/~([A-Za-z0-9_-]{43}))?(\/.*)?$/;
const proxyPrefix = (port, key) => `/api/workbench/browse/${port}${key ? `/~${key}` : ""}`;
const escapeAttr = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A URL on the same service (loopback, plain http, same port) as its proxied path; otherwise null. */
export function sameService(location, base, port, key) {
  let url;
  try {
    url = new URL(location, base);
  } catch {
    return null;
  }
  const urlPort = Number(url.port || (url.protocol === "http:" ? 80 : 443));
  return url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname) && urlPort === port
    ? `${proxyPrefix(port, key)}${url.pathname}${url.search}${url.hash}`
    : null;
}

/**
 * Put `<base href>` first in <head> so relative URLs, and a page's own same-service
 * base, resolve through the proxy. The href is the document's own proxied URL (for a
 * root page, `/api/workbench/browse/<port>/`), so fragment links stay in-page. A page
 * whose own base points elsewhere is left untouched.
 */
export function injectBase(body, { port, key, path, upstream }) {
  const text = body.toString("latin1");
  const lower = text.toLowerCase();
  let docUrl;
  try {
    docUrl = new URL(path, upstream).href;
  } catch {
    return body;
  }
  // The page's own <base href>, found by a linear scan of the first base tag.
  let ownHref;
  const baseAt = tagAt(lower, "base", 0);
  if (baseAt >= 0) {
    const tag = text.slice(baseAt, tagEnd(lower, baseAt));
    ownHref = attribute(tag, "href");
  }
  const href = ownHref !== undefined ? sameService(ownHref, docUrl, port, key) : sameService(docUrl, upstream, port, key);
  if (!href) return body;
  let index = 0;
  for (const name of ["head", "html"]) {
    const at = tagAt(lower, name, 0);
    if (at >= 0) {
      index = tagEnd(lower, at);
      break;
    }
  }
  if (!index && /^\s*<!doctype/i.test(text.slice(0, 64))) index = tagEnd(lower, text.indexOf("<"));
  return Buffer.concat([body.subarray(0, index), Buffer.from(`<base href="${escapeAttr(href)}">`), body.subarray(index)]);
}

// Bounded, linear HTML helpers. A tag is "<name" followed by whitespace, "/" or ">";
// its end is the next ">" (or the end of the text). Nothing here backtracks.
function tagAt(lower, name, from) {
  for (let at = lower.indexOf(`<${name}`, from); at >= 0; at = lower.indexOf(`<${name}`, at + 1)) {
    const next = lower[at + name.length + 1];
    if (next === undefined || next === ">" || next === "/" || /\s/.test(next)) return at;
  }
  return -1;
}
function tagEnd(lower, at) {
  const end = lower.indexOf(">", at);
  return end < 0 ? lower.length : end + 1;
}
/** The value of `name` in one tag's text, or undefined. */
function attribute(tag, name) {
  const lower = tag.toLowerCase();
  for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
    if (!/\s/.test(lower[at - 1] ?? "")) continue;
    let i = at + name.length;
    while (/\s/.test(lower[i] ?? "")) i++;
    if (lower[i] !== "=") continue;
    i++;
    while (/\s/.test(lower[i] ?? "")) i++;
    const quote = tag[i] === '"' || tag[i] === "'" ? tag[i] : "";
    if (quote) {
      const close = tag.indexOf(quote, i + 1);
      return tag.slice(i + 1, close < 0 ? tag.length : close);
    }
    let j = i;
    while (j < tag.length && !/[\s>]/.test(tag[j])) j++;
    return tag.slice(i, j);
  }
  return undefined;
}

// Root-relative URLs ("/assets/app.js") resolve against the Mars origin, not the
// proxied service, and <base> does not change that. These rewrite them to the keyed
// proxy prefix in HTML, CSS and JavaScript module specifiers, and a small script in
// the page does the same for fetch, XMLHttpRequest, EventSource and history. Absolute
// URLs to other origins and WebSockets are left alone (docs/WORKBENCH.md).
const ROOT = String.raw`\/(?!\/|api\/workbench\/browse\/)`;
const HTML_ATTR = new RegExp(String.raw`(\s(?:src|href|action|formaction|poster|data)\s*=\s*)(["']?)${ROOT}`, "gi");
const SRCSET = /(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi;
const CSS_URL = new RegExp(String.raw`(url\(\s*)(["']?)${ROOT}`, "gi");
const CSS_IMPORT = new RegExp(String.raw`(@import\s+)(["'])${ROOT}`, "gi");
const JS_IMPORT = new RegExp(String.raw`(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'\x60])${ROOT}`, "g");

export const rewriteCss = (text, prefix) => text.replace(CSS_URL, `$1$2${prefix}/`).replace(CSS_IMPORT, `$1$2${prefix}/`);
export const rewriteJs = (text, prefix) => text.replace(JS_IMPORT, `$1$2${prefix}/`);
export function rewriteHtml(text, prefix) {
  const attrs = rewriteCss(
    text
      .replace(HTML_ATTR, `$1$2${prefix}/`)
      .replace(SRCSET, (_, lead, quote, list) => `${lead}${quote}${list.replace(new RegExp(String.raw`(^|,\s*)${ROOT}`, "g"), `$1${prefix}/`)}${quote}`),
    prefix,
  );
  // Inline module scripts: a linear walk over <script> tags, rewriting only type=module bodies.
  const lower = attrs.toLowerCase();
  let out = "";
  let from = 0;
  for (let at = tagAt(lower, "script", 0); at >= 0; at = tagAt(lower, "script", from)) {
    const open = tagEnd(lower, at);
    const close = lower.indexOf("</script", open);
    const end = close < 0 ? attrs.length : close;
    const isModule = (attribute(attrs.slice(at, open), "type") ?? "").trim().toLowerCase() === "module";
    out += attrs.slice(from, open) + (isModule ? rewriteJs(attrs.slice(open, end), prefix) : attrs.slice(open, end));
    from = end;
    if (close < 0) break;
  }
  return out + attrs.slice(from);
}

/** Runs first in every proxied HTML page: keeps the page's own requests inside its prefix. */
export function runtimeShim(prefix) {
  const json = JSON.stringify(prefix).replace(/</g, "\\u003c");
  return `<script>(()=>{const P=${json};const fix=u=>{try{if(typeof u!=="string"&&!(u instanceof URL))return u;const s=String(u);if(s.startsWith("//"))return u;if(s.startsWith("/"))return s.startsWith(P+"/")||s===P?s:P+s;const x=new URL(s,location.href);if(x.origin===location.origin&&!x.pathname.startsWith(P+"/"))return P+x.pathname+x.search+x.hash;}catch{}return u};const f=window.fetch;window.fetch=(i,o)=>f(i instanceof Request?new Request(fix(i.url),i):fix(i),o);const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return xo.call(this,m,fix(u),...r)};if(window.EventSource){const E=window.EventSource;window.EventSource=function(u,o){return new E(fix(u),o)};window.EventSource.prototype=E.prototype}const tell=()=>{try{parent.postMessage({marsBrowse:location.pathname+location.search},"*")}catch{}};for(const k of["pushState","replaceState"]){const h=history[k];history[k]=function(s,t,u){const r=h.call(this,s,t,u==null?u:fix(u));tell();return r}}addEventListener("popstate",tell);tell();})();</script>`;
}

const textKind = (type = "") =>
  isHtml(type) ? "html" : /^\s*text\/css\b/i.test(type) ? "css" : /^\s*(text|application)\/(javascript|ecmascript|x-javascript)\b/i.test(type) ? "js" : null;

const active = { all: 0, ports: new Map() };

function proxy(req, res, options) {
  const { send, port } = options;
  if (active.all >= MAX_ACTIVE || (active.ports.get(port) ?? 0) >= MAX_ACTIVE_PER_PORT)
    return Promise.resolve(send(res, 503, { error: "Too many workbench browser requests at once. Try again shortly." }));
  active.all++;
  active.ports.set(port, (active.ports.get(port) ?? 0) + 1);
  return proxyOnce(req, res, options).finally(() => {
    active.all--;
    active.ports.set(port, active.ports.get(port) - 1);
  });
}

function proxyOnce(req, res, { send, port, address, key, path }) {
  return new Promise((resolve) => {
    const origin = `http://${hostHeader(address, port)}`;
    const headers = { host: hostHeader(address, port), "accept-encoding": "identity" };
    for (const [name, value] of Object.entries(req.headers))
      if (!DROP_REQUEST.has(name) && !name.startsWith("x-forwarded-")) headers[name] = value;
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    let settled = false;
    let timer;
    let idle;
    const finish = (status, error, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      upstream.destroy();
      if (res.headersSent) res.destroy();
      else send(res, status, { error, ...extra });
      resolve();
    };
    const done = () => {
      settled = true;
      clearTimeout(idle);
      resolve();
    };
    // Everything that reacts to the upstream runs inside `guard`: a hostile service must
    // never be able to throw out of a callback and take the host down.
    const guard = (fn) => (...args) => {
      try {
        return fn(...args);
      } catch {
        finish(502, "The service sent a response the workbench cannot show.");
      }
    };
    const touchBody = () => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(504, `localhost:${port} stopped sending.`), BODY_IDLE_MS);
    };
    const upstream = http.request({ host: address, port, method: req.method, path, headers }, guard((incoming) => {
      clearTimeout(timer);
      touchBody();
      const status = incoming.statusCode ?? 0;
      if (!((status >= 200 && status <= 599) || status === 304))
        return finish(502, "The service answered with an invalid status.");
      const out = {};
      for (const [name, value] of Object.entries(incoming.headers)) if (KEEP_RESPONSE.has(name)) out[name] = value;
      out["x-content-type-options"] = "nosniff";
      out["content-security-policy"] = SANDBOX;
      out["referrer-policy"] = "no-referrer";
      // Keyed requests come from the opaque-origin frame and carry no credentials, so
      // the frame may read its own service's responses (module scripts, fetch).
      if (key) out["access-control-allow-origin"] = "null";
      const location = incoming.headers.location;
      if (location) {
        const mapped = sameService(location, `${origin}${path.startsWith("/") ? path : `/${path}`}`, port, key);
        if (!mapped && status >= 300 && status < 400)
          return finish(502, "The service redirected to another address, which the workbench does not follow.", { location: String(location) });
        if (mapped) out.location = mapped;
        else delete out.location;
      }
      if (Number(incoming.headers["content-length"]) > BODY_CAP) return finish(502, TOO_BIG);
      let size = 0;
      const counted = (chunk) => {
        touchBody();
        size += chunk.length;
        if (size > BODY_CAP) finish(502, TOO_BIG);
        return size <= BODY_CAP;
      };
      incoming.on("error", () => finish(502, "The service closed the connection."));
      const encoded = (incoming.headers["content-encoding"] ?? "identity") !== "identity";
      const declared = Number(incoming.headers["content-length"]);
      const kind = textKind(incoming.headers["content-type"]);
      // Rewriting buffers the body, so it is limited to 2 MiB; larger text streams as is.
      if (!kind || encoded || status === 204 || status === 304 || declared > REWRITE_CAP) {
        res.writeHead(status, out);
        incoming.on("data", counted);
        incoming.on("end", done);
        incoming.pipe(res);
        return;
      }
      const chunks = [];
      let buffered = 0;
      incoming.on("data", (chunk) => {
        if (!counted(chunk) || settled) return;
        buffered += chunk.length;
        if (buffered > REWRITE_CAP) return finish(502, "This page is larger than the 2 MiB the workbench browser rewrites.");
        chunks.push(chunk);
      });
      incoming.on("end", guard(() => {
        if (settled) return;
        const prefix = proxyPrefix(port, key);
        const raw = Buffer.concat(chunks);
        let body;
        if (kind === "html") {
          const based = injectBase(raw, { port, key, path, upstream: origin }).toString("latin1");
          // The shim goes straight after the injected <base> so it runs before any page script.
          const at = based.indexOf("<base href=");
          const end = at < 0 ? 0 : based.indexOf(">", at) + 1;
          body = Buffer.from(based.slice(0, end) + runtimeShim(prefix) + rewriteHtml(based.slice(end), prefix), "latin1");
        } else body = Buffer.from((kind === "css" ? rewriteCss : rewriteJs)(raw.toString("latin1"), prefix), "latin1");
        delete out.etag;
        out["content-length"] = String(body.length);
        res.writeHead(status, out);
        res.end(body);
        done();
      }));
    }));
    timer = setTimeout(() => finish(504, `localhost:${port} did not answer within 30 seconds.`), HEADERS_MS);
    upstream.on("error", (error) =>
      finish(502, error.code === "ECONNREFUSED" ? `Nothing is answering on localhost:${port}.` : `localhost:${port} could not be reached.`),
    );
    res.on("close", () => {
      if (!res.writableFinished) finish(502, "The browser closed the request.");
    });
    let sent = 0;
    req.on("data", (chunk) => {
      sent += chunk.length;
      if (sent > BODY_CAP) {
        finish(413, "The request body is larger than 20 MiB.");
        req.destroy();
      }
    });
    req.pipe(upstream);
  });
}
