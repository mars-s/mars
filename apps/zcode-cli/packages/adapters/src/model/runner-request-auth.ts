/**
 * Composes the per-attempt request credential port.
 *
 * WHY THIS EXISTS
 *
 * `ModelInvocationContext.refreshRuntimeHeadersBeforeAttempt` used to be dropped
 * at the adapter boundary. The reason it gave (a bound model no longer carries an
 * account access type) was true about the OLD access type and false about the
 * requirement: a DYNAMIC credential must never be frozen into the bind-time
 * snapshot, because it expires and can be rotated between two physical requests.
 * The bound model only knows the static key; the live token has to be resolved
 * again on every attempt, right before the bytes go out.
 *
 * The port is therefore forwarded only for models that actually declare a
 * request-auth dependency. Forwarding it unconditionally would send every static
 * api-key provider down the host refresh path and fail those requests before they
 * are sent, which is the real hazard the old comment was reaching for.
 *
 * WHO IS THE AUTHORITY
 *
 * When the host port exists, the host answers and the host's answer is final. A
 * refusal is forwarded verbatim rather than quietly retried against the scoped
 * source: the host is the credential authority, and a refusal there means "not
 * signed in" or "refused", which must fail loudly rather than go out as an
 * anonymous request. The scoped source is only the fallback for hosts that do
 * not provide a port at all.
 *
 * WHY THE HOST ANSWER IS NOT ENOUGH ON ITS OWN
 *
 * The host verified a destination, but the request URL is built from the config
 * the runner FROZE at bind time, and those are two different snapshots of one
 * config. So the host sends back the destination it verified, and this refuses
 * the credential unless it matches the destination of the request about to be
 * built. That is what makes "the checked value is the used value" true rather
 * than merely likely. See `request-auth-endpoint.ts`.
 */
import {
  ModelErrorCode,
  ModelProtocolError,
  type ModelRequestAuth,
  type ModelRequestAuthSource,
  type ModelRequestCredentialReason,
  type TraceContext,
} from "@zcode/contracts";
import { assertCredentialEndpointApproved } from "./request-auth-endpoint.js";

export type RequestAuthRefresh = (input: {
  attempt: number;
  reason?: ModelRequestCredentialReason;
  abortSignal?: AbortSignal;
  providerId: string;
  modelId: string;
  traceContext?: TraceContext;
}) => Promise<{ headersApplied: boolean; requestAuth?: ModelRequestAuth; approvedBaseUrl?: string }>;

export function composeRequestAuthRefresh(input: {
  hostRefresh?: RequestAuthRefresh;
  /**
   * The base URL the bound model is frozen at, which is the destination of every
   * request this refresh feeds. It is compared against the host's
   * `approvedBaseUrl` before any credential is handed back.
   */
  requestBaseUrl: string;
  source?: ModelRequestAuthSource;
}): RequestAuthRefresh {
  return async (params) => {
    if (input.hostRefresh) {
      const refreshed = await input.hostRefresh(params);
      if (refreshed.headersApplied) {
        assertCredentialEndpointApproved({
          approvedBaseUrl: refreshed.approvedBaseUrl,
          providerId: params.providerId,
          requestBaseUrl: input.requestBaseUrl,
        });
      }
      return refreshed;
    }
    if (!input.source) {
      // The dependency declared "this model needs request-level auth" but nothing
      // can produce it. Failing closed here is the whole point of the declaration.
      throw authMissing("no credential source is bound for this model");
    }
    const requestAuth = await input.source.resolve({
      attempt: params.attempt,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
      providerId: params.providerId,
      modelId: params.modelId,
    });
    if (!requestAuth) {
      throw authMissing("the bound request auth source produced no credential");
    }
    // No `approvedBaseUrl` here on purpose. This credential came from the bound
    // scope, not from a host that verified a registry destination, so there is no
    // registry destination to attest to. The host branch above is the one that
    // closes the frozen-snapshot gap.
    return { headersApplied: true, requestAuth };
  };
}

function authMissing(detail: string): ModelProtocolError {
  return new ModelProtocolError(
    ModelErrorCode.ModelRequestAuthMissing,
    `Model request auth is required but unavailable: ${detail}`,
    { detail },
  );
}
