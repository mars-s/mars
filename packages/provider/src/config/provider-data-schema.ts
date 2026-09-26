import { z } from "zod";
import { sparseShape } from "@zcode/shared/config-schema";

export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export const providerGroupDataSchema = z.enum([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
]);
export const providerVisibilityDataSchema = z.enum(["visible", "hidden"]);
export const providerLogoDataSchema = z
  .object({ type: z.literal("builtin"), key: z.string().min(1) })
  .strict();

const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {
  message: "必填配置不能为空",
  params: { configIssueCode: "required-field-missing" },
});

/**
 * Access shape whose credential is minted by an OAuth grant and lives in a grant
 * store, never in this config.
 *
 * It is a discriminator of the CREDENTIAL SOURCE, not a provider family: nothing
 * branches on it to decide which vendor is being talked to, only to decide that no
 * static key exists for this provider. The account-provider access member that used
 * to sit here carried an account type instead, and that whole subsystem is gone.
 */
export const OAUTH_ACCESS_TYPE = "oauth" as const;

/** True for the grant-backed access shape, whose `apiKey` is structurally absent. */
export function isOAuthAccessType(value: unknown): boolean {
  return value === OAUTH_ACCESS_TYPE;
}

export const apiKeyAccessDataSchema = z
  .object({
    // `api-key` is the only type this build produces. The Z.ai coding-plan key is still
    // accepted so a config written before the removal cannot fail to parse and lock a
    // user out; no catalog template emits it and nothing branches on it any more. Drop
    // the literal once the one-way read is no longer worth carrying.
    // `oauth` is the one non-key shape: the credential comes from a grant, not here.
    type: z.enum(["api-key", OAUTH_ACCESS_TYPE, "zhipu-coding-plan-api-key"]),
    apiKey: z.string().nullable().optional(),
    apiKeyManagementUrl: z.string().url().nullable().optional(),
  })
  .strict();
// The key is NOT demanded here. Whether a key is required is an access-shape
// question, and it is answered in `ApiKeyAccessConfig.validateComplete` because the
// rule differs per shape. Demanding it in the schema would make every grant-backed
// provider fail completeness and therefore never enter the registry at all.
export const completeApiKeyAccessDataSchema = apiKeyAccessDataSchema.extend({
  apiKey: z.string().nullable().optional(),
});

export const providerAccessDataSchema = apiKeyAccessDataSchema;
const completeProviderAccessDataSchema = completeApiKeyAccessDataSchema;

export const completeProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema,
    baseUrl: nonBlankRequiredString.pipe(z.string().url()),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict();
export const providerApiDataSchema = z
  .object({
    ...sparseShape(completeProviderApiDataSchema.shape),
    baseUrl: z.string().url().nullable().optional(),
  })
  .strict();
// Personal 允许暂存编辑中的 endpoint；完整 schema 仍拒绝，且只影响该 Provider 的准入。
export const personalProviderApiDataSchema = providerApiDataSchema.extend({
  baseUrl: z.string().nullable().optional(),
});

const modelIdsDataSchema = z.array(z.string().min(1)).readonly().nullable().optional();
export const providerConfigDataSchema = z
  .object({
    group: providerGroupDataSchema.nullable().optional(),
    logo: providerLogoDataSchema.nullable().optional(),
    access: providerAccessDataSchema.nullable().optional(),
    api: providerApiDataSchema.nullable().optional(),
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict();
export const completeProviderConfigDataSchema = providerConfigDataSchema.extend({
  group: providerGroupDataSchema,
  access: completeProviderAccessDataSchema,
  api: completeProviderApiDataSchema,
});

export const providerTemplateNameMapDataSchema = z
  .object({
    "zh-CN": z.string().min(1).optional(),
    "en-US": z.string().min(1).optional(),
  })
  .strict();
export const providerTemplateDataSchema = z
  .object({
    templateId: z.string().min(1),
    templateNameMap: providerTemplateNameMapDataSchema,
    config: providerConfigDataSchema,
  })
  .strict();
