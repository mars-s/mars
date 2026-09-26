import type { ICredentialService } from "#src/credential/credential.js";

const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) {
    return false;
  }

  // 共享 zcode JWT 是 ZCode 后端的唯一鉴权凭据，只有它能触发强制登出。
  // provider 自己的 access token 由各自的 adapter 归一化，不在这里判定。
  const currentJwt = (await options.credentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() ?? "";
  return Boolean(currentJwt) && authorization === `Bearer ${currentJwt}`;
}
