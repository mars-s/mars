// The sidebar's one Archived list (docs/LIVE-INTEGRATION.md "Archive"): archived chats, and side
// chats and sub-threads that are archived or have finished. The host's list
// (GET /api/conversations/archive) is the whole archive, newest activity first; what the page
// already knows from its last poll decides for the rows it lists, so archiving, unarchiving or a
// side chat finishing shows at once, on top.
import type { ConversationSummary, Subthread } from "./live-state";

export type ArchiveKind = "chat" | "side" | "task";
export type ArchiveItem = { id: string; title: string; kind: ArchiveKind; parentId: string; parentTitle: string };

/** Raw worker states that mean the work is still going (archive.mjs ACTIVE). */
const ACTIVE = new Set(["running", "started", "pending", "scheduled", "stopping", "waiting"]);
export const subthreadActive = (status: string) => ACTIVE.has(status);

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function parseArchive(value: unknown): { items: ArchiveItem[]; total: number } {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const items = (Array.isArray(data.items) ? data.items : []).flatMap((entry): ArchiveItem[] => {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const kind: ArchiveKind | null = row.kind === "chat" || row.kind === "side" || row.kind === "task" ? row.kind : null;
    const id = text(row.id);
    return kind && /^\d+$/.test(id)
      ? [{ id, title: text(row.title) || "Chat", kind, parentId: text(row.parentId), parentTitle: text(row.parentTitle) }]
      : [];
  });
  const total = typeof data.total === "number" && data.total >= items.length ? data.total : items.length;
  return { items, total };
}

type Known = { conversations: ConversationSummary[]; subthreads: Subthread[]; openId: string };

/**
 * What the page's last poll says about each row it lists: its archive row when it is archived or
 * finished, or null when it belongs elsewhere (a live chat, a running side chat or sub-thread, or
 * the open one, which shows under its parent).
 */
export function knownArchive({ conversations, subthreads, openId }: Known): Map<string, ArchiveItem | null> {
  const known = new Map<string, ArchiveItem | null>();
  const titles = new Map(conversations.map((row) => [row.id, row.title]));
  for (const row of conversations) {
    known.set(row.id, row.archived ? { id: row.id, title: row.title, kind: "chat", parentId: "", parentTitle: "" } : null);
    for (const side of row.sideChats)
      known.set(
        side.id,
        side.running || side.id === openId
          ? null
          : { id: side.id, title: side.title, kind: "side", parentId: row.id, parentTitle: row.title },
      );
  }
  for (const task of subthreads)
    known.set(
      task.id,
      task.id === openId || (!task.archived && subthreadActive(task.status))
        ? null
        : { id: task.id, title: task.title, kind: "task", parentId: task.conversationId, parentTitle: titles.get(task.conversationId) ?? "" },
    );
  return known;
}

/**
 * The rows to show: rows that moved into the archive since the host's list was read (`recent`,
 * newest first), then the host's rows the page does not contradict. Without a host list (an
 * older host), every row the page knows.
 */
export function mergeArchive({
  host,
  known,
  openId,
  recent = [],
}: {
  /** The host's rows, or null when it has not answered. */
  host: ArchiveItem[] | null;
  known: Map<string, ArchiveItem | null>;
  openId: string;
  /** Ids that moved into the archive since the host's list was read, newest first. */
  recent?: string[];
}): ArchiveItem[] {
  if (!host) return [...known.values()].filter((row): row is ArchiveItem => !!row);
  const hostIds = new Set(host.map((row) => row.id));
  const fresh = recent.flatMap((id) => {
    const row = known.get(id);
    return row && !hostIds.has(id) ? [row] : [];
  });
  const listed = host.flatMap((row) => {
    if (!known.has(row.id)) return row.id === openId && row.kind !== "chat" ? [] : [row];
    const now = known.get(row.id);
    return now ? [{ ...row, title: now.title }] : [];
  });
  return [...fresh, ...listed];
}
