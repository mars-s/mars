// Pure view model for the Changes pane. Type-only imports so node --test loads it.
import type { FileDiff } from "@/components/ai/tool-adapter";
import type { ChangedFile, Changes } from "@/lib/pi/workbench";

export type ChangeKind = "modified" | "added" | "deleted" | "untracked" | "type" | "conflict";
export type ChangeRow = ChangedFile & {
  kind: ChangeKind;
  /** Directory part including the trailing slash, or "". */
  dir: string;
  name: string;
  /** Text diff for this file; absent for binary files and files past the patch cap. */
  diff?: FileDiff;
};

const KINDS: Record<string, ChangeKind> = { M: "modified", A: "added", D: "deleted", "?": "untracked", T: "type", U: "conflict" };
export const KIND_LABEL: Record<ChangeKind, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  untracked: "Untracked",
  type: "Type changed",
  conflict: "Conflict",
};

/** Join the host's file list with the parsed patch. The file list stays the source of truth. */
export function changeRows(changes: Changes, diffs: FileDiff[]): ChangeRow[] {
  const byPath = new Map(diffs.map((diff) => [diff.path, diff]));
  return changes.files.map((file) => {
    const slash = file.path.lastIndexOf("/");
    return {
      ...file,
      kind: KINDS[file.status] ?? "modified",
      dir: file.path.slice(0, slash + 1),
      name: file.path.slice(slash + 1),
      diff: file.binary ? undefined : byPath.get(file.path),
    };
  });
}

export function totals(rows: ChangeRow[]) {
  return rows.reduce((sum, row) => ({ added: sum.added + row.added, removed: sum.removed + row.removed }), { added: 0, removed: 0 });
}

/** GitHub-style five blocks: how many show additions. */
export function changeBar(added: number, removed: number): number {
  const total = added + removed;
  return total === 0 ? 0 : Math.round((added / total) * 5);
}

export const repoLabel = (path: string) => path || "Workspace root";
