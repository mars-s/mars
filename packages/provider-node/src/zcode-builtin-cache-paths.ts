import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Every cache directory is prefixed with this, so an endpoint-scoped cache is
 * always recognisable as one. The `none` suffix marks the no-control-plane case.
 */
const ENDPOINT_KEY_PREFIX = "endpoint-";

export function resolveZCodeBuiltinClientPlatform(): string {
  const target = process.platform === "win32" ? "windows" : process.platform;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${target}-${arch}`;
}

export interface ZCodeBuiltinCachePathOptions {
  readonly environmentConfigRoot: string;
  readonly platform: string;
  readonly appVersion: string;
  readonly zcodeEndpointOrigin: string;
}

export interface ZCodeBuiltinCachePaths {
  readonly activeFilePath: string;
}

/** 按平台与 App 版本隔离 Active/LKG；路径本身就是兼容范围。 */
export function resolveZCodeBuiltinCachePaths(
  options: ZCodeBuiltinCachePathOptions,
): ZCodeBuiltinCachePaths {
  const platform = normalizeSegment(options.platform, "platform");
  const appVersion = normalizeSegment(options.appVersion, "appVersion");
  const endpointKey = createZCodeBuiltinEndpointKey(options.zcodeEndpointOrigin);
  const directory = join(
    options.environmentConfigRoot,
    "runtime",
    "provider",
    platform,
    appVersion,
    endpointKey,
  );
  return {
    activeFilePath: join(directory, "zcode-builtin.json"),
  };
}

/** 将 ZCode 控制面 Origin 规范化后映射为安全、稳定且碰撞风险可忽略的缓存路径段。 */
export function createZCodeBuiltinEndpointKey(zcodeEndpointOrigin: string): string {
  const normalized = normalizeZCodeBuiltinEndpointOrigin(zcodeEndpointOrigin);
  // 没有配置控制面时，目录段必须是固定字面量而不是 sha256("")，这样它与任何
  // `endpoint-<sha256(vendor origin)>` 形式的历史目录在字符集上就不相交。vendor 构建
  // 遗留下来的缓存目录永远不可能被这里的无控制面分支重新认领。
  if (!normalized) return `${ENDPOINT_KEY_PREFIX}none`;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `${ENDPOINT_KEY_PREFIX}${digest}`;
}

export function normalizeZCodeBuiltinEndpointOrigin(value: string): string {
  const normalized = value.trim();
  // 空的控制面 Origin 是合法的配置状态，不是编程错误：fork 不带 vendor 控制面，
  // 内置 catalog 永远来自打包文件。`resolveZCodeEndpointOrigin` 按约定在未配置时
  // 返回空串，所以把它当成错误会让整个 provider view 读不出来。只有非空值才必须
  // 真的像一个 origin。
  if (!normalized) return "";
  const url = new URL(normalized);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ZCode Built-in Endpoint Origin 只支持 HTTP(S)");
  }
  return url.origin;
}

function normalizeSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new Error(`ZCode Built-in ${name} 不是合法路径段`);
  }
  return normalized;
}
