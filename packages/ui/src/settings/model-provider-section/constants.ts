import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";

export function resolveModelProviderDisplayName(
  provider: Pick<ProviderSettingsFormProvider, "providerId" | "config">,
): string {
  // The Z.ai / BigModel Coding Plan and Start Plan label branches were removed with the
  // coding-plan surface: those provider ids are no longer published by the catalog, and a
  // hardcoded vendor plan name is exactly the surface being deleted.
  return getProviderFormLabel(provider);
}

/**
 * The only navigation entry the model-provider section builds.
 *
 * The preset, coding-plan, team-plan and coding-plan-loading variants all keyed off
 * `BUILTIN_MODEL_PROVIDER_IDS`, which is now an empty object. Every surviving provider is
 * configured as a Personal Provider (`group: "standard-personal"`), so one variant is left.
 */
export interface ModelProviderNavItem {
  key: string;
  type: "custom";
  label: string;
  provider: ProviderSettingsFormProvider;
  statusActive: boolean;
}

export type ModelProviderNavGroupId = "preset" | "custom";

export interface ModelProviderNavGroup {
  id: ModelProviderNavGroupId;
  title: string;
  items: ModelProviderNavItem[];
}
