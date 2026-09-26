/**
 * Offline tests for the host-side ChatGPT request credential.
 *
 * The whole point of this file is the NEGATIVE cases. `provider-data-schema.ts`
 * has no host allowlist, so a personal provider can be named anything and pointed
 * anywhere; a credential handler that matched on a caller-supplied string would
 * hand a live subscription grant to whatever host the caller named. Every test
 * below that ends in "refused" is one of those strings.
 *
 * No real grant, token, or account is used anywhere: the store is a fake and the
 * access tokens are unsigned locally built JWTs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { zcodeProviderRuntimeHeadersResponseSchema } from "@zcode/shared";
import {
  answerProviderRequestAuthRequest,
  isRegistryVerifiedChatGptProvider,
  projectGrantToRequestAuth,
  resolveChatGptProviderRequestAuth,
  resolveChatGptRegistryIdentity,
  type ChatGptRegistryIdentity,
} from "../src/zcode-agent/chatgptProviderRequestAuth.js";
import type {
  ProviderRequestAuthGrant,
  ProviderRequestAuthGrantStore,
} from "../src/oauth/providers/providerAdapter.js";
import { CHATGPT_ACCOUNT_ID_HEADER } from "../src/oauth/providers/chatgpt/chatgptOAuthConfig.js";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const FIXED_NOW = 1_800_000_000_000;

function base64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

/** A locally built, unsigned token. Never a real credential. */
function makeAccessToken(payload: Record<string, unknown>): string {
  return `${base64Url(JSON.stringify({ alg: "none" }))}.${base64Url(JSON.stringify(payload))}.sig`;
}

const VALID_TOKEN = makeAccessToken({
  exp: Math.floor(FIXED_NOW / 1000) + 3600,
  chatgpt_account_id: "acct-fake-0001",
});

const IDENTITY: ChatGptRegistryIdentity = {
  accessType: "oauth",
  apiType: "openai-responses",
  baseUrl: CODEX_BASE_URL,
  templateId: "chatgpt-subscription",
};

function grant(overrides: Partial<ProviderRequestAuthGrant> = {}): ProviderRequestAuthGrant {
  return {
    accessToken: VALID_TOKEN,
    accountId: "acct-fake-0001",
    expiresAt: FIXED_NOW + 3_600_000,
    refreshToken: "refresh-01",
    rotation: 3,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

interface FakeStoreOptions {
  initial?: ProviderRequestAuthGrant | null;
  onRotate?: (expectedRefreshToken: string) => void;
  rotateError?: Error;
  unlocked?: boolean;
}

function fakeStore(options: FakeStoreOptions = {}): ProviderRequestAuthGrantStore & {
  rotateCalls: string[];
} {
  let current = options.initial === undefined ? grant() : options.initial;
  const rotateCalls: string[] = [];
  return {
    rotateCalls,
    read: async () => current,
    rotate: async (request) => {
      rotateCalls.push(request.expectedRefreshToken);
      if (options.rotateError) {
        throw options.rotateError;
      }
      if (options.unlocked) {
        return { grant: null, status: "unlocked" };
      }
      options.onRotate?.(request.expectedRefreshToken);
      current = grant({
        accessToken: makeAccessToken({
          exp: Math.floor(FIXED_NOW / 1000) + 7200,
          chatgpt_account_id: "acct-fake-0001",
        }),
        refreshToken: "refresh-02",
        rotation: 4,
      });
      return { grant: current, status: "rotated" };
    },
  };
}

// ---------------------------------------------------------------- the happy path

test("attaches the credential for the registry-verified ChatGPT identity", async () => {
  const store = fakeStore();
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: store,
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "model-request",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.requestAuth.apiKey, VALID_TOKEN);
  assert.equal(result.requestAuth.headers[CHATGPT_ACCOUNT_ID_HEADER], "acct-fake-0001");
  assert.equal(result.requestAuth.headers.originator, "zcode");
  // A live token must never be rotated on the ordinary path.
  assert.deepEqual(store.rotateCalls, []);
});

test("the projected api key is the bare token, not a duplicated Bearer header", async () => {
  const requestAuth = projectGrantToRequestAuth({
    accessToken: "  token-value  ",
    accountId: "acct-fake-0001",
  });
  assert.equal(requestAuth.apiKey, "token-value");
  // The AI SDK builds `Authorization` itself from the api key, so shipping one
  // here too would be a second copy of the same secret on the request.
  assert.equal(
    Object.keys(requestAuth.headers).some((name) => name.toLowerCase() === "authorization"),
    false,
  );
});

test("a trailing slash on the registry base URL is not a different host", () => {
  assert.equal(
    isRegistryVerifiedChatGptProvider({ ...IDENTITY, baseUrl: `${CODEX_BASE_URL}/` }),
    true,
  );
});

// ------------------------------------------------------- the spoofing refusals

test("a caller-supplied provider NAME is not an identity", async () => {
  const store = fakeStore();
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: store,
    // The caller named the provider "chatgpt"; the registry knows nothing of it.
    identity: { accessType: null, apiType: null, baseUrl: null, templateId: null },
    now: () => FIXED_NOW,
    reason: "model-request",
  });
  assert.deepEqual(result, { ok: false, detail: "registry-identity-rejected" });
  assert.deepEqual(store.rotateCalls, [], "a refused identity must not touch the grant");
});

