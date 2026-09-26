import type { TuiSelection, TuiSubmitPrompt } from "@zcode/tui";
import { getZCodeCopy } from "@zcode/i18n";
import { getModelProviderFamilySpec, MODEL_PROVIDER_FAMILY_SPECS } from "@zcode/shared";
import type { CommandCenterApp, CommandCenterLoginResult } from "./types.js";
import { randomUUID } from "node:crypto";

/**
 * The provider namespaces the operator's ZCode backend can sign a user into.
 * Read from the shared family table rather than a hardcoded list so this
 * screen never names a vendor the fork does not ship.
 */
export function loginProviderIds(): readonly string[] {
  return MODEL_PROVIDER_FAMILY_SPECS.map((spec) => spec.id);
}

export function loginProviderLabel(providerId: string): string {
  const spec = MODEL_PROVIDER_FAMILY_SPECS.find((candidate) => candidate.id === providerId);
  return spec ? getModelProviderFamilySpec(spec.id).label : providerId;
}

export function buildLoginSelection(locale?: string): TuiSelection {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: false,
    help: copy.help,
    items: loginProviderIds().map((providerId) => ({
      command: `/login ${providerId}`,
      id: `browser-${providerId}`,
      keywords: [providerId, "oauth", "browser", "login"],
      pending: {
        cancelStatus: copy.pending.cancelStatus,
        help: copy.pending.help,
        primary: copy.options.browser.pendingPrimary,
        secondary: copy.options.browser.pendingSecondary,
        status: copy.pending.status,
      },
      primary: `${loginProviderLabel(providerId)} ${copy.options.browser.primary}`,
      secondary: copy.options.browser.secondary,
    })),
    prompt: copy.prompt,
    title: copy.title,
  };
}

export function loginSetupResponse(locale?: string): string {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  const providerIds = loginProviderIds();
  if (providerIds.length === 0) {
    return `${copy.response}\n${copy.emptyMessage}`;
  }
  return `${copy.response} ${providerIds.map(loginProviderLabel).join(", ")}`;
}

export function formatLoginResult(result: CommandCenterLoginResult): string {
  const label = result.user.name || result.user.email || result.user.user_id;
  const browserNote =
    result.browser && !result.browser.opened
      ? `\nBrowser open failed: ${result.browser.reason ?? "unknown error"}`
      : "";

  return [
    `Signed in to ${loginProviderLabel(result.providerId ?? "")} as ${label}.`,
    `Credentials: ${result.credentialsPath}${browserNote}`,
  ].join("\n");
}

export async function emitLoginAuthorizeMessage(
  options: Parameters<TuiSubmitPrompt>[1],
  authorizeUrl: string,
  providerName: string,
  session: Pick<CommandCenterApp, "sessionId" | "traceId">,
): Promise<void> {
  const onEvent = options.onEvent;
  if (!onEvent) return;

  await onEvent({
    id: `local-login-authorize-${randomUUID()}` as never,
    payload: {
      content: [
        `Open this URL to sign in with ${providerName}:`,
        "",
        authorizeUrl,
        "",
        "After authorization, return here and I will finish the login automatically.",
      ].join("\n"),
    },
    sequenceNumber: 0,
    sessionId: session.sessionId as never,
    timestamp: new Date(),
    traceId: session.traceId as never,
    type: "assistant_message" as never,
  });
}
