/**
 * Pure type definitions for usage-quota snapshots reported by a quota service.
 *
 * The shapes are vendor-neutral: nothing here names a plan product, and a
 * snapshot is scoped by an opaque provider-scope id rather than by a family id.
 * Keep it that way, so a new quota source is a new interface here rather than a
 * vendor branch inside an existing one.
 *
 * 这里只依赖自身，不构成循环依赖；对外由 index.ts 直接 re-export。
 */

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /** Server-side bucket identity and its period window; times are epoch ms, so a consumer can de-duplicate reminders by them. */
  bucketId?: string;
  userPlanId?: string;
  periodStart?: number;
  periodEnd?: number;
  /** 所属 entitlement 的周期类型，如 daily / one_time。 */
  period?: string;
  meter?: string;
  unitType?: string;
  /** Entitlement the bucket belongs to. Grouping key only: never a lookup key for a selectable model. */
  planId?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails: UsageQuotaUsageDetail[];
}

export interface UsageQuotaUsageDetail {
  modelCode: string;
  displayName?: string;
  usage: number;
}

/**
 * `aggregate.type` 的合成值。
 *
 * 不复用 TOKENS_LIMIT / TIME_LIMIT：`isSameLimitCategory` 会把 TIME_LIMIT 判为工具额度同类，
 * 让 MCP 汇总额度被现有按 type 查额度项的查询误命中。
 */
export const MCP_USAGE_QUOTA_LIMIT_TYPE = "MCP_USAGE_LIMIT" as const;

/** Which connection an MCP quota snapshot was read from, so a consumer can tell whether it belongs under the current provider tab. */
export type UsageMcpQuotaScope =
  | {
      /** Opaque provider-scope id the snapshot was read from. */
      providerFamily: string;
      targetType: "PERSONAL";
    }
  | {
      /** Opaque provider-scope id the snapshot was read from. */
      providerFamily: string;
      targetType: "TEAM";
      organizationId: string;
      projectId: string;
    };

export interface UsageMcpQuotaSnapshot {
  /** 服务端 server_time，毫秒（接口返回 Unix 秒）。 */
  serverTime: number;
  level: string | null;
  scope: UsageMcpQuotaScope;
  /**
   * 服务端 `total_usage`（总已用 / 总额度 / 总剩余）的等价表达，直接复用现有额度条 / 额度卡的
   * 展示逻辑。注意 percentage 沿用 quota 接口口径：**已使用占比**，展示端负责反转成剩余。
   */
  aggregate: UsageQuotaLimit;
}
