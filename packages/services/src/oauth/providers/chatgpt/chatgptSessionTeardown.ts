/**
 * Session teardown capability for providers that keep secrets of their own.
 *
 * The frozen `OAuthProviderAdapter` seam has no logout hook, but a provider
 * whose grant lives outside the shared credential store must be able to drop
 * that grant when the user signs out. Leaving a live refresh token on disk after
 * an explicit logout is a security defect, not a caching trade-off.
 */

export interface ProviderSessionTeardownCapability {
  /** Invoked after the shared OAuth session for this provider has been cleared. */
  clearProviderSessionSecrets(): Promise<void>;
}

export function isSessionTeardownAdapter(
  adapter: unknown,
): adapter is ProviderSessionTeardownCapability {
  return (
    typeof adapter === "object" &&
    adapter !== null &&
    typeof (adapter as ProviderSessionTeardownCapability).clearProviderSessionSecrets === "function"
  );
}
