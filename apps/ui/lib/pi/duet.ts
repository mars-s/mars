/** Duet (docs/DUET.md): the owner's assistant thread as the host's /api/duet returns it. */
import { record } from "./live-state";

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
};
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
export type DuetView = { threadId: string; running: boolean; messages: DuetMessage[]; tasks: DuetTask[] };

const STATES: readonly string[] = ["queued", "running", "stopping", "waiting", "done", "stopped", "failed"];
const SENDERS: readonly string[] = ["owner", "duet", "system"];
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
          ? [{ id: text(m.id, 40), from: text(m.from) as DuetSender, kind: text(m.kind, 40), text: text(m.text), taskId: text(m.taskId, 20), label: text(m.label, 80), quote: text(m.quote, 300) }]
          : [],
      ),
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
