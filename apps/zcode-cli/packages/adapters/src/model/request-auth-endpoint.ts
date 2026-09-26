/**
 * The one decision that stands between a host-issued request credential and the
 * host it is about to be sent to.
 *
 * WHY THIS EXISTS
 *
 * The host verifies a provider identity against a LIVE registry view, read fresh
 * per request, and only then releases a subscription bearer token. The agent
 * froze its own copy of the provider config when the model was bound, and every
 * later attempt builds the real request URL from that frozen `baseURL`. Two
 * independently snapshotted copies of one config, so they can disagree.
 *
 * An actor able to rewrite the user's provider config can exploit that: bind a
 * model for a provider whose frozen base URL points at an attacker host, then
 * rewrite the config so that provider's live base URL is the real Codex
 * endpoint. The host's live view now passes every check and releases the live
 * token, and the agent would send it to the attacker.
 *
 * So the agent does not trust its own snapshot and does not trust the host's
 * answer alone. The host sends back the destination it verified
 * (`approvedBaseUrl`), and this refuses the credential unless that destination
 * and the destination this request is actually built from normalize equal. Both
 * sides run the one normalizer in `@zcode/shared`, so the two cannot drift.
 *
 * THE ERROR
 *
 * `ModelRequestAuthMissing` is deliberate. It is already the "this model cannot
 * get the credential it declared it needs" code: it is classified as a
 * not-configured failure that stops instead of retrying, and it is already
 * passed through unwrapped at the three boundaries that resolve a credential
 * before any bytes are sent. A mismatch is exactly that condition, and reusing
 * the code means it inherits the right stop-and-surface behaviour instead of
 * needing a new one wired into all of them. The `detail` below is what
 * distinguishes this from a genuinely absent credential in a log.
 */
import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import { isSameProviderBaseUrl } from "@zcode/shared";

/**
 * Throws unless the credential the host released was verified for the exact
 * destination this request will be sent to.
 *
 * A missing attestation fails. It is absent only from the UI-supplied scoped
 * auth source, which never went through the host's registry verification and so
 * is not a host-issued credential; every producer that did go through the host
 * protocol has to send one, because the response schema requires it.
 */
export function assertCredentialEndpointApproved(input: {
  readonly approvedBaseUrl: string | null | undefined;
  readonly providerId: string;
  readonly requestBaseUrl: string | null | undefined;
}): void {
  if (isSameProviderBaseUrl(input.approvedBaseUrl, input.requestBaseUrl)) {
    return;
  }
  throw new ModelProtocolError(
    ModelErrorCode.ModelRequestAuthMissing,
    "Model request auth was released for a different destination than this request uses",
    {
      detail: "approved-base-url-mismatch",
      providerId: input.providerId,
    },
  );
}
