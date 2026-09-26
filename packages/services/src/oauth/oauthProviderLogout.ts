import type { OAuthProviderId } from "@zcode/shared";

/**
 * OAuth logout hook.
 *
 * The account-backed provider derivation is gone, so there is no derived credential to
 * clear on logout. A provider that later gains one registers its deletion branch here.
 */
export function createOAuthProviderLogoutHandler(): (
  provider: OAuthProviderId,
  accountIdentity?: string | null,
) => Promise<void> {
  return async () => {};
}
