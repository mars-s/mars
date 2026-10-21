import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { freePort } from "./dev-tools.mjs";
import { BODY_CAP, SANDBOX, createBrowser, htmlTitle, injectBase, loopbackPorts, parseLsof, parseSs, rewriteCss, rewriteHtml, rewriteJs, sameService } from "./workbench/browser.mjs";
import { startHost } from "./workbench/test-host.mjs";

// Parsers and rewriting, independent of any listener.
const lsof = parseLsof("p10\ncnode\nf20\nn127.0.0.1:5173\nf21\nn[::1]:5173\np11\ncpostgres\nf3\nn*:5432\np12\ncsshd\nf4\nn192.168.1.4:22\nn[fe80::1%en0]:9000\n");
assert.deepEqual(lsof.map(({ host, port, pid }) => `${pid} ${host} ${port}`), ["10 127.0.0.1 5173", "10 ::1 5173", "11 * 5432", "12 192.168.1.4 22", "12 fe80::1 9000"]);
const ss = parseSs(
  'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=77,fd=20))\nLISTEN 0 128 [::1]:8080 [::]:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 4096 [::]:9090 [::]:*\nLISTEN 0 5 10.0.0.2:7000 0.0.0.0:*\n',
);
assert.deepEqual(ss.map(({ host, port, pid }) => `${pid} ${host} ${port}`), ["77 127.0.0.1 3000", "null ::1 8080", "null 0.0.0.0 22", "null :: 9090", "null 10.0.0.2 7000"]);
assert.deepEqual(
  loopbackPorts([...lsof, ...ss], new Set([22])).map(({ port, addresses }) => `${port} ${addresses.join(",")}`),
  ["3000 127.0.0.1", "5173 127.0.0.1,::1", "5432 127.0.0.1,::1", "8080 ::1", "9090 127.0.0.1,::1"],
  "loopback and wildcard binds only, excluded ports removed, IPv4 tried first",
);
assert.equal(htmlTitle("<head><title>\n  Docs &amp; notes </title>"), "Docs & notes");
assert.equal(sameService("http://localhost:5173/a?b#c", "http://127.0.0.1:5173/", 5173, "k"), "/api/workbench/browse/5173/~k/a?b#c");
assert.equal(sameService("/login", "http://127.0.0.1:5173/x", 5173), "/api/workbench/browse/5173/login");
for (const elsewhere of ["http://127.0.0.1:5174/", "https://127.0.0.1:5173/", "http://evil.test:5173/", "//evil.test/"])
  assert.equal(sameService(elsewhere, "http://127.0.0.1:5173/", 5173), null, `not the same service: ${elsewhere}`);
const inject = (html, path = "/") => injectBase(Buffer.from(html), { port: 5173, key: "k", path, upstream: "http://127.0.0.1:5173" }).toString();
assert.equal(inject("<!doctype html><html><head><title>x</title>"), '<!doctype html><html><head><base href="/api/workbench/browse/5173/~k/"><title>x</title>');
assert.equal(inject("<p>bare", "/docs/a.html?q=1"), '<base href="/api/workbench/browse/5173/~k/docs/a.html?q=1"><p>bare');
assert.equal(inject('<head><base href="/static/">'), '<head><base href="/api/workbench/browse/5173/~k/static/"><base href="/static/">', "a page's own base is mapped through the proxy");
assert.equal(inject('<head><base href="https://cdn.test/">'), '<head><base href="https://cdn.test/">', "an external base is left alone");

// Root-relative rewriting: the page's own absolute paths go through the keyed prefix.
const P = "/api/workbench/browse/5173/~k";
assert.equal(rewriteHtml('<script src="/assets/a.js"></script><link href=/s.css><img srcset="/a.png 1x, /b.png 2x"><a href="//cdn.test/x">', P),
  `<script src="${P}/assets/a.js"></script><link href=${P}/s.css><img srcset="${P}/a.png 1x, ${P}/b.png 2x"><a href="//cdn.test/x">`);
assert.equal(rewriteHtml(`<a href="${P}/x">`, P), `<a href="${P}/x">`, "already proxied paths are left alone");
assert.equal(rewriteCss('a{background:url(/i.png)}@import "/b.css";', P), `a{background:url(${P}/i.png)}@import "${P}/b.css";`);
assert.equal(rewriteJs('import x from "/m.js";import("/n.js")', P), `import x from "${P}/m.js";import("${P}/n.js")`);

// Lister missing: the tool says why instead of pretending.
assert.deepEqual(await createBrowser({ hostPort: 1, uiPort: 2, env: {}, listerDirs: [] }).available(), {
  ok: false,
  reason: "Neither lsof nor ss was found on the host, so local web services cannot be listed.",
});