test("a personal provider pointed at an attacker host is refused", async () => {
  const store = fakeStore();
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: store,
    // Everything matches except the endpoint. This is the case that matters: a
    // personal provider may carry the ChatGPT template id and still redirect the
    // request, and the base URL is the only field that catches it.
    identity: {
      accessType: "oauth",
      apiType: "openai-responses",
      baseUrl: "https://attacker.example/v1",
      templateId: "chatgpt-subscription",
    },
    now: () => FIXED_NOW,
    reason: "model-request",
  });
  assert.deepEqual(result, { ok: false, detail: "registry-identity-rejected" });
});

test("a host-prefix confusion in the base URL is refused", async () => {
  for (const baseUrl of [
    "https://chatgpt.com/backend-api/codex.attacker.example",
    "https://chatgpt.com/backend-api/codex@attacker.example",
    "https://evil.example/https://chatgpt.com/backend-api/codex",
    "https://chatgpt.com/backend-api",
  ]) {
    assert.equal(
      isRegistryVerifiedChatGptProvider({ ...IDENTITY, baseUrl }),
      false,
      `${baseUrl} must not verify`,
    );
  }
});

test("a mismatched template, access shape or api type is refused", async () => {
  const cases: ChatGptRegistryIdentity[] = [
    { ...IDENTITY, templateId: "openai" },
    { ...IDENTITY, templateId: undefined },
    { ...IDENTITY, accessType: "api-key" },
    { ...IDENTITY, apiType: "anthropic" },
    { ...IDENTITY, baseUrl: undefined },
  ];
  for (const identity of cases) {
    assert.equal(isRegistryVerifiedChatGptProvider(identity), false, JSON.stringify(identity));
  }
});

// ------------------------------------------------------------- grant refusals

test("no stored grant is a refusal, not an anonymous request", async () => {
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: fakeStore({ initial: null }),
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "model-request",
  });
  assert.deepEqual(result, { ok: false, detail: "grant-absent" });
});

test("a rotation that finds no grant is a refusal", async () => {
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: fakeStore({ unlocked: true }),
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "unauthorized",
  });
  assert.deepEqual(result, { ok: false, detail: "grant-incomplete" });
});

test("a rejected refresh token is a refusal that asks for a fresh login", async () => {
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: fakeStore({ rotateError: new Error("invalid_grant") }),
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "unauthorized",
  });
  assert.deepEqual(result, { ok: false, detail: "grant-revoked" });
});

// -------------------------------------------------- rotation on a 401 and expiry

test("an unauthorized reason rotates the grant exactly once", async () => {
  const seen: string[] = [];
  const store = fakeStore({ onRotate: (token) => seen.push(token) });
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: store,
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "unauthorized",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(store.rotateCalls, ["refresh-01"]);
  assert.deepEqual(seen, ["refresh-01"], "the exchange runs inside the store's lock");
  if (!result.ok) return;
  assert.notEqual(
    result.requestAuth.apiKey,
    VALID_TOKEN,
    "the replay must not reuse the old token",
  );
});

