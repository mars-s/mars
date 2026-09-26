// ============================================================
// Vercel AI SDK model runner
// ============================================================

import {
  ModelErrorCode,
  ModelProtocolError,
  getCurrentModelInvocationContext,
  type ModelRequestAuth,
  type ModelRequestDependencies,
} from "@zcode/contracts";
import type {
  Logger,
  Model,
  ModelOptions,
  ModelStatusSink,
  ModelStreamEvent,
  ModelTextResult,
} from "@zcode/contracts";
import type { RegistryModelConfig, RegistryProviderConfig } from "@zcode/provider";
import {
  AiSdkModelExecution,
  type AiSdkNetworkConfig,
  type AiSdkModelExecutionConfig,
  type EnvRecord,
} from "./model-execution.js";
import {
  resolveAiSdkModelRetryOptions,
  type AiSdkModelRetryOptions,
  type ResolvedAiSdkModelRetryOptions,
} from "./retry-policy.js";
import { DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS } from "./stream-idle-timeout.js";
import { runGenerateText } from "./runner-generate.js";
import { runStreamText } from "./runner-stream.js";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.js";
import {
  defaultRuntime,
  type AiSdkModelRuntime,
  type AiSdkModelTextRequest,
  type ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { createModel, type ModelExecutionRequest } from "./model.js";
import { composeRequestAuthRefresh } from "./runner-request-auth.js";

export type { AiSdkModelRetryOptions } from "./retry-policy.js";
export type {
  AiSdkGenerateTextOptions,
  AiSdkGenerateTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
} from "./runner-runtime.js";
export { normalizeUsage, toModelStreamEvent } from "./runner-normalization.js";

export interface AiSdkModelAdapterOptions {
  defaultHeaders?: AiSdkModelExecutionConfig["defaultHeaders"];
  network?: AiSdkNetworkConfig;
  runtime?: AiSdkModelRuntime;
  env?: EnvRecord;
  debugDir?: string;
  logger?: Logger;
  retry?: AiSdkModelRetryOptions;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs?: number;
  modelIoFullRetentionEnabled?: boolean;
}

export interface CreateAiSdkModelOptions {
  providerId: string;
  modelId: string;
  providerConfig: RegistryProviderConfig;
  modelConfig: RegistryModelConfig;
  /**
   * Execution-scope credential dependencies for this model.
   *
   * The PRESENCE of `requestAuth` is the declaration that this model cannot be
   * served by a bind-time snapshot: its credential has to be resolved again on
   * every physical attempt. It is never inferred from "the provider has no static
   * api key", because every builtin template omits the key (keys come from user
   * settings), so that rule would push all static providers onto the host refresh
   * path and break them. A present dependency with no source fails closed.
   */
  requestDependencies?: ModelRequestDependencies;
  displayName?: string;
  options?: ModelOptions;
}

export class AiSdkModelAdapter {
  private readonly execution: AiSdkModelExecution;
  private readonly runtime: AiSdkModelRuntime;
  private readonly env: EnvRecord;
  private readonly debugDir?: string;
  private readonly logger?: Logger;
  private readonly retry: ResolvedAiSdkModelRetryOptions;
  private statusSink?: ModelStatusSink;
  private readonly streamIdleTimeoutMs: number;
  private modelIoFullRetentionEnabled: boolean;

  constructor(options: AiSdkModelAdapterOptions) {
    this.execution = new AiSdkModelExecution(
      {
        defaultHeaders: options.defaultHeaders,
        ...(options.network ? { network: options.network } : {}),
        ...(options.env ? { env: options.env } : {}),
      },
      {
        ...(options.logger ? { logger: options.logger } : {}),
      },
    );
    this.runtime = options.runtime ?? defaultRuntime;
    this.env = options.env ?? process.env;
    this.debugDir = options.debugDir;
    this.logger = options.logger;
    this.retry = resolveAiSdkModelRetryOptions(options.retry, this.env);
    this.statusSink = options.statusSink;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
    this.modelIoFullRetentionEnabled = options.modelIoFullRetentionEnabled ?? false;
  }

  setModelIoFullRetentionEnabled(enabled: boolean): void {
    this.modelIoFullRetentionEnabled = enabled;
  }

  addStatusSink(sink: ModelStatusSink): void {
    const current = this.statusSink;
    if (!current || current === sink) {
      this.statusSink = sink;
      return;
    }
    this.statusSink = {
      async publish(event) {
        // 多个 sink 必须独立执行：任一 sink 失败不得连带影响其他 sink，
        // 也不能阻塞原有调用链。
        const results = await Promise.allSettled([
          Promise.resolve().then(() => current.publish(event)),
          Promise.resolve().then(() => sink.publish(event)),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      },
    };
  }

  createModel(options: CreateAiSdkModelOptions): Model {
    const boundResolution = this.execution.bindModel({
      providerId: options.providerId,
      modelId: options.modelId,
      providerConfig: options.providerConfig,
      supportsJsonSchemaOutput: options.modelConfig.properties.supportsJsonSchemaOutput,
      optionSpecs: options.modelConfig.optionSpecs,
    });
    const properties = options.modelConfig.properties;
    const resolved = {
      ...boundResolution.resolved,
      properties,
    };
    const optionSpecs = options.modelConfig.optionSpecs;
    const requestAuthDependency = options.requestDependencies?.requestAuth;
    const toLegacyRequest = (request: ModelExecutionRequest): AiSdkModelTextRequest => {
      const context = getCurrentModelInvocationContext();
      const { refreshRuntimeHeadersBeforeAttempt: hostRefresh, ...invocationContext } = context ?? {};
      const shouldAttachReasoningTelemetry = request.options.reasoningLevel !== undefined;
      const selectedReasoningLevel = request.options.reasoningLevel;
      return {
        messages: request.messages,
        tools: request.tools,
        responseJsonSchema: request.responseJsonSchema,
        abortSignal: request.abortSignal,
        maxOutputTokens: request.options.maxOutputTokens,
        ...invocationContext,
        // Forwarded ONLY for a model that declared the dependency. Unconditional
        // forwarding is what the old comment was afraid of, and it was right: it
        // would put every static api-key provider on the host refresh path. What
        // the old reasoning got wrong was the conclusion, not the fear: a dynamic
        // credential must never be frozen into the bind-time snapshot, because it
        // expires and rotates between two physical requests.
        ...(requestAuthDependency
          ? {
              refreshRuntimeHeadersBeforeAttempt: composeRequestAuthRefresh({
                ...(hostRefresh ? { hostRefresh } : {}),
                // The destination every request from this bound model is built
                // from. The host's answer is checked against it, so a credential
                // it released for somewhere else is refused rather than sent
                // here.
                requestBaseUrl: String(boundResolution.resolved.baseURL),
                ...(requestAuthDependency.source ? { source: requestAuthDependency.source } : {}),
              }),
            }
          : {}),
        ...(shouldAttachReasoningTelemetry
          ? {
              modelCall: {
                ...invocationContext.modelCall,
                reasoning: {
                  ...invocationContext.modelCall?.reasoning,
                  // 过去按 none/off 等档位名称猜测 enabled/disabled，导致 Telemetry
                  // 把 Provider 方言当成统一语义。这里只记录请求实际选择的公开档位。
                  ...(selectedReasoningLevel ? { requestedLevel: selectedReasoningLevel } : {}),
                },
              },
            }
          : {}),
      };
    };
    // The per-attempt credential is threaded in here rather than captured at bind
    // time: `resolveModelForAttempt` calls this once with no auth to build the
    // bound model, then again with the freshly resolved auth for the real request.
    const resolveForRequest = (
      optionValues: Required<ModelOptions>,
      requestAuth?: ModelRequestAuth,
    ): ResolvedAiSdkModel => {
      const maxOutputTokens = requireMaxOutputTokens(optionValues);
      return {
        ...boundResolution.resolveRequest({
          options: {
            maxOutputTokens,
            reasoningLevel: optionValues.reasoningLevel,
          },
          ...(requestAuth ? { requestAuth } : {}),
        }),
        properties,
      };
    };
    return createModel({
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      displayName: options.displayName,
      properties,
      optionSpecs: {
        maxOutputTokens: optionSpecs.maxOutputTokens,
        reasoningLevel: optionSpecs.reasoningLevel,
      },
      options: options.options,
      executor: {
        generateText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.generateTextWithResolved(legacyRequest, resolved, () =>
            resolveForRequest(request.options),
          );
        },
        streamText: (request) => {
          const legacyRequest = toLegacyRequest(request);
          return this.streamTextWithResolved(legacyRequest, resolved, () =>
            resolveForRequest(request.options),
          );
        },
      },
    });
  }

  private generateTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: (requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel,
  ): Promise<ModelTextResult> {
    const projectedRequest = projectRequestHistory(request, resolved);
    return runGenerateText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      retry: this.retry,
      runtime: this.runtime,
      statusSink: this.statusSink,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }

  private async *streamTextWithResolved(
    request: AiSdkModelTextRequest,
    resolved: ResolvedAiSdkModel,
    resolveModel: (requestAuth?: ModelRequestAuth) => ResolvedAiSdkModel,
  ): AsyncGenerator<ModelStreamEvent> {
    const projectedRequest = projectRequestHistory(request, resolved);
    yield* runStreamText({
      debugDir: this.debugDir,
      env: this.env,
      logger: this.logger,
      request: projectedRequest,
      resolveModel,
      resolved,
      retry: this.retry,
      runtime: this.runtime,
      statusSink: this.statusSink,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      modelIoFullRetentionEnabled: this.modelIoFullRetentionEnabled,
    });
  }
}

function requireMaxOutputTokens(options: ModelOptions): number {
  if (options.maxOutputTokens === undefined) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "maxOutputTokens requires an explicit request value",
    );
  }
  return options.maxOutputTokens;
}

function projectRequestHistory(
  request: AiSdkModelTextRequest,
  resolved: ResolvedAiSdkModel,
): AiSdkModelTextRequest {
  if (resolved.providerKind !== "anthropic") return request;

  // 结构归一化过去位于每次物理请求都会经过的 serializer，签名修复重试
  // 因而会再次删除上一轮刚补出的 assistant 占位并合并 user。逻辑请求入口只投影一次，
  // 后续 attempt 只能复用或从这份 request-local history 派生。
  const messages = normalizeReasoningHistory(request.messages, {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
  });
  return messages === request.messages ? request : { ...request, messages };
}
