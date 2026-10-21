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
const KEY_IDLE_MS = 30 * 60_000;
const KEY_LIFE_MS = 8 * 60 * 60_000;
const MAX_KEYS = 32;
export const BODY_CAP = 20 * 1024 * 1024;
export const SANDBOX = "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'";

const HOP = ["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
const DROP_REQUEST = new Set([...HOP, "host", "cookie", "authorization", "origin", "referer", "accept-encoding", "content-length"]);
const DROP_RESPONSE = new Set([
  ...HOP,
  "set-cookie",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "strict-transport-security",
  "referrer-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
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
export function htmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return "";
  return match[1]
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const hostHeader = (address, port) => `${address.includes(":") ? `[${address}]` : address}:${port}`;
const isHtml = (type = "") => /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type);

/** GET / within 1.5 s: { http: true, status, title } or { http: false, refused }. */
function probe(address, port) {
  return new Promise((resolve) => {
    const req = http.get(
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
          if (result.http) return { port, address, status: result.status, title: result.title };
          if (!result.refused) break;
        }
        notHttp.set(key, now);
        return null;
      }),
    );
    const services = found.filter(Boolean);
    routes.clear();
    for (const service of services) routes.set(service.port, service.address);
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
    if ((await services()).some((service) => service.port === port)) return routes.get(port) ?? "127.0.0.1";
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
  function mint(port) {
    const now = Date.now();
    for (const [key, row] of keys) if (!live(row, now)) keys.delete(key);
    while (keys.size >= MAX_KEYS) keys.delete(keys.keys().next().value);
    const key = randomBytes(32).toString("base64url");
    keys.set(key, { port, created: now, used: now });
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
  const docUrl = new URL(path, upstream).href;
  const own = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(text);
  const href = own ? sameService(own[1] ?? own[2] ?? own[3], docUrl, port, key) : sameService(docUrl, upstream, port, key);
  if (!href) return body;
  const at = [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /^\s*<!doctype[^>]*>/i].map((pattern) => pattern.exec(text)).find(Boolean);
  const index = at ? at.index + at[0].length : 0;
  return Buffer.concat([body.subarray(0, index), Buffer.from(`<base href="${escapeAttr(href)}">`), body.subarray(index)]);
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
  return rewriteCss(
    text
      .replace(HTML_ATTR, `$1$2${prefix}/`)
      .replace(SRCSET, (_, lead, quote, list) => `${lead}${quote}${list.replace(new RegExp(String.raw`(^|,\s*)${ROOT}`, "g"), `$1${prefix}/`)}${quote}`),
    prefix,
  ).replace(/<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>([\s\S]*?)<\/script>/gi, (block, code) => block.replace(code, rewriteJs(code, prefix)));
}

/** Runs first in every proxied HTML page: keeps the page's own requests inside its prefix. */
export function runtimeShim(prefix) {
  const json = JSON.stringify(prefix).replace(/</g, "\\u003c");
  return `<script>(()=>{const P=${json};const fix=u=>{try{if(typeof u!=="string"&&!(u instanceof URL))return u;const s=String(u);if(s.startsWith("//"))return u;if(s.startsWith("/"))return s.startsWith(P+"/")||s===P?s:P+s;const x=new URL(s,location.href);if(x.origin===location.origin&&!x.pathname.startsWith(P+"/"))return P+x.pathname+x.search+x.hash;}catch{}return u};const f=window.fetch;window.fetch=(i,o)=>f(i instanceof Request?new Request(fix(i.url),i):fix(i),o);const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u,...r){return xo.call(this,m,fix(u),...r)};if(window.EventSource){const E=window.EventSource;window.EventSource=function(u,o){return new E(fix(u),o)};window.EventSource.prototype=E.prototype}const tell=()=>{try{parent.postMessage({marsBrowse:location.pathname+location.search},"*")}catch{}};for(const k of["pushState","replaceState"]){const h=history[k];history[k]=function(s,t,u){const r=h.call(this,s,t,u==null?u:fix(u));tell();return r}}addEventListener("popstate",tell);tell();})();</script>`;
}

const textKind = (type = "") =>
  isHtml(type) ? "html" : /^\s*text\/css\b/i.test(type) ? "css" : /^\s*(text|application)\/(javascript|ecmascript|x-javascript)\b/i.test(type) ? "js" : null;

function proxy(req, res, { send, port, address, key, path }) {
  return new Promise((resolve) => {
    const origin = `http://${hostHeader(address, port)}`;
    const headers = { host: hostHeader(address, port), "accept-encoding": "identity" };
    for (const [name, value] of Object.entries(req.headers))
      if (!DROP_REQUEST.has(name) && !name.startsWith("x-forwarded-")) headers[name] = value;
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    let settled = false;
    const finish = (status, error, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upstream.destroy();
      if (res.headersSent) res.destroy();
      else send(res, status, { error, ...extra });
      resolve();
    };
    const done = () => {
      settled = true;
      resolve();
    };
    const upstream = http.request({ host: address, port, method: req.method, path, headers }, (incoming) => {
      clearTimeout(timer);
      const status = incoming.statusCode ?? 502;
      const out = {};
      for (const [name, value] of Object.entries(incoming.headers)) if (!DROP_RESPONSE.has(name)) out[name] = value;
      out["content-security-policy"] = SANDBOX;
      out["referrer-policy"] = "no-referrer";
      // Keyed requests come from the opaque-origin frame and carry no credentials, so
      // the frame may read its own service's responses (module scripts, fetch).
      if (key) out["access-control-allow-origin"] = "null";
      const location = incoming.headers.location;
      if (location) {
        const mapped = sameService(location, new URL(path, origin), port, key);
        if (!mapped && status >= 300 && status < 400)
          return finish(502, "The service redirected to another address, which the workbench does not follow.", { location: String(location) });
        if (mapped) out.location = mapped;
        else delete out.location;
      }
      if (Number(incoming.headers["content-length"]) > BODY_CAP) return finish(502, TOO_BIG);
      let size = 0;
      const counted = (chunk) => {
        size += chunk.length;
        if (size > BODY_CAP) finish(502, TOO_BIG);
        return size <= BODY_CAP;
      };
      incoming.on("error", () => finish(502, "The service closed the connection."));
      const encoded = (incoming.headers["content-encoding"] ?? "identity") !== "identity";
      const kind = textKind(incoming.headers["content-type"]);
      if (!kind || encoded || status === 204 || status === 304) {
        res.writeHead(status, out);
        incoming.on("data", counted);
        incoming.on("end", done);
        incoming.pipe(res);
        return;
      }
      const chunks = [];
      incoming.on("data", (chunk) => counted(chunk) && chunks.push(chunk));
      incoming.on("end", () => {
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
      });
    });
    const timer = setTimeout(() => finish(504, `localhost:${port} did not answer within 30 seconds.`), HEADERS_MS);
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
