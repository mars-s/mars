/**
 * Offline tests for the ChatGPT OAuth logic that needs no network and no real
 * ChatGPT account: PKCE generation, the account-id claim, the mandatory
 * `store: false` body, and the device-code poll state machine.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveCodeChallenge,
  generatePkcePair,
  isValidPkceVerifier,
} from "../src/oauth/providers/chatgpt/chatgptPkce.js";
import {
  isAccessTokenKnownExpired,
  readAccessTokenSubject,
  readChatgptAccountId,
} from "../src/oauth/providers/chatgpt/chatgptAccessTokenClaims.js";
import {
  buildCodexRequestHeaders,
  buildCodexResponsesRequestBody,
} from "../src/oauth/providers/chatgpt/chatgptCodexRequest.js";
import {
  buildChatGptTokenRequestBody,
  ChatGptAuthorizationPendingError,
  ChatGptDeviceFlowTerminalError,
  createChatGptClient,
  normalizeIntervalSeconds,
  type ChatGptTransport,
} from "../src/oauth/providers/chatgpt/chatgptDeviceFlow.js";
import { ChatGptDeviceFlowSession } from "../src/oauth/providers/chatgpt/chatgptDeviceFlowSession.js";
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_ORIGINATOR,
} from "../src/oauth/providers/chatgpt/chatgptOAuthConfig.js";

function base64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function makeAccessToken(payload: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "none" }))}.${base64Url(JSON.stringify(payload))}.sig`;
}

test("PKCE verifier satisfies RFC 7636 and the challenge is its S256 digest", () => {
  const pair = generatePkcePair();
  assert.equal(pair.codeChallengeMethod, "S256");
  assert.ok(isValidPkceVerifier(pair.codeVerifier), "verifier must be 43-128 unreserved chars");
  const expected = createHash("sha256").update(pair.codeVerifier, "ascii").digest("base64url");
  assert.equal(pair.codeChallenge, expected);
  assert.equal(pair.codeChallenge, deriveCodeChallenge(pair.codeVerifier));
  // The challenge must never leak the verifier.
  assert.notEqual(pair.codeChallenge, pair.codeVerifier);
});

test("PKCE generation is unpredictable and honours the injected random source", () => {
  const first = generatePkcePair();
  const second = generatePkcePair();
  assert.notEqual(first.codeVerifier, second.codeVerifier);

  const fixed = Buffer.alloc(64, 7);
  const injected = generatePkcePair({ randomSource: () => fixed });
  assert.equal(injected.codeVerifier, fixed.toString("base64url"));
  assert.equal(injected.codeChallenge, deriveCodeChallenge(injected.codeVerifier));
});

test("isValidPkceVerifier rejects out-of-range and illegal characters", () => {
  assert.equal(isValidPkceVerifier("a".repeat(42)), false);
  assert.equal(isValidPkceVerifier("a".repeat(129)), false);
  assert.equal(isValidPkceVerifier(`${"a".repeat(42)}+`), false);
  assert.equal(isValidPkceVerifier("a".repeat(43)), true);
});

test("chatgpt_account_id is read from a flat claim and from the namespaced claim", () => {
  assert.equal(
    readChatgptAccountId(makeAccessToken({ chatgpt_account_id: "acct-flat" })),
    "acct-flat",
  );
  assert.equal(
    readChatgptAccountId(
      makeAccessToken({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
      }),
    ),
    "acct-nested",
  );
  assert.equal(readChatgptAccountId(makeAccessToken({ sub: "user-1" })), null);
});

test("account-id extraction fails closed on opaque or malformed tokens", () => {
  assert.equal(readChatgptAccountId("opaque-token"), null);
  assert.equal(readChatgptAccountId("a.b"), null);
  assert.equal(readChatgptAccountId("a.!!!not-base64!!!.c"), null);
  assert.equal(readChatgptAccountId(""), null);
  assert.equal(readChatgptAccountId(makeAccessToken({ chatgpt_account_id: "   " })), null);
  assert.equal(readAccessTokenSubject(makeAccessToken({ sub: "user-1" })), "user-1");
});

test("expiry is only reported as expired when the token actually says so", () => {
  const now = 1_700_000_000_000;
  const fresh = makeAccessToken({ exp: (now + 600_000) / 1_000 });
  const stale = makeAccessToken({ exp: (now - 600_000) / 1_000 });
  assert.equal(isAccessTokenKnownExpired(fresh, now), false);
  assert.equal(isAccessTokenKnownExpired(stale, now), true);
  // Unknown expiry must never be treated as expired: that would sign out a
  // healthy subscriber whose token simply has no exp claim.
  assert.equal(isAccessTokenKnownExpired(makeAccessToken({ sub: "u" }), now), false);
  assert.equal(isAccessTokenKnownExpired("opaque", now), false);
});

test("every token request body carries store:false as a boolean", () => {
  const body = buildChatGptTokenRequestBody({
    clientId: "app_test",
    grantType: "refresh_token",
    refreshToken: "rt",
  });
  assert.equal(body.store, false);
  assert.equal(typeof body.store, "boolean");
  assert.equal(body.refresh_token, "rt");
  assert.equal(body.client_id, "app_test");
  assert.equal(body.grant_type, "refresh_token");
});

test("the codex responses body always sets store:false and a default model", () => {
  const body = buildCodexResponsesRequestBody({ input: [{ role: "user" }] });
  assert.equal(body.store, false);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });

  const nonStreaming = buildCodexResponsesRequestBody({ input: [], stream: false, model: "x" });
  assert.equal(nonStreaming.store, false);
  assert.equal(nonStreaming.stream, false);
  assert.equal(nonStreaming.stream_options, undefined);
});

test("codex request headers carry the account id and this product's own originator", () => {
  const headers = buildCodexRequestHeaders("access-token", "acct-1");
  assert.equal(headers[CHATGPT_ACCOUNT_ID_HEADER], "acct-1");
  assert.equal(headers.Authorization, "Bearer access-token");
  assert.equal(headers.originator, CHATGPT_ORIGINATOR);
  assert.equal(headers.originator, "zcode");
  // Must never impersonate another product.
  assert.notEqual(headers.originator, "codex_cli_rs");

  assert.throws(() => buildCodexRequestHeaders("access-token", "  "), /chatgpt_account_id/);
  assert.throws(() => buildCodexRequestHeaders("  ", "acct-1"), /access token/);
});

test("device authorization parses the challenge and the poll maps pending", async () => {
  const bodies: string[] = [];
  const transport: ChatGptTransport = async (input, init) => {
    bodies.push(init.body);
    if (input.endsWith("/oauth/device/code")) {
      return jsonResponse({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.openai.com/device",
        verification_uri_complete: "https://auth.openai.com/device?user_code=ABCD-EFGH",
        expires_in: 900,
        interval: 1,
      });
    }
    return jsonResponse({ error: "authorization_pending" }, 400);
  };

  const client = createChatGptClient({ transport });
  const authorization = await client.requestDeviceAuthorization();
  assert.equal(authorization.userCode, "ABCD-EFGH");
  assert.equal(authorization.deviceCode, "dc");
  assert.equal(authorization.expiresInSeconds, 900);
  // The server asked for a 1s cadence; the client enforces its own floor.
  assert.equal(authorization.intervalSeconds, 5);

  await assert.rejects(
    () => client.pollDeviceToken("dc"),
    (error: unknown) => error instanceof ChatGptAuthorizationPendingError,
  );
  for (const body of bodies) {
    assert.match(body, /store=false/);
    assert.match(body, /client_id=app_EMoamEEZ73f0CkXaXp7hrann/);
  }
});

test("terminal device failures are distinguishable from pending", async () => {
  const terminal = createChatGptClient({
    transport: async () => jsonResponse({ error: "access_denied" }, 400),
  });
  await assert.rejects(
    () => terminal.pollDeviceToken("dc"),
    (error: unknown) =>
      error instanceof ChatGptDeviceFlowTerminalError && error.code === "access_denied",
  );

  const expired = createChatGptClient({
    transport: async () => jsonResponse({ error: "expired_token" }, 400),
  });
  await assert.rejects(
    () => expired.pollDeviceToken("dc"),
    (error: unknown) =>
      error instanceof ChatGptDeviceFlowTerminalError && error.code === "expired_token",
  );
});

test("a token response without a refresh token is rejected, not silently accepted", async () => {
  const client = createChatGptClient({
    transport: async () => jsonResponse({ access_token: "at" }),
  });
  await assert.rejects(
    () => client.pollDeviceToken("dc"),
    (error: unknown) =>
      error instanceof ChatGptDeviceFlowTerminalError && error.code === "missing_refresh_token",
  );
});

test("the poll interval is clamped into the documented band", () => {
  assert.equal(normalizeIntervalSeconds(0), 5);
  assert.equal(normalizeIntervalSeconds(1), 5);
  assert.equal(normalizeIntervalSeconds(5), 5);
  assert.equal(normalizeIntervalSeconds(600), 30);
});

test("device session returns null while pending and the token set once approved", async () => {
  let polls = 0;
  const session = new ChatGptDeviceFlowSession({
    client: {
      requestToken: async () => ({}),
      requestDeviceAuthorization: async () => ({
        deviceCode: "dc",
        userCode: "CODE",
        verificationUri: "https://auth.openai.com/device",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      }),
      pollDeviceToken: async () => {
        polls += 1;
        if (polls < 3) throw new ChatGptAuthorizationPendingError();
        return { accessToken: "at", refreshToken: "rt", expiresInSeconds: 3600 };
      },
    },
    now: () => 1_000,
    toTokenSet: async (grant) => ({
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
    }),
  });

  const start = await session.startDeviceFlow("state-1");
  assert.equal(start.userCode, "CODE");
  assert.equal(start.expiresAt, 601_000);
  assert.deepEqual(session.peekDeviceFlow(), start);

  // The first poll happens immediately; the second is rate limited to null.
  assert.equal(await session.pollDeviceFlow("state-1"), null);
  assert.equal(await session.pollDeviceFlow("state-1"), null);

  // A poll for a different state never touches this session.
  assert.equal(await session.pollDeviceFlow("other-state"), null);

  session.cancelDeviceFlow("state-1");
  assert.equal(session.peekDeviceFlow(), null);
  assert.equal(await session.pollDeviceFlow("state-1"), null);
});

test("a device session that expires terminates the flow instead of polling forever", async () => {
  let clock = 1_000;
  const session = new ChatGptDeviceFlowSession({
    client: {
      requestToken: async () => ({}),
      requestDeviceAuthorization: async () => ({
        deviceCode: "dc",
        userCode: "CODE",
        verificationUri: "https://auth.openai.com/device",
        expiresInSeconds: 10,
        intervalSeconds: 5,
      }),
      pollDeviceToken: async () => {
        throw new Error("must not be polled after expiry");
      },
    },
    now: () => clock,
    toTokenSet: async () => {
      throw new Error("unreachable");
    },
  });

  await session.startDeviceFlow("state-1");
  clock = 20_000;
  await assert.rejects(
    () => session.pollDeviceFlow("state-1"),
    (error: unknown) =>
      error instanceof ChatGptDeviceFlowTerminalError && error.code === "expired_token",
  );
  assert.equal(session.peekDeviceFlow(), null);
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