// A test service with the awkward parts real dev servers have.
const seen = [];
const big = Buffer.alloc(BODY_CAP + 1024, 97);
const service = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    const hostile = {
      "set-cookie": "sid=1; Path=/",
      "content-security-policy": "default-src 'self'",
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=600",
      "x-service": "kept",
    };
    if (req.url === "/") return res.writeHead(200, { ...hostile, "content-type": "text/html; charset=utf-8" }), res.end("<!doctype html><html><head><title>Workbench &amp; test</title><link rel=stylesheet href=app.css></head><body>hi</body></html>");
    if (req.url === "/app.css") return res.writeHead(200, { "content-type": "text/css" }), res.end("body{color:red}");
    if (req.url === "/same") return res.writeHead(302, { location: `http://localhost:${servicePort}/landing?x=1` }), res.end();
    if (req.url === "/relative") return res.writeHead(301, { location: "/landing" }), res.end();
    if (req.url === "/other-port") return res.writeHead(302, { location: `http://127.0.0.1:${silentPort}/` }), res.end();
    if (req.url === "/external") return res.writeHead(307, { location: "https://example.com/" }), res.end();
    if (req.url === "/big-declared") return res.writeHead(200, { "content-type": "application/octet-stream", "content-length": big.length }), res.end(big);
    if (req.url === "/big-html") return res.writeHead(200, { "content-type": "text/html" }), res.end(big);
    if (req.url === "/big-stream") return res.writeHead(200, { "content-type": "application/octet-stream" }), res.end(big);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
const listen = (server, port) => new Promise((resolve) => server.listen(port ?? 0, "127.0.0.1", () => resolve(server.address().port)));
const servicePort = await listen(service);
// Not HTTP: one speaks a line protocol, one never answers.
const lineProtocol = net.createServer((socket) => socket.end("-ERR unknown command\r\n"));
const silent = net.createServer(() => {});
const notHttpPort = await listen(lineProtocol);
const silentPort = await listen(silent);
// Excluded on purpose, and the UI port, both real HTTP servers.
const hello = () => http.createServer((req, res) => res.end("<title>should be hidden</title>"));
const excludedPort = await listen(hello(), await freePort());
const uiPort = await freePort();
const uiServer = hello();
await listen(uiServer, uiPort);

