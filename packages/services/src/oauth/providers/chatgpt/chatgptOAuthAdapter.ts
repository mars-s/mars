/**
 * ChatGPT subscription OAuth provider adapter.
 *
 * Default flow: device code (RFC 8628). No loopback listener is required, so the
 * app never has to bind the fixed port 1455 that the authorization-code flow
 * would demand, and therefore cannot collide with the owner running another
 * ChatGPT client at the same time.
 *
 * The adapter keeps its own grant in an app-owned store and rotates it under a
 * cross-process lock; see chatgptGrantStore.ts for why that lock is mandatory.
 */
import { join } from "node:path";
import {
  ApiError,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { createServiceLogger } from "../../../logger/serviceLogger.js";
import { getAppConfigDir } from "../../../paths.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "../providerAdapter.js";
import {
  CHATGPT_AUTH_METADATA_URL,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_DEVICE_CODE_GRANT_TYPE,
  CHATGPT_LOOPBACK_REDIRECT_URI,
  CHATGPT_OAUTH_PROVIDER_ID,
  CHATGPT_OAUTH_SCOPE,
  CHATGPT_ORIGINATOR,
  CHATGPT_PUBLIC_CLIENT_ID,
} from "./chatgptOAuthConfig.js";
import { generatePkcePair, isValidPkceVerifier, type PkcePair } from "./chatgptPkce.js";
import {
  readAccessTokenExpiration,
  readAccessTokenSubject,
  readChatgptAccountId,
} from "./chatgptAccessTokenClaims.js";
import {
  createChatGptClient,
  readTokenGrant,
  ChatGptDeviceFlowTerminalError,
  type ChatGptClientOptions,
  type ChatGptDeviceCodeClient,
  type ChatGptTokenGrant,
} from "./chatgptDeviceFlow.js";
import {
  ChatGptDeviceFlowSession,
  type ChatGptDeviceFlowCapability,
} from "./chatgptDeviceFlowSession.js";
import type { ProviderSessionTeardownCapability } from "./chatgptSessionTeardown.js";
import { ChatGptGrantRevokedError, ChatGptGrantStore } from "./chatgptGrantStore.js";

const log = createServiceLogger("chatgptOAuth");

/** Used only when a token carries neither an account id nor a subject claim. */
const UNKNOWN_ACCOUNT_ID = "unknown";

export interface ChatGptOAuthAdapterOptions {
  readonly client?: ChatGptDeviceCodeClient;
  readonly clientOptions?: ChatGptClientOptions;
  readonly grantStorePath?: string;
  readonly now?: () => number;
  /** Injection seam for tests; production uses the platform fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

function defaultGrantStorePath(): string {
  return join(getAppConfigDir(), "chatgpt", "oauth-grant.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

class FetchApiClient implements ApiClient {
  constructor(private readonly fetchImpl: typeof globalThis.fetch) {}

  request(input: string | URL, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(input, init);
  }
}

export class ChatGptOAuthAdapter
  implements OAuthProviderAdapter, ChatGptDeviceFlowCapability, ProviderSessionTeardownCapability
{
  readonly supportsDeviceCodeFlow = true as const;

  readonly providerId = CHATGPT_OAUTH_PROVIDER_ID;
  /**
   * Frozen seam field. The device-code default never hands a redirect URI to a
   * browser; this is the registered loopback URI and is only used by the
   * authorization-code request, which is an opt-in fallback.
   */
  readonly redirectUri = CHATGPT_LOOPBACK_REDIRECT_URI;
  readonly apiClient: ApiClient;

  readonly meta = {
    id: CHATGPT_OAUTH_PROVIDER_ID,
    displayName: "ChatGPT",
    enabled: true,
    order: 0,
    // This provider authenticates against its own issuer and issues no shared
    // ZCode backend JWT, so the startup session gate must not require one.
    sessionKind: "provider-token",
  } as const;

  private readonly client: ChatGptDeviceCodeClient;
  private readonly deviceFlow: ChatGptDeviceFlowSession;
  private readonly grantStore: ChatGptGrantStore;
  private readonly now: () => number;
  private readonly pkceByState = new Map<string, PkcePair>();

  constructor(options: ChatGptOAuthAdapterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.apiClient = new FetchApiClient(options.fetchImpl ?? globalThis.fetch);
    this.client = options.client ?? createChatGptClient(options.clientOptions);
    this.grantStore = new ChatGptGrantStore({
      storePath: options.grantStorePath ?? defaultGrantStorePath(),
      now: this.now,
    });
    this.deviceFlow = new ChatGptDeviceFlowSession({
      client: this.client,
      now: this.now,
      redirectUri: CHATGPT_LOOPBACK_REDIRECT_URI,
      toTokenSet: (grant) => this.persistGrant(grant),
    });
  }

  // ---------------------------------------------------------------- device code

  peekDeviceFlow(): ReturnType<ChatGptDeviceFlowSession["peekDeviceFlow"]> {
    return this.deviceFlow.peekDeviceFlow();
  }

  cancelDeviceFlow(state: string): void {
    this.deviceFlow.cancelDeviceFlow(state);
  }

  startDeviceFlow(state: string): ReturnType<ChatGptDeviceFlowSession["startDeviceFlow"]> {
    return this.deviceFlow.startDeviceFlow(state);
  }

  pollDeviceFlow(state: string): ReturnType<ChatGptDeviceFlowSession["pollDeviceFlow"]> {
    return this.deviceFlow.pollDeviceFlow(state);
  }

  // ---------------------------------------------------------- frozen interface

  parseCallbackParams(url: string): OAuthCallbackParams {
    const parsed = new URL(url);
    const code = readTrimmedString(parsed.searchParams.get("code"));
    const state = readTrimmedString(parsed.searchParams.get("state"));
    if (!code || !state) {
      const error = readTrimmedString(parsed.searchParams.get("error"));
      throw new Error(
        error
          ? `ChatGPT authorization was refused: ${error}`
          : "ChatGPT callback is missing the authorization code",
      );
    }

    return { code, state };
  }

  buildAuthorizeUrl(context: OAuthProviderContext): string {
    const pkce = generatePkcePair();
    // The verifier must survive until the callback arrives; it is the only thing
    // binding the redirect back to this process's authorization request.
    this.pkceByState.set(context.state, pkce);
    const url = new URL(CHATGPT_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CHATGPT_PUBLIC_CLIENT_ID);
    url.searchParams.set("redirect_uri", context.redirectUri);
    url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
    url.searchParams.set("state", context.state);
    url.searchParams.set("code_challenge", pkce.codeChallenge);
    url.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);
    return url.toString();
  }

  async exchangeToken(
    params: OAuthCallbackParams,
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    const pkce = this.pkceByState.get(params.state);
    if (!pkce || !isValidPkceVerifier(pkce.codeVerifier)) {
      throw new Error("ChatGPT authorization request is no longer valid, please retry");
    }
    // Single use: an authorization code can only be exchanged once, so keeping
    // the verifier would let a duplicate callback replay it.
    this.pkceByState.delete(params.state);

    const payload = await this.client.requestToken({
      grantType: "authorization_code",
      code: params.code,
      codeVerifier: pkce.codeVerifier,
      redirectUri: context.redirectUri || this.redirectUri,
    });
    return this.persistGrant(readTokenGrant(payload));
  }

  async fetchUserInfo(tokenSet: OAuthTokenSet): Promise<OAuthUserProfile> {
    // The account id is a token claim, not a token-endpoint field. Reading it
    // from the access token is the only way to obtain the header the backend
    // requires.
    const accountId = readChatgptAccountId(tokenSet.accessToken);
    const subject = readAccessTokenSubject(tokenSet.accessToken);
    const plan = await this.fetchPlanType(tokenSet.accessToken);

    const id = accountId ?? subject ?? UNKNOWN_ACCOUNT_ID;
    return {
      id,
      username: subject ?? id,
      displayName: plan ? `ChatGPT (${plan})` : "ChatGPT",
      ...(plan ? { rawProfile: { chatgpt_account_id: accountId, chatgpt_plan_type: plan } } : {}),
    };
  }

  /**
   * Rotates the grant under the cross-process lock.
   *
   * `expectedRefreshToken` is the token this process believes is current. If a
   * peer rotated first, the store answers `adopted` with that peer's pair and no
   * refresh token is submitted, so a race can never revoke the token family.
   */
  async refreshToken(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    const refreshToken = tokenSet.refreshToken?.trim();
    if (!refreshToken) {
      throw new ChatGptDeviceFlowTerminalError(
        "missing_refresh_token",
        "This ChatGPT session cannot be refreshed, please log in again",
      );
    }

    const outcome = await this.grantStore.rotate({
      expectedRefreshToken: refreshToken,
      exchange: async () => {
        const payload = await this.client.requestToken({
          grantType: "refresh_token",
          refreshToken,
        });
        const grant = readTokenGrant(payload);
        return {
          accessToken: grant.accessToken,
          expiresAt: grant.expiresInSeconds
            ? this.now() + grant.expiresInSeconds * 1_000
            : readAccessTokenExpiration(grant.accessToken),
          refreshToken: grant.refreshToken,
        };
      },
    });

    if (outcome.status === "unlocked" || !outcome.grant) {
      throw new ChatGptDeviceFlowTerminalError(
        "missing_grant",
        "The local ChatGPT grant is gone, please log in again",
      );
    }
    if (outcome.status === "adopted") {
      log.info(undefined, "adopted a ChatGPT grant a peer process already rotated", {
        rotation: outcome.grant.rotation,
      });
    }
    return toTokenSet(outcome.grant);
  }

  /**
   * Upgrade path: adopt a grant this app already owns.
   *
   * Only this app's own store is consulted. No other application's store is ever
   * read, because sharing a single-use refresh token across two clients is how
   * they end up revoking each other's access.
   */
  async loadLegacyTokenSet(): Promise<OAuthTokenSet | null> {
    const grant = await this.grantStore.read();
    return grant ? toTokenSet(grant) : null;
  }

  /**
   * Drop the app-owned grant on sign-out.
   *
   * The shared credential store is cleared by the service; this grant lives in
   * its own file, so an explicit logout that left it behind would keep a working
   * refresh token on disk after the user asked to be signed out.
   */
  async clearProviderSessionSecrets(): Promise<void> {
    await this.grantStore.clear();
    log.info(undefined, "cleared the local ChatGPT grant");
  }

  normalizeError(error: unknown): Error {
    if (
      error instanceof ChatGptDeviceFlowTerminalError ||
      error instanceof ChatGptGrantRevokedError
    ) {
      return new Error(error.message, { cause: error });
    }
    if (error instanceof ApiError) {
      return new Error(`ChatGPT sign-in failed (HTTP ${error.status ?? "?"}): ${error.message}`, {
        cause: error,
      });
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error(`ChatGPT sign-in failed: ${String(error)}`, { cause: error });
  }

  // ----------------------------------------------------------------- internals

  private async persistGrant(grant: ChatGptTokenGrant): Promise<OAuthTokenSet> {
    const stored = await this.grantStore.write({
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      // Taken from the token, because the token endpoint never returns it.
      accountId: readChatgptAccountId(grant.accessToken),
      expiresAt: grant.expiresInSeconds
        ? this.now() + grant.expiresInSeconds * 1_000
        : readAccessTokenExpiration(grant.accessToken),
    });
    return toTokenSet(stored);
  }

  private async fetchPlanType(accessToken: string): Promise<string | null> {
    try {
      const response = await this.apiClient.request(CHATGPT_AUTH_METADATA_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          originator: CHATGPT_ORIGINATOR,
        },
      });
      if (!response.ok) {
        return null;
      }
      const payload = await readJsonRecord(response);
      return (
        readTrimmedString(payload.chatgpt_plan_type) ??
        readTrimmedString(payload.plan_type) ??
        readTrimmedString(payload.plan)
      );
    } catch (error) {
      // Plan metadata is decoration. Losing it must never fail a valid login.
      log.info(undefined, "ChatGPT plan metadata is unavailable", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function toTokenSet(grant: {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string;
}): OAuthTokenSet {
  return {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken,
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
  };
}

export { CHATGPT_DEVICE_CODE_GRANT_TYPE };
