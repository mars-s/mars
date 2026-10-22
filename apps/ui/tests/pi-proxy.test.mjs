import assert from "node:assert/strict";
import test from "node:test";
import { proxyPi } from "../lib/server/pi-proxy.ts";

test("development proxy stays disabled without private configuration", async () => {
  const response = await proxyPi(new Request("http://localhost:3000/api/state"), {
    origin: "",
    token: "",
  });
  assert.equal(response.status, 503);
});
test("cross-origin mutation and non-Pi paths are rejected before forwarding", async () => {
  let called = false;
  const options = {
    origin: "https://private.example",
    token: "fixture-owner-token",
    fetcher: async () => {
      called = true;
      return new Response("{}");
    },
  };
  assert.equal(
    (
      await proxyPi(
        new Request("http://localhost:3000/api/chat", {
          method: "POST",
          headers: { origin: "https://evil.example", "content-type": "application/json" },
          body: "{}",
        }),
        options,
      )
    ).status,
    403,
  );
  assert.equal(
    (await proxyPi(new Request("http://localhost:3000/private/auth.json"), options)).status,
    404,
  );
  assert.equal(called, false);
  assert.equal(
    (await proxyPi(new Request("http://attacker.example:3000/api/state"), options)).status,
    403,
  );
  assert.equal(
    (
      await proxyPi(
        new Request("http://localhost:3000/api/state", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
        options,
      )
    ).status,
    403,
  );
});
test("owner token stays server-side; caller cookies and upstream secret headers are stripped", async () => {
  let forwarded;
  const options = {
    origin: "https://private.example",
    token: "fixture-owner-token",
    fetcher: async (url, init) => {
      forwarded = { url: String(url), init };
      return new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": "private=secret",
          "x-api-key": "fixture-owner-token",
        },
      });
    },
  };
  const response = await proxyPi(
    new Request("http://localhost:3000/api/model", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        cookie: "caller=private",
      },
      body: '{"model":"fixture"}',
    }),
    options,
  );
  assert.equal(response.status, 200);
  assert.equal(forwarded.url, "https://private.example/api/model");
  assert.equal(forwarded.init.headers.authorization, "Bearer fixture-owner-token");
  assert.equal(forwarded.init.headers.origin, "https://private.example");
  assert.equal(forwarded.init.headers.cookie, undefined);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-api-key"), null);
  assert.ok(!(await response.text()).includes("fixture-owner-token"));
});
test("network errors are sanitised and only catalogued extension paths are forwarded", async () => {
  const options = {
    origin: "https://private.example",
    token: "fixture-owner-token",
    fetcher: async () => {
      throw Error("fixture-owner-token");
    },
  };
  const response = await proxyPi(
    new Request("http://localhost:3000/extensions/" + "a".repeat(64) + "/client.js"),
    options,
  );
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes("fixture-owner-token"));
  assert.equal(
    (await proxyPi(new Request("http://localhost:3000/extensions/auth.json"), options)).status,
    404,
  );
});

test("image upload forwards binary bytes and private image reads preserve the MIME type", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  let forwarded;
  const options = { origin: "https://private.example", token: "fixture-owner-token", fetcher: async (_url, init) => {
    forwarded = init;
    return new Response(bytes, { headers: { "content-type": "image/webp" } });
  } };
  const response = await proxyPi(new Request("http://localhost:3000/api/attachments", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "image/png", "x-file-name": "screenshot.png" }, body: bytes,
  }), options);
  assert.deepEqual(new Uint8Array(forwarded.body), bytes);
  assert.equal(forwarded.headers["x-file-name"], "screenshot.png");
  assert.equal(forwarded.headers["content-type"], "image/png");
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("binary writes stay confined to bounded image uploads", async () => {
  let calls = 0;
  const options = { origin: "https://private.example", token: "fixture-owner-token", fetcher: async () => { calls++; return Response.json({}); } };
  const request = (path, type, body) => new Request("http://localhost:3000" + path, {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": type }, body,
  });
  assert.equal((await proxyPi(request("/api/chat", "image/png", new Uint8Array([1])), options)).status, 415);
  assert.equal((await proxyPi(request("/api/attachments", "image/svg+xml", "<svg/>"), options)).status, 415);
  assert.equal((await proxyPi(request("/api/attachments", "image/png", new Uint8Array(10 * 1024 * 1024 + 1)), options)).status, 413);
  assert.equal(calls, 0);
});

test("keyed workbench browse is the only cross-site route, and never carries the owner token", async () => {
  const key = "A".repeat(43);
  const calls = [];
  const options = {
    origin: "http://127.0.0.1:3191",
    token: "fixture-owner-token",
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("<p>ok</p>", {
        headers: { "content-type": "text/html", "set-cookie": "sid=1", "content-security-policy": "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'self'" },
      });
    },
  };
  const crossSite = { "sec-fetch-site": "cross-site", cookie: "pi_trial=owner", origin: "null" };
  const page = await proxyPi(new Request(`http://localhost:3200/api/workbench/browse/5173/~${key}/assets/a.js`, { headers: crossSite }), options);
  assert.equal(page.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://127.0.0.1:3191/api/workbench/browse/5173/~${key}/assets/a.js`);
  const sent = new Headers(calls[0].init.headers);
  for (const name of ["authorization", "cookie", "origin"]) assert.equal(sent.get(name), null, `${name} is not forwarded`);
  assert.equal(page.headers.get("set-cookie"), null);
  assert.match(page.headers.get("content-security-policy"), /sandbox allow-scripts allow-forms allow-popups/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");

  const form = await proxyPi(
    new Request(`http://localhost:3200/api/workbench/browse/5173/~${key}/form`, {
      method: "POST",
      headers: { ...crossSite, "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    }),
    options,
  );
  assert.equal(form.status, 200, "a form post from the sandboxed page is forwarded");

  // Every other shape keeps the existing checks.
  for (const path of ["/api/state", "/api/workbench/browse/5173/", `/api/workbench/browse/5173/~${key.slice(1)}/x`, `/api/workbench/services/~${key}`])
    assert.equal((await proxyPi(new Request(`http://localhost:3200${path}`, { headers: crossSite }), options)).status, 403, `cross-site ${path}`);
  assert.equal(
    (await proxyPi(new Request("http://localhost:3200/api/chat", { method: "POST", headers: { origin: "null", "content-type": "text/plain" }, body: "x" }), options)).status,
    403,
  );
  assert.equal(calls.length, 2, "no other request was forwarded");
});

test("the proxy is off in production builds and refuses DNS-rebound Host headers", async () => {
  let called = false;
  const options = {
    origin: "http://127.0.0.1:3191",
    token: "fixture-owner-token",
    fetcher: async () => ((called = true), new Response("{}")),
  };
  assert.equal((await proxyPi(new Request("http://127.0.0.1:3200/api/state"), { ...options, production: true })).status, 404);
  const rebound = new Request("http://127.0.0.1:3200/api/workbench/file?path=notes.txt", {
    headers: { host: "rebind.attacker.example:3200", "sec-fetch-site": "same-origin" },
  });
  assert.equal((await proxyPi(rebound, options)).status, 403, "an attacker's Host is refused even though Next saw 127.0.0.1");
  const keyedRebound = new Request(`http://127.0.0.1:3200/api/workbench/browse/5173/~${"A".repeat(43)}/`, {
    headers: { host: "rebind.attacker.example:3200" },
  });
  assert.equal((await proxyPi(keyedRebound, options)).status, 403, "keyed browse too");
  assert.equal(called, false);
  const local = new Request("http://127.0.0.1:3200/api/state", { headers: { host: "localhost:3200" } });
  assert.equal((await proxyPi(local, options)).status, 200);
});
test("a page opened at 127.0.0.1 can POST, though Next reports the request URL as localhost", async () => {
  const options = { origin: "http://127.0.0.1:3191", token: "fixture-owner-token", fetcher: async () => Response.json({ ok: true }) };
  const post = (host, origin) =>
    proxyPi(new Request("http://localhost:3211/api/chat", { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: "{}" }), options);
  assert.equal((await post("127.0.0.1:3211", "http://127.0.0.1:3211")).status, 200);
  assert.equal((await post("localhost:3211", "http://localhost:3211")).status, 200);
  assert.equal((await post("127.0.0.1:3211", "http://localhost:3211")).status, 403, "the Origin must match the host the browser addressed");
  assert.equal((await post("127.0.0.1:3211", "http://127.0.0.1:9999")).status, 403, "another local port is a different origin");
  assert.equal((await post("127.0.0.1:3211", "https://evil.example")).status, 403);
});
