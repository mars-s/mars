// Updates from main (docs/UPDATES.md), for Settings, Updates and the sidebar notice.
// Parsed at the boundary: the UI renders only these fields.

// No relative imports: unit tests load this file directly with Node type stripping.
// live-state.ts parses the same states for the /api/state badge.
const UPDATE_STATES = ["up_to_date", "ahead", "fast_forward", "merge", "needs_reconcile", "blocked", "updating", "unknown"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
export const OUTCOMES = ["updated", "failed", "rolled_back", "rollback_failed", "interrupted"] as const;
export type UpdateOutcome = (typeof OUTCOMES)[number];

export type UpdateBlocker = { code: string; message: string; files: string[] };
export type UpdateStep = { name: string; status: "running" | "done" | "skipped" | "failed"; detail: string };
export type UpdateCheck = {
  state: Exclude<UpdateState, "updating" | "unknown">;
  checkedAt: string;
  branch: string;
  head: string;
  target: string;
  behind: number;
  ahead: number;
  commits: { sha: string; subject: string }[];
  blockers: UpdateBlocker[];
  reconciled: boolean;
  next: string;
};
export type UpdateAttempt = { id: string; outcome: UpdateOutcome; detail: string; from: string; result: string; restarted: boolean; next: string; steps: UpdateStep[] };
export type UpdateStatus = {
  check: UpdateCheck | null;
  head: string;
  installedAt: string;
  auto: boolean;
  running: { phase: string; step: string; steps: UpdateStep[] } | null;
  last: UpdateAttempt | null;
};
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const text = (value: unknown, max = 300) => (typeof value === "string" ? value.slice(0, max) : "");
const count = (value: unknown) => (Number.isInteger(value) && Number(value) >= 0 ? Number(value) : 0);
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => values.some((item) => item === value);
const STEP_STATES = ["running", "done", "skipped", "failed"] as const;

const steps = (value: unknown): UpdateStep[] =>
  list(value).map(record).slice(0, 30).map((row) => ({
    name: text(row.name, 40),
    status: isOneOf(STEP_STATES, row.status) ? row.status : "done",
    detail: text(row.detail, 600),
  }));

function parseCheck(value: unknown): UpdateCheck | null {
  const row = record(value);
  const state = row.state;
  if (!isOneOf(UPDATE_STATES, state) || state === "updating" || state === "unknown") return null;
  return {
    state,
    checkedAt: text(row.checkedAt, 40),
    branch: text(row.branch, 80) || "main",
    head: text(row.head, 12),
    target: text(row.target, 12),
    behind: count(row.behind),
    ahead: count(row.ahead),
    commits: list(row.commits).slice(0, 20).flatMap((line) => {
      const match = /^(\S+) (.*)$/.exec(text(line, 300));
      return match ? [{ sha: match[1], subject: match[2] }] : [];
    }),
    blockers: list(row.blockers).map(record).slice(0, 5).map((blocker) => ({
      code: text(blocker.code, 40),
      message: text(blocker.message, 400),
      files: list(blocker.files).slice(0, 20).map((file) => text(file, 200)).filter(Boolean),
    })),
    reconciled: row.reconciled === true,
    next: text(row.next, 400),
  };
}

function parseAttempt(value: unknown): UpdateAttempt | null {
  const row = record(value);
  if (!isOneOf(OUTCOMES, row.outcome)) return null;
  return {
    id: text(row.id, 40),
    outcome: row.outcome,
    detail: text(row.detail, 1500),
    from: text(row.from, 12),
    result: text(row.result, 12),
    restarted: row.restarted !== false,
    next: text(row.next, 400),
    steps: steps(row.steps),
  };
}

export function parseUpdateStatus(value: unknown): UpdateStatus {
  const data = record(value);
  if (!("status" in data) || typeof data.head !== "string") throw Error("Update status is unavailable. Try again.");
  const running = record(data.running);
  return {
    check: parseCheck(data.status),
    head: text(data.head, 12),
    installedAt: text(record(data.installed).at, 40),
    auto: record(data.settings).auto === true,
    running: data.running ? { phase: text(running.phase, 40), step: text(running.step, 40), steps: steps(running.steps) } : null,
    last: parseAttempt(data.last),
  };
}

/** True when there is something to install now. */
export const installable = (state: UpdateState) => state === "fast_forward" || state === "merge";

export type ApplyResult = { started: boolean; outcome: string; detail: string; next: string };
function parseApply(value: unknown): ApplyResult {
  const row = record(value);
  return { started: row.started === true, outcome: text(row.outcome, 40), detail: text(row.detail, 600), next: text(row.next, 600) };
}

async function call(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, body === undefined ? { cache: "no-store", signal } : {
    method: "POST", cache: "no-store", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw Error(response.status === 401 ? "Sign in again to manage updates." : "Could not reach Mars. Try again.");
  return response.json();
}
export const loadUpdates = async (signal?: AbortSignal) => parseUpdateStatus(await call("/api/update", undefined, signal));
export const checkUpdates = async () => parseUpdateStatus(await call("/api/update/check", {}));
export const setAutoUpdate = async (auto: boolean) => parseUpdateStatus(await call("/api/update/settings", { auto }));
export const applyUpdate = async () => parseApply(await call("/api/update/apply", {}));

export const STEP_LABELS: Record<string, string> = {
  check: "Check main", merge: "Merge", tree: "Copy the new version", dependencies: "Dependencies", syntax: "Syntax",
  build: "Build the interface", runtime: "Prepare the host", boot: "Test start", checks: "Host checks",
  stop: "Stop Mars", checkout: "Move to the new commit", swap_dependencies: "Swap dependencies", swap_ui: "Swap the interface",
  swap_runtime: "Swap the host", start: "Start Mars", health: "Health check",
};
