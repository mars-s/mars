/**
 * Request shape for the ChatGPT subscription backend.
 *
 * The Codex backend is not the public OpenAI API: it requires the
 * `ChatGPT-Account-Id` header, and it REJECTS the request unless the body
 * carries `store: false`. Both facts are protocol requirements, not preferences.
 */
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_RESPONSES_URL,
  CHATGPT_DEFAULT_MODEL_ID,
  CHATGPT_ORIGINATOR,
} from "./chatgptOAuthConfig.js";

export interface CodexResponsesRequestInput {
  readonly instructions?: string;
  readonly input: unknown;
  readonly model?: string;
  readonly stream?: boolean;
  readonly tools?: readonly unknown[];
}

export interface CodexResponsesRequestBody {
  readonly input: unknown;
  readonly instructions?: string;
  readonly model: string;
  /** Mandatory. The subscription backend refuses anything else. */
  readonly store: false;
  readonly stream: boolean;
  readonly stream_options?: { include_usage: true };
  readonly tools?: readonly unknown[];
}

export function buildCodexResponsesRequestBody(
  input: CodexResponsesRequestInput,
): CodexResponsesRequestBody {
  return {
    input: input.input,
    ...(input.instructions ? { instructions: input.instructions } : {}),
    model: input.model ?? CHATGPT_DEFAULT_MODEL_ID,
    store: false,
    stream: input.stream ?? true,
    ...(input.stream === false ? {} : { stream_options: { include_usage: true as const } }),
    ...(input.tools && input.tools.length > 0 ? { tools: [...input.tools] } : {}),
  };
}

export function buildCodexRequestHeaders(
  accessToken: string,
  accountId: string,
): Record<string, string> {
  const token = accessToken.trim();
  const account = accountId.trim();
  if (!token) {
    throw new Error("ChatGPT Codex request requires an access token");
  }
  if (!account) {
    throw new Error("ChatGPT Codex request requires a chatgpt_account_id");
  }

  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    [CHATGPT_ACCOUNT_ID_HEADER]: account,
    Authorization: `Bearer ${token}`,
    originator: CHATGPT_ORIGINATOR,
  };
}

export { CHATGPT_CODEX_RESPONSES_URL };
