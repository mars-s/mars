/**
 * Device authorization grant (RFC 8628) for the ChatGPT subscription.
 *
 * This is the DEFAULT login flow. A GUI must not have to bind a loopback port
 * to log a user in: the port registered for the authorization-code flow is
 * fixed at 1455 and collides the moment the owner also runs another ChatGPT
 * client. The device flow has no port, so it cannot collide.
 *
 * Every network call goes through an injected transport so the whole flow can
 * be unit tested without network access.
 */
import { ApiError } from "@zcode/shared";
import {
  CHATGPT_DEVICE_CODE_GRANT_TYPE,
  CHATGPT_DEVICE_CODE_URL,
  CHATGPT_OAUTH_REQUEST_TIMEOUT_MS,
  CHATGPT_OAUTH_SCOPE,
  CHATGPT_ORIGINATOR,
  CHATGPT_PUBLIC_CLIENT_ID,
  CHATGPT_TOKEN_URL,
  CHATGPT_DEVICE_POLL_DEFAULT_INTERVAL_MS,
  CHATGPT_DEVICE_POLL_MAX_INTERVAL_MS,
  CHATGPT_DEVICE_POLL_MIN_INTERVAL_MS,
} from "./chatgptOAuthConfig.js";

export interface ChatGptTransport {
  (
    input: string,
    init: { body: string; headers: Record<string, string>; signal: AbortSignal },
  ): Promise<Response>;
}

export interface ChatGptTokenGrant {
  readonly accessToken: string;
  readonly idToken?: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number | null;
}

export interface ChatGptDeviceAuthorization {
  readonly deviceCode: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
}

/** Non-terminal poll outcome: the user has not finished approving yet. */
export class ChatGptAuthorizationPendingError extends Error {
  constructor() {
    super("ChatGPT device authorization is still pending");
    this.name = "ChatGptAuthorizationPendingError";
  }
}

/** Terminal poll outcome: the user denied the request or the code expired. */
export class ChatGptDeviceFlowTerminalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChatGptDeviceFlowTerminalError";
    this.code = code;
  }
}

export interface ChatGptClientOptions {
  readonly clientId?: string;
  readonly scope?: string;
  readonly timeoutMs?: number;
  readonly transport?: ChatGptTransport;
}

export interface ChatGptTokenRequestFields {
  readonly code?: string;
  readonly codeVerifier?: string;
  readonly deviceCode?: string;
  readonly grantType: string;
  readonly redirectUri?: string;
  readonly refreshToken?: string;
}

