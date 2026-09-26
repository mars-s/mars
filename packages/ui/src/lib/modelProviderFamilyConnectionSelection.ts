import type { ProviderFamilyConnectionSelection, ProviderFamilyDomain } from "@zcode/shared";
import { getModelProviderFamilySpec } from "@zcode/shared";

export type ModelProviderFamilyConnectionSelection = ProviderFamilyConnectionSelection;

/** 把当前 Family 连接意图映射为对应的 Built-in Account Provider 身份。 */
export function resolveModelProviderFamilyConnectionProviderId(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
}): string {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);
  switch (params.selection.kind) {
    case "start-plan":
      return familySpec.startPlanProviderId;
    case "individual-coding-plan":
      return familySpec.individualCodingPlanProviderId;
    // Enterprise team pricing is part of the removed Z.ai billing surface and nothing produces
    // this selection any more, but a `team-coding-plan` value can still be persisted in settings,
    // so the mapping stays exhaustive for it.
    case "team-coding-plan":
      return familySpec.teamCodingPlanProviderId;
  }
}

export function resolveAutomaticModelProviderFamilyConnectionSelection(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  /** 首次登录可落到购买入口；修复已有连接时只能选确认可用的套餐。 */
  allowPurchaseEntry?: boolean;
  /** 当前 Account View 是个人连接可用性的唯一判定来源。 */
  codingPlanAvailable?: boolean;
}): ModelProviderFamilyConnectionSelection | null {
  if (params.codingPlanAvailable) {
    return {
      kind: "individual-coding-plan",
    };
  }

  if (params.allowPurchaseEntry === false) return null;
  // OAuth 登录后的输入框连接方式必须始终保持 OAuth 语义。
  // 即使当前账号没有 Start 或个人 Coding，也应落到个人 Coding 入口，
  // 由后续购买/不可用态承接，而不是自动切到 API Key。
  return {
    kind: "individual-coding-plan",
  };
}
