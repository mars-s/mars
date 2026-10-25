/** Duet (docs/DUET.md): the owner's assistant thread as the host's /api/duet returns it. */

export type DuetSender = "owner" | "duet" | "system";
export type DuetMessage = {
  id: string;
  from: DuetSender;
  /** owner: "message"; duet: "reply", "result", "update", "question" or "failed"; system: "started", "stopped" or "mail". */
  kind: string;
  text: string;
  /** The task it came from or went to, e.g. "T3", or "". */
  taskId: string;
  label: string;
  /** The owner words that asked for a task, shown on its result. */
  quote: string;
  /** A result the task filed quietly: shown folded with its neighbours, never announced. */
  quiet: boolean;
  /** "wrong" once the owner marked it Not right, otherwise "". */
  feedback: "wrong" | "";
  /** On kind "confirm": the grey-area action Duet asks about, or null. */
  confirm: DuetConfirm | null;
};
export type DuetConfirm = { id: string; state: "pending" | "yes" | "no"; action: string };
/** How much of the thread's prompt the model provider served from its cache. */
export type DuetContext = { cacheHitPercent: number | null; cachedTokens: number; inputTokens: number; turns: number };
export type DuetTaskState = "queued" | "running" | "stopping" | "waiting" | "done" | "stopped" | "failed" | "unknown";
export type DuetTask = {
  id: string;
  conversationId: string;
  label: string;
  state: DuetTaskState;
  running: boolean;
  model: string;
  progress: { text: string; done?: number; total?: number } | null;
  origin: string;
};
export type DuetView = { threadId: string; running: boolean; messages: DuetMessage[]; tasks: DuetTask[]; context: DuetContext | null };

const STATES: readonly string[] = ["queued", "running", "stopping", "waiting", "done", "stopped", "failed"];
const SENDERS: readonly string[] = ["owner", "duet", "system"];
const CONFIRM_STATES: readonly string[] = ["pending", "yes", "no"];
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const text = (value: unknown, max = 100000) => (typeof value === "string" ? value.slice(0, max) : "");
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const count = (value: unknown) => (Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined);

export function parseDuet(value: unknown): DuetView {
  const row = record(value);
  return {
    threadId: /^[1-9]\d*$/.test(text(row.threadId)) ? text(row.threadId) : "",
    running: row.running === true,
    messages: list(row.messages)
      .map(record)
      .flatMap((m) =>
        SENDERS.includes(text(m.from)) && text(m.id)
          ? [
              {
                id: text(m.id, 40),
                from: text(m.from) as DuetSender,
                kind: text(m.kind, 40),
                text: text(m.text),
                taskId: text(m.taskId, 20),
                label: text(m.label, 80),
                quote: text(m.quote, 300),
                quiet: m.quiet === true,
                feedback: m.feedback === "wrong" ? ("wrong" as const) : ("" as const),
                confirm: parseConfirm(m.confirm),
              },
            ]
          : [],
      ),
    context: parseContext(row.context),
    tasks: list(row.tasks)
      .map(record)
      .flatMap((t) => {
        if (!/^T[1-9]\d*$/.test(text(t.id))) return [];
        const progress = record(t.progress);
        return [
          {
            id: text(t.id),
            conversationId: text(t.conversationId, 20),
            label: text(t.label, 80) || text(t.id),
            state: (STATES.includes(text(t.state)) ? text(t.state) : "unknown") as DuetTaskState,
            running: t.running === true,
            model: text(t.model, 80),
            progress: text(progress.text) ? { text: text(progress.text, 200), done: count(progress.done), total: count(progress.total) } : null,
            origin: text(t.origin, 300),
          },
        ];
      }),
  };
}

/** Tasks still going: running, stopping or waiting for a free slot. */
export const isActive = (task: DuetTask) => task.running || task.state === "running" || task.state === "stopping" || task.state === "queued";

/** The word a task card shows for its state. Never colour alone. */
export function stateWord(task: DuetTask): string {
  if (task.state === "stopping") return "Stopping…";
  if (task.running || task.state === "running") return "Working";
  return { queued: "Waiting", waiting: "Needs you", done: "Done", stopped: "Stopped", failed: "Failed", unknown: "Unknown" }[task.state] ?? "Unknown";
}

function parseConfirm(value: unknown): DuetConfirm | null {
  const row = record(value);
  if (!text(row.id)) return null;
  return { id: text(row.id, 80), state: (CONFIRM_STATES.includes(text(row.state)) ? text(row.state) : "pending") as DuetConfirm["state"], action: text(row.action, 300) };
}

function parseContext(value: unknown): DuetContext | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = record(value);
  const percent = typeof row.cacheHitPercent === "number" && Number.isFinite(row.cacheHitPercent) ? Math.min(100, Math.max(0, row.cacheHitPercent)) : null;
  return { cacheHitPercent: percent, cachedTokens: count(row.cachedTokens) ?? 0, inputTokens: count(row.inputTokens) ?? 0, turns: count(row.turns) ?? 0 };
}

/** The short cache note for the task strip, e.g. "Cache 91%", or "" when the host has no figure. */
export function cacheLabel(context: DuetContext | null): string {
  return context?.cacheHitPercent == null ? "" : "Cache " + Math.round(context.cacheHitPercent) + "%";
}

/** What the cache note means, for its tooltip. */
export function cacheTitle(context: DuetContext | null): string {
  if (context?.cacheHitPercent == null) return "";
  const tokens = context.inputTokens ? " (" + context.cachedTokens.toLocaleString("en-AU") + " of " + context.inputTokens.toLocaleString("en-AU") + " input tokens" + (context.turns ? " over " + context.turns + (context.turns === 1 ? " turn" : " turns") : "") + ")" : "";
  return "How much of Duet's prompt the model provider reused from its cache" + tokens + ". Higher is faster and cheaper.";
}

export type DuetItem = { kind: "message"; message: DuetMessage } | { kind: "quiet"; id: string; messages: DuetMessage[] };

/** The thread as shown: each run of consecutive quiet bubbles folds into one item. */
export function groupQuiet(messages: readonly DuetMessage[]): DuetItem[] {
  const items: DuetItem[] = [];
  for (const message of messages) {
    const last = items.at(-1);
    if (!message.quiet) items.push({ kind: "message", message });
    else if (last?.kind === "quiet") last.messages.push(message);
    else items.push({ kind: "quiet", id: "quiet-" + message.id, messages: [message] });
  }
  return items;
}

/** The folded card's words, e.g. "3 quiet updates". */
export const quietSummary = (messages: readonly DuetMessage[]) => messages.length + (messages.length === 1 ? " quiet update" : " quiet updates");

/** Duet's own replies and results can be marked Not right. */
export const canMarkWrong = (message: DuetMessage) => message.from === "duet" && (message.kind === "reply" || message.kind === "result");