test("a known-expired access token rotates without an unauthorized reason", async () => {
  const store = fakeStore({
    initial: grant({ accessToken: makeAccessToken({ exp: Math.floor(FIXED_NOW / 1000) - 10 }) }),
  });
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: store,
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "model-request",
  });
  assert.equal(result.ok, true);
  assert.equal(store.rotateCalls.length, 1);
});

test("a token whose expiry cannot be read is never treated as expired", async () => {
  const store = fakeStore({ initial: grant({ accessToken: "not-a-jwt" }) });
  const result = await resolveChatGptProviderRequestAuth({
    grantStore: store,
    identity: IDENTITY,
    now: () => FIXED_NOW,
    reason: "model-request",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(store.rotateCalls, []);
});

test("a grant with no account id cannot be dressed up as a usable one", () => {
  assert.throws(
    () => projectGrantToRequestAuth({ accessToken: VALID_TOKEN, accountId: null }),
    /chatgpt_account_id/u,
  );
});

// ---------------------------------------------------------------------------
// The request's providerId is a lookup key and nothing else.
//
// These build a registry view the way the host holds one, then hand it a
// caller-controlled `providerId` and `modelId`. The identity that comes back is
// the only thing the credential decision is allowed to see.
// ---------------------------------------------------------------------------

function registryProvider(overrides: Partial<RegistryProviderLike> = {}): RegistryProviderLike {
  return {
    config: {
      access: { type: "oauth" },
      api: { baseUrl: CODEX_BASE_URL, type: "openai-responses" },
    },
    models: [{ modelId: "gpt-5.6-luna" }],
    providerId: "account:chatgpt",
    templateId: "chatgpt-subscription",
    ...overrides,
  };
}

type RegistryProviderLike = Parameters<
  typeof resolveChatGptRegistryIdentity
>[0]["providers"][number];

const LOOKUP = { modelId: "gpt-5.6-luna", providerId: "account:chatgpt" };

test("a registry-verified provider yields a verifiable identity", () => {
  const identity = resolveChatGptRegistryIdentity({
    ...LOOKUP,
    providers: [registryProvider()],
  });
  assert.deepEqual(identity, {
    accessType: "oauth",
    apiType: "openai-responses",
    baseUrl: CODEX_BASE_URL,
    templateId: "chatgpt-subscription",
  });
  assert.equal(isRegistryVerifiedChatGptProvider(identity!), true);
});

test("a providerId the registry does not hold resolves to nothing", () => {
  assert.equal(
    resolveChatGptRegistryIdentity({
      ...LOOKUP,
      providerId: "account:not-in-the-registry",
      providers: [registryProvider()],
    }),
    null,
    "a caller-chosen id that is absent from the registry cannot become an identity",
  );
  // Spoofing the CHATGPT template id as if it were a provider id buys nothing.
  assert.equal(
    resolveChatGptRegistryIdentity({
      ...LOOKUP,
      providerId: "chatgpt-subscription",
      providers: [registryProvider()],
    }),
    null,
  );
});

test("a model the provider does not hold resolves to nothing", () => {
  // Otherwise a request could name the right provider with a model it does not
  // own and still receive that provider's credential.
  assert.equal(
    resolveChatGptRegistryIdentity({
      ...LOOKUP,
      modelId: "gpt-5.6-not-real",
      providers: [registryProvider()],
    }),
    null,
  );
});

test("a personal provider pointing at an attacker host is refused", async () => {
  // The catalog is permissive by design: nothing stops a personal rule from
  // naming the shipped template and redirecting the endpoint. The identity is
  // projected from the EFFECTIVE config, so the redirect is what gets checked.
  const identity = resolveChatGptRegistryIdentity({
    ...LOOKUP,
    providers: [
      registryProvider({
        config: {
          access: { type: "oauth" },
          api: { baseUrl: "https://attacker.example/v1", type: "openai-responses" },
        },
        providerId: "personal-sneaky",
      }),
    ],
    providerId: "personal-sneaky",
  });
  assert.equal(identity?.baseUrl, "https://attacker.example/v1");
  assert.equal(isRegistryVerifiedChatGptProvider(identity!), false);

  const result = await resolveChatGptProviderRequestAuth({
    grantStore: fakeStore(),
    identity: identity!,
    now: () => FIXED_NOW,
    reason: "model-request",
  });
  assert.deepEqual(result, { ok: false, detail: "registry-identity-rejected" });
});

test("a personal provider that kept the real base URL is still refused", () => {
  // A personal rule may legitimately re-declare the ChatGPT provider without a
  // template. Same endpoint, but the identity did not come from the shipped
  // catalog, and the template id is the only thing that records that.
  const identity = resolveChatGptRegistryIdentity({
    ...LOOKUP,
    providers: [registryProvider({ templateId: null })],
  });
  assert.equal(isRegistryVerifiedChatGptProvider(identity!), false);
});

test("a personal provider that swapped in a static key is refused", () => {
  const identity = resolveChatGptRegistryIdentity({
    ...LOOKUP,
    providers: [
      registryProvider({
        config: {
          access: { type: "apiKey" },
          api: { baseUrl: CODEX_BASE_URL, type: "openai-responses" },
        },
      }),
    ],
  });
  assert.equal(isRegistryVerifiedChatGptProvider(identity!), false);
});

test("a hidden or absent registry view cannot be talked into an identity", () => {
  assert.equal(resolveChatGptRegistryIdentity({ ...LOOKUP, providers: [] }), null);
  // A view entry with no template, access or api at all still projects to nulls
  // rather than to undefined leaking through as a match.
  const identity = resolveChatGptRegistryIdentity({
    ...LOOKUP,
    providers: [{ models: [{ modelId: "gpt-5.6-luna" }], providerId: "account:chatgpt" }],
  });
  assert.deepEqual(identity, {
    accessType: null,
    apiType: null,
    baseUrl: null,
    templateId: null,
  });
  assert.equal(isRegistryVerifiedChatGptProvider(identity!), false);
});

// ---------------------------------------------------------------------------
// The protocol handler itself.
//
// Every branch returns the same refusal payload, so the assertions below check
// both halves: the payload a caller can observe, and the non-sensitive reason
// that goes to the host log.
// ---------------------------------------------------------------------------

const REFUSAL = {
  errorMessage: "Provider request auth is unavailable",
  headersApplied: false,
};

function handlerPort(
  overrides: {
    identity?: ChatGptRegistryIdentity | null;
    identityError?: Error;
    store?: ProviderRequestAuthGrantStore | null;
    storeError?: Error;
  } = {},
) {
  let storeReads = 0;
  let storeResolutions = 0;
  const wrapped: ProviderRequestAuthGrantStore = {
    read: async () => {
      storeReads += 1;
      return grant();
    },
    rotate: async () => ({ grant: null, status: "unlocked" }),
  };
  const port = {
    resolveGrantStore: () => {
      storeResolutions += 1;
      if (overrides.storeError) throw overrides.storeError;
      return overrides.store === undefined ? wrapped : overrides.store;
    },
    resolveProviderIdentity: async () => {
      if (overrides.identityError) throw overrides.identityError;
      return overrides.identity === undefined ? IDENTITY : overrides.identity;
    },
  };
  // `storeResolutions` is the stronger assertion than `storeReads`: reading is
  // what pulls a secret into memory, but RESOLVING the store is the call the
  // ordering forbids, because the moment that resolver starts caring about its
  // `identity` argument it becomes a secret read in its own right.
  return { port, storeReads: () => storeReads, storeResolutions: () => storeResolutions };
}

const REQUEST = {
  modelId: "gpt-5.6-luna",
  now: () => FIXED_NOW,
  providerId: "account:chatgpt",
  reason: "model-request" as const,
};

test("the handler attaches the credential for the verified identity", async () => {
  const { port, storeResolutions } = handlerPort();
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.equal(response.headersApplied, true);
  if (!response.headersApplied) return;
  assert.equal(response.requestAuth.apiKey, VALID_TOKEN);
  assert.equal(response.requestAuth.headers[CHATGPT_ACCOUNT_ID_HEADER], "acct-fake-0001");
  assert.equal(response.requestAuth.headers.authorization, undefined, "the SDK owns the bearer");
  // The destination the host verified goes back with the credential, in the one
  // form the agent compares in, so it can prove its own destination is the same
  // one before it attaches anything.
  assert.equal(response.approvedBaseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(storeResolutions(), 1, "a verified identity does reach the store");
});

test("a trailing slash in the registry base URL is normalized out of the attestation", async () => {
  const { port } = handlerPort({ identity: { ...IDENTITY, baseUrl: `${CODEX_BASE_URL}/` } });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.equal(response.headersApplied, true);
  if (!response.headersApplied) return;
  assert.equal(response.approvedBaseUrl, "https://chatgpt.com/backend-api/codex");
});

test("the verified destination is what the protocol schema actually accepts", async () => {
  // The attestation is load-bearing, so it has to survive the wire schema rather
  // than be stripped by it. A `headersApplied: true` answer without it is
  // rejected, which is what makes "the host forgot to attest" a hard failure
  // instead of a silent pass.
  const { port } = handlerPort();
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.equal(zcodeProviderRuntimeHeadersResponseSchema.safeParse(response).success, true);
  const { approvedBaseUrl: _omitted, ...withoutAttestation } = response as {
    approvedBaseUrl: string;
  };
  assert.equal(
    zcodeProviderRuntimeHeadersResponseSchema.safeParse(withoutAttestation).success,
    false,
    "an unattested success must not validate",
  );
});

// ---------------------------------------------------------------------------
// The grant store is never resolved, let alone read, before the identity has been
// VERIFIED. This is not an incidental property of the current call graph: the
// order is the security property, and it has to hold for a `resolveGrantStore`
// that starts depending on its `identity` argument tomorrow.
// ---------------------------------------------------------------------------

test("the grant store is never resolved for a non-ChatGPT identity", async () => {
  // Each of these is a registry hit that does not verify. Resolving the store for
  // any of them would be a secret read on behalf of a provider that is not the
  // ChatGPT subscription one.
  const cases: [string, ChatGptRegistryIdentity][] = [
    ["wrong template", { ...IDENTITY, templateId: "openai" }],
    ["no template", { ...IDENTITY, templateId: null }],
    ["static key access", { ...IDENTITY, accessType: "api-key" }],
    ["wrong api type", { ...IDENTITY, apiType: "anthropic" }],
    ["attacker host", { ...IDENTITY, baseUrl: "https://attacker.example/v1" }],
    ["nothing at all", { accessType: null, apiType: null, baseUrl: null, templateId: null }],
  ];
  for (const [name, identity] of cases) {
    const { port, storeReads, storeResolutions } = handlerPort({ identity });
    const reasons: string[] = [];
    const response = await answerProviderRequestAuthRequest({
      ...REQUEST,
      port,
      onRefusal: (detail) => reasons.push(detail),
    });
    assert.deepEqual(response, REFUSAL, name);
    assert.deepEqual(reasons, ["registry-identity-rejected"], name);
    assert.equal(storeResolutions(), 0, `${name}: the store must not even be resolved`);
    assert.equal(storeReads(), 0, name);
  }
});

test("a missing identity never reaches the grant store", async () => {
  const { port, storeReads, storeResolutions } = handlerPort({ identity: null });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.deepEqual(response, REFUSAL);
  assert.equal(storeResolutions(), 0);
  assert.equal(storeReads(), 0);
});

test("a throwing identity resolver never reaches the grant store", async () => {
  // A lookup failure is untrusted input, so it is a refusal rather than a pass,
  // and a refusal that happens before the store is resolved.
  const { port, storeReads, storeResolutions } = handlerPort({
    identityError: new Error("registry offline"),
  });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.deepEqual(response, REFUSAL);
  assert.equal(storeResolutions(), 0);
  assert.equal(storeReads(), 0);
});

test("an absent host never reaches a grant store", async () => {
  // The port is built and then deliberately not passed, so the only way its
  // store could be consulted is if some fallback reached past the missing port
  // and resolved one anyway. Nothing does.
  const { storeReads, storeResolutions } = handlerPort();
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port: undefined });
  assert.deepEqual(response, REFUSAL);
  assert.equal(storeResolutions(), 0);
  assert.equal(storeReads(), 0);
});

test("no host port is a refusal, not an anonymous request", async () => {
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port: undefined });
  assert.deepEqual(response, REFUSAL);
});

