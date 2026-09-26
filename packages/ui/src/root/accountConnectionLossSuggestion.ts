import type { IServiceAccessor, ProviderSettingsView } from "@zcode/services";
import type { ProviderFamilyConnectionSelection } from "@zcode/shared";
import type { AccountConnectionLoss } from "@/root/accountConnectionRefreshObserver.js";
import { resolveModelProviderFamilyConnectionProviderId } from "@/lib/modelProviderFamilyConnectionSelection.js";
import { logger } from "@/logger.js";

/** 只计算建议，不替用户保存；闭包固定按钮展示的那个目标，点击时重新校验。 */
export async function prepareAccountConnectionSwitch(
  services: IServiceAccessor,
  event: AccountConnectionLoss,
) {
  const settings = await services.settingService.get();
  const family = settings.providerFamilyDomain;
  const original = family && settings.providerFamilyConnectionSelections?.[family];
  if (!family || !original || original.kind === "start-plan" || !event.isCurrent()) return null;
  if (
    resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection: original,
    }) !== event.providerId
  )
    return null;
  const expected = {
    providerFamilyDomain: family,
    providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections,
  };
  const isOriginal = (view: ProviderSettingsView) => {
    const state = view.providers.find((p) => p.providerId === event.providerId)?.accountState;
    return (
      event.isCurrent() &&
      state?.current === true &&
      state.connectionKey === event.connectionKey &&
      state.availability === "unavailable"
    );
  };
  const view = await services.providerSettingsService.getView();
  if (!isOriginal(view)) return null;
  // 可用性统一取自最新 Account View；权益快照读取随 Z.ai 订阅面一起下线，
  // 目标连接是否可用由 Host 的 accountState 事实裁决。
  const isAvailable = (
    selection: ProviderFamilyConnectionSelection,
    view: ProviderSettingsView,
  ) => {
    const providerId = resolveModelProviderFamilyConnectionProviderId({
      providerFamilyDomain: family,
      selection,
    });
    return (
      view.providers.find((p) => p.providerId === providerId)?.accountState?.availability ===
      "available"
    );
  };
  // Only the individual coding plan can be suggested now: enterprise team pricing was the sole
  // source of a team candidate, and it is gone with the Z.ai billing surface.
  let selection: ProviderFamilyConnectionSelection | undefined;
  if (isAvailable({ kind: "individual-coding-plan" }, view))
    selection = { kind: "individual-coding-plan" };
  if (!selection || !event.isCurrent()) return null;
  const target = selection;
  let running = false;
  let applied = false;
  return {
    selection: target,
    // The organisation/project label only ever came from the removed team candidate, so callers
    // now always fall back to their i18n title. The key stays to keep the result shape stable.
    label: undefined,
    async apply(): Promise<"switched" | "stale"> {
      if (running || applied || !event.isCurrent()) return "stale";
      running = true;
      try {
        const latest = await services.providerSettingsService.refresh(
          "account-connection-switch-confirm",
        );
        if (!isOriginal(latest) || !isAvailable(target, latest) || !event.isCurrent())
          return "stale";
        await services.settingService.update(
          {
            providerFamilyConnectionSelections: {
              ...settings.providerFamilyConnectionSelections,
              [family]: target,
            },
          },
          expected,
        );
        applied = true;
        try {
          await services.providerSettingsService.refresh("account-connection-switched");
        } catch (error) {
          // 写入已完成，刷新失败不能把结果伪装成未保存；后续正常刷新继续收敛。
          logger.lifecycle.warn("[AccountConnection] 连接已保存，刷新暂未完成", { error });
        }
        return "switched";
      } finally {
        running = false;
      }
    },
  };
}
