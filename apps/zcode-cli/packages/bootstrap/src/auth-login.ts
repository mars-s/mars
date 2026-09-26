import {
  createSharedZCodeCredentialStore,
  createCliOAuthClient,
  createCliOAuthPollToken,
  openUrlInBrowser,
  LEGACY_VENDOR_CREDENTIAL_KEYS,
  sharedZCodeProviderCredentialKeys,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type BrowserOpenResult,
  type SharedZCodeCredentialStore,
  type CliOAuthClient,
  type CliOAuthInitData,
  type CliOAuthPollData,
  type CliOAuthProviderId,
  type CliOAuthUser,
} from "@zcode/adapters";
import { createConfig } from "@zcode/adapters/config";
import { createNodeHttpClientAdapter } from "@zcode/adapters/http";
import type { EnvRecord } from "@zcode/adapters/model";
import { buildZCodeEndpointUrls, resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";
import { setTimeout as delay } from "node:timers/promises";
import { pollUntilReady } from "./auth-login-polling.js";

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;

export interface LoginZCodeCliOptions {
  /**
   * Provider namespace the operator's ZCode backend mints the access token
   * under. Required and unvalidated beyond shape: the backend owns the
   * vocabulary, so the CLI must not ship a default that names a vendor.
   */
  providerId: CliOAuthProviderId;
  abortSignal?: AbortSignal;
  baseUrl?: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  httpClient?: Parameters<typeof createCliOAuthClient>[0]["httpClient"];
  noBrowser?: boolean;
  now?: () => number;
  onAuthorizeUrl?: (data: CliOAuthInitData) => void | Promise<void>;
  onBrowserOpen?: (result: BrowserOpenResult) => void | Promise<void>;
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  openBrowser?: (url: string) => Promise<BrowserOpenResult>;
  pollToken?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface LoginZCodeCliResult {
  browser?: BrowserOpenResult;
  credentialsPath: string;
  providerId: CliOAuthProviderId;
  user: CliOAuthUser;
}

export interface LogoutZCodeCliOptions {
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
}

export interface LogoutZCodeCliResult {
  credentialsPath: string;
}

export class ZCodeCliLoginError extends Error {
  readonly code:
    | "auth_failed"
    | "auth_timeout"
    | "config_update_failed"
    | "credential_write_failed";

  constructor(
    code: ZCodeCliLoginError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliLoginError";
    this.code = code;
  }
}

export async function loginZCodeCli(options: LoginZCodeCliOptions): Promise<LoginZCodeCliResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadlineMs = now() + timeoutMs;
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = () =>
    new ZCodeCliLoginError("auth_timeout", "Authorization timed out. Please retry login.");
  let timer = setTimeout(() => timeoutController.abort(timeoutError()), timeoutMs);
  try {
    throwIfAborted(signal);
    const pollToken = options.pollToken ?? createCliOAuthPollToken();
    const credentialStore = options.credentialStore ?? createSharedZCodeCredentialStore({ env });
    const oauthClient = createOAuthClient(options, env);
    const initData = await waitWithAbort(oauthClient.init({ pollToken }, { signal }), signal);
    const remainingMs = Math.min(deadlineMs, initData.expires_at * 1_000) - now();
    if (remainingMs <= 0) throw timeoutError();
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(timeoutError()), remainingMs);
    await options.onAuthorizeUrl?.(initData);
    throwIfAborted(signal);
    const browser = options.noBrowser
      ? undefined
      : await waitWithAbort(
          (options.openBrowser ?? openUrlInBrowser)(initData.authorize_url),
          signal,
        );
    if (browser) await options.onBrowserOpen?.(browser);
    const readyData = await pollUntilReady({
      abortSignal: signal,
      initData,
      now,
      oauthClient,
      onPollStatus: options.onPollStatus,
      pollToken,
      sleep: options.sleep ?? ((ms) => delay(ms, undefined, { signal })),
      timeoutMs: Math.max(0, deadlineMs - now()),
      createError: (code) =>
        code === "auth_timeout"
          ? timeoutError()
          : new ZCodeCliLoginError(code, "Authorization failed. Please retry login."),
    });
    // A cancelled/expired attempt must not persist a late ready response.
    throwIfAborted(signal);
    try {
      await clearSupersededProviderCredentials(credentialStore, readyData.providerId);
      await credentialStore.saveMany(
        buildLoginCredentials(readyData.providerId, {
          accessToken: readyData.accessToken,
          jwtToken: readyData.token,
          user: readyData.user,
          ...(readyData.refreshToken ? { refreshToken: readyData.refreshToken } : {}),
        }),
      );
    } catch (error) {
      throw new ZCodeCliLoginError(
        "credential_write_failed",
        "Login succeeded but writing credentials failed.",
        { cause: error },
      );
    }
    throwIfAborted(signal);
    return {
      ...(browser ? { browser } : {}),
      credentialsPath: credentialStore.filePath,
      providerId: readyData.providerId,
      user: readyData.user,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function logoutZCodeCli(
  options: LogoutZCodeCliOptions = {},
): Promise<LogoutZCodeCliResult> {
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  // The active provider namespace is derived from whatever is on disk rather
  // than from a provider catalog, so a logout still clears a namespace no
  // shipped catalog declares.
  const activeProvider = (
    await credentialStore.load(SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider)
  )?.trim();
  const activeProviderKeys = activeProvider
    ? Object.values(sharedZCodeProviderCredentialKeys(activeProvider))
    : [];
  const keys = [
    ...Object.values(SHARED_ZCODE_CREDENTIAL_KEYS),
    ...LEGACY_VENDOR_CREDENTIAL_KEYS,
    ...activeProviderKeys,
  ];
  const current = await credentialStore.loadMany(keys);
  await credentialStore.deleteIfValues(
    Object.fromEntries(
      Object.entries(current).flatMap(([key, value]) => (value === null ? [] : [[key, value]])),
    ),
  );
  return {
    credentialsPath: credentialStore.filePath,
  };
}

/**
 * Drop the previous provider's token namespace when the new login switches
 * provider, so a superseded access token does not sit unreadable in the
 * credentials file indefinitely. The active provider key is the guard, so a
 * login that landed in between is left alone rather than half-cleared.
 */
async function clearSupersededProviderCredentials(
  credentialStore: SharedZCodeCredentialStore,
  providerId: CliOAuthProviderId,
): Promise<void> {
  const activeProviderKey = SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider;
  const previousProvider = (await credentialStore.load(activeProviderKey))?.trim();
  if (!previousProvider || previousProvider === providerId) return;
  await credentialStore.deleteManyIfValue(
    activeProviderKey,
    previousProvider,
    Object.values(sharedZCodeProviderCredentialKeys(previousProvider)),
  );
}

/**
 * The token set the operator's backend handed back, in the same key scheme the
 * desktop OAuth repo reads. The caller clears any superseded namespace first.
 */
function buildLoginCredentials(
  providerId: CliOAuthProviderId,
  ready: { accessToken: string; jwtToken: string; user: CliOAuthUser; refreshToken?: string },
): Readonly<Record<string, string>> {
  const providerKeys = sharedZCodeProviderCredentialKeys(providerId);
  const user = ready.user;
  const displayName = user.name || user.email || user.user_id;
  return {
    [SHARED_ZCODE_CREDENTIAL_KEYS.activeProvider]: providerId,
    [SHARED_ZCODE_CREDENTIAL_KEYS.zcodeJwtToken]: ready.jwtToken,
    [providerKeys.accessToken]: ready.accessToken,
    ...(ready.refreshToken ? { [providerKeys.refreshToken]: ready.refreshToken } : {}),
    [providerKeys.userInfo]: JSON.stringify({
      id: user.user_id,
      username: displayName,
      displayName,
      rawProfile: user,
    }),
  };
}

function createOAuthClient(options: LoginZCodeCliOptions, env: EnvRecord): CliOAuthClient {
  return createCliOAuthClient({
    baseUrl:
      options.baseUrl ?? buildZCodeEndpointUrls(resolveCliZCodeEndpointOrigin(env)).apiBaseUrl,
    providerId: options.providerId,
    httpClient: options.httpClient ?? createDefaultHttpClient(env),
  });
}

function resolveCliZCodeEndpointOrigin(env: EnvRecord): string {
  return resolveRuntimeZCodeEndpointOrigin(env);
}

function createDefaultHttpClient(env: EnvRecord) {
  const config = createConfig({ env });
  return createNodeHttpClientAdapter({
    env,
    proxyUrl: config.config.network.httpProxy,
    noProxy: config.config.network.noProxy,
    caCertFile: config.config.network.caCertFile,
    timeoutMs: config.config.network.timeout,
  });
}
