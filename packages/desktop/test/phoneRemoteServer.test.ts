import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { startPhoneRemoteServer } from "../src/host/phoneRemoteServer.js";

async function startWithStaticPage() {
  const root = await mkdtemp(join(tmpdir(), "phone-remote-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>phone</title>");
  return startPhoneRemoteServer({
    services: new ServiceCollection(),
    staticRoot: root,
    resolveHost: () => "127.0.0.1",
  });
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}

test("serves the phone page to a client that presents the pairing token", async (t) => {
  const handle = await startWithStaticPage();
  t.after(() => handle.dispose());

  const response = await fetch(handle.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /phone/);
});

test("refuses the API without a token, so a bare LAN port is not an agent", async (t) => {
  const handle = await startWithStaticPage();
  t.after(() => handle.dispose());

  const response = await fetch(new URL("/api/server-info", handle.url));
  assert.equal(response.status, 401);
});

test("refuses the WebSocket upgrade path without a token", async (t) => {
  const handle = await startWithStaticPage();
  t.after(() => handle.dispose());

  const response = await fetch(new URL("/ws", handle.url));
  assert.equal(response.status, 401);
});

test("exchanges the token for a cookie, so it never has to ride the socket URL", async (t) => {
  const handle = await startWithStaticPage();
  t.after(() => handle.dispose());

  const first = await fetch(
    new URL(`/api/server-info?token=${encodeURIComponent(tokenOf(handle.url))}`, handle.url),
  );
  assert.equal(first.status, 200);
  const cookie = first.headers.getSetCookie()[0] ?? "";
  assert.match(cookie, /zcode_lite_token=/);
  assert.match(cookie, /HttpOnly/);

  // The bare API path is now reachable with the cookie alone.
  const second = await fetch(new URL("/api/server-info", handle.url), {
    headers: { cookie: cookie.split(";")[0] ?? "" },
  });
  assert.equal(second.status, 200);
});

test("a wrong token is still refused", async (t) => {
  const handle = await startWithStaticPage();
  t.after(() => handle.dispose());

  const response = await fetch(
    new URL(`/api/server-info?token=${encodeURIComponent(tokenOf(handle.url) + "x")}`, handle.url),
  );
  assert.equal(response.status, 401);
});

test("each start gets its own token and its own port", async (t) => {
  const first = await startWithStaticPage();
  const second = await startWithStaticPage();
  t.after(() => Promise.all([first.dispose(), second.dispose()]));

  assert.notEqual(tokenOf(first.url), tokenOf(second.url));
  assert.notEqual(first.port, second.port);
});

test("disposing stops answering, which is how the operator revokes a pairing", async () => {
  const handle = await startWithStaticPage();
  await handle.dispose();

  await assert.rejects(() => fetch(handle.url));
});

test("refuses to start rather than binding loopback a phone cannot reach", async () => {
  await assert.rejects(
    () =>
      startPhoneRemoteServer({
        services: new ServiceCollection(),
        staticRoot: tmpdir(),
        resolveHost: () => null,
      }),
    /reachable network address/,
  );
});
