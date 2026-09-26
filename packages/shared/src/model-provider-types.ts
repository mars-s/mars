/* eslint-disable max-lines -- 模型供应商 schema、迁移和运行时投影 helper 需要共享同一套类型边界，暂时集中在单文件避免契约分散。 */

/**
 * Pay-per-token template IDs deleted from the built-in catalog. The table is
 * empty: the two legacy ids are gone, resolving either one now yields a
 * `missing-template` issue, and no replacement template is introduced.
 */
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {} as const;

/**
 * Account provider ids. The account-provider subsystem is deleted, so the table
 * is empty and every derived type below is an empty union. No substitute id is
 * introduced.
 */
export const BUILTIN_MODEL_PROVIDER_IDS = {} as const;

/** Empty union: no built-in account provider id exists any more. */
export type BuiltinOAuthProviderId = keyof typeof BUILTIN_MODEL_PROVIDER_IDS;

/** Empty union: no built-in account provider id exists any more. */
export type BuiltinModelProviderId = (typeof BUILTIN_MODEL_PROVIDER_IDS)[BuiltinOAuthProviderId];

/** 一个正式 Model 的连通性测试结果。 */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** 设置连接测试边界已确认的资格失败；其他执行错误保留原消息。 */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };
