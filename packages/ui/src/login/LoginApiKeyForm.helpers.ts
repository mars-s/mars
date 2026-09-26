import { isApiKeyAccess, resolveProviderTemplateName } from "@zcode/provider";
import { type Locale } from "@zcode/shared";
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

type ProviderTemplateView = ProviderSettingsView["providerTemplates"][number];

/** The choice is the built-in template id: the pasted key becomes a Personal Provider of it. */
export type ApiKeyProviderChoice = string;

export interface LoginApiKeyProviderOption {
  readonly templateId: string;
  readonly label: string;
  readonly apiKeyUrl: string | undefined;
  readonly logo: ProviderTemplateView["config"]["logo"];
}

/**
 * The offer list comes from the built-in catalog alone, so no vendor is hard-coded
 * on the login screen. Every template that declares pay-per-token API key access is
 * offered, and the key the user pastes lands as that template's Personal Provider.
 */
export function resolveLoginApiKeyProviderOptions(
  templates: readonly ProviderTemplateView[],
  locale: Locale,
): readonly LoginApiKeyProviderOption[] {
  const options: LoginApiKeyProviderOption[] = [];
  for (const template of templates) {
    const access = template.config.access;
    if (!isApiKeyAccess(access)) continue;
    options.push({
      templateId: template.templateId,
      label: resolveProviderTemplateName(template.templateId, template, locale),
      apiKeyUrl: access.apiKeyManagementUrl ?? undefined,
      logo: template.config.logo,
    });
  }
  return Object.freeze(options);
}

export function shouldShowLoginApiKeyLink(
  apiKeyValue: string,
  apiKeyUrl: string | undefined,
): boolean {
  return Boolean(apiKeyUrl) && apiKeyValue.trim().length === 0;
}

export function buildLoginApiKeyDefaultModelPreferenceFromSelection(
  view: ModelSelectionView,
  providerId: string,
): string | null {
  const firstModel = view.providers.find((provider) => provider.providerId === providerId)
    ?.models[0]?.modelId;
  return firstModel ? encodeCustomModelValue(providerId, firstModel) : null;
}
