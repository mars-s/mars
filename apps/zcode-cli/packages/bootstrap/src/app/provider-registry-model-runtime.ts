import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { Model, ModelRequestDependencies } from "@zcode/contracts";
import type { AgentRuntimeDeps } from "@zcode/core";
import {
  OAUTH_ACCESS_TYPE,
  type ModelSelection,
  type ModelSelectionValidation,
  type Provider,
  type ProviderModel,
  type ProviderRegistryView,
} from "@zcode/provider";
import { createRegistrySelectionProtocolError } from "./provider-registry-selection.js";

export type RuntimeModelFactory = NonNullable<AgentRuntimeDeps["modelFactory"]>;

export interface ProviderRegistryModelSource {
  getView(): ProviderRegistryView;
  getProvider(providerId: string): Provider | undefined;
  getModel(providerId: string, modelId: string): ProviderModel | undefined;
  validateSelection(selection: ModelSelection): ModelSelectionValidation;
  onDidChange(listener: () => void): () => void;
}

type ApiProviderModelAdapter = Pick<AiSdkModelAdapter, "createModel">;

interface ApiProviderModelRuntimeOptions {
  readonly registry: ProviderRegistryModelSource;
  readonly modelAdapter: ApiProviderModelAdapter;
}

/**
 * 从业务 Registry 精确查找一次完整事实，并直接创建冻结静态配置的 Model。
 */
export class ApiProviderModelRuntime {
  readonly #registry: ProviderRegistryModelSource;
  readonly #modelAdapter: ApiProviderModelAdapter;
  #started = false;

  constructor(options: ApiProviderModelRuntimeOptions) {
    this.#registry = options.registry;
    this.#modelAdapter = options.modelAdapter;
  }

  readonly modelFactory: RuntimeModelFactory = (target): Model => {
    if (!this.#started) throw new Error("ApiProviderModelRuntime 必须先 start() 再创建 Model");
    const validation = this.#registry.validateSelection(target.selection);
    if (!validation.ok) throw createRegistrySelectionProtocolError(validation);
    const providerId = target.selection.providerId;
    const modelId = target.selection.modelId;
    const provider = this.#registry.getProvider(providerId);
    if (!provider) throw new Error("Registry Selection 校验与 Provider 索引结果不一致");
    const registryModel = this.#registry.getModel(providerId, modelId);
    if (!registryModel) throw new Error("Registry Selection 校验与 Model 索引结果不一致");
    return this.#createRegistryModel(provider, registryModel, target);
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
  }

  dispose(): void {
    this.#started = false;
  }

  #createRegistryModel(
    provider: Provider,
    registryModel: ProviderModel,
    target: Parameters<RuntimeModelFactory>[0],
  ): Model {
    const config = registryModel.config;
    // 输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定。
    // Selection 已在上面的 Registry 边界完成校验，Factory 不再承担任何缺省修复。
    const normalReasoningLevel = target.selection.options!.reasoningLevel!;
    const requestDependencies = resolveRequestDependencies(provider, target.requestDependencies);
    return this.#modelAdapter.createModel({
      providerId: provider.providerId,
      modelId: registryModel.modelId,
      providerConfig: provider.config,
      modelConfig: config,
      options: {
        reasoningLevel: normalReasoningLevel,
      },
      ...(requestDependencies ? { requestDependencies } : {}),
    });
  }
}

/**
 * Whether this model must resolve a credential on every physical attempt.
 *
 * The caller's explicit dependency wins and is never second-guessed. Otherwise
 * the registry itself declares it, and only for the access shape that
 * structurally cannot carry a static key. Deriving it from "no apiKey" in
 * general would be wrong: every builtin template omits the key because keys come
 * from user settings, so that rule would drag all static providers onto the
 * per-request host credential path and fail them before they are sent.
 *
 * The synthesized declaration carries NO source on purpose. It says "this model
 * needs request-level auth"; the adapter fails closed until a host port or a
 * scoped source is bound. Minting a source here would mean the worker produced
 * provider credentials itself, which is the one thing that must never happen.
 */
function resolveRequestDependencies(
  provider: Provider,
  declared: ModelRequestDependencies | undefined,
): ModelRequestDependencies | undefined {
  if (declared) {
    return declared;
  }
  if (provider.config.access?.type !== OAUTH_ACCESS_TYPE) {
    return undefined;
  }
  return { requestAuth: {} };
}
