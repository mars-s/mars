export interface TelemetryRendererContext {
  clientTimezone: string;
  clientLanguage: string;
  screenResolution: string;
}

export interface TelemetryEventPayload {
  elementName: string;
  eventRegion: string;
  eventType: string;
  eventText?: string;
  eventExtraDetail: Record<string, string>;
  userId?: string;
  talkId?: string;
  messageId?: string;
}

export interface RendererTelemetryEventPayload extends TelemetryEventPayload {
  context: TelemetryRendererContext;
}

/**
 * URL 配置进入业务埋点前只允许提取 hostname。
 * 无效值和非 HTTP(S) 协议返回空串，避免误把完整 URL、userinfo 或任意文本带入 payload。
 */
export function resolveSafeTelemetryHostname(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized) return "";
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 错误原文可能带任意格式密钥；整体丢弃，不用正则猜测秘密边界。 */
export function sanitizeTelemetryErrorMessage(value: string | null | undefined): string {
  return value ? "[redacted]" : "";
}

function sanitizeLoginHostname(value: string): string {
  const hostname = resolveSafeTelemetryHostname(value);
  if (hostname) return hostname;
  // UI 已取过 hostname 时 Core 仍需幂等；只接受精确 hostname，不放行无协议的路径或凭据。
  const normalized = value.trim().toLowerCase();
  return normalized && resolveSafeTelemetryHostname(`https://${normalized}`) === normalized
    ? normalized
    : "";
}

/** 只清洗上报副本；业务错误、授权地址和调用方持有的 detail 不得被修改。 */
export function sanitizeTelemetryEventDetail(
  elementName: string,
  detail: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail).map(([key, value]) => [
      key,
      key === "error_msg"
        ? sanitizeTelemetryErrorMessage(value)
        : elementName === "app_login_ck" && key === "login_url"
          ? sanitizeLoginHostname(value)
          : value,
    ]),
  );
}

interface TelemetryScreenLike {
  width: number;
  height: number;
}

interface TelemetryWindowLike {
  intlLocale?: string;
  timeZone?: string;
  screen: TelemetryScreenLike;
}

export function collectTelemetryRendererContext(
  options?: TelemetryWindowLike,
): TelemetryRendererContext {
  const resolvedIntlOptions =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions() : undefined;
  const timeZone = options?.timeZone ?? resolvedIntlOptions?.timeZone ?? "UTC";
  const clientLanguage = options?.intlLocale ?? resolvedIntlOptions?.locale ?? "en-US";
  const runtimeScreen = (globalThis as { screen?: TelemetryScreenLike }).screen;
  const screen = options?.screen ?? runtimeScreen ?? { width: 0, height: 0 };

  return {
    clientTimezone: timeZone,
    clientLanguage,
    screenResolution: `${screen.width}x${screen.height}`,
  };
}
