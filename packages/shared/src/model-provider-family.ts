import { BIGMODEL_PROVIDER_ID, type OAuthProviderId, ZAI_PROVIDER_ID } from "./oauth.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";
import { ZCODE_ENV } from "./env.js";
import { buildBigModelCodingPlanTeamManageUrl } from "./zcodeEndpoint.js";

/**
 * The shape every family entry must satisfy. Deliberately `string`-typed rather
 * than a closed union of the vendor ids: adding or removing a family is a data
 * edit to MODEL_PROVIDER_FAMILY_SPECS below, not a change to thirteen type
 * signatures scattered across the tree. See DECISIONS.md entry 3.
 */
interface ModelProviderFamilySpecShape {
  id: string;
  label: string;
  rootDomain: string;
  oauthProviderId: string;
  startPlanProviderId: string;
  individualCodingPlanProviderId: string;
  teamCodingPlanProviderId: string;
  teamCodingPlanManageUrl: string;
}

export const MODEL_PROVIDER_FAMILY_SPECS = [
  {
    id: "zai",
    label: "Z.ai",
    rootDomain: "z.ai",
    oauthProviderId: ZAI_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    teamCodingPlanManageUrl: "https://z.ai/manage-apikey/subscription",
  },
  {
    id: "bigmodel",
    label: "BigModel",
    rootDomain: "bigmodel.cn",
    oauthProviderId: BIGMODEL_PROVIDER_ID,
    startPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    individualCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    teamCodingPlanProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    teamCodingPlanManageUrl: buildBigModelCodingPlanTeamManageUrl({ ZCODE_ENV }),
  },
] as const satisfies readonly ModelProviderFamilySpecShape[];

/**
 * The single source of truth for which provider families exist. `ModelProviderFamilyId`
 * is derived from this array, so adding a family is one entry here and removing one
 * is deleting one entry here.
 */
export type ModelProviderFamilyId = (typeof MODEL_PROVIDER_FAMILY_SPECS)[number]["id"];

export type ProviderFamilyDomain = ModelProviderFamilyId;

/** A family entry with its `id` narrowed back to the family union. */
export type ModelProviderFamilySpec = (typeof MODEL_PROVIDER_FAMILY_SPECS)[number];

const MODEL_PROVIDER_FAMILY_IDS: ReadonlySet<string> = new Set(
  MODEL_PROVIDER_FAMILY_SPECS.map((spec) => spec.id),
);

/** Narrows an untrusted string, e.g. one that crossed a channel boundary. */
export function isModelProviderFamilyId(value: unknown): value is ModelProviderFamilyId {
  return typeof value === "string" && MODEL_PROVIDER_FAMILY_IDS.has(value);
}

const MODEL_PROVIDER_FAMILY_SPEC_BY_ID = new Map<ModelProviderFamilyId, ModelProviderFamilySpec>(
  MODEL_PROVIDER_FAMILY_SPECS.map((spec) => [spec.id, spec]),
);

// Keyed by string rather than BuiltinModelProviderId so a family may name any
// provider id, not only the six currently in BUILTIN_MODEL_PROVIDER_IDS.
const MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID = new Map<string, ModelProviderFamilyId>(
  MODEL_PROVIDER_FAMILY_SPECS.flatMap((spec) =>
    [
      spec.startPlanProviderId,
      spec.individualCodingPlanProviderId,
      spec.teamCodingPlanProviderId,
    ].map((providerId) => [providerId, spec.id] as const),
  ),
);

export function getModelProviderFamilySpec(
  familyId: ModelProviderFamilyId,
): ModelProviderFamilySpec {
  return MODEL_PROVIDER_FAMILY_SPEC_BY_ID.get(familyId)!;
}

export function resolveModelProviderFamilyIdByProviderId(
  providerId: string,
): ModelProviderFamilyId | null {
  return MODEL_PROVIDER_FAMILY_ID_BY_PROVIDER_ID.get(providerId) ?? null;
}

export function resolveModelProviderFamilyIdByBaseURL(
  baseURL: string | null | undefined,
): ModelProviderFamilyId | null {
  const trimmed = baseURL?.trim();
  if (!trimmed) {
    return null;
  }
  let hostname: string;
  try {
    hostname = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const spec of MODEL_PROVIDER_FAMILY_SPECS) {
    if (hostname === spec.rootDomain || hostname.endsWith(`.${spec.rootDomain}`)) {
      return spec.id;
    }
  }
  return null;
}

export function resolveModelProviderFamilySpecByProviderId(
  providerId: string,
): ModelProviderFamilySpec | null {
  const familyId = resolveModelProviderFamilyIdByProviderId(providerId);
  return familyId ? getModelProviderFamilySpec(familyId) : null;
}

export function resolveModelProviderFamilyLabelByProviderId(providerId: string): string | null {
  return resolveModelProviderFamilySpecByProviderId(providerId)?.label ?? null;
}

export function normalizeProviderFamilyDomain(
  value: string | null | undefined,
): ProviderFamilyDomain | null {
  return isModelProviderFamilyId(value) ? value : null;
}

export function resolveProviderFamilyDomainFromOAuthProvider(
  provider: OAuthProviderId | string | null | undefined,
): ProviderFamilyDomain | null {
  if (provider === ZAI_PROVIDER_ID) {
    return "zai";
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return "bigmodel";
  }
  return null;
}

export function shouldShowModelProviderFamilyForDomain(params: {
  familyId: ModelProviderFamilyId;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const providerFamilyDomain = normalizeProviderFamilyDomain(params.providerFamilyDomain);
  if (!providerFamilyDomain) {
    return true;
  }
  return params.familyId === providerFamilyDomain;
}

export function shouldShowModelProviderFamilyForActiveOAuth(params: {
  familyId: ModelProviderFamilyId;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowModelProviderFamilyForDomain({
    familyId: params.familyId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}

export function shouldShowBuiltinModelProviderForDomain(params: {
  providerId: string;
  providerFamilyDomain: ProviderFamilyDomain | null | undefined;
}): boolean {
  const familyId = resolveModelProviderFamilyIdByProviderId(params.providerId);
  if (!familyId) {
    return true;
  }
  return shouldShowModelProviderFamilyForDomain({
    familyId,
    providerFamilyDomain: params.providerFamilyDomain,
  });
}

export function shouldShowBuiltinModelProviderForActiveOAuth(params: {
  providerId: string;
  activeOAuthProvider: OAuthProviderId | null | undefined;
}): boolean {
  return shouldShowBuiltinModelProviderForDomain({
    providerId: params.providerId,
    providerFamilyDomain: resolveProviderFamilyDomainFromOAuthProvider(params.activeOAuthProvider),
  });
}
