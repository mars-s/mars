import { normalizeOfficialGlmModelId } from "./official-glm-model-id.js";

// 不凭用户自定义 Provider 的名字猜所属站点；闲时 Ticket 的绑定身份也不能改。
export function migrateLegacyOfficialGlmModelId(providerId: string, modelId: string): string {
  return /^(?:builtin:(?:zai|bigmodel)(?:-start-plan|-coding-plan)?|account:(?:zai|bigmodel)-(?:start-plan|individual-coding-plan|team-coding-plan))$/.test(
    providerId,
  )
    ? normalizeOfficialGlmModelId(modelId)
    : modelId;
}

/**
 * 仅供已发布旧数据的单向升级使用，不是运行时 Provider 别名或选择兜底。
 * 依赖当前账号解释旧 Coding Plan 会使离线/SSH 迁移丢失原意图。
 * 同域 Individual 仅是确定性迁移落点，当前账号对应留给有效选择解析，不能据此绑定执行。
 * 迁移不查模型/档位是否可用；普通未知 ID 不构成旧格式证据。
 *
 * The old `builtin:zai` / `builtin:bigmodel` ids used to name built-in
 * pay-per-token templates. Every template they could migrate to has been
 * deleted from the catalog, so there is nothing left to rewrite them to: they
 * all fall through to the `default` branch together with every other
 * unrecognised `builtin:` id, which migrates the row to "no provider" and leaves
 * it to valid-selection resolution. Do not add a replacement target here.
 */
export function migrateLegacyModelProviderId(providerId: string): string | undefined {
  return providerId.startsWith("builtin:") ? undefined : providerId;
}