test("a registry miss never reaches the grant store", async () => {
  const { port, storeReads } = handlerPort({ identity: null });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.deepEqual(response, REFUSAL);
  assert.equal(storeReads(), 0, "reading the grant first would put a secret in memory");
});

test("a throwing identity resolver is treated as untrusted", async () => {
  const { port, storeReads } = handlerPort({ identityError: new Error("registry offline") });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.deepEqual(response, REFUSAL);
  assert.equal(storeReads(), 0);
});

test("a non-ChatGPT identity is refused before the store is consulted", async () => {
  const { port, storeReads, storeResolutions } = handlerPort({
    identity: { ...IDENTITY, templateId: "openai" },
  });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.deepEqual(response, REFUSAL);
  assert.equal(storeResolutions(), 0, "an unverified identity must not reach the store at all");
  assert.equal(storeReads(), 0);
});

test("a missing or throwing grant store is a refusal", async () => {
  assert.deepEqual(
    await answerProviderRequestAuthRequest({ ...REQUEST, port: handlerPort({ store: null }).port }),
    REFUSAL,
  );
  assert.deepEqual(
    await answerProviderRequestAuthRequest({
      ...REQUEST,
      port: handlerPort({ storeError: new Error("locked") }).port,
    }),
    REFUSAL,
  );
});

