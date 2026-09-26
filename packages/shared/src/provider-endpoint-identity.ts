/* The single base-URL normalization and comparison for provider destinations.
 *
 * This lives in `shared` rather than in either side because there is a real
 * TOCTOU between two independently snapshotted copies of one provider config:
 *
 *   - the host verifies the provider identity against a LIVE registry view and
 *     only then releases a subscription bearer token;
 *   - the agent FREEZES the provider config when the model is bound, and every
 *     later attempt builds the real request URL from that frozen baseURL.
 *
 * Those copies can disagree. An actor able to rewrite the provider config can
 * bind a model whose frozen baseURL points at an attacker host and then rewrite
 * the config so the registry's live view points back at the real Codex endpoint:
 * the host verifies and releases, and the agent sends the token to the attacker.
 *
 * The fix is for the host to hand back the exact destination it verified, and
 * for the agent to refuse the credential unless its own destination normalizes
 * equal to it. That comparison is only sound while both sides run the SAME
 * function, so the function exists here exactly once and neither side keeps a
 * copy. */

/**
 * The Codex responses PARENT, not the full `/responses` address.
 *
 * The AI SDK's OpenAI responses model calls `url({ path: "/responses" })` and
 * `createOpenAI` defines that as `` `${baseURL}${path}` ``, so the configured
 * base URL has to be the parent and the SDK appends `/responses` itself. Both
 * sides compare the parent, because that is the value the registry holds and the
 * value the request URL is built from.
 */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Reduces a base URL to the canonical form two destinations are compared in.
 *
 * A trailing slash is not a different host and must not fail the comparison, but
 * everything else about the URL is compared verbatim, including the path. Query
 * and hash are dropped: neither is part of the endpoint identity, and keeping
 * them would only make one endpoint compare unequal because of a meaningless
 * query parameter. A value that will not parse is reduced textually rather than
 * throwing, because this runs on a request path.
 */
export function normalizeProviderBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.hash = "";
    url.search = "";
    return url.toString().toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/u, "").toLowerCase();
  }
}

/**
 * Whether two base URLs name the same destination.
 *
 * Two absent URLs are NOT the same destination: `null === null` would make "the
 * host named nothing and the agent has nothing either" compare equal, which is
 * exactly the case a credential gate has to refuse. Either side being absent is
 * false.
 */
export function isSameProviderBaseUrl(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizeProviderBaseUrl(left);
  return normalizedLeft !== null && normalizedLeft === normalizeProviderBaseUrl(right);
}