export interface ChatGptDeviceCodeClient {
  /**
   * Raw token-endpoint call. Returns the decoded payload on success and throws
   * a typed error otherwise, so every caller sees the same `store: false` body
   * and the same error taxonomy.
   */
  requestToken(
    fields: ChatGptTokenRequestFields,
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  requestDeviceAuthorization(options?: {
    redirectUri?: string;
  }): Promise<ChatGptDeviceAuthorization>;
  pollDeviceToken(
    deviceCode: string,
    options?: { redirectUri?: string; signal?: AbortSignal },
  ): Promise<ChatGptTokenGrant>;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readErrorPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function defaultTransport(): ChatGptTransport {
  return (input, init) => fetch(input, init);
}

function buildFormBody(fields: Readonly<Record<string, string>>): string {
  return new URLSearchParams(fields).toString();
}

/**
 * Builds the request body for every token-endpoint call.
 *
 * `store: false` is mandatory: the authorization backend rejects any request
 * that asks it to persist state. The field is always emitted as the boolean
 * false, never omitted and never stringified.
 */
export function buildChatGptTokenRequestBody(fields: {
  clientId: string;
  grantType: string;
  deviceCode?: string;
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  refreshToken?: string;
  scope?: string;
}): Record<string, string | boolean> {
  return {
    client_id: fields.clientId,
    grant_type: fields.grantType,
    scope: fields.scope ?? CHATGPT_OAUTH_SCOPE,
    store: false,
    ...(fields.deviceCode ? { device_code: fields.deviceCode } : {}),
    ...(fields.code ? { code: fields.code } : {}),
    ...(fields.codeVerifier ? { code_verifier: fields.codeVerifier } : {}),
    ...(fields.redirectUri ? { redirect_uri: fields.redirectUri } : {}),
    ...(fields.refreshToken ? { refresh_token: fields.refreshToken } : {}),
  };
}

export function createChatGptClient(options: ChatGptClientOptions = {}): ChatGptDeviceCodeClient {
  const clientId = options.clientId ?? CHATGPT_PUBLIC_CLIENT_ID;
  const scope = options.scope ?? CHATGPT_OAUTH_SCOPE;
  const timeoutMs = options.timeoutMs ?? CHATGPT_OAUTH_REQUEST_TIMEOUT_MS;
  const transport = options.transport ?? defaultTransport();

  async function postForm(
    url: string,
    body: Record<string, string | boolean>,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; payload: Record<string, unknown>; status: number }
  > {
    // Every call is bounded. A hung socket inside the rotation lock would keep
    // the cross-process grant lock held and stall every other process.
    const deadline = AbortSignal.timeout(timeoutMs);
    const response = await transport(url, {
      body: buildFormBody(
        Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)])),
      ),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        originator: CHATGPT_ORIGINATOR,
      },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    const payload = await readErrorPayload(response);
    if (response.ok) {
      return { ok: true, payload };
    }
    return { ok: false, payload, status: response.status };
  }

  return {
    async requestToken(fields, options = {}) {
      const result = await postForm(
        CHATGPT_TOKEN_URL,
        buildChatGptTokenRequestBody({
          clientId,
          grantType: fields.grantType,
          scope,
          ...(fields.deviceCode ? { deviceCode: fields.deviceCode } : {}),
          ...(fields.code ? { code: fields.code } : {}),
          ...(fields.codeVerifier ? { codeVerifier: fields.codeVerifier } : {}),
          ...(fields.redirectUri ? { redirectUri: fields.redirectUri } : {}),
          ...(fields.refreshToken ? { refreshToken: fields.refreshToken } : {}),
        }),
        options.signal,
      );
      if (!result.ok) {
        throw translateDeviceTokenFailure(result.payload, result.status);
      }
      return result.payload;
    },

    async requestDeviceAuthorization(request = {}) {
      const redirectUri = request.redirectUri;
      const result = await postForm(
        CHATGPT_DEVICE_CODE_URL,
        buildChatGptTokenRequestBody({
          clientId,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
          ...(redirectUri ? { redirectUri } : {}),
          scope,
        }),
      );
      if (!result.ok) {
        throw new ApiError({
          message:
            readTrimmedString(result.payload.error_description) ??
            `ChatGPT device authorization failed (HTTP ${result.status})`,
          url: CHATGPT_DEVICE_CODE_URL,
          method: "POST",
          status: result.status,
        });
      }

      const deviceCode = readTrimmedString(result.payload.device_code);
      const userCode = readTrimmedString(result.payload.user_code);
      const verificationUri =
        readTrimmedString(result.payload.verification_uri) ??
        readTrimmedString(result.payload.verification_url);
      const expiresIn = Number(result.payload.expires_in);
      if (!deviceCode || !userCode || !verificationUri) {
        throw new Error("ChatGPT device authorization response is missing required fields");
      }

      const intervalSeconds = Number(result.payload.interval);
      return {
        deviceCode,
        userCode,
        verificationUri,
        ...(readTrimmedString(result.payload.verification_uri_complete)
          ? {
              verificationUriComplete: readTrimmedString(result.payload.verification_uri_complete)!,
            }
          : {}),
        expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 600,
        intervalSeconds: normalizeIntervalSeconds(intervalSeconds),
      };
    },

    async pollDeviceToken(deviceCode, poll = {}) {
      const payload = await this.requestToken(
        {
          grantType: CHATGPT_DEVICE_CODE_GRANT_TYPE,
          deviceCode,
          ...(poll.redirectUri ? { redirectUri: poll.redirectUri } : {}),
        },
        poll.signal ? { signal: poll.signal } : {},
      );
      return readTokenGrant(payload);
    },
  };
}

export function normalizeIntervalSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return CHATGPT_DEVICE_POLL_DEFAULT_INTERVAL_MS / 1_000;
  }
  return Math.min(
    Math.max(value, CHATGPT_DEVICE_POLL_MIN_INTERVAL_MS / 1_000),
    CHATGPT_DEVICE_POLL_MAX_INTERVAL_MS / 1_000,
  );
}

function translateDeviceTokenFailure(payload: Record<string, unknown>, status: number): Error {
  const code = readTrimmedString(payload.error) ?? `http_${status}`;
  if (code === "authorization_pending") {
    return new ChatGptAuthorizationPendingError();
  }
  if (code === "slow_down") {
    // RFC 8628: back off by 5 seconds. Surfaced as pending so the caller keeps
    // polling with the widened interval rather than treating it as a failure.
    return new ChatGptAuthorizationPendingError();
  }
  if (code === "expired_token") {
    return new ChatGptDeviceFlowTerminalError(code, "The ChatGPT login code expired, please retry");
  }
  if (code === "access_denied") {
    return new ChatGptDeviceFlowTerminalError(code, "The ChatGPT login request was denied");
  }
  return new ApiError({
    message:
      readTrimmedString(payload.error_description) ??
      `ChatGPT token request failed (HTTP ${status})`,
    url: CHATGPT_TOKEN_URL,
    method: "POST",
    status,
  });
}

export function readTokenGrant(payload: Record<string, unknown>): ChatGptTokenGrant {
  const accessToken = readTrimmedString(payload.access_token);
  const refreshToken = readTrimmedString(payload.refresh_token);
  if (!accessToken || !refreshToken) {
    // A token response without a refresh token cannot be refreshed later, and a
    // ChatGPT grant must always be refreshable to stay signed in.
    throw new ChatGptDeviceFlowTerminalError(
      "missing_refresh_token",
      "The authorization server did not return a refresh token",
    );
  }

  const expiresIn = Number(payload.expires_in);
  return {
    accessToken,
    refreshToken,
    ...(readTrimmedString(payload.id_token)
      ? { idToken: readTrimmedString(payload.id_token)! }
      : {}),
    expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  };
}
