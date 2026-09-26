/**
 * Host-side request credential for the ChatGPT subscription provider.
 *
 * WHY THE HOST OWNS THIS
 *
 * The agent process never holds a provider secret. It asks the host, over
 * `interaction/requestProviderRuntimeHeaders`, for the credential to use on the
 * next physical request, and the host answers with per-request auth material.
 * That is the only path, and it is why a subscription grant can never end up in
 * a session file, a CLI log, or a model request body.
 *
 * WHY THE IDENTITY IS NOT A CALLER-SUPPLIED STRING
 *
 * `provider-data-schema.ts` has no host allowlist: `baseUrl` is only
 * `z.string().url()`, and a user-defined personal provider may point anywhere
 * under any name. So a credential handler that matched on a provider NAME, a
 * template id the caller chose, or a base URL the caller supplied would send a
 * live subscription grant to whatever host the caller named. The caller of this
 * protocol is the agent process, which is not the user, and "the agent asked" is
 * not authorization.
 *
 * Therefore this module accepts an identity the HOST already resolved out of its
 * own provider registry (`ModelSelectionProviderView.config`, the effective
 * registry config, plus the registry-assigned `templateId`) and demands all three
 * of these before it will read a single byte of the grant:
 *
 *   1. `templateId` is the built-in ChatGPT subscription template, so the
 *      identity came from the shipped catalog rather than from a personal rule,
 *   2. `access.type` is the credential-less OAuth access shape, so this provider
 *      was never given a static key by anyone,
 *   3. `api.baseUrl` is exactly the ChatGPT Codex responses parent, and
 *      `api.type` is `openai-responses`.
 *
 * A caller can put any string it likes in the `providerId` field of the request.
 * That string is only ever a LOOKUP KEY into the host's registry. It becomes a
 * credential-bearing identity only if the registry itself holds a provider under
 * that id whose effective config satisfies all three checks, which means the
 * destination is `https://chatgpt.com/backend-api/codex` by registry fact and not
 * by assertion. Anything else is refused, and a refusal is indistinguishable
 * from "not signed in" on the wire.
 */
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_ORIGINATOR,
} from "#src/oauth/providers/chatgpt/chatgptOAuthConfig.js";
import { isAccessTokenKnownExpired } from "#src/oauth/providers/chatgpt/chatgptAccessTokenClaims.js";
import { buildCodexRequestHeaders } from "#src/oauth/providers/chatgpt/chatgptCodexRequest.js";
import type {
  ProviderRequestAuthGrant,
  ProviderRequestAuthGrantStore,
} from "#src/oauth/providers/providerAdapter.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const log = createServiceLogger("chatgptProviderRequestAuth");

/**
 * The shipped catalog template id for the ChatGPT subscription provider.
 *
 * It is a template identity, not a provider id: the user creates a provider
 * instance from the template and that instance carries whatever id the
 * allocation gives it. Matching on the instance id would be matching on a
 * caller-visible string, which is exactly what this module refuses to do.
 */
export const CHATGPT_SUBSCRIPTION_TEMPLATE_ID = "chatgpt-subscription";

/**
 * The Codex responses PARENT, not `CHATGPT_CODEX_RESPONSES_URL`.
 *
 * The AI SDK's OpenAI responses model calls `url({ path: "/responses" })` and
 * `createOpenAI` defines that as `` `${baseURL}${path}` ``, so the configured
 * base URL must be the parent and the SDK appends `/responses` itself. Both
 * constants are compared here, the parent, because that is the value the
 * registry holds.
 */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Why the host is being asked for a credential. */
export type ChatGptCredentialReason = "model-request" | "unauthorized";

/**
 * The registry-resolved facts about the provider being executed. Every field is
 * read out of the host's own provider registry projection, never out of the
 * request.
 */
export interface ChatGptRegistryIdentity {
  readonly accessType: string | null | undefined;
  readonly apiType: string | null | undefined;
  readonly baseUrl: string | null | undefined;
  readonly templateId: string | null | undefined;
}

export interface ChatGptProviderRequestAuthInput {
  readonly grantStore: ProviderRequestAuthGrantStore;
  readonly identity: ChatGptRegistryIdentity;
  readonly now?: () => number;
  readonly reason: ChatGptCredentialReason;
}

/**
 * Why no credential was attached. Enumerable so a log line can be acted on, and
 * deliberately identical for "refused" and "not signed in" on the wire.
 */
export type ChatGptCredentialRefusal =
  | "registry-identity-rejected"
  | "grant-absent"
  | "grant-incomplete"
  | "grant-revoked";

export type ChatGptProviderRequestAuthResult =
  | {
      readonly ok: true;
      readonly requestAuth: { apiKey: string; headers: Record<string, string> };
    }
  | { readonly ok: false; readonly detail: ChatGptCredentialRefusal };

/**
 * Registry verification, the whole of it.
 *
 * A caller cannot forge any of these three: they are all outputs of the host's
 * provider registry, and the resolver is what turns a personal config overlay
 * into the effective config this reads. In particular `templateId` alone is NOT
 * sufficient, because a personal provider rule is allowed to name a template; the
 * base URL check is what closes that, and it is checked on the EFFECTIVE config,
 * so a personal overlay that redirects the endpoint is caught.
 */
