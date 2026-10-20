// Pure helpers for the Files pane. No React or DOM imports: node --test loads it directly.
import type { FileEntry, Listing } from "@/lib/pi/workbench";

export type DirState = { status: "loading" } | { status: "ready"; listing: Listing } | { status: "error"; error: string };

export type TreeRow =
  | { kind: "entry"; path: string; entry: FileEntry; depth: number; expanded: boolean }
  | { kind: "note"; key: string; depth: number; text: string; retry?: string };

export const childPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
export const baseName = (path: string) => path.split("/").pop() || path;
export const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");

/** Folders that must be open to show `path`, root first: "a/b/c.md" gives ["", "a", "a/b"]. */
export function ancestors(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).reduce<string[]>((acc, part) => [...acc, childPath(acc[acc.length - 1], part)], [""]);
}

/** Visible rows in document order. Only folders in `expanded` show their children. */
export function flattenTree(dirs: Record<string, DirState | undefined>, expanded: ReadonlySet<string>, root = ""): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const state = dirs[dir];
    if (!state || state.status === "loading") {
      rows.push({ kind: "note", key: `${dir}:loading`, depth, text: "Loading…" });
      return;
    }
    if (state.status === "error") {
      rows.push({ kind: "note", key: `${dir}:error`, depth, text: state.error, retry: dir });
      return;
    }
    if (!state.listing.entries.length) rows.push({ kind: "note", key: `${dir}:empty`, depth, text: dir ? "Empty folder" : "The workspace is empty." });
    for (const entry of state.listing.entries) {
      const path = childPath(dir, entry.name);
      const open = entry.type === "dir" && expanded.has(path);
      rows.push({ kind: "entry", path, entry, depth, expanded: open });
      if (open) walk(path, depth + 1);
    }
    if (state.listing.truncated)
      rows.push({ kind: "note", key: `${dir}:truncated`, depth, text: `Showing the first ${state.listing.entries.length.toLocaleString("en-AU")} items.` });
  };
  walk(root, 1);
  return rows;
}

/**
 * Resolve a Markdown link or image `href` written in the file at `from` to a workspace
 * path. Returns null for external URLs, anchors and anything that climbs out of the root.
 */
export function resolveRelative(from: string, href: string): string | null {
  const clean = href.split(/[?#]/)[0];
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const parts = clean.startsWith("/") ? [] : parentPath(from).split("/").filter(Boolean);
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(safeDecode(part));
  }
  return parts.length ? parts.join("/") : null;
}
const safeDecode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString("en-AU")} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("en-AU", { maximumFractionDigits: 1 })} MB`;
}

export const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** One gutter string for the whole file: two text nodes render a 2 MiB file without a row per line. */
export function lineGutter(text: string) {
  const count = Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
  return Array.from({ length: count }, (_, index) => index + 1).join("\n");
}

export const rawUrl = (path: string) => `/api/workbench/raw?path=${encodeURIComponent(path)}`;
