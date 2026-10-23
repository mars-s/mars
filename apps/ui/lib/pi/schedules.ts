// Scheduled jobs for Settings, Schedules (docs/SCHEDULES.md). Parsed at the boundary: the UI
// renders only these fields, never raw response text.
export type ScheduleKind = "interval" | "daily" | "weekdays" | "weekly" | "once";
export type DayName = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type ScheduleWhen =
  | { kind: "interval"; every: number; unit: "minutes" | "hours" }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "weekly"; days: DayName[]; time: string }
  | { kind: "once"; at: string };
export type ScheduleRunStatus = "starting" | "running" | "completed" | "failed" | "missed" | "skipped";
export type ScheduleRun = { status: ScheduleRunStatus; at: number; conversationId: string; reason: string; manual: boolean };
export type Schedule = {
  id: string;
  title: string;
  prompt: string;
  summary: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: number | null;
  nextRun: string;
  target: { kind: "new" } | { kind: "conversation"; conversationId: string };
  lastRun: ScheduleRun | null;
};
export type ScheduleList = { schedules: Schedule[]; timezone: string };
export type ScheduleDraft = {
  title: string;
  prompt: string;
  when: ScheduleWhen;
  timezone: string;
  conversationId?: string;
};

export const DAYS: { id: DayName; label: string; name: string }[] = [
  { id: "mon", label: "Mon", name: "Monday" },
  { id: "tue", label: "Tue", name: "Tuesday" },
  { id: "wed", label: "Wed", name: "Wednesday" },
  { id: "thu", label: "Thu", name: "Thursday" },
  { id: "fri", label: "Fri", name: "Friday" },
  { id: "sat", label: "Sat", name: "Saturday" },
  { id: "sun", label: "Sun", name: "Sunday" },
];
export const RUN_LABELS: Record<ScheduleRunStatus, string> = {
  starting: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  missed: "Missed",
  skipped: "Skipped",
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const text = (value: unknown, max = 200) => (typeof value === "string" ? value.slice(0, max) : "");
const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const STATUSES = Object.keys(RUN_LABELS) as ScheduleRunStatus[];

function parseRun(value: unknown): ScheduleRun | null {
  if (value === null || value === undefined) return null;
  const row = record(value);
  return {
    status: (STATUSES as unknown[]).includes(row.status) ? (row.status as ScheduleRunStatus) : "failed",
    at: time(row.at) ?? 0,
    conversationId: text(row.conversationId, 40),
    reason: text(row.reason, 300),
    manual: row.manual === true,
  };
}

export function parseSchedules(value: unknown): ScheduleList {
  const source = record(value);
  if (!Array.isArray(source.schedules)) throw Error("Schedules are unavailable. Try again.");
  return {
    timezone: text(source.timezone, 80),
    schedules: source.schedules.map(record).map((row) => {
      const target = record(row.target);
      return {
        id: text(row.id, 40),
        title: text(row.title, 60),
        prompt: text(row.prompt, 20000),
        summary: text(row.summary, 200),
        timezone: text(row.timezone, 80),
        enabled: row.enabled === true,
        nextRunAt: time(row.nextRunAt),
        nextRun: text(row.nextRun, 80),
        target: target.kind === "conversation" ? { kind: "conversation", conversationId: text(target.conversationId, 40) } : { kind: "new" },
        lastRun: parseRun(row.lastRun),
      };
    }),
  };
}

async function failure(response: Response, fallback: string) {
  const body = record(await response.json().catch(() => ({})));
  return Error(text(body.error, 300) || fallback);
}

export async function loadSchedules(signal?: AbortSignal): Promise<ScheduleList> {
  const response = await fetch("/api/schedules", { cache: "no-store", signal });
  if (!response.ok) throw await failure(response, "Could not load schedules. Try again.");
  return parseSchedules(await response.json());
}

async function post(path: string, body: unknown, fallback: string) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw await failure(response, fallback);
  return response.json();
}

export const createSchedule = (draft: ScheduleDraft) => post("/api/schedules", draft, "Could not add the schedule. Try again.");
export const setScheduleEnabled = (id: string, enabled: boolean) =>
  post("/api/schedules/update", { id, enabled }, enabled ? "Could not resume the schedule." : "Could not pause the schedule.");
export const runScheduleNow = (id: string) => post("/api/schedules/run-now", { id }, "Could not run the schedule.");
export const deleteSchedule = (id: string) => post("/api/schedules/delete", { id }, "Could not delete the schedule.");

/** Every IANA zone the browser knows, with the given one first when it is missing. */
export function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return all.includes(current) || !current ? all : [current, ...all];
}
