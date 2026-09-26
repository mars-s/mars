import type { ApiClient } from "@zcode/shared";
import type { OAuthProviderAdapter } from "./providerAdapter.js";
import { ChatGptOAuthAdapter } from "./chatgpt/chatgptOAuthAdapter.js";

/**
 * 创建当前可用的 provider adapter 列表。
 *
 * The former built-in vendor providers are gone, so no default branch is registered.
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

  // ChatGPT authenticates against its own issuer (auth.openai.com) and not against
  // the ZCode backend, so the adapter carries its own transport and never routes
  // ChatGPT credentials through the injected backend apiClient.
  return [new ChatGptOAuthAdapter()];
}

export type {
  OAuthProviderAdapter,
  OAuthProviderContext,
  ProviderRequestAuthGrant,
  ProviderRequestAuthGrantStore,
  ProviderRequestAuthGrantStoreCapability,
} from "./providerAdapter.js";
export { ChatGptOAuthAdapter } from "./chatgpt/chatgptOAuthAdapter.js";
