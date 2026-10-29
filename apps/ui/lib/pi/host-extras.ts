// Fields of /api/state read beside live-state.ts's parser: the compaction behind "Compact now",
// and whether the host has Duet turned on (docs/DUET.md "Parked").
import type { LiveSnapshot } from "./live-state";

export type Compaction = {
  /** A compaction task is live: older turns are being summarised. */
  running: boolean;
  /** Waiting to retry after this provider error. */
  retryError: string;
  /** The last compaction failed with this error, since a summary was last written. */
  failure: string;
};

export type WorkspaceSnapshot = LiveSnapshot & { compaction?: Compaction; duet?: boolean };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function parseCompaction(value: unknown): Compaction {
  const row = object(value);
  return { running: row.running === true, retryError: text(row.retryError), failure: text(row.failure) };
}

/** The fields above, to spread over parseSnapshot's result. */
export function readExtras(value: unknown): Required<Pick<WorkspaceSnapshot, "compaction" | "duet">> {
  const raw = object(value);
  return { compaction: parseCompaction(raw.compaction), duet: raw.duet === true };
}
