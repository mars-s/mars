/**
 * Provider family table. The catalog is intentionally empty: no vendor family
 * survives the removal wave, and no placeholder family is introduced to keep a
 * signature compiling. The module still exports the (now empty) family types so
 * that module-level imports across the tree keep resolving; every helper that
 * existed only to resolve a family is gone with the table.
 *
 * The provider-connection authorisation that used to sit next to this table does
 * NOT live here. It lives in @zcode/provider's config-service and still guards
 * every personal provider.
 */
export const MODEL_PROVIDER_FAMILY_SPECS = [] as const;

/** Empty union: no family exists, so this is `never`. */
export type ModelProviderFamilyId = (typeof MODEL_PROVIDER_FAMILY_SPECS)[number]["id"];

/** @see ModelProviderFamilyId */
export type ProviderFamilyDomain = ModelProviderFamilyId;

/** A family entry with its `id` narrowed back to the family union. */
export type ModelProviderFamilySpec = (typeof MODEL_PROVIDER_FAMILY_SPECS)[number];
