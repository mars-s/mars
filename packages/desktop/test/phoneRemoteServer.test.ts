import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { startPhoneRemoteServer } from "../src/host/phoneRemoteServer.js";

async function stageIndex(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "phone-remote-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>phone</title>");
  return root;
}

async function startWithStaticPage() {
  return startPhoneRemoteServer({
    services: new ServiceCollection(),
    staticRoot: await stageIndex(),
    resolveCandidates: () => [{ address: "127.0.0.1", reach: "lan" }],
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

test("every pairing shares one token and one port, so any QR unlocks the same session", async (t) => {
  const handle = await startPhoneRemoteServer({
    services: new ServiceCollection(),
    staticRoot: await stageIndex(),
    resolveCandidates: () => [
      { address: "100.124.17.182", reach: "tailnet" as const },
      { address: "192.168.1.101", reach: "lan" as const },
    ],
  });
  t.after(() => handle.dispose());

  assert.equal(handle.pairings.length, 2);
  assert.equal(new Set(handle.pairings.map((p) => tokenOf(p.url))).size, 1);
  for (const pairing of handle.pairings) {
    assert.equal(new URL(pairing.url).port, String(handle.port));
  }
  // A caller that renders a single QR gets the best pairing, not an arbitrary one.
  assert.equal(handle.url, handle.pairings[0].url);
  assert.equal(handle.pairings[0].reach, "tailnet");
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
        resolveCandidates: () => [],
      }),
    /reachable network address/,
  );
});
