import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useOffPeakTaskStore } from "@/store/offPeakTaskStore.js";

/** 两个闲时入口共享初始化/连接/Registry 通知边界，不在组件中另存资格。 */
export function useOffPeakEligibility(registryRevision: number | undefined): void {
  const { offPeakTaskService } = useServices();
  const initialize = useOffPeakTaskStore((state) => state.initialize);
  const refresh = useOffPeakTaskStore((state) => state.refreshCodingPlanSupport);
  // This hook used to key on the provider family setting, which is gone. The Registry revision is
  // the only invalidation signal left. Rendered as a string so the effect dep stays stable.
  const freshnessKey = registryRevision === undefined ? undefined : `offpeak:${registryRevision}`;

  useEffect(() => {
    void initialize({ offPeakTaskService });
  }, [initialize, offPeakTaskService]);

  useEffect(() => {
    if (freshnessKey === undefined) return;
    // ProviderSettings View revision comes from a completed Registry publish. Even when nothing
    // was selected, an account that becomes ready later still triggers a recheck. Both entry
    // points sharing a key is deduplicated inside the store.
    void refresh(offPeakTaskService, freshnessKey);
  }, [freshnessKey, offPeakTaskService, refresh]);
}
