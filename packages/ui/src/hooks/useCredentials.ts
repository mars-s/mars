/**
 * useCredentials —— 凭据服务 hooks
 */
import { useCallback } from "react";
import { useServices } from "./useServices.js";

/** 凭据管理的基础 hook */
export function useCredentials() {
  const { credentialService } = useServices();

  const load = useCallback((key: string) => credentialService.load(key), [credentialService]);
  const save = useCallback(
    (key: string, value: string) => credentialService.save(key, value),
    [credentialService],
  );
  const del = useCallback((key: string) => credentialService.delete(key), [credentialService]);

  return { load, save, delete: del };
}

/** active provider access_token 专用便捷 hook */
export function useAuthToken() {
  const { credentialService, oauthService } = useServices();

  const getToken = useCallback(async () => {
    const activeProvider = await oauthService.getActiveProvider();
    if (!activeProvider) {
      return null;
    }

    const namespacedToken = await credentialService.load(`oauth:${activeProvider}:access_token`);
    if (namespacedToken) {
      return namespacedToken;
    }

    return null;
  }, [credentialService, oauthService]);
  const setToken = useCallback(
    async (token: string) => {
      const activeProvider = await oauthService.getActiveProvider();
      if (!activeProvider) {
        throw new Error("当前没有 active provider，无法写入 auth token");
      }
      await credentialService.save(`oauth:${activeProvider}:access_token`, token);
    },
    [credentialService, oauthService],
  );
  const clearToken = useCallback(async () => {
    const activeProvider = await oauthService.getActiveProvider();
    if (!activeProvider) {
      return;
    }
    await credentialService.delete(`oauth:${activeProvider}:access_token`);
  }, [credentialService, oauthService]);

  return { getToken, setToken, clearToken };
}
