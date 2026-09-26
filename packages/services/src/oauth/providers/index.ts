import type { ApiClient } from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providerAdapter.js";

/**
 * 创建当前可用的 provider adapter 列表。
 *
 * 内置的 Z.ai 与 BigModel provider 已下线，这里不再登记任何默认分支。
 * 新的 provider 实现必须在本工厂里显式登记，否则运行时会被视为不支持而拒绝登录。
 */
export function createOAuthProviderAdapters(options: {
  apiClient?: ApiClient;
}): OAuthProviderAdapter[] {
  if (!options.apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }

  return [];
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
