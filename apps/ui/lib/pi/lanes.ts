// Lanes for Settings, Lanes (docs/LANES.md): parallel chats changing Mars, each in its own
// worktree with a preview, merged into main in queue order. Parsed at the boundary.
import { record } from "@/lib/pi/live-state";

export type LaneState = "open" | "queued" | "merging" | "blocked" | "merged" | "closed";
export type Lane = {
  id: string;
  title: string;
  state: LaneState;
  branch: string;
  conversationId: string | null;
  queuePosition: number | null;
  preview: { url: string; state: string } | null;
  note: string;
  changed: string[];
  mergedCommit: string | null;
};
export type LaneList = { lanes: Lane[]; queue: string[]; paused: boolean; main: string; previewsMax: number };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const STATES: LaneState[] = ["open", "queued", "merging", "blocked", "merged", "closed"];

export function parseLane(value: unknown): Lane | null {
  const data = record(value);
  if (!text(data.id)) return null;
  const preview = record(data.preview);
  return {
    id: text(data.id),
    title: text(data.title) || text(data.id),
    state: STATES.includes(data.state as LaneState) ? (data.state as LaneState) : "open",
    branch: text(data.branch),
    conversationId: text(data.conversationId) || null,
    queuePosition: Number.isInteger(data.queuePosition) ? Number(data.queuePosition) : null,
    preview: text(preview.url) ? { url: text(preview.url), state: text(preview.state) || "running" } : null,
    note: text(data.note),
    changed: Array.isArray(data.changed) ? data.changed.filter((item): item is string => typeof item === "string") : [],
    mergedCommit: text(data.mergedCommit) || null,
  };
}

export function parseLaneList(value: unknown): LaneList {
  const data = record(value);
  return {
    lanes: (Array.isArray(data.lanes) ? data.lanes : []).map(parseLane).filter((lane): lane is Lane => !!lane),
    queue: Array.isArray(data.queue) ? data.queue.filter((item): item is string => typeof item === "string") : [],
    paused: data.paused === true,
    main: text(data.main) || "main",
    previewsMax: Number.isInteger(data.previewsMax) ? Number(data.previewsMax) : 2,
  };
}

// Starting a preview waits for its first page to compile, and a merge runs checks: both can
// take minutes, longer than the usual request timeout.
async function request(path: string, body?: unknown, timeoutMs = 15000): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(text(record(data).error) || `Pi request failed (${response.status}).`);
  return data;
}

export const loadLanes = async () => parseLaneList(await request("/api/lanes"));
export const setLaneOrder = async (ids: string[]) => parseLaneList(await request("/api/lanes/order", { ids }));
export const setLanesPaused = async (paused: boolean) => parseLaneList(await request("/api/lanes/pause", { paused }));
export const mergeLanesNow = async () => parseLaneList(await request("/api/lanes/merge", {}, 20 * 60000));
export const setLanePreview = (id: string, on: boolean) => request(`/api/lanes/${encodeURIComponent(id)}/preview`, { on }, 4 * 60000);
export const closeLane = (id: string) => request(`/api/lanes/${encodeURIComponent(id)}/close`, {});

/** Move a queued lane one place up (-1) or down (+1); returns the new queue order. */
export function moveInQueue(queue: string[], id: string, by: -1 | 1): string[] {
  const at = queue.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= queue.length) return queue;
  const next = [...queue];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}
