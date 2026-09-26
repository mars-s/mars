import type { WebZaiOAuthProviderConfig } from "./zaiWebOAuthProvider.js";
import { buildZCodeEndpointUrls, DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

interface WebImportMetaEnv {
  VITE_DEV_ORIGIN?: string;
  VITE_ZAI_OAUTH_CLIENT_ID?: string;
  VITE_ZAI_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_ORIGIN?: string;
  VITE_BIGMODEL_OAUTH_APP_ID?: string;
  VITE_ZCODE_BASE_URL?: string;
  VITE_ZCODE_ENDPOINT_ORIGIN?: string;
  VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO?: string;
}

export interface WebZaiOAuthConfig extends WebZaiOAuthProviderConfig {
  devOrigin?: string;
  shareRedirectUri: string;
  allowDevReturnToRedirect: boolean;
}

function normalizeZaiOAuthOrigin(value: string): string {
  return new URL(value.trim()).origin;
}

function buildZaiOAuthAuthorizeUrl(origin: string | undefined): string {
  // No built-in vendor default: the origin is operator supplied through
  // VITE_ZAI_OAUTH_ORIGIN. When it is missing the authorize URL stays empty instead of
  // silently pointing the login flow at the vendor.
  const trimmed = origin?.trim();
  return trimmed ? `${normalizeZaiOAuthOrigin(trimmed)}/api/oauth/authorize` : "";
}

/**
 * BigModel authorize entry.
 *
 * The origin must follow the environment: hardcoding the vendor host sends the login flow to
 * a deployment the operator did not choose. vite.config injects VITE_BIGMODEL_OAUTH_ORIGIN via
 * resolveBigModelApiOrigin at build time; when it is not injected the URL stays empty instead
 * of falling back to the built-in production origin.
 */
function buildBigModelAuthorizeUrl(origin: string | undefined): string {
  const trimmed = origin?.trim();
  return trimmed ? `${new URL(trimmed).origin}/login` : "";
}

function createWebZaiOAuthConfig(env: WebImportMetaEnv = {}): WebZaiOAuthConfig {
  const devOrigin = env.VITE_DEV_ORIGIN?.trim().replace(/\/$/, "");
  const zcodeEndpointUrls = buildZCodeEndpointUrls(
    env.VITE_ZCODE_BASE_URL?.trim() ||
      env.VITE_ZCODE_ENDPOINT_ORIGIN?.trim() ||
      DEFAULT_ZCODE_ENDPOINT_ORIGIN,
  );

  return {
    // ZAI 当前 OAuth 授权入口使用 /api/oauth 前缀，继续走 /auth/oauth 会打开旧入口。
    authorizeUrl: buildZaiOAuthAuthorizeUrl(env.VITE_ZAI_OAUTH_ORIGIN),
    tokenUrl: "/api/v1/oauth/token",
    // client_id 会出现在授权 URL 中，属于公开配置；这里允许 VITE_ 注入，但不能放 secret/token。
    clientId: env.VITE_ZAI_OAUTH_CLIENT_ID?.trim() || "client_P8X5CMWmlaRO9gyO-KSqtg",
    bigmodelAuthorizeUrl: buildBigModelAuthorizeUrl(env.VITE_BIGMODEL_OAUTH_ORIGIN),
    // BigModel 用 appId 而不是 client_id，且默认值就是桌面端在用的 "zcode"。
    bigmodelAppId: env.VITE_BIGMODEL_OAUTH_APP_ID?.trim() || "zcode",
    redirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    shareRedirectUri: zcodeEndpointUrls.webShareCallbackUrl,
    ...(devOrigin ? { devOrigin } : {}),
    allowDevReturnToRedirect: env.VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO === "true",
  };
}

const env = ((import.meta as ImportMeta & { env?: WebImportMetaEnv }).env ??
  {}) as WebImportMetaEnv;

export const WEB_ZAI_OAUTH_CONFIG: WebZaiOAuthConfig = createWebZaiOAuthConfig(env);

export function resolveWebAuthDevReturnTo(config: WebZaiOAuthConfig): string | undefined {
  return config.devOrigin ? `${config.devOrigin}/share/callback` : undefined;
}
