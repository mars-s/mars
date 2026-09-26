import { decodeCustomModelValue, encodeCustomModelValue } from "@zcode/shared";

// Provider 重构拆分了执行身份，但旧报表仍按原桶统计；只在事件构造处使用，禁止回流业务配置。
// 旧 staging 790884b1ce 的 Team 连接也使用 builtin:* 原 Coding Plan 身份。
// Every legacy bucket the table used to hold was a Z.ai / BigModel identity, and the
// catalog no longer declares any of those provider ids, so no live event can carry one
// any more. The table therefore stays empty and the lookups below are pass-throughs:
// they keep the vendor-neutral telemetry shape stable for the surviving families.
const legacyProviderIds: Readonly<Record<string, string>> = Object.freeze({});

export function legacyTelemetryProviderId(providerId: string): string {
  return Object.hasOwn(legacyProviderIds, providerId) ? legacyProviderIds[providerId]! : providerId;
}

/** 只替换已知 Provider 前缀；纯模型 ID、未知身份及模型内部编码保持原样。 */
export function legacyTelemetryModelValue(value: string): string {
  const custom = decodeCustomModelValue(value);
  if (custom) {
    const providerId = legacyTelemetryProviderId(custom.providerId);
    return providerId === custom.providerId
      ? value
      : encodeCustomModelValue(providerId, custom.modelName);
  }
  const slash = value.indexOf("/");
  if (slash < 1) return value;
  const providerId = value.slice(0, slash);
  return legacyTelemetryProviderId(providerId) + value.slice(slash);
}

/** 对话事件完成归因后再投影，不改 request/child/seed 的原始事实。 */
export function legacyTelemetryModelFields(detail: Record<string, string>): Record<string, string> {
  return {
    ...detail,
    ...(detail.model_provider !== undefined
      ? { model_provider: legacyTelemetryProviderId(detail.model_provider) }
      : {}),
    ...(detail.model_name !== undefined
      ? { model_name: legacyTelemetryModelValue(detail.model_name) }
      : {}),
  };
}