test("a grant that cannot be projected is a refusal, not a half credential", async () => {
  const { port } = handlerPort({
    store: {
      read: async () => grant({ accountId: null }),
      rotate: async () => ({ grant: null, status: "unlocked" }),
    },
  });
  const response = await answerProviderRequestAuthRequest({ ...REQUEST, port });
  assert.deepEqual(response, REFUSAL);
});

test("every refusal reason reaches the host log and never the caller", async () => {
  const cases = [
    { expected: "host-port-absent", input: { ...REQUEST, port: undefined } },
    {
      expected: "registry-identity-absent",
      input: { ...REQUEST, port: handlerPort({ identity: null }).port },
    },
    {
      expected: "grant-store-absent",
      input: { ...REQUEST, port: handlerPort({ store: null }).port },
    },
  ];
  for (const entry of cases) {
    const reasons: string[] = [];
    const response = await answerProviderRequestAuthRequest({
      ...entry.input,
      onRefusal: (detail) => reasons.push(detail),
    });
    assert.deepEqual(response, REFUSAL, entry.expected);
    assert.deepEqual(reasons, [entry.expected]);
  }
});

test("an unauthorized reason rotates through the handler before answering", async () => {
  const rotates: string[] = [];
  const rotatedToken = makeAccessToken({
    chatgpt_account_id: "acct-fake-0001",
    exp: Math.floor(FIXED_NOW / 1000) + 7200,
  });
  const { port } = handlerPort();
  const response = await answerProviderRequestAuthRequest({
    ...REQUEST,
    port: {
      resolveGrantStore: () => ({
        read: async () => grant(),
        rotate: async (request) => {
          rotates.push(request.expectedRefreshToken);
          return {
            grant: grant({ accessToken: rotatedToken, rotation: 4 }),
            status: "rotated" as const,
          };
        },
      }),
      resolveProviderIdentity: port.resolveProviderIdentity,
    },
    reason: "unauthorized",
  });

  assert.deepEqual(rotates, ["refresh-01"], "the host rotates before it answers");
  assert.equal(response.headersApplied, true);
  if (!response.headersApplied) return;
  assert.equal(
    response.requestAuth.apiKey,
    rotatedToken,
    "the replay must carry the NEW token, not the rejected one",
  );
});
