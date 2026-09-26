/**
 * Adapter-level offline tests.
 *
 * These drive the real adapter with an injected device-code client and an
 * injected fetch, so the whole login -> persist -> refresh -> logout chain is
 * exercised without a ChatGPT account or any network access.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChatGptOAuthAdapter } from "../src/oauth/providers/chatgpt/chatgptOAuthAdapter.js";
import { createChatGptClient } from "../src/oauth/providers/chatgpt/chatgptDeviceFlow.js";
import type { ApiClient } from "@zcode/shared";
import { createOAuthProviderAdapters } from "../src/oauth/providers/index.js";

const ACCOUNT_ID = "acct-under-test";

let accessTokenSerial = 0;

function makeAccessToken(accountId = ACCOUNT_ID, expiresInSeconds = 3600): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  // The serial keeps every issued token distinct, which is what a real
  // authorization server does and what the rotation assertions rely on.
  accessTokenSerial += 1;
  return `${encode({ alg: "none" })}.${encode({
    chatgpt_account_id: accountId,
    sub: "user-under-test",
    jti: `at-${accessTokenSerial}`,
    exp: Math.floor(Date.now() / 1_000) + expiresInSeconds,
  })}.sig`;
}

interface Harness {
  adapter: ChatGptOAuthAdapter;
  dir: string;
  requests: { bodies: string[]; urls: string[] };
  grantPath: string;
}

async function createHarness(options: { devicePolls?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-chatgpt-adapter-"));
  const grantPath = join(dir, "oauth-grant.json");
  const requests = { bodies: [] as string[], urls: [] as string[] };
  let polls = 0;
  const tokenResponse = () => ({
    access_token: makeAccessToken(),
    refresh_token: `rt-${++polls}`,
    expires_in: 3600,
  });

  const client = createChatGptClient({
    transport: async (url, init) => {
      requests.urls.push(url);
      requests.bodies.push(init.body);
      if (url.endsWith("/oauth/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "device-code",
            user_code: "WXYZ-1234",
            verification_uri: "https://auth.openai.com/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(tokenResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = String(input);
    requests.urls.push(url);
    if (url.includes("api.openai.com/auth")) {
      return new Response(JSON.stringify({ chatgpt_plan_type: "pro" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };

  const adapter = new ChatGptOAuthAdapter({ client, fetchImpl, grantStorePath: grantPath });
  void options;
  return { adapter, dir, requests, grantPath };
}

test("the factory registers the ChatGPT adapter and requires an apiClient", () => {
  assert.throws(() => createOAuthProviderAdapters({}), /apiClient/);
  const adapters = createOAuthProviderAdapters({ apiClient: {} as ApiClient });
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0]?.providerId, "chatgpt");
  assert.equal(adapters[0]?.meta.displayName, "ChatGPT");
  assert.equal(adapters[0]?.meta.enabled, true);
  // A provider that owns its issuer must not be gated on the backend JWT.
  assert.equal(adapters[0]?.meta.sessionKind, "provider-token");
});

test("the default login flow is device code and needs no loopback listener", async () => {
  const harness = await createHarness();
  try {
    const start = await harness.adapter.startDeviceFlow("state-1");
    assert.equal(start.userCode, "WXYZ-1234");
    assert.equal(start.verificationUri, "https://auth.openai.com/device");
    assert.equal(harness.adapter.supportsDeviceCodeFlow, true);
    assert.equal(harness.adapter.redirectUri, "http://localhost:1455/auth/callback");

    // A revoked flow must stop being pollable.
    harness.adapter.cancelDeviceFlow("state-1");
    assert.equal(await harness.adapter.pollDeviceFlow("state-1"), null);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("a completed device login persists an encrypted grant and resolves the account", async () => {
  const harness = await createHarness();
  try {
    await harness.adapter.startDeviceFlow("state-1");
    const tokenSet = await harness.adapter.pollDeviceFlow("state-1");
    assert.ok(tokenSet?.accessToken);
    assert.ok(tokenSet?.refreshToken);

    const profile = await harness.adapter.fetchUserInfo(tokenSet!);
    // The account id comes from the JWT claim, not from the token response.
    assert.equal(profile.id, ACCOUNT_ID);
    assert.equal(profile.displayName, "ChatGPT (pro)");

    const stored = await readFile(harness.grantPath, "utf-8");
    assert.doesNotMatch(stored, /rt-1/, "the refresh token must not be readable on disk");
    assert.match(stored, /"version": 1/);
    for (const body of harness.requests.bodies) {
      assert.match(body, /store=false/);
    }
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("refresh submits the live token exactly once and then adopts the stored pair", async () => {
  const harness = await createHarness();
  try {
    await harness.adapter.startDeviceFlow("state-1");
    const tokenSet = (await harness.adapter.pollDeviceFlow("state-1"))!;

    const rotated = await harness.adapter.refreshToken(tokenSet);
    assert.notEqual(rotated.refreshToken, tokenSet.refreshToken);
    assert.notEqual(rotated.accessToken, tokenSet.accessToken);

    // A second holder of the now-spent refresh token adopts instead of replaying.
    const adopted = await harness.adapter.refreshToken(tokenSet);
    assert.equal(adopted.refreshToken, rotated.refreshToken);
    assert.equal(adopted.accessToken, rotated.accessToken);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("refresh refuses when the token has no refresh token and never hits the network", async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      () => harness.adapter.refreshToken({ accessToken: makeAccessToken() }),
      /cannot be refreshed/,
    );
    assert.deepEqual(harness.requests.urls, []);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("logout drops the app-owned grant so no live refresh token survives", async () => {
  const harness = await createHarness();
  try {
    await harness.adapter.startDeviceFlow("state-1");
    await harness.adapter.pollDeviceFlow("state-1");
    assert.ok(await harness.adapter.loadLegacyTokenSet());

    await harness.adapter.clearProviderSessionSecrets();
    assert.equal(await harness.adapter.loadLegacyTokenSet(), null);
    await assert.rejects(() => readFile(harness.grantPath, "utf-8"), /ENOENT/);
  } finally {
    await rm(harness.dir, { recursive: true, force: true });
  }
});

test("the authorization-code request carries PKCE and this product's client id", () => {
  const adapter = new ChatGptOAuthAdapter({ grantStorePath: "/nonexistent/never-written.json" });
  const url = new URL(
    adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state: "state-x",
      redirectUri: adapter.redirectUri,
      now: Date.now,
    }),
  );
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok((url.searchParams.get("code_challenge") ?? "").length >= 43);
  assert.equal(url.searchParams.get("state"), "state-x");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  // The verifier must never appear in the URL.
  assert.equal(url.searchParams.get("code_verifier"), null);
});

test("a callback without a matching PKCE request is refused", async () => {
  const adapter = new ChatGptOAuthAdapter({ grantStorePath: "/nonexistent/never-written.json" });
  assert.deepEqual(
    adapter.parseCallbackParams("http://localhost:1455/auth/callback?code=abc&state=state-x"),
    { code: "abc", state: "state-x" },
  );
  assert.throws(
    () => adapter.parseCallbackParams("http://localhost:1455/auth/callback?state=state-x"),
    /missing the authorization code/,
  );
  await assert.rejects(
    () =>
      adapter.exchangeToken(
        { code: "abc", state: "unknown-state" },
        {
          providerId: adapter.providerId,
          state: "unknown-state",
          redirectUri: adapter.redirectUri,
          now: Date.now,
        },
      ),
    /no longer valid/,
  );
});
