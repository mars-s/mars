/**
 * Coding Plan 额度相关的纯类型定义。
 *
 * 这里只依赖自身，不构成循环依赖；对外由 index.ts 直接 re-export。
 */
import type { ModelProviderFamilyId } from "./model-provider-family.js";

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /** Start Plan 服务端额度桶及周期身份；周期时间为毫秒，供提醒去重。 */
  bucketId?: string;
  userPlanId?: string;
  periodStart?: number;
  periodEnd?: number;
  /** 所属 entitlement 的周期类型，如 daily / one_time。 */
  period?: string;
  meter?: string;
  unitType?: string;
  /** Start Plan bucket 所属套餐身份，仅用于设置页按 plan 分组展示。 */
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
 * 让 MCP 汇总额度被现有的 findCodingPlanQuotaLimit 查询误命中。
 */
export const MCP_USAGE_QUOTA_LIMIT_TYPE = "MCP_USAGE_LIMIT" as const;

/** MCP 额度所属的 Coding Plan 连接，供 UI 判断能否显示在当前 provider tab 下。 */
export type UsageMcpQuotaScope =
  | {
      providerFamily: ModelProviderFamilyId;
      targetType: "PERSONAL";
    }
  | {
      providerFamily: ModelProviderFamilyId;
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
