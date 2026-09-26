import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_CDN_BASE_URL__: string | undefined;

// No built-in asset host: remote assets are served from whatever origin the
// operator configures. An empty result means "no remote origin configured",
// which keeps development on the local mock CDN and surfaces an explicit
// error in packaged builds instead of reaching out to a third party.
function readConfiguredCdnBaseUrl(): string {
  const fromEnv = process.env.ZCODE_CDN_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  if (typeof __ZCODE_CDN_BASE_URL__ === "undefined") return "";
  return __ZCODE_CDN_BASE_URL__.trim();
}

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CDN URL must use http or https");
  return value.replace(/\/+$/, "");
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];
  const baseUrl = readConfiguredCdnBaseUrl();
  if (!baseUrl) return [];
  return [
    `${normalizeBaseUrl(baseUrl)}/zcode/electron/releases/${options.version ?? ZCODE_VERSION}`,
  ];
}
