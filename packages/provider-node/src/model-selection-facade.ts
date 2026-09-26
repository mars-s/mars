import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  // The built-in account and off-peak provider sets are gone, so no id resolves to a
  // paid kind. Classifying by an id set that is always empty would be a check that can
  // never pass, so every provider is ordinary and the classifier collapses to a constant.
  return new ModelSelectionFacade(source, () => "ordinary", resolveLegacyReasoningLevel);
}
