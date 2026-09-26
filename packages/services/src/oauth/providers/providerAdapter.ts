import type {
  ApiClient,
  OAuthCallbackParams,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";

/** Provider 执行上下文 */
export interface OAuthProviderContext {
  providerId: OAuthProviderId;
  state: string;
  redirectUri: string;
  now: () => number;
}

/** OAuth provider 适配器：隔离协议差异 */
export interface OAuthProviderAdapter {
  readonly providerId: OAuthProviderId;
  readonly meta: OAuthProviderMeta;
  readonly redirectUri: string;
  readonly apiClient: ApiClient;

  parseCallbackParams(url: string): OAuthCallbackParams;
  buildAuthorizeUrl(context: OAuthProviderContext): string;
  exchangeToken(params: OAuthCallbackParams, context: OAuthProviderContext): Promise<OAuthTokenSet>;
  /** 将后端 polling 返回的 provider token 归一化为 Desktop 持久化语义。 */
  normalizePolledTokenSet?(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet>;
  fetchUserInfo?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthUserProfile>;
  refreshToken?(tokenSet: OAuthTokenSet, context: OAuthProviderContext): Promise<OAuthTokenSet>;

  /** provider 级 legacy 凭据读取（用于升级兼容） */
  loadLegacyTokenSet?(
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null>;

  normalizeError(error: unknown): Error;
}

/**
 * An app-owned provider grant, as the model request path needs to see it.
 *
 * Structurally the adapter's own stored grant; keeping it here is what lets the
 * host credential handler stay vendor-neutral while still failing closed on a
 * grant it does not understand.
 */
export interface ProviderRequestAuthGrant {
  readonly accessToken: string;
  /** The routing id the provider requires as a request header, when it has one. */
  readonly accountId: string | null;
  readonly expiresAt: number | null;
  readonly refreshToken: string;
  readonly rotation: number;
  readonly updatedAt: number;
}

/**
 * Read/rotate access to an app-owned grant.
 *
 * There is deliberately no `exchange` seam: the token endpoint is pinned inside
 * the adapter that implements this, so nothing on the credential path can
 * substitute an exchange and therefore nothing on it can be pointed at another
 * authorization server. Rotation still runs through the adapter's own store, so
 * its cross-process lock and peer-rotated adoption branch apply unchanged.
 */
export interface ProviderRequestAuthGrantStore {
  read(): Promise<ProviderRequestAuthGrant | null>;
  rotate(request: { expectedRefreshToken: string }): Promise<{
    grant: ProviderRequestAuthGrant | null;
    status: "rotated" | "adopted" | "unlocked";
  }>;
}

/**
 * Optional adapter capability: this provider's credential is an app-owned grant
 * that the host may project onto a single model request.
 *
 * The shared ZCode backend adapters deliberately do NOT implement it. The zcode
 * JWT is a session credential for one backend, not a provider credential, and it
 * already has its own 401 handling (`isCurrentOAuthCredentialRequest`); handing
 * it out per request would be a second, unaudited copy of a session token.
 */
export interface ProviderRequestAuthGrantStoreCapability {
  createRequestAuthGrantStore(): ProviderRequestAuthGrantStore;
}
