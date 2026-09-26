import { resolveRuntimeZCodeEndpointOrigin } from "@zcode/shared";
import type { EnvRecord } from "./model-execution.js";

/**
 * Rewrites the official coding plan model endpoint onto a ZCode platform gateway path.
 *
 * The table ships empty on purpose. Every entry used to name a specific vendor host, and a
 * lookup is a rewrite rule, not a source of endpoints: leaving an entry in place would keep
 * sending that vendor's model traffic to a ZCode platform gateway, and dropping the host from
 * the entry would silently repoint operator configured traffic back at the vendor. Emptying
 * the table is the only option that neither pins a vendor host nor guesses a replacement.
 *
 * With no entries the map is empty, resolveOfficialCodingPlanGatewayUrl always reports
 * viaGateway false and returns the request URL unchanged, and the fetch wrapper passes every
 * request through to the lower fetch. The gateway origin still follows
 * ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN, and is only resolved on an actual match.
 */
export interface OfficialCodingPlanGatewayRoute {
  /** Official model endpoint including its path, https only. */
  readonly providerEndpoint: string;
  /** Gateway endpoint path, relative to the ZCode platform origin. */
  readonly gatewayPath: string;
}

export const OFFICIAL_CODING_PLAN_GATEWAY_ROUTES: readonly OfficialCodingPlanGatewayRoute[] = [];

export interface OfficialCodingPlanGatewayDecision {
  /** 是否命中官方端点并改为经网关发送。 */
  readonly viaGateway: boolean;
  /** 实际发送的 URL；未命中时与入参一致。 */
  readonly url: string;
}

export type OfficialCodingPlanGatewayFetch = typeof globalThis.fetch;

const ROOT_PATH = "/";
const HOST_HEADER = "host";
const HTTPS_DEFAULT_PORT = "443";

const GATEWAY_PATH_BY_PROVIDER_ENDPOINT: ReadonlyMap<string, string> = new Map(
  OFFICIAL_CODING_PLAN_GATEWAY_ROUTES.map((route) => [
    endpointKey(new URL(route.providerEndpoint)),
    route.gatewayPath,
  ]),
);

export function resolveOfficialCodingPlanGatewayUrl(
  requestUrl: string,
  env: EnvRecord = process.env,
): OfficialCodingPlanGatewayDecision {
  const parsed = parseHttpsUrl(requestUrl);
  if (!parsed) {
    return { viaGateway: false, url: requestUrl };
  }
  const gatewayPath = GATEWAY_PATH_BY_PROVIDER_ENDPOINT.get(endpointKey(parsed));
  if (!gatewayPath) {
    return { viaGateway: false, url: requestUrl };
  }
  const gatewayUrl = new URL(gatewayPath, resolveRuntimeZCodeEndpointOrigin(env));
  gatewayUrl.search = parsed.search;
  return { viaGateway: true, url: gatewayUrl.href };
}

/**
 * 包装模型 provider 的 fetch：命中官方端点时发往网关端点，其余请求原样交给下层 fetch。
 * 应放在用户 HTTP 代理 fetch 之前，使 httpProxy / noProxy 规则按实际发送的网关地址判定。
 */
export function createOfficialCodingPlanGatewayFetch(options: {
  env?: EnvRecord;
  fetch: OfficialCodingPlanGatewayFetch;
}): OfficialCodingPlanGatewayFetch {
  return async (input, init) => {
    const requestUrl = readRequestUrl(input);
    if (!requestUrl) {
      return await options.fetch(input, init);
    }
    const decision = resolveOfficialCodingPlanGatewayUrl(requestUrl, options.env);
    if (!decision.viaGateway) {
      return await options.fetch(input, init);
    }
    // 显式 Host 头会指向官方模型端点的主机，改为经网关发送后由 fetch 按实际 URL 重新计算。
    const gatewayInput = withUrl(input, decision.url);
    if (gatewayInput instanceof Request) {
      gatewayInput.headers.delete(HOST_HEADER);
    }
    return await options.fetch(gatewayInput, withoutHostHeader(init));
  };
}

function withoutHostHeader(
  init: Parameters<OfficialCodingPlanGatewayFetch>[1],
): Parameters<OfficialCodingPlanGatewayFetch>[1] {
  if (!init?.headers) {
    return init;
  }
  const headers = new Headers(init.headers);
  if (!headers.has(HOST_HEADER)) {
    return init;
  }
  headers.delete(HOST_HEADER);
  return { ...init, headers };
}

function readRequestUrl(input: Parameters<OfficialCodingPlanGatewayFetch>[0]): string | undefined {
  try {
    if (input instanceof Request) {
      return input.url;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return new URL(String(input)).href;
  } catch {
    return undefined;
  }
}

function withUrl(
  input: Parameters<OfficialCodingPlanGatewayFetch>[0],
  url: string,
): Parameters<OfficialCodingPlanGatewayFetch>[0] {
  if (input instanceof Request) {
    return new Request(url, input);
  }
  if (input instanceof URL) {
    return new URL(url);
  }
  return url;
}

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function endpointKey(url: URL): string {
  const effectivePort = url.port || HTTPS_DEFAULT_PORT;
  return `${url.protocol}//${url.hostname.toLowerCase()}:${effectivePort}${normalizedPath(url.pathname)}`;
}

function normalizedPath(pathname: string): string {
  if (pathname === ROOT_PATH) {
    return ROOT_PATH;
  }
  return pathname.replace(/\/+$/u, "") || ROOT_PATH;
}
