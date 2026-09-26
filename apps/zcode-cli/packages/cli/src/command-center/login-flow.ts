import type { TuiSelection, TuiSubmitPrompt } from "@zcode/tui";
import { getZCodeCopy } from "@zcode/i18n";
import type { CommandCenterApp, CommandCenterLoginResult } from "./types.js";
import { randomUUID } from "node:crypto";

/**
 * The fork ships no provider catalog, so there is no built-in list of namespaces
 * a sign-in can target. The operator's ZCode backend owns that vocabulary, so
 * this screen has no items to offer and falls back to its empty message; the
 * namespace is supplied by hand as `/login <provider>` and validated by shape.
 */
export function buildLoginSelection(locale?: string): TuiSelection {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: false,
    help: copy.help,
    items: [],
    prompt: copy.prompt,
    title: copy.title,
  };
}

export function loginSetupResponse(locale?: string): string {
  const copy = getZCodeCopy(locale).tui.loginSetup;
  return `${copy.response}\n${copy.emptyMessage}`;
}

export function formatLoginResult(result: CommandCenterLoginResult): string {
  const label = result.user.name || result.user.email || result.user.user_id;
  const browserNote =
    result.browser && !result.browser.opened
      ? `\nBrowser open failed: ${result.browser.reason ?? "unknown error"}`
      : "";

  return [
    `Signed in to ${result.providerId ?? ""} as ${label}.`,
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
