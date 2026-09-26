/**
 * Claim extraction from the ChatGPT access token.
 *
 * The access token is a JWT issued by the authorization server. The subscription
 * account id lives in it and is NOT returned by the token endpoint, so the only
 * way to obtain the `ChatGPT-Account-Id` header value is to read the token.
 *
 * Signature verification is deliberately NOT attempted here: the token is
 * presented back to the same issuer, which is the only party that has to trust
 * it. This code extracts routing metadata and never authorizes a decision.
 */

const AUTH_CLAIM_NAMESPACE = "https://api.openai.com/auth";

interface AccessTokenClaims {
  readonly accountId: string | null;
  readonly expiresAt: number | null;
  readonly subject: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeBase64Url(segment: string): string | null {
  try {
    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = globalThis.atob(padded);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function parseAccessTokenPayload(accessToken: string): Record<string, unknown> | null {
  const segments = accessToken.trim().split(".");
  const payloadSegment = segments[1];
  if (segments.length !== 3 || !payloadSegment) {
    return null;
  }

  const decoded = decodeBase64Url(payloadSegment);
  if (!decoded) {
    return null;
  }

  try {
    const parsed = JSON.parse(decoded) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readClaims(accessToken: string): AccessTokenClaims | null {
  const payload = parseAccessTokenPayload(accessToken);
  if (!payload) {
    return null;
  }

  const namespaced = isRecord(payload[AUTH_CLAIM_NAMESPACE])
    ? (payload[AUTH_CLAIM_NAMESPACE] as Record<string, unknown>)
    : null;
  // The account id has been published both as a flat claim and inside the
  // namespaced auth claim; accept either so a server-side change cannot silently
  // strip the header the Codex backend requires.
  const accountId =
    readNonEmptyString(payload.chatgpt_account_id) ??
    readNonEmptyString(namespaced?.chatgpt_account_id);
  const rawExp = payload.exp;
  const expiresAt =
    typeof rawExp === "number" && Number.isFinite(rawExp) && rawExp > 0 ? rawExp * 1_000 : null;

  return {
    accountId,
    expiresAt,
    subject: readNonEmptyString(payload.sub),
  };
}

/** Returns the `chatgpt_account_id` claim, or null when the token is not readable. */
export function readChatgptAccountId(accessToken: string): string | null {
  return readClaims(accessToken)?.accountId ?? null;
}

/** Returns the access token expiry in epoch milliseconds, or null when unknown. */
export function readAccessTokenExpiration(accessToken: string): number | null {
  return readClaims(accessToken)?.expiresAt ?? null;
}

/** Returns the subject claim, used as a stable profile id when no account id exists. */
export function readAccessTokenSubject(accessToken: string): string | null {
  return readClaims(accessToken)?.subject ?? null;
}

/**
 * True when the access token is known to be expired. An unreadable or
 * expiry-less token returns false: only the server can reject it, and treating
 * "unknown" as "expired" would sign a healthy user out on every launch.
 */
export function isAccessTokenKnownExpired(accessToken: string, now: number): boolean {
  const expiresAt = readAccessTokenExpiration(accessToken);
  if (expiresAt === null) {
    return false;
  }

  return now + 30_000 >= expiresAt;
}
