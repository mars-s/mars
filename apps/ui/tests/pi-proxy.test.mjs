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
