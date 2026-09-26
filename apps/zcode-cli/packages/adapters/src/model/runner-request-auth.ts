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
 */
import {
  ModelErrorCode,
  ModelProtocolError,
  type ModelRequestAuth,
  type ModelRequestAuthSource,
  type ModelRequestCredentialReason,
  type TraceContext,
} from "@zcode/contracts";

export type RequestAuthRefresh = (input: {
  attempt: number;
  reason?: ModelRequestCredentialReason;
  abortSignal?: AbortSignal;
  providerId: string;
  modelId: string;
  traceContext?: TraceContext;
}) => Promise<{ headersApplied: boolean; requestAuth?: ModelRequestAuth }>;

export function composeRequestAuthRefresh(input: {
  hostRefresh?: RequestAuthRefresh;
  source?: ModelRequestAuthSource;
}): RequestAuthRefresh {
  return async (params) => {
    if (input.hostRefresh) {
      return input.hostRefresh(params);
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
