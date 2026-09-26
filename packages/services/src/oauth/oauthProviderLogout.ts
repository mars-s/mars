import type { OAuthProviderId } from "@zcode/shared";
import type { AccountProviderCredentialStore } from "../model-provider/accountProviderCredentialStore.js";

interface OAuthProviderLogoutDependencies {
  readonly accountProviderCredentialStore: Pick<AccountProviderCredentialStore, "deleteApiKey">;
  readonly refreshAccountProviders?: (reason: string) => Promise<unknown>;
}

/**
 * OAuth 登出后同步刷新派生 provider 配置。
 *
 * 内置的 Z.ai 与 BigModel 映射已下线，本 hook 不再清理任何内置派生凭据；
 * 新的 provider 如果也持有派生 API key，在这里补上对应的删除分支。
 */
export function createOAuthProviderLogoutHandler(
  dependencies: OAuthProviderLogoutDependencies,
): (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void> {
  return async (provider) => {
    await dependencies.refreshAccountProviders?.(`oauth-logout:${provider}`);
  };
}
