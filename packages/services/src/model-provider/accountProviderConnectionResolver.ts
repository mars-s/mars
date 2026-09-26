import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AccountProviderUnavailableReason,
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
  ZhipuAccountMode,
} from "@zcode/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@zcode/provider";
import {
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";

export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** Host 旧连接导入尚不能确定身份；仅运行时事实，不写入配置或协议。 */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

/**
 * Connection facts this layer can still prove for one configured account
 * provider. The Z.ai / BigModel coding-plan entitlement APIs were deleted with
 * the catalog entries, so no subscription can be queried here any more and the
 * only remaining local facts are the logged-in account and the plan mode
 * itself. Every branch below is fail-closed.
 */
type AccountPlanConnectionAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: AccountProviderUnavailableReason }
  | { readonly kind: "unknown" };

export interface AccountProviderConnectionResolverOptions {
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

/**
 * Projects the configured account families, connection modes and plan
 * entitlements into the domain Connection Result.
 *
 * This adapter holds no credentials. The Personal Coding Plan Key had its
 * physical source injected here, and the Start/Team entitlement query that
 * backed Start/Team is gone with the provider catalog, so a connection is now
 * decided from the logged-in account and the plan mode alone.
 */
export function createAccountProviderConnectionResolver(
  options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
  let previousScopes = new Map<string, string>();
  return async ({ configuredProviders }) => {
    const settings = structuredClone(await options.readSettings());
    const accountIdentityByFamily = new Map<ProviderFamilyDomain, Promise<string | null>>();
    const loadAccountIdentity = (family: ProviderFamilyDomain) => {
      const existing = accountIdentityByFamily.get(family);
      if (existing) return existing;
      const pending = options.loadAccountIdentity(family).then((identity) => {
        const normalized = identity?.trim() ?? "";
        return normalized || null;
      });
      accountIdentityByFamily.set(family, pending);
      return pending;
    };
    const availabilityByProviderId = new Map<string, AccountPlanConnectionAvailability>();

    for (const family of ["zai", "bigmodel"] as const) {
      const configured = configuredProviders
        .entries()
        .flatMap(([providerId, config]) =>
          config.access?.type === "zhipu-account" &&
          config.access.accountType === family &&
          config.access.mode &&
          config.access.mode !== "off-peak"
            ? [{ providerId, config, planKind: config.access.mode }]
            : [],
        );
      if (configured.length === 0) continue;

      // 旧团队身份补全只限制付费访问，Start 只依赖当前登录账号。
      const queryable = configured.filter(({ providerId, planKind }) => {
        if (settings.unresolvedFamilies?.includes(family) && planKind !== "start-plan") {
          availabilityByProviderId.set(providerId, { kind: "unknown" });
          return false;
        }
        return true;
      });
      if (queryable.length === 0) continue;

      const accountIdentity = await loadAccountIdentity(family);
      for (const { providerId, planKind } of queryable) {
        availabilityByProviderId.set(
          providerId,
          resolvePlanConnectionAvailability(planKind, Boolean(accountIdentity)),
        );
      }
    }

    const connections: AccountProviderConnectionResult[] = [];
    const scopes = new Map<string, string>();
    for (const [providerId, config] of configuredProviders.entries()) {
      const access = config.access;
      if (access?.type !== "zhipu-account") continue;
      if (!access.accountType || !access.mode) {
        connections.push({ providerId, status: "unavailable" });
        continue;
      }
      const selection = settings.selections[access.accountType];
      // last-known-good 只对同账号、同 Team 身份成立。切账号后的网络失败不能复活旧权益。
      const scope = JSON.stringify([
        await loadAccountIdentity(access.accountType),
        access.mode === "team-coding-plan" && selection?.kind === "team-coding-plan"
          ? [selection.organizationId, selection.projectId, selection.productId]
          : null,
      ]);
      scopes.set(providerId, scope);
      const resetPrevious =
        previousScopes.has(providerId) && previousScopes.get(providerId) !== scope;
      if (access.mode === "off-peak") {
        // Off-peak quota is produced by an entitled Coding Plan, and the
        // entitlement query that could confirm one is gone. No Coding Plan can
        // resolve to `available` any more, so Off-peak is reported unavailable
        // instead of being carried forward from a previous snapshot.
        connections.push({ providerId, status: "unavailable", unavailableReason: "not-entitled" });
        continue;
      }
      const availability = availabilityByProviderId.get(providerId) ?? {
        kind: "unknown" as const,
      };
      connections.push({
        providerId,
        status: availability.kind,
        // 原因必须随连接结果一起发布。UI 拿不到原因时只能把"已登录但无套餐"
        // 也显示成"未连接"。
        ...(availability.kind === "unavailable" ? { unavailableReason: availability.reason } : {}),
        // Start 跟随登录身份，付费套餐跟随连接选择；两者可同时 current，不改写权益或配置。
        current:
          settings.providerFamilyDomain === access.accountType &&
          (access.mode === "start-plan"
            ? Boolean(await loadAccountIdentity(access.accountType))
            : selection?.kind === access.mode),
        // 两个 Team 共用 Provider ID，观察器必须按同一快照中的完整身份比较，
        // 不能把手动换套餐/账号误当成原套餐失效。它只进入 Account State，不进入 Config。
        connectionKey: createHash("sha256")
          .update(
            JSON.stringify([
              await loadAccountIdentity(access.accountType),
              access.accountType,
              access.mode === "start-plan" ? { kind: "start-plan" } : (selection ?? null),
            ]),
          )
          .digest("hex"),
        ...(resetPrevious ? { resetPrevious: true } : {}),
      });
    }
    // The round still awaits the account identity, so a login or a plan switch
    // can land halfway through. Re-check this round's identity and settings
    // before publishing: a result assembled from a stale snapshot must be
    // dropped, not merged with the new one. A failed check must not advance
    // previousScopes either, or the next round would accept the unpublished
    // account as last-known-good. Retries stay driven by the existing refresh
    // events.
    const identitiesUnchanged = await Promise.all(
      [...accountIdentityByFamily].map(
        async ([family, captured]) =>
          (await captured) === ((await options.loadAccountIdentity(family))?.trim() || null),
      ),
    );
    if (
      identitiesUnchanged.some((unchanged) => !unchanged) ||
      !isDeepStrictEqual(settings, await options.readSettings())
    ) {
      throw new Error("账号查询期间连接或身份发生变化，丢弃过期结果");
    }
    previousScopes = scopes;
    return Object.freeze(connections);
  };
}

/**
 * Decide one account provider's connection from local facts only.
 *
 * A missing account identity is still a hard rejection, exactly as before: a
 * signed-out account can never resolve to an available connection. What changed
 * is the positive case. The subscription entitlement query is gone, so a
 * configured individual or team Coding Plan has no entitlement source left and
 * is reported as not-entitled instead of being assumed. That is what keeps the
 * Team plan branch from selecting a connection on nothing but a stored setting.
 * Start Plan is not a subscription: it follows the logged-in account, so the
 * account identity is its whole gate, which is also the gate
 * `resolveCurrentAccountAccess` applies on the request path.
 */
function resolvePlanConnectionAvailability(
  planKind: ZhipuAccountMode,
  connected: boolean,
): AccountPlanConnectionAvailability {
  if (!connected) return { kind: "unavailable", reason: "not-connected" };
  if (planKind === "start-plan") return { kind: "available" };
  if (planKind === "individual-coding-plan" || planKind === "team-coding-plan") {
    return { kind: "unavailable", reason: "not-entitled" };
  }
  return { kind: "unknown" };
}

/** 组装 Config、账号连接解析与第三层 Account Provider Config Source。 */
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/**
 * 把 Active Model 的静态 Access 约束投影到当前账号连接。
 *
 * Team scope 和账号版本不能冻结进 Model：账号切换后旧 Model 会错误失效。
 * 每次请求重新读取当前选择；只有 family 与 mode 兼容时才返回动态访问事实。
 */
export async function resolveCurrentAccountAccess(input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  const settings = await input.readSettings();
  const { accountType, mode } = input.access;
  if (settings.providerFamilyDomain !== accountType) return null;
  if (mode === "start-plan") {
    if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
    return { type: "zhipu-account", family: accountType, planKind: "start-plan" };
  }
  const selection = settings.selections[accountType];
  if (!selection) return null;
  if (mode === "off-peak") {
    if (selection.kind !== "individual-coding-plan" && selection.kind !== "team-coding-plan") {
      return null;
    }
  } else if (selection.kind !== mode) {
    return null;
  }
  if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
  if (selection.kind === "team-coding-plan") {
    return {
      type: "zhipu-account",
      family: accountType,
      planKind: selection.kind,
      productId: selection.productId,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
    };
  }
  return {
    type: "zhipu-account",
    family: accountType,
    planKind: selection.kind,
  };
}