export function isRegistryVerifiedChatGptProvider(identity: ChatGptRegistryIdentity): boolean {
  return (
    identity.templateId === CHATGPT_SUBSCRIPTION_TEMPLATE_ID &&
    identity.accessType === "oauth" &&
    identity.apiType === "openai-responses" &&
    normalizeBaseUrl(identity.baseUrl) === normalizeBaseUrl(CHATGPT_CODEX_BASE_URL)
  );
}

/**
 * Projects a registry provider view onto the identity this module verifies.
 *
 * This is the ONLY place the request's `providerId` is consumed, and it is
 * consumed strictly as a lookup key. The returned facts all come out of the
 * registry's own effective config, so no caller-supplied string ever reaches
 * `isRegistryVerifiedChatGptProvider`. The model id is matched as well, because
 * a provider id alone would let a request name a provider that has the right
 * shape for a DIFFERENT model, which is not the model whose request is running.
 *
 * `null` means "the host registry does not hold that provider/model", which the
 * handler turns into the same refusal as any other unverified identity.
 */
export function resolveChatGptRegistryIdentity(input: {
  readonly modelId: string;
  readonly providerId: string;
  readonly providers: readonly {
    readonly models: readonly { readonly modelId: string }[];
    readonly providerId: string;
    readonly templateId?: string | null;
    readonly config?: {
      readonly access?: { readonly type?: string | null } | null;
      readonly api?: { readonly baseUrl?: string | null; readonly type?: string | null } | null;
    } | null;
  }[];
}): ChatGptRegistryIdentity | null {
  const provider = input.providers.find(
    (candidate) =>
      candidate.providerId === input.providerId &&
      candidate.models.some((model) => model.modelId === input.modelId),
  );
  if (!provider) {
    return null;
  }
  return {
    accessType: provider.config?.access?.type ?? null,
    apiType: provider.config?.api?.type ?? null,
    baseUrl: provider.config?.api?.baseUrl ?? null,
    templateId: provider.templateId ?? null,
  };
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    // A trailing slash is not a different host and must not fail the check, but
    // anything else about the URL is compared verbatim, including the path.
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.hash = "";
    url.search = "";
    return url.toString().toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/u, "").toLowerCase();
  }
}

/**
 * Reads, and if necessary rotates, the grant, then projects it onto the protocol's
 * per-request auth shape.
 *
 * `read()` never refreshes, so the expiry check below is the only reason a
 * rotation happens on the happy path. A rotation is ALWAYS the store's `rotate`,
 * which holds the cross-process lock across the read, the exchange and the write
 * back, and adopts a peer's already-rotated pair instead of replaying a spent
 * refresh token. There is deliberately no second rotation path in this file.
 */
export async function resolveChatGptProviderRequestAuth(
  input: ChatGptProviderRequestAuthInput,
): Promise<ChatGptProviderRequestAuthResult> {
  if (!isRegistryVerifiedChatGptProvider(input.identity)) {
    // Nothing about the request reached this line except a lookup that already
    // failed, so there is nothing sensitive to log and nothing to redact.
    log.warn(undefined, "refused a provider request credential for a non-ChatGPT identity", {
      reason: "registry-identity-rejected",
    });
    return { ok: false, detail: "registry-identity-rejected" };
  }

  const now = input.now ?? Date.now;
  const stored = await input.grantStore.read();
  if (!stored) {
    return { ok: false, detail: "grant-absent" };
  }

  // `unauthorized` means the backend rejected the credential this host just
  // handed out, so the stored pair is spent as far as this host is concerned and
  // has to be exchanged. Rotating more than once per rejected request is
  // impossible: the caller retries the request exactly once.
  const mustRotate =
    input.reason === "unauthorized" || isAccessTokenKnownExpired(stored.accessToken, now());
  if (!mustRotate) {
    return { ok: true, requestAuth: projectGrantToRequestAuth(stored) };
  }

  const rotation = await rotateGrant(input, stored);
  if ("detail" in rotation) {
    return { ok: false, detail: rotation.detail };
  }
  return { ok: true, requestAuth: projectGrantToRequestAuth(rotation.grant) };
}

async function rotateGrant(
  input: ChatGptProviderRequestAuthInput,
  stored: ProviderRequestAuthGrant,
): Promise<{ grant: ProviderRequestAuthGrant } | { detail: ChatGptCredentialRefusal }> {
  try {
    const outcome = await input.grantStore.rotate({
      expectedRefreshToken: stored.refreshToken,
    });
    if (outcome.status === "unlocked" || !outcome.grant) {
      log.warn(undefined, "the local ChatGPT grant vanished during rotation", {
        reason: "grant-incomplete",
      });
      return { detail: "grant-incomplete" };
    }
    return { grant: outcome.grant };
  } catch (error) {
    // A rejected refresh token means the whole ChatGPT token family is gone, so
    // the user has to log in again. Surfacing that as a refusal keeps the agent
    // from retrying against a grant that can never work again.
    log.warn(undefined, "could not rotate the ChatGPT grant for a model request", {
      reason: "grant-revoked",
      message: error instanceof Error ? error.message : String(error),
    });
    return { detail: "grant-revoked" };
  }
}