const host = await startHost({ MARS_UI_PORT: String(uiPort), MARS_WORKBENCH_EXCLUDE_PORTS: String(excludedPort) });
try {
  const caps = await host.request("/api/workbench/capabilities");
  assert.deepEqual(caps.json.tools.browser, { available: true }, "lsof or ss is present on this machine");

  assert.equal((await host.request("/api/workbench/services", { auth: false })).status, 401, "services needs the owner");
  assert.equal((await host.request(`/api/workbench/browse/${servicePort}/`, { auth: false })).status, 401, "browse needs the owner");

  const started = Date.now();
  const services = (await host.request("/api/workbench/services")).json.services;
  const ports = services.map((row) => row.port);
  assert.deepEqual(
    services.find((row) => row.port === servicePort),
    { port: servicePort, title: "Workbench & test", status: 200 },
    "the test HTTP server is found with its title",
  );
  for (const [port, why] of [[notHttpPort, "line protocol"], [silentPort, "silent listener"], [host.port, "host port"], [uiPort, "UI port"], [excludedPort, "MARS_WORKBENCH_EXCLUDE_PORTS"]])
    assert.ok(!ports.includes(port), `${why} is not listed`);
  assert.ok(Date.now() - started < 5000, "probes stay inside their 1.5 s budget");
  const again = Date.now();
  await host.request("/api/workbench/services");
  assert.ok(Date.now() - again < 200, "second call within 10 s is served from the cache");
  const suggestions = (await host.request("/api/workbench/suggestions")).json.suggestions;
  assert.ok(suggestions.some((row) => row.kind === "service" && row.port === servicePort && row.title === "Workbench & test"), "suggestions use services()");

  for (const port of [notHttpPort, excludedPort, host.port, uiPort, 0, 70000]) {
    const refused = await host.request(`/api/workbench/browse/${port}/`);
    assert.equal(refused.status, 403, `port ${port} is refused`);
    assert.equal(refused.headers["content-security-policy"], SANDBOX, "even refusals carry the sandbox");
  }

  // Keys: minted only by the owner, only for a discovered port, bound to that port.
  assert.equal((await host.request("/api/workbench/browse-key", { method: "POST", body: { port: servicePort }, auth: false })).status, 401, "minting needs the owner");
  assert.equal(
    (await host.request("/api/workbench/browse-key", { method: "POST", body: { port: servicePort }, headers: { origin: "https://evil.example" } })).status,
    403,
    "a cross-origin mint is refused",
  );
  for (const port of [notHttpPort, excludedPort, host.port, uiPort, 0])
    assert.equal((await host.request("/api/workbench/browse-key", { method: "POST", body: { port } })).status, 403, `no key for port ${port}`);
  const minted = await host.request("/api/workbench/browse-key", { method: "POST", body: { port: servicePort } });
  assert.equal(minted.status, 201);
  const key = minted.json.key;
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  assert.ok(!host.log().includes(key), "the key is never logged");

  const page = await host.request(`/api/workbench/browse/${servicePort}/~${key}/`, {
    auth: false,
    headers: { cookie: "pi_trial=" + host.token, referer: `http://127.0.0.1:${host.port}/`, origin: `http://127.0.0.1:${host.port}`, "x-requested-with": "kept" },
  });
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-security-policy"], SANDBOX, "proxied pages run sandboxed and may be framed only by Mars");
  for (const name of ["set-cookie", "x-frame-options", "strict-transport-security"]) assert.equal(page.headers[name], undefined, `${name} is stripped`);
  assert.equal(page.headers["x-service"], undefined, "response headers are forwarded from an allow list only");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8", "allowed headers pass through");
  assert.ok(page.text.startsWith(`<!doctype html><html><head><base href="/api/workbench/browse/${servicePort}/~${key}/"><script>`), "keyed <base> then the shim, first in <head>: " + page.text.slice(0, 160));
  assert.equal(Number(page.headers["content-length"]), Buffer.byteLength(page.text), "content-length matches the rewritten body");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  const upstream = seen.findLast((row) => row.url === "/");
  for (const name of ["cookie", "authorization", "origin", "referer"]) assert.equal(upstream.headers[name], undefined, `${name} is not forwarded`);
  assert.equal(upstream.headers.host, `127.0.0.1:${servicePort}`);
  assert.equal(upstream.headers["x-requested-with"], "kept");

  const keyed = (path, options = {}) => host.request(`/api/workbench/browse/${servicePort}/~${key}${path}`, { auth: false, ...options });
  const css = await keyed("/app.css");
  assert.equal(css.text, "body{color:red}", "relative assets resolve through the keyed base");
  assert.equal(css.headers["content-security-policy"], SANDBOX);

  const same = await keyed("/same");
  assert.equal(same.status, 302);
  assert.equal(same.headers.location, `/api/workbench/browse/${servicePort}/~${key}/landing?x=1`, "same-port redirect stays in the proxy");
  assert.equal((await keyed("/relative")).headers.location, `/api/workbench/browse/${servicePort}/~${key}/landing`);
  for (const path of ["/other-port", "/external"]) {
    const away = await keyed(path);
    assert.equal(away.status, 502, `${path} is not followed`);
    assert.match(away.json.error, /redirected to another address/);
  }

  const post = await keyed("/form?step=2", { method: "POST", body: "name=mars", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(post.status, 200);
  const posted = seen.findLast((row) => row.url === "/form?step=2");
  assert.deepEqual([posted.method, posted.body, posted.headers.origin, posted.headers.authorization], ["POST", "name=mars", undefined, undefined], "forms are forwarded without Mars credentials");

  assert.equal((await keyed("/big-declared")).status, 502, "declared bodies over 20 MiB are refused");
  const bigHtml = await keyed("/big-html");
  assert.equal(bigHtml.status, 502, "HTML too large to rewrite is refused, never buffered whole");
  assert.match(bigHtml.json.error, /2 MiB/);
  const streamed = await keyed("/big-stream", { raw: true });
  assert.ok(streamed.truncated && streamed.buffer.length <= BODY_CAP, `a streamed body is cut off at the cap (${streamed.buffer.length} bytes)`);
  assert.equal((await keyed("/upload", { method: "POST", body: Buffer.alloc(BODY_CAP + 1), headers: { "content-type": "application/octet-stream" } })).status, 413, "request bodies over 20 MiB are refused");
  assert.equal((await host.request(`/api/workbench/browse/${servicePort}/`, { method: "PUT", body: "x" })).status, 405);

  // The key is bound to its port and opens nothing else.
  const other = http.createServer((req, res) => (res.writeHead(200, { "content-type": "text/html" }), res.end("<title>Second service</title>")));
  const otherPort = await listen(other);
  await new Promise((resolve) => setTimeout(resolve, 10_100)); // let the 10 s services cache see it
  assert.ok((await host.request("/api/workbench/services")).json.services.some((row) => row.port === otherPort));
  assert.equal((await host.request(`/api/workbench/browse/${otherPort}/~${key}/`, { auth: false })).status, 401, "a key for port A does not open port B");
  assert.equal((await host.request(`/api/workbench/browse/${servicePort}/~${"A".repeat(43)}/app.css`, { auth: false })).status, 401, "an unknown key is refused");
  for (const path of ["/api/workbench/services", `/api/workbench/services/~${key}`, `/api/workbench/files?path=~${key}`])
    assert.equal((await host.request(path, { auth: false })).status, 401, `a key opens nothing else: ${path}`);
  // Encoded dot segments are resolved before routing, so they leave the keyed path and
  // meet the normal owner check instead of reaching any route with the key's authority.
  const before = seen.length;
  const dots = await host.request(`/api/workbench/browse/${servicePort}/~${key}/%2e%2e/%2e%2e/state`, { auth: false });
  assert.equal(dots.status, 401, "dot segments cannot carry a key out of its path");
  assert.equal(seen.length, before, "and nothing reached the service");
  assert.equal((await host.request(`/api/state?k=${key}`, { auth: false })).status, 401, "a key is not an owner credential");
  assert.equal((await host.request("/api/state", { auth: false, headers: { cookie: `pi_trial=${key}` } })).status, 401, "nor as a cookie");
  const revoked = await host.request("/api/workbench/browse-key/revoke", { method: "POST", body: { key } });
  assert.deepEqual(revoked.json, { revoked: true });
  assert.equal((await keyed("/app.css")).status, 401, "a revoked key is refused");
  other.close();

  // Port takeover: a key minted for one process stops working when another process
  // takes over the same port (the original exits, a newcomer binds it).
  const { spawn } = await import("node:child_process");
  const serve = (port) => {
    const child = spawn(process.execPath, ["-e", `require("http").createServer((q,s)=>s.end("<title>p"+process.pid+"</title>")).listen(${port},"127.0.0.1",()=>console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
    return new Promise((resolve) => child.stdout.once("data", () => resolve(child)));
  };
  const takeoverPort = await freePort();
  const children = [];
  process.once("exit", () => children.forEach((child) => child.kill()));
  const first = await serve(takeoverPort);
  children.push(first);
  await new Promise((resolve) => setTimeout(resolve, 10_100));
  const firstKey = (await host.request("/api/workbench/browse-key", { method: "POST", body: { port: takeoverPort } })).json.key;
  assert.equal((await host.request(`/api/workbench/browse/${takeoverPort}/~${firstKey}/`, { auth: false })).status, 200);
  first.kill();
  await new Promise((resolve) => first.once("close", resolve));
  const second = await serve(takeoverPort);
  children.push(second);
  await new Promise((resolve) => setTimeout(resolve, 10_100));
  await host.request("/api/workbench/services");
  assert.equal((await host.request(`/api/workbench/browse/${takeoverPort}/~${firstKey}/`, { auth: false })).status, 401, "a key does not outlive the process it was minted for");
  second.kill();
  await new Promise((resolve) => second.once("close", resolve));
} finally {
  await host.stop();
}

// Expiry: a key unused for 30 minutes stops working, without waiting 30 minutes.
{
  const realNow = Date.now;
  const browser = createBrowser({ hostPort: 1, uiPort: 2, env: { MARS_WORKBENCH_PORTS: String(servicePort) } });
  const replies = [];
  const send = (res, status, value) => replies.push({ status, value });
  const body = (value) => async () => value;
  const fake = (method, path) => ({ method, headers: {}, url: path });
  await browser.handle(fake("POST"), {}, new URL("http://l/api/workbench/browse-key"), "browse-key", { send, jsonBody: body({ port: servicePort }) });
  const expKey = replies.at(-1).value.key;
  const keyedUrl = new URL(`http://l/api/workbench/browse/${servicePort}/~${expKey}/app.css`);
  try {
    Date.now = () => realNow() + 31 * 60_000;
    assert.equal(await browser.handleKeyed(fake("GET"), {}, keyedUrl, { send }), false, "an idle key expires after 30 minutes");
  } finally {
    Date.now = realNow;
  }
}
for (const server of [service, lineProtocol, silent, uiServer]) server.close();
console.log(
  "PASS workbench browser: lsof/ss parsing, loopback filter, HTTP probe with titles, non-HTTP and excluded ports ignored, 10 s cache, 401 without owner, owner-only same-origin key mint for discovered ports, key bound to one port, unknown/revoked/expired keys refused, key bound to the listening process, key opens nothing else and is never logged, request and response header stripping, sandbox CSP, no-referrer, keyed <base> plus shim, root-relative HTML/CSS/JS rewriting, same-port redirects kept and others refused, 20 MiB caps both ways",
);
process.exit(0);
