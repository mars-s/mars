import type { ZCodeEnv } from "./env.js";

/**
 * There is no built-in vendor endpoint. These stay exported (many packages import
 * them) but every value is the empty string, which means "not configured": the
 * resolve* and build* functions below then return an empty string and the caller
 * fails at the point of use. Nothing throws for an absent origin, because callers
 * evaluate these at module scope and a throw there is a dead app rather than a
 * readable error. Never restore a vendor host here.
 *
 * The deployment contract is: set ZCODE_BASE_URL (or ZCODE_ENDPOINT_ORIGIN),
 * BIGMODEL_API_BASE_URL, ZAI_OAUTH_ORIGIN and ZAI_BUSINESS_BASE_URL in the
 * operator environment. An unconfigured build is expected to fail remote
 * features, which is the intended state, not a regression.
 */
export const DEFAULT_ZCODE_ENDPOINT_ORIGIN = "";
export const DEFAULT_BIGMODEL_API_ORIGIN = "";
export const DEFAULT_ZAI_OAUTH_ORIGIN = "";
export const DEFAULT_ZAI_BUSINESS_BASE_URL = "";
/**
 * The vendor OAuth client id is not a secret, but it is vendor-issued identity
 * rather than configuration, so it is not shipped as a default either. A self
 * hosted deployment supplies its own client id via ZAI_OAUTH_CLIENT_ID or
 * ZAI_OAUTH_APP_ID. The vendor issued value paired with a vendor OAuth host, and
 * the host is gone, so keeping the id would authenticate as somebody else's app.
 */
export const DEFAULT_ZAI_OAUTH_CLIENT_ID = "";

// 构建仅注入公开链接；Node 调用方仍可显式传 env，避免读取另一进程的配置。
declare const __ZCODE_ENDPOINT_ENV__: Record<string, string | undefined> | undefined;
export function pickProductEndpointEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const keys = [
    "ZCODE_BASE_URL",
    "ZCODE_ENDPOINT_ORIGIN",
    "BIGMODEL_API_BASE_URL",
    "ZAI_OAUTH_ORIGIN",
    "ZAI_BUSINESS_BASE_URL",
    "ZAI_OAUTH_CLIENT_ID",
    "ZAI_OAUTH_APP_ID",
  ];
  return Object.fromEntries(
    keys.flatMap((key) => (env[key]?.trim() ? [[key, env[key]!.trim()]] : [])),
  );
}
export function readProductEndpointEnv(): Record<string, string | undefined> {
  return {
    ...(typeof __ZCODE_ENDPOINT_ENV__ === "undefined" ? {} : __ZCODE_ENDPOINT_ENV__),
    ...pickProductEndpointEnv(typeof process === "undefined" ? {} : process.env),
  };
}

export interface ZCodeEndpointUrls {
  origin: string;
  apiBaseUrl: string;
  webShareCallbackUrl: string;
  zcodePlanOpenAiBaseUrl: string;
  zcodePlanAnthropicBaseUrl: string;
  zcodePlanBillingCurrentUrl: string;
  zcodePlanBillingBalanceUrl: string;
}

export interface RuntimeZCodeEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZCODE_BASE_URL?: string;
  ZCODE_ENDPOINT_ORIGIN?: string;
}

export interface RuntimeBigModelApiEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  BIGMODEL_API_BASE_URL?: string;
}

export interface RuntimeZaiEndpointEnv {
  [key: string]: string | undefined;
  ZCODE_ENV?: string;
  ZAI_OAUTH_ORIGIN?: string;
  ZAI_BUSINESS_BASE_URL?: string;
  ZAI_OAUTH_CLIENT_ID?: string;
  ZAI_OAUTH_APP_ID?: string;
}

export interface RuntimeProductEndpointEnv
  extends RuntimeZCodeEndpointEnv, RuntimeBigModelApiEnv, RuntimeZaiEndpointEnv {}

export interface RuntimeProductEndpointConfig {
  zcodeEnv: ZCodeEnv;
  zcodeEndpointOrigin: string;
  zcodeEndpointUrls: ZCodeEndpointUrls;
  zaiOAuthOrigin: string;
  zaiBusinessBaseUrl: string;
  zaiOAuthClientId: string;
  bigModelApiOrigin: string;
}

function readRuntimeEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * Normalizes a value that is allowed to be absent. An empty value means "not
 * configured" and stays empty; a value that is present but malformed still throws
 * from normalizeZCodeEndpointOrigin. Nothing here throws for an absent origin:
 * several packages evaluate the build* helpers at module scope, so throwing would
 * break the import and with it the whole app, instead of failing the one feature
 * that needs the endpoint.
 */
function normalizeOptionalOrigin(value: string): string {
  return value.trim() ? normalizeZCodeEndpointOrigin(value) : "";
}

export function normalizeZCodeEndpointOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("ZCode endpoint origin is empty");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("ZCode endpoint origin must use http or https");
  }
  return parsed.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isTrustedCodingPlanWebviewOrigin(
  value: string | null | undefined,
  options?: {
    e2eStoreBridgeEnabled?: boolean;
  },
): boolean {
  if (!value) return false;
  try {
    const origin = normalizeZCodeEndpointOrigin(value);
    // Fails closed: with no built-in default there is nothing to match, and an
    // unconfigured runtime origin is "" which can never equal a parsed origin.
    // The only remaining paths are an explicitly configured runtime origin and
    // the opt-in loopback case for the e2e store bridge.
    const builtInOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN.trim();
    if (
      (builtInOrigin !== "" && origin === builtInOrigin) ||
      origin === resolveRuntimeZCodeEndpointOrigin()
    ) {
      return true;
    }
    const parsed = new URL(origin);
    return options?.e2eStoreBridgeEnabled === true && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function resolveZCodeEndpointOrigin(options?: {
  env?: ZCodeEnv;
  envBaseOrigin?: string | null;
  overrideOrigin?: string | null;
}): string {
  const origin = options?.overrideOrigin?.trim() || options?.envBaseOrigin?.trim();
  // Unconfigured resolves to the empty string rather than a vendor host. Callers
  // that need a real URL go through buildZCodeEndpointUrls, which fails loudly.
  return origin ? normalizeZCodeEndpointOrigin(origin) : "";
}

export function resolveRuntimeZCodeEnv(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEnv {
  // 产品身份仅用于既有展示与安装标识，不参与地址解析。
  return env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production";
}

export function resolveRuntimeZCodeEndpointOrigin(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  options?: { overrideOrigin?: string | null },
): string {
  return resolveZCodeEndpointOrigin({
    envBaseOrigin:
      readRuntimeEnvValue(env, "ZCODE_BASE_URL") ??
      readRuntimeEnvValue(env, "ZCODE_ENDPOINT_ORIGIN"),
    overrideOrigin: options?.overrideOrigin,
  });
}

export function buildRuntimeZCodeEndpointUrls(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
): ZCodeEndpointUrls {
  return buildZCodeEndpointUrls(resolveRuntimeZCodeEndpointOrigin(env));
}

export function buildRuntimeZCodeApiUrl(
  env: RuntimeZCodeEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  // Absent configuration yields an empty string, not a path with no origin: a
  // relative string could be resolved against whatever origin happens to be
  // current. It fails at the point of use instead, which is where the operator
  // can act on it.
  const origin = resolveRuntimeZCodeEndpointOrigin(env);
  return origin ? `${origin}${normalizedPath}` : "";
}

export function resolveBigModelApiOrigin(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  const configured = readRuntimeEnvValue(env, "BIGMODEL_API_BASE_URL");
  return configured ? normalizeZCodeEndpointOrigin(configured) : "";
}

export function buildBigModelApiUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const origin = resolveBigModelApiOrigin(env);
  return origin ? `${origin}${normalizedPath}` : "";
}

export function buildBigModelCodingPlanPersonalManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  // 管理页与业务 API 共用显式 origin，避免把已登录账号带到另一个部署。
  return buildBigModelApiUrl(env, "/coding-plan/personal/overview");
}

export function buildBigModelCodingPlanTeamManageUrl(
  env: RuntimeBigModelApiEnv = readProductEndpointEnv(),
): string {
  return buildBigModelApiUrl(env, "/coding-plan/team/plans");
}

export function resolveZaiOAuthOrigin(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  const configured = readRuntimeEnvValue(env, "ZAI_OAUTH_ORIGIN");
  return configured ? normalizeZCodeEndpointOrigin(configured) : "";
}

export function resolveZaiBusinessBaseUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  const configured = readRuntimeEnvValue(env, "ZAI_BUSINESS_BASE_URL");
  return configured ? normalizeZCodeEndpointOrigin(configured) : "";
}

