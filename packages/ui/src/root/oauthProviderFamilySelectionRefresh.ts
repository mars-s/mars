import type { IServiceAccessor } from "@zcode/services";
import type { AccountProviderState } from "@zcode/provider";
import type { OAuthProviderId } from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  resolveProviderFamilyDomainFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

import { getEnterprisePricingProductsOrEmpty } from "@/root/oauthTeamPricing.js";

function resolveModelProviderFamilySpecFromOAuth(
  provider: OAuthProviderId | string,
): ReturnType<typeof getModelProviderFamilySpec> | null {
  const family = resolveProviderFamilyDomainFromOAuthProvider(provider);
  return family ? getModelProviderFamilySpec(family) : null;
}

/** 刷新 Account View 并投影每个连接的可用性事实；登录/启动的连接裁决只读这一份。 */
async function refreshAccountProviderStates(params: {
  services: IServiceAccessor;
  providerIds: readonly string[];
  reason: string;
}): Promise<{
  states: ReadonlyMap<string, AccountProviderState>;
  refreshed: boolean;
  error?: unknown;
}> {
  const providerSettingsService = params.services.providerSettingsService;

  try {
    const view = await providerSettingsService.refresh(params.reason);
    return {
      refreshed: true,
      states: new Map(
        view.providers.flatMap((provider) =>
          provider.accountState ? [[provider.providerId, provider.accountState] as const] : [],
        ),
      ),
    };
  } catch (error) {
    logger.warn("[Root] 刷新 Account Provider 可用性失败", {
      providerIds: params.providerIds,
      error,
    });
    return { refreshed: false, states: new Map(), error };
  }
}

export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.provider);
  if (!domain) {
    return null;
  }

  const familySpec = resolveModelProviderFamilySpecFromOAuth(params.provider);
  if (!familySpec) return null;
  // 登录查询也有网络等待，条件写入必须基于查询前的意图，而非回包后的选择。
  const currentSettings = await params.services.settingService.get();
  const expectedAccountSettings = {
    providerFamilyDomain: currentSettings.providerFamilyDomain,
    providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
  };
  const codingPlanProviderId = familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = familySpec.startPlanProviderId;
  const codingPlanProviderIds = [
    familySpec.individualCodingPlanProviderId,
    familySpec.startPlanProviderId,
    familySpec.teamCodingPlanProviderId,
  ];
  const { states, refreshed } = await refreshAccountProviderStates({
    services: params.services,
    providerIds: codingPlanProviderIds,
    reason: "oauth-login-entitlement",
  });
  if (!refreshed) return null;
  // 登录后的刷新也可能仍在等待旧 Team 补组织；未知不是可按排序重选的首次连接。
  if (
    !currentSettings.providerFamilyConnectionSelections?.[domain] &&
    codingPlanProviderIds.every((id) => states.get(id)?.availability === "unknown")
  )
    return null;

  // 个人连接是否可用只认 Account View 的 availability 事实，不再叠加权益快照兜底。
  const teamProducts = await getEnterprisePricingProductsOrEmpty(params.services, domain);
  // 旧 Start 连接只保留读取，不以权益失效为由删除或自动替换成付费连接。
  const savedSelection = currentSettings.providerFamilyConnectionSelections?.[domain];
  if (savedSelection?.kind === "start-plan") return savedSelection;
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    teamProducts,
    codingPlanAvailable: states.has(codingPlanProviderId)
      ? states.get(codingPlanProviderId)!.availability === "available"
      : undefined,
  });
  if (!selection) {
    return null;
  }

  await params.services.settingService.update(
    {
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    expectedAccountSettings,
  );
  return selection;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const domain = resolveProviderFamilyDomainFromOAuthProvider(params.activeProvider);
  if (!domain) return null;
  const settings = await params.services.settingService.get();
  if (settings.providerFamilyDomain && settings.providerFamilyDomain !== domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    // 原因：启动时的不可用不是本次运行中发生的失效，不能替用户更换已保存连接。
    // 刷新账号事实仍照常执行；只有后续真实失效提示的点击动作允许选择替代套餐。
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  try {
    // 仅真正没有选择才沿用首次初始化；该入口保留旧连接待迁移的 unknown 保护及条件写入。
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] 启动初始化连接失败", { error });
    return null;
  }
}
