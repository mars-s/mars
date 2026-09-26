/**
 * PKCE pair generation for the ChatGPT authorization-code flow.
 *
 * The verifier never leaves this process; only its S256 challenge is sent to
 * the authorization server. Generation is pure enough to unit test offline.
 */
import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 caps the verifier at 128 octets; 64 random bytes is 86 base64url chars. */
const VERIFIER_RANDOM_BYTES = 64;

export interface PkcePair {
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
  readonly codeVerifier: string;
}

export interface PkceOptions {
  /** Injection seam for tests; production always uses crypto.randomBytes. */
  readonly randomSource?: (size: number) => Buffer;
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

export function deriveCodeChallenge(codeVerifier: string): string {
  return base64UrlEncode(createHash("sha256").update(codeVerifier, "ascii").digest());
}

export function generatePkcePair(options: PkceOptions = {}): PkcePair {
  const source = options.randomSource ?? randomBytes;
  const codeVerifier = base64UrlEncode(source(VERIFIER_RANDOM_BYTES));
  return {
    codeVerifier,
    codeChallenge: deriveCodeChallenge(codeVerifier),
    codeChallengeMethod: "S256",
  };
}

/**
 * RFC 7636 requires 43 to 128 unreserved characters. base64url output uses only
 * `A-Z a-z 0-9 - _ . ~`-safe characters, so the length bound is the only check.
 */
export function isValidPkceVerifier(codeVerifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier);
}