/**
 * Projects a grant onto the protocol's `requestAuth` shape.
 *
 * `apiKey` carries the access token so the OpenAI provider factory can build its
 * `Authorization: Bearer` header at all: `loadApiKey` in `@ai-sdk/openai` throws
 * when it cannot resolve a key, so a request-scoped credential that arrived only
 * as a header would fail before it was sent. The header set comes from the
 * single canonical builder, minus the two transport headers the AI SDK owns:
 * it sets `content-type` and the streaming `accept` itself, and a static
 * `Accept: text/event-stream` would break the non-streaming request.
 */
export function projectGrantToRequestAuth(grant: {
  readonly accessToken: string;
  readonly accountId: string | null;
}): { apiKey: string; headers: Record<string, string> } {
  const accountId = grant.accountId?.trim() ?? "";
  if (!accountId) {
    // The Codex backend rejects the call without this header, so a grant with no
    // account id is not usable and must not be dressed up as one.
    throw new Error("ChatGPT grant has no chatgpt_account_id");
  }

  // The canonical builder is the single place that knows the exact header names
  // the Codex backend requires; it is asked for them rather than re-spelled here.
  const canonical = buildCodexRequestHeaders(grant.accessToken, accountId);
  const accountHeader = canonical[CHATGPT_ACCOUNT_ID_HEADER];
  const authorization = canonical.Authorization;
  if (!accountHeader || !authorization) {
    throw new Error("ChatGPT Codex request header set is incomplete");
  }
  return {
    apiKey: authorization.replace(/^Bearer /u, ""),
    headers: {
      [CHATGPT_ACCOUNT_ID_HEADER]: accountHeader,
      originator: canonical.originator ?? CHATGPT_ORIGINATOR,
    },
  };
}

/** The host's port for the dynamic credential, or nothing at all. */
export interface ChatGptProviderRequestAuthPort {
  resolveGrantStore(identity: ChatGptRegistryIdentity): ProviderRequestAuthGrantStore | null;
  resolveProviderIdentity(input: {
    readonly modelId: string;
    readonly providerId: string;
  }): Promise<ChatGptRegistryIdentity | null>;
}

export type ChatGptProviderRequestAuthResponse =
  | {
      readonly headersApplied: true;
      readonly requestAuth: { readonly apiKey: string; readonly headers: Record<string, string> };
    }
  | { readonly headersApplied: false; readonly errorMessage: string };

/**
 * The whole `interaction/requestProviderRuntimeHeaders` credential decision.
 *
 * Extracted from the protocol handler so every branch is testable without
 * standing up an agent process. The ORDER is the security property: the registry
 * identity is resolved FIRST, and the grant store is only touched once an
 * identity exists. Reading the grant and then deciding not to use it would pull a
 * live subscription secret into memory on behalf of any caller.
 *
 * Every refusal below returns the SAME payload, because "this identity is not
 * ChatGPT" and "you are not signed in" must not be distinguishable on the wire.
 * The distinct reasons go to the host log, never to the caller.
 */
export async function answerProviderRequestAuthRequest(input: {
  readonly now?: () => number;
  readonly port: ChatGptProviderRequestAuthPort | undefined;
  readonly providerId: string;
  readonly modelId: string;
  readonly reason: ChatGptCredentialReason;
  readonly onRefusal?: (detail: string) => void;
}): Promise<ChatGptProviderRequestAuthResponse> {
  const refuse = (detail: string): ChatGptProviderRequestAuthResponse => {
    input.onRefusal?.(detail);
    return { errorMessage: "Provider request auth is unavailable", headersApplied: false };
  };

  const port = input.port;
  if (!port) {
    return refuse("host-port-absent");
  }

  let identity: ChatGptRegistryIdentity | null;
  try {
    identity = await port.resolveProviderIdentity({
      modelId: input.modelId,
      providerId: input.providerId,
    });
  } catch (error) {
    // A throwing resolver is an untrusted resolver. Never treat a lookup failure
    // as a pass.
    return refuse(
      `identity-resolver-failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!identity) {
    return refuse("registry-identity-absent");
  }

  let grantStore: ProviderRequestAuthGrantStore | null;
  try {
    grantStore = port.resolveGrantStore(identity);
  } catch (error) {
    return refuse(`grant-store-failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!grantStore) {
    return refuse("grant-store-absent");
  }

  let result: ChatGptProviderRequestAuthResult;
  try {
    result = await resolveChatGptProviderRequestAuth({
      grantStore,
      identity,
      ...(input.now ? { now: input.now } : {}),
      reason: input.reason,
    });
  } catch (error) {
    // A grant that cannot be projected (no account id) throws. That is a
    // refusal, not a partially attached credential.
    return refuse(`grant-read-failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!result.ok) {
    return refuse(result.detail);
  }

  return { headersApplied: true, requestAuth: result.requestAuth };
}
