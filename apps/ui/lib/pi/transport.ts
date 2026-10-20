import type { MarsMessage, Task, WorkspaceSettings } from "../types";

/**
 * Application-owned boundary between this UI and a future Mars server adapter.
 * This is NOT Pi's native protocol and makes no assumptions about HTTP routes,
 * authentication, reconnect cursors, or the server's source of durable state.
 */
export interface ChatRunRequest {
  /** A client operation key; a server adapter must map it to its actual run ID. */
  runId: string;
  sessionId: string;
  messages: readonly MarsMessage[];
  model: WorkspaceSettings["model"];
  permissionMode: WorkspaceSettings["permissionMode"];
  context?: { tasks: readonly Task[] };
}

export type MarsRunEvent =
  | { type: "text-delta"; delta: string }
  | { type: "text-snapshot"; text: string }
  | { type: "activity"; activity: NonNullable<MarsMessage["activity"]> }
  | { type: "complete" };

export interface MarsTransport {
  readonly mode: "demo" | "remote";
  /** Aborting this signal detaches the client stream. It must not cancel durable server work. */
  stream(request: ChatRunRequest, signal: AbortSignal): AsyncIterable<MarsRunEvent>;
  /** Reattach without resubmitting; start with a text-snapshot or send only unseen deltas. */
  resume?(request: { sessionId: string; runId: string }, signal: AbortSignal): AsyncIterable<MarsRunEvent>;
  /** Resolve only after the server confirms cancellation; reject on failure. */
  cancel?(request: { sessionId: string; runId: string }): Promise<void>;
}

/** Remote conversation snapshots and event cursors remain the server adapter's responsibility. */
export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
