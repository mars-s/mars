/* eslint-disable max-lines -- Off-Peak 凭证解析、支持矩阵与 Request Auth 共用同一组契约，拆散会让双凭证边界更难追踪。 */
/* Host 派发时按当前票据构造逐请求鉴权材料；Provider/Model 静态事实由 Built-in Config 提供。 */
import {
  buildRuntimeZCodeApiUrl,
  type OffPeakCodingPlanSupport,
  type OffPeakCodingPlanUnsupportedReason,
} from "@zcode/shared";
import { isOffPeakMockEnabled, startOffPeakMockGateway } from "./offPeakMockGateway.js";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/** 仅用于确定性配置错误；host 据类型输出 permanent，禁止依赖错误文本分流。 */
export class OffPeakPermanentDispatchError extends Error {
  readonly failureKind = "permanent" as const;

  constructor(message: string) {
    super(message);
    this.name = "OffPeakPermanentDispatchError";
  }
}

/** 双凭证解析失败的类型化错误（UI 可据此提示登录/配置 coding plan）。 */
export class OffPeakCredentialsUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly missing: "jwt" | "codingPlanApiKey") {
    super(
      missing === "jwt"
        ? "off-peak requires zcode login (jwt missing)"
        : "off-peak requires a coding plan provider api key",
    );
    this.name = "OffPeakCredentialsUnavailableError";
  }
}

/** 当前 provider family / selected connection 不属于 Off-Peak 支持矩阵。 */
export class OffPeakCodingPlanUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly reason: OffPeakCodingPlanUnsupportedReason) {
    super(`off-peak selected coding plan unavailable: ${reason}`);
    this.name = "OffPeakCodingPlanUnavailableError";
  }
}

/** 用户常驻模型或 idle plan 模型缺失时停止空耗 ticket 的类型化错误。 */
export class OffPeakModelUnavailableError extends OffPeakPermanentDispatchError {
  constructor(readonly scope: "idlePlan" | "workspaceUser") {
    super(
      scope === "idlePlan"
        ? "off-peak dispatch has no usable model (Built-in Provider models empty)"
        : "off-peak dispatch has no usable user workspace model",
    );
    this.name = "OffPeakModelUnavailableError";
  }
}

export interface OffPeakCredentialSnapshot {
  jwt: string;
  codingPlanApiKey: string;
}

interface OffPeakCredentialResolverDeps {
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the dual Off-Peak credentials.
 *
 * The selected Coding Plan connection used to be discovered through the account
 * provider subsystem, which is deleted. No Coding Plan provider remains that could
 * mint a matching plan key, so a real request can never satisfy this contract and
 * the resolver fails closed with `connection_unavailable`. The mock branch stays
 * because the in-process mock gateway does not verify credentials.
 */
export async function resolveOffPeakCredentials(
  deps: OffPeakCredentialResolverDeps,
  options: { allowMockCredentials?: boolean } = {},
): Promise<OffPeakCredentialSnapshot> {
  const env = deps.env ?? process.env;
  if (options.allowMockCredentials !== false && env["ZCODE_OFFPEAK_MOCK"] === "1") {
    if (env["ZCODE_OFFPEAK_MOCK_NO_PLAN"] === "1") {
      throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
    }
    // The mock gateway does not verify credentials; deterministic values keep the
    // UI and the ticket/runtime paths on one support shape.
    return {
      jwt: "offpeak-mock-jwt",
      codingPlanApiKey: "offpeak-mock-key",
    };
  }
  throw new OffPeakCodingPlanUnavailableError("connection_unavailable");
}

/**
 * Construct the per-dispatch dynamic auth material for one idle execution.
 *
 * Endpoint, model capability and reasoning stay in the Built-in Provider / Model
 * Config and are never shipped with a single dispatch.
 */
export function buildOffPeakRequestAuth(params: {
  credentials: OffPeakCredentialSnapshot;
  ticketId: string;
}): { apiKey: string; headers: Record<string, string> } {
  return {
    // Anthropic-compatible clients send x-api-key; the server still adjudicates on
    // Authorization and the plan key.
    apiKey: params.credentials.jwt,
    headers: {
      Authorization: `Bearer ${params.credentials.jwt}`,
      "X-Coding-Plan-Api-Key": params.credentials.codingPlanApiKey,
      "X-Off-Peak-Ticket-ID": params.ticketId,
    },
  };
}

/** renderer 可见的脱敏支持快照；凭证原文始终留在 host/service 内存。 */
export async function resolveOffPeakCodingPlanSupport(
  deps: OffPeakCredentialResolverDeps,
): Promise<OffPeakCodingPlanSupport> {
  try {
    await resolveOffPeakCredentials(deps);
  } catch (error) {
    if (error instanceof OffPeakCodingPlanUnavailableError) {
      return { supported: false, reason: error.reason };
    }
    if (error instanceof OffPeakCredentialsUnavailableError) {
      return {
        supported: false,
        reason: error.missing === "jwt" ? "jwt_missing" : "connection_unavailable",
      };
    }
    throw error;
  }
  // No Coding Plan provider survives the account-provider removal, so a successful
  // credential resolution is unreachable. Fail closed rather than report support.
  return { supported: false, reason: "connection_unavailable" };
}

/**
 * origin 解析器（memoized）：mock 模式懒启动进程内网关（固定端口，多实例经 EADDRINUSE
 * 复用同一份票据状态），真实模式指向 zcode API origin。node 服务装配与 host 派发两侧
 * 各持一个解析器也安全——谁先绑定谁持有网关，另一方外部复用。
 */
export function createOffPeakOriginResolver(deps: {
  logger: ServiceLogger;
  // null means "do not proxy": the mock gateway answers with its own fixed response.
  resolveUpstream: () => Promise<{ url: string; headers: Record<string, string> } | null>;
  env?: NodeJS.ProcessEnv;
}): { resolveOrigin: () => Promise<string>; close: () => Promise<void> } {
  const env = deps.env ?? process.env;
  let originPromise: Promise<string> | null = null;
  let closeGateway: (() => Promise<void>) | null = null;
  return {
    resolveOrigin: () => {
      if (!originPromise) {
        originPromise = (async () => {
          if (!isOffPeakMockEnabled(env)) {
            return new URL(buildRuntimeZCodeApiUrl(env, "/")).origin;
          }
          const gateway = await startOffPeakMockGateway({
            logger: deps.logger,
            resolveUpstream: deps.resolveUpstream,
          });
          if (!gateway.external) closeGateway = gateway.close;
          return gateway.origin;
        })().catch((error) => {
          originPromise = null; // 失败后允许重试（如端口短暂占用）
          throw error;
        });
      }
      return originPromise;
    },
    close: async () => {
      const close = closeGateway;
      closeGateway = null;
      if (close) await close();
    },
  };
}