export function resolveZaiOAuthClientId(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
): string {
  return (
    readRuntimeEnvValue(env, "ZAI_OAUTH_CLIENT_ID") ??
    readRuntimeEnvValue(env, "ZAI_OAUTH_APP_ID") ??
    DEFAULT_ZAI_OAUTH_CLIENT_ID
  );
}

export function buildZaiOAuthUrl(origin: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedOrigin = normalizeOptionalOrigin(origin);
  return normalizedOrigin ? `${normalizedOrigin}${normalizedPath}` : "";
}

export function buildRuntimeZaiOAuthUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  return buildZaiOAuthUrl(resolveZaiOAuthOrigin(env), path);
}

export function buildRuntimeZaiBusinessUrl(
  env: RuntimeZaiEndpointEnv = readProductEndpointEnv(),
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const origin = resolveZaiBusinessBaseUrl(env);
  return origin ? `${origin}${normalizedPath}` : "";
}

export function resolveRuntimeProductEndpointConfig(
  env: RuntimeProductEndpointEnv = readProductEndpointEnv(),
): RuntimeProductEndpointConfig {
  const zcodeEnv = resolveRuntimeZCodeEnv(env);
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(env);

  return {
    zcodeEnv,
    zcodeEndpointOrigin,
    zcodeEndpointUrls: buildZCodeEndpointUrls(zcodeEndpointOrigin),
    zaiOAuthOrigin: resolveZaiOAuthOrigin(env),
    zaiBusinessBaseUrl: resolveZaiBusinessBaseUrl(env),
    zaiOAuthClientId: resolveZaiOAuthClientId(env),
    bigModelApiOrigin: resolveBigModelApiOrigin(env),
  };
}

export function buildZCodeEndpointUrls(origin: string): ZCodeEndpointUrls {
  const normalizedOrigin = normalizeOptionalOrigin(origin);
  // An unconfigured origin yields an empty string for every field rather than a
  // relative path, so nothing here can be resolved against a current origin and
  // this never throws at module scope. Consumers fail at the point of use.
  const at = (path: string): string => (normalizedOrigin ? `${normalizedOrigin}${path}` : "");
  return {
    origin: normalizedOrigin,
    apiBaseUrl: at("/api/v1"),
    webShareCallbackUrl: at("/cn/share/callback"),
    zcodePlanOpenAiBaseUrl: at("/api/v1/zcode-plan"),
    zcodePlanAnthropicBaseUrl: at("/api/v1/zcode-plan/anthropic"),
    zcodePlanBillingCurrentUrl: at("/api/v1/zcode-plan/billing/current"),
    zcodePlanBillingBalanceUrl: at("/api/v1/zcode-plan/billing/balance"),
  };
}

export function rewriteZCodeEndpointUrl(input: string | URL, endpointOrigin: string): string | URL {
  const originalUrl = typeof input === "string" ? input : input.toString();
  let parsed: URL;
  try {
    parsed = new URL(originalUrl);
  } catch {
    return input;
  }
  // The built-in vendor origin is gone, so there is normally no source origin to
  // rewrite away from and a legacy vendor URL is returned untouched instead of
  // being silently redirected. The signature stays for callers and for a
  // deployment that does configure a source origin.
  const sourceOrigin = DEFAULT_ZCODE_ENDPOINT_ORIGIN.trim();
  if (!sourceOrigin || parsed.origin !== sourceOrigin) {
    return input;
  }

  const targetOrigin = normalizeZCodeEndpointOrigin(endpointOrigin);
  if (targetOrigin === sourceOrigin) {
    return input;
  }

  const target = new URL(targetOrigin);
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.toString();
}
