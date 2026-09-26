/**
 * ChatGPT subscription backend (Codex responses) request wrapper.
 *
 * Two protocol requirements of the subscription backend are handled here, and
 * both are facts about that backend rather than preferences:
 *
 * 1. The body must carry `store: false`. The plain SDK responses factory does not
 *    send it: `store` is `openaiOptions.store` in `@ai-sdk/openai`, it is
 *    `nullish` in the options schema, and undefined entries are stripped before
 *    the body is serialized. The backend rejects a request that omits it. It is
 *    injected by rewriting the outgoing JSON body rather than through
 *    `providerOptions`, because a body rewrite survives an SDK upgrade that
 *    renames or reorders the provider options.
 *
 * 2. A 401 means the access token this host just handed out is spent, so the
 *    request is rotated and replayed ONCE. A plain retry would present the same
 *    rejected token and fail identically; the old 401 path
 *    (`isCurrentOAuthCredentialRequest`) only matches the shared ZCode backend
 *    JWT, which an OAuth token never matches, so it never fires here.
 *
 * The rotation is the host's, reached through the same per-attempt port every
 * other request-level credential uses, with `reason: "unauthorized"`. The host
 * holds the cross-process lock across the read, the token exchange and the write
 * back, so a replay can never submit an already-spent refresh token. Exactly one
 * replay happens per request because the replay flag is local to this closure; a
 * second 401 is returned to the caller.
 *
 * WHY THE REPLAY RE-RUNS THE DESTINATION CHECK
 *
 * The replay asks the host for a fresh credential and attaches it to a URL that
 * was already chosen, so it needs the same guarantee as the first attempt: the
 * host must have verified the destination the bytes actually go to. Activation
 * already keys off the frozen base URL, which makes a mismatch unreachable with
 * today's wiring, but "unreachable because of how it happens to be wired" is not
 * a property worth leaving implicit. See `request-auth-endpoint.ts`.
 */
import { getCurrentModelInvocationContext, type ModelRequestAuth } from "@zcode/contracts";
import { CHATGPT_CODEX_BASE_URL, normalizeProviderBaseUrl } from "@zcode/shared";
import { assertCredentialEndpointApproved } from "./request-auth-endpoint.js";

type ProviderFetch = typeof globalThis.fetch;

const JSON_CONTENT_TYPE = "application/json";

/**
 * Whether this resolved registry config is the ChatGPT Codex backend.
 *
 * Both inputs are registry facts, never request-supplied strings: `baseURL` came
 * out of the effective provider config and `accessType` out of the effective
 * access shape. Activation therefore cannot be triggered by anything the caller
 * sends, only by what the registry resolved.
 *
 * The comparison runs the same normalizer the host does, out of the same shared
 * constant, so "is this the Codex endpoint" cannot mean one thing here and
 * another there.
 */
export function isChatGptCodexBackend(input: {
  accessType: string | null | undefined;
  baseUrl: string | null | undefined;
}): boolean {
  return (
    input.accessType === "oauth" &&
    normalizeProviderBaseUrl(input.baseUrl) === normalizeProviderBaseUrl(CHATGPT_CODEX_BASE_URL)
  );
}

/**
 * Rewrites the outgoing body to carry `store: false`, and replays a 401 exactly
 * once with a freshly rotated credential.
 *
 * The provider and model ids are the resolved ones, not request-supplied, because
 * the host looks the credential's provider identity up by id in its own registry
 * and refuses anything it does not recognise. A replay that sent an empty id
 * would therefore be refused and the 401 would surface unrotated.
 *
 * `requestBaseUrl` is the base URL of the model this wrapper was built for, which
 * is the destination of both the original attempt and the replay. The host's
 * verified destination is checked against it before the rotated credential is
 * attached, and a mismatch refuses instead of replaying.
 */
export function createChatGptCodexResponsesFetch(baseFetch: ProviderFetch, identity: {
  readonly modelId: string;
  readonly providerId: string;
  readonly requestBaseUrl: string;
}): ProviderFetch {
  let replayed = false;
  return async (input, init) => {
    const attempt = withStoreDisabled(init);
    const response = await baseFetch(input, attempt);
    if (response.status !== 401 || replayed) {
      return response;
    }
    replayed = true;

    // Nothing in the per-attempt port means no host is on the other end of this
    // request. A 401 is then a real 401 and must reach the caller, not be retried
    // forever with the same rejected token.
    const refresh = getCurrentModelInvocationContext()?.refreshRuntimeHeadersBeforeAttempt;
    if (!refresh) {
      return response;
    }

    // `attempt` is the replay's own ordinal within this physical request, not the
    // runner's attempt counter: the host uses it only for logging, and the runner's
    // counter is not visible from inside the fetch.
    const rotated = await refresh({
      attempt: 1,
      reason: "unauthorized",
      ...(init?.signal ? { abortSignal: init.signal } : {}),
      providerId: identity.providerId,
      modelId: identity.modelId,
    });
    if (!rotated.headersApplied || !rotated.requestAuth) {
      return response;
    }
    assertCredentialEndpointApproved({
      approvedBaseUrl: rotated.approvedBaseUrl,
      providerId: identity.providerId,
      requestBaseUrl: identity.requestBaseUrl,
    });

    // The body of the rejected attempt is never read, so it is released before the
    // replay: an unread SSE body would hold the connection open.
    await discardBody(response);
    return baseFetch(input, applyRequestAuth(attempt, rotated.requestAuth));
  };
}

function withStoreDisabled(init: RequestInit | undefined): RequestInit {
  const body = init?.body;
  // Only a JSON body can carry `store`. A stream, a FormData body or an absent
  // body is left exactly as the SDK produced it.
  if (typeof body !== "string" || !isJsonRequest(init)) {
    return init ?? {};
  }
  const parsed = parseJsonObject(body);
  if (!parsed || parsed.store === false) {
    return init ?? {};
  }
  return { ...init, body: JSON.stringify({ ...parsed, store: false }) };
}

function isJsonRequest(init: RequestInit | undefined): boolean {
  const headers = new Headers(init?.headers);
  const contentType = headers.get("content-type");
  return contentType === null || contentType.toLowerCase().includes(JSON_CONTENT_TYPE);
}

function applyRequestAuth(init: RequestInit, requestAuth: ModelRequestAuth): RequestInit {
  const headers = new Headers(init.headers);
  if (requestAuth.apiKey) {
    headers.set("authorization", `Bearer ${requestAuth.apiKey}`);
  }
  for (const [name, value] of Object.entries(requestAuth.headers ?? {})) {
    headers.set(name, value);
  }
  return { ...init, headers };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body that cannot be cancelled is not a reason to skip the replay.
  }
}

function parseJsonObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
