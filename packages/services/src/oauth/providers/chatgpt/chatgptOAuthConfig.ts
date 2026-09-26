/**
 * ChatGPT subscription OAuth constants.
 *
 * Every value here is public protocol surface documented by the official client
 * registration. The client id is a PUBLIC OAuth client identifier that ships in
 * every public-client binary; it is not a secret and must not be treated as one.
 */
import type { OAuthProviderId } from "@zcode/shared";

/** Provider id registered in the OAuth provider adapter factory. */
export const CHATGPT_OAUTH_PROVIDER_ID = "chatgpt" as OAuthProviderId;

/** Public OAuth client id of the official ChatGPT client registration. */
export const CHATGPT_PUBLIC_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CHATGPT_DEVICE_CODE_URL = "https://auth.openai.com/oauth/device/code";
export const CHATGPT_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Account metadata endpoint; the id it reports is the same value as the JWT claim. */
export const CHATGPT_AUTH_METADATA_URL = "https://api.openai.com/auth";

/** Backend that serves the subscription-gated Responses API. */
export const CHATGPT_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/**
 * Loopback redirect registered by OpenAI. The port is fixed by the client
 * registration and cannot be moved, which is exactly why device code is the
 * default flow: a GUI never has to bind a port another client may already hold.
 */
export const CHATGPT_LOOPBACK_REDIRECT_URI = "http://localhost:1455/auth/callback";

/**
 * Identifies this product to the authorization server.
 *
 * Must be this app's own name. Sending another client's originator would make
 * the server attribute ChatGPT subscription traffic to that product.
 */
export const CHATGPT_ORIGINATOR = "zcode";

/** Required header on every Codex backend request; without it the backend rejects the call. */
export const CHATGPT_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id";

/** The subscription model verified to work on this path. */
export const CHATGPT_DEFAULT_MODEL_ID = "gpt-5.6-luna";

/** OAuth scope requested at the device authorization and authorize-code steps. */
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access";

/** Poll cadence floor mandated by the device flow contract (slow_down backoff base). */
export const CHATGPT_DEVICE_POLL_MIN_INTERVAL_MS = 5_000;
export const CHATGPT_DEVICE_POLL_DEFAULT_INTERVAL_MS = 5_000;
export const CHATGPT_DEVICE_POLL_MAX_INTERVAL_MS = 30_000;

/** Every network call in this module is bounded so a hung socket cannot pin the lock. */
export const CHATGPT_OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Bound for the cross-process grant lock. A rotation holds it across a network
 * POST, so it has to exceed one request timeout plus the write-back.
 */
export const CHATGPT_GRANT_LOCK_MAX_WAIT_MS = 45_000;
export const CHATGPT_GRANT_LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1_600] as const;
