"use client";

import {
  ChevronRight,
  Download,
  File,
  FileCode,
  FileImage,
  FileSymlink,
  FileText,
  Folder,
  FolderOpen,
  FolderSymlink,
  RefreshCw,
  Search,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { piRequest } from "@/lib/pi/live-state";
import { parseFile, parseListing, parseSearch, type FileContent, type FileEntry, type SearchResult } from "@/lib/pi/workbench";
import { query } from "@/lib/pi/workbench-client";
import { useWorkbench } from "./workbench-context";
import type { WorkbenchTab } from "./workbench-state";
import {
  ancestors,
  baseName,
  flattenTree,
  formatSize,
  isMarkdown,
  lineGutter,
  parentPath,
  rawUrl,
  resolveRelative,
  type DirState,
  type TreeRow,
} from "./files-model";
import "./files-pane.css";

type Viewer = { path: string; status: "loading" } | { path: string; status: "ready"; file: FileContent } | { path: string; status: "error"; error: string };

const failureText = (failure: unknown) => (failure instanceof Error ? failure.message : "The Pi host did not answer.");
const remarkPlugins = [remarkGfm];
const CODE = /\.(c|cc|cpp|cs|css|go|h|html|java|js|jsx|json|mjs|cjs|py|rb|rs|sh|sql|swift|toml|ts|tsx|ya?ml|zsh)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function entryIcon(entry: FileEntry, open: boolean): LucideIcon {
  if (entry.type === "dir") return open ? FolderOpen : Folder;
  if (entry.type === "link") return entry.target?.type === "dir" ? FolderSymlink : FileSymlink;
  if (isMarkdown(entry.name) || /\.(txt|log|csv)$/i.test(entry.name)) return FileText;
  if (IMAGE.test(entry.name)) return FileImage;
  return CODE.test(entry.name) ? FileCode : File;
}

const modifiedText = (ms: number) =>
  ms ? new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";

/** Read-only view of the Pi workspace (docs/WORKBENCH.md "Files"). */
export function FilesPane({ tab }: { tab: Extract<WorkbenchTab, { kind: "files" }> }) {
  const { dispatch } = useWorkbench();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusPath, setFocusPath] = useState("");
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const requested = useRef(new Set<string>());
  const fileRequest = useRef(0);
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef("");

  const loadDir = useCallback(async (dir: string) => {
    requested.current.add(dir);
    setDirs((current) => ({ ...current, [dir]: { status: "loading" } }));
    try {
      const listing = parseListing(await piRequest(query("/api/workbench/files", { path: dir || undefined })));
      setDirs((current) => ({ ...current, [dir]: { status: "ready", listing } }));
    } catch (failure) {
      setDirs((current) => ({ ...current, [dir]: { status: "error", error: failureText(failure) } }));
    }
  }, []);
  const ensureDir = useCallback((dir: string) => void (requested.current.has(dir) || loadDir(dir)), [loadDir]);

  const expand = useCallback(
    (paths: string[]) => {
      for (const path of paths) ensureDir(path);
      setExpanded((current) => (paths.every((path) => current.has(path)) ? current : new Set([...current, ...paths])));
    },
    [ensureDir],
  );

  const focusRow = useCallback((path: string) => {
    setFocusPath(path);
    // A row that is not rendered yet (its folder is still loading) is focused once it appears.
    const row = treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (row) row.focus();
    else pendingFocus.current = path;
  }, []);

  /** Opens folders down to `path` and moves tree focus there. */
  const reveal = useCallback(
    (path: string, folder: boolean, focus = true) => {
      expand([...ancestors(path), ...(folder && path ? [path] : [])].filter((dir, index, all) => all.indexOf(dir) === index));
      if (path && focus) focusRow(path);
      else if (path) setFocusPath(path);
    },
    [expand, focusRow],
  );

  const openFile = useCallback(
    async (path: string) => {
      const ticket = ++fileRequest.current;
      setViewer({ path, status: "loading" });
      dispatch({ type: "update", id: tab.id, patch: { path } });
      reveal(path, false, false);
      try {
        const file = parseFile(await piRequest(query("/api/workbench/file", { path })));
        if (ticket === fileRequest.current) setViewer({ path, status: "ready", file });
      } catch (failure) {
        if (ticket === fileRequest.current) setViewer({ path, status: "error", error: failureText(failure) });
      }
    },
    [dispatch, reveal, tab.id],
  );

  // First mount only: the root listing, then the file the tab remembers (reload reopens it).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    ensureDir("");
    if (tab.path) void openFile(tab.path);
  }, [ensureDir, openFile, tab.path]);

  const refresh = () => {
    for (const dir of requested.current) if (dir === "" || expanded.has(dir)) void loadDir(dir);
    for (const dir of [...requested.current]) if (dir !== "" && !expanded.has(dir)) requested.current.delete(dir);
    if (viewer) void openFile(viewer.path);
  };

  const rows = useMemo(() => flattenTree(dirs, expanded), [dirs, expanded]);
  useEffect(() => {
    const path = pendingFocus.current;
    const row = path && treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (!row) return;
    pendingFocus.current = "";
    row.focus();
  }, [rows]);
  const entries = rows.filter((row): row is Extract<TreeRow, { kind: "entry" }> => row.kind === "entry");
  const tabStop = entries.some((row) => row.path === focusPath) ? focusPath : entries[0]?.path;

  const activate = (row: Extract<TreeRow, { kind: "entry" }>) => {
    const { entry, path } = row;
    setFocusPath(path);
    if (entry.type === "dir") {
      if (row.expanded) setExpanded((current) => new Set([...current].filter((item) => item !== path)));
      else expand([path]);
    } else if (entry.type === "link") {
      const target = entry.target;
      if (target?.type === "dir") reveal(target.path, true);
      else if (target?.type === "file") void openFile(target.path);
    } else void openFile(path);
  };

  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>, row: Extract<TreeRow, { kind: "entry" }>) => {
    const index = entries.indexOf(row);
    const move = (next: number) => entries[next] && focusRow(entries[next].path);
    const handlers: Record<string, () => void> = {
      ArrowDown: () => move(index + 1),
      ArrowUp: () => move(index - 1),
      Home: () => move(0),
      End: () => move(entries.length - 1),
      Enter: () => activate(row),
      " ": () => activate(row),
      ArrowRight: () => {
        if (row.entry.type !== "dir") return;
        if (!row.expanded) expand([row.path]);
        else if (entries[index + 1]?.depth > row.depth) move(index + 1);
      },
      ArrowLeft: () => {
        if (row.entry.type === "dir" && row.expanded) setExpanded((current) => new Set([...current].filter((item) => item !== row.path)));
        else if (row.depth > 1) focusRow(parentPath(row.path));
      },
    };
    const handler = handlers[event.key];
    if (!handler) return;
    event.preventDefault();
    handler();
  };

  const quickReturn = useRef<HTMLElement | null>(null);
  const showQuickOpen = () => {
    quickReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuickOpen(true);
  };
  const hideQuickOpen = useCallback((restore: boolean) => {
    setQuickOpen(false);
    if (restore) quickReturn.current?.focus();
  }, []);
  const onPaneKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "p") {
      event.preventDefault();
      showQuickOpen();
    }
  };

  const crumbs = viewer ? viewer.path.split("/") : [];
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = mac ? "⌘P" : "Ctrl+P";

  return (
    <div className="wb-files" onKeyDown={onPaneKey}>
      <div className="wb-files-bar">
        <nav aria-label="Breadcrumb" className="wb-files-crumbs">
          <ol>
            <li>
              {crumbs.length ? (
                <button type="button" onClick={() => treeRef.current?.querySelector<HTMLElement>("[role=treeitem]")?.focus()}>
                  Workspace
                </button>
              ) : (
                <span aria-current="page">Workspace</span>
              )}
            </li>
            {crumbs.map((part, index) => {
              const path = crumbs.slice(0, index + 1).join("/");
              const last = index === crumbs.length - 1;
              return (
                <li key={path}>
                  <ChevronRight size={12} aria-hidden="true" />
                  {last ? (
                    <span aria-current="page" title={path}>
                      {part}
                    </span>
                  ) : (
                    <button type="button" title={`Show ${path} in the tree`} onClick={() => reveal(path, true)}>
                      {part}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <button type="button" className="wb-files-search" aria-label="Go to file" onClick={showQuickOpen} aria-keyshortcuts={mac ? "Meta+P" : "Control+P"}>
          <Search size={14} aria-hidden="true" />
          <span>Go to file</span>
          <kbd aria-hidden="true">{shortcut}</kbd>
        </button>
        <button type="button" className="wb-icon" aria-label="Refresh files" title="Refresh files" onClick={refresh}>
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="wb-files-body" data-file={viewer ? "" : undefined}>
        <div className="wb-files-tree" ref={treeRef} role="tree" aria-label="Workspace files">
          {rows.map((row) =>
            row.kind === "note" ? (
              <div key={row.key} className="wb-files-note" style={{ paddingInlineStart: indent(row.depth) }} role="none">
                <span role={row.retry === undefined ? "status" : "alert"}>{row.text}</span>
                {row.retry !== undefined && (
                  <button type="button" onClick={() => void loadDir(row.retry ?? "")}>
                    Try again
                  </button>
                )}
              </div>
            ) : (
              <TreeItem
                key={row.path}
                row={row}
                selected={viewer?.path === row.path || (row.entry.type === "link" && row.entry.target?.type === "file" && viewer?.path === row.entry.target.path)}
                tabStop={row.path === tabStop}
                onActivate={() => activate(row)}
                onKeyDown={(event) => onTreeKey(event, row)}
                onFocus={() => setFocusPath(row.path)}
              />
            ),
          )}
        </div>
        <section className="wb-files-viewer" aria-label={viewer ? `Viewing ${baseName(viewer.path)}` : "File viewer"}>
          <ViewerBody viewer={viewer} onOpen={(path) => void openFile(path)} shortcut={shortcut} />
        </section>
      </div>
      {quickOpen && (
        <QuickOpen
          onClose={hideQuickOpen}
          onPick={(hit) => {
            hideQuickOpen(false);
            if (hit.type === "dir") reveal(hit.path, true);
            else {
              void openFile(hit.path);
              focusRow(hit.path);
            }
          }}
        />
      )}
    </div>
  );
}

const indent = (depth: number) => `${8 + (depth - 1) * 14}px`;

function TreeItem({
  row,
  selected,
  tabStop,
  onActivate,
  onKeyDown,
  onFocus,
}: {
  row: Extract<TreeRow, { kind: "entry" }>;
  selected: boolean;
  tabStop: boolean;
  onActivate: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
}) {
  const { entry } = row;
  const Icon = entryIcon(entry, row.expanded);
  const unreachable = entry.type === "link" && entry.target?.type !== "dir" && entry.target?.type !== "file";
  const target = entry.type === "link" ? entry.target : undefined;
  const linkNote = !target
    ? undefined
    : "path" in target
      ? `Link to ${target.path || "Workspace"}`
      : target.type === "outside"
        ? "Link points outside the workspace"
        : "Link target is missing";
  return (
    <div
      role="treeitem"
      data-path={row.path}
      aria-level={row.depth}
      aria-expanded={entry.type === "dir" ? row.expanded : undefined}
      aria-selected={selected}
      aria-disabled={unreachable || undefined}
      aria-description={linkNote}
      title={linkNote ?? row.path}
      tabIndex={tabStop ? 0 : -1}
      className="wb-files-row"
      data-hidden={entry.hidden ? "" : undefined}
      style={{ paddingInlineStart: indent(row.depth) }}
      onClick={unreachable ? undefined : onActivate}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <span className="wb-files-chevron" data-open={row.expanded ? "" : undefined} aria-hidden="true">
        {entry.type === "dir" && <ChevronRight size={13} />}
      </span>
      <Icon size={15} aria-hidden="true" className="wb-files-glyph" />
      <span className="wb-files-name">{entry.name}</span>
    </div>
  );
}

const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
/** The host serves the file as an inert attachment (docs/WORKBENCH.md "File downloads"). */
export const downloadUrl = (path: string) => `/api/workbench/download?path=${encodeURIComponent(path)}`;

function DownloadLink({ path, size, labelled = false }: { path: string; size: number; labelled?: boolean }) {
  const name = baseName(path);
  if (size > DOWNLOAD_LIMIT)
    return (
      <span className="wb-files-download" aria-disabled="true" title="Files over 20 MiB cannot be downloaded from the workbench.">
        <Download size={14} aria-hidden="true" />
        {labelled && "Too large to download"}
      </span>
    );
  return (
    <a
      className="wb-files-download"
      href={downloadUrl(path)}
      download={name}
      aria-label={labelled ? undefined : `Download ${name}`}
      title={`Download ${name} (${formatSize(size)})`}
    >
      <Download size={14} aria-hidden="true" />
      {labelled && `Download ${formatSize(size)}`}
    </a>
  );
}

function ViewerBody({ viewer, onOpen, shortcut }: { viewer: Viewer | null; onOpen: (path: string) => void; shortcut: string }) {
  if (!viewer)
    return (
      <div className="wb-empty">
        <div className="wb-files-empty">
          <p>Choose a file to view it.</p>
          <p className="wb-note">
            Press <kbd>{shortcut}</kbd> to find one by name.
          </p>
        </div>
      </div>
    );
  if (viewer.status === "loading")
    return (
      <div className="wb-empty" role="status">
        <p>Opening {baseName(viewer.path)}…</p>
      </div>
    );
  if (viewer.status === "error")
    return (
      <div className="wb-empty">
        <div className="wb-files-empty" role="alert">
          <p>{baseName(viewer.path)} could not be opened.</p>
          <p className="wb-note">{viewer.error}</p>
        </div>
      </div>
    );
  return <FileView key={`${viewer.file.path}:${viewer.file.modified}`} file={viewer.file} onOpen={onOpen} />;
}

function FileView({ file, onOpen }: { file: FileContent; onOpen: (path: string) => void }) {
  const markdown = file.kind === "text" && isMarkdown(file.path);
  const [source, setSource] = useState(false);
  const [dimensions, setDimensions] = useState("");
  const meta = [formatSize(file.size), dimensions, modifiedText(file.modified) && `Modified ${modifiedText(file.modified)}`].filter(Boolean).join(" · ");
  return (
    <>
      <header className="wb-files-head">
        <div className="wb-files-title">
          <h3>{baseName(file.path)}</h3>
          <p className="wb-note">{meta}</p>
        </div>
        {markdown && (
          <div className="wb-files-mode" role="group" aria-label="Markdown view">
            <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
              Preview
            </button>
            <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
              Source
            </button>
          </div>
        )}
        <DownloadLink path={file.path} size={file.size} />
      </header>
      {file.truncated && (
        <p className="wb-files-warning" role="status">
          Showing the first 2 MB of {formatSize(file.size)}.
        </p>
      )}
      {file.kind === "image" ? (
        <div className="wb-files-image">
          <img
            src={rawUrl(file.path)}
            alt={baseName(file.path)}
            onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight} px`)}
          />
        </div>
      ) : file.kind === "binary" ? (
        <div className="wb-empty">
          <div className="wb-files-binary">
            <p>Binary file, {formatSize(file.size)}. It cannot be previewed here.</p>
            <DownloadLink path={file.path} size={file.size} labelled />
          </div>
        </div>
      ) : markdown && !source ? (
        <MarkdownView file={file} onOpen={onOpen} />
      ) : (
        <CodeView text={file.text} label={`${baseName(file.path)} contents`} />
      )}
    </>
  );
}

function CodeView({ text, label }: { text: string; label: string }) {
  const gutter = useMemo(() => lineGutter(text), [text]);
  return (
    <div className="wb-files-code" role="region" aria-label={label} tabIndex={0}>
      <pre className="wb-files-gutter" aria-hidden="true">
        {gutter}
      </pre>
      <pre className="wb-files-text">
        <code>{text}</code>
      </pre>
    </div>
  );
}

type MdProps<Tag extends "a" | "img"> = ComponentProps<Tag> & { node?: unknown };
function MarkdownView({ file, onOpen }: { file: FileContent; onOpen: (path: string) => void }) {
  const components = useMemo(
    () => ({
      a: ({ node: _node, href = "", children, ...props }: MdProps<"a">) => {
        const local = resolveRelative(file.path, href);
        if (href.startsWith("#")) return <a href={href} {...props}>{children}</a>;
        if (local)
          return (
            <a
              href={href}
              {...props}
              onClick={(event) => {
                event.preventDefault();
                onOpen(local);
              }}
            >
              {children}
            </a>
          );
        return (
          <a href={href} {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
      },
      img: ({ node: _node, src, alt = "", ...props }: MdProps<"img">) => {
        const local = typeof src === "string" ? resolveRelative(file.path, src) : null;
        // Remote images would let a workspace file make the browser call out; only workspace images load.
        if (!local) return <span className="wb-files-remote">{alt ? `Image: ${alt}` : "Remote image not loaded"}</span>;
        return <img {...props} src={rawUrl(local)} alt={alt} loading="lazy" />;
      },
    }),
    [file.path, onOpen],
  );
  return (
    <article className="wb-files-md">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {file.text}
      </ReactMarkdown>
    </article>
  );
}

function QuickOpen({ onClose, onPick }: { onClose: (restoreFocus: boolean) => void; onPick: (hit: { path: string; type: "file" | "dir" }) => void }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ticket = useRef(0);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose]);

  useEffect(() => {
    const q = text.trim();
    const mine = ++ticket.current;
    if (!q) return;
    const timer = setTimeout(async () => {
      try {
        const next = parseSearch(await piRequest(query("/api/workbench/search", { q })));
        if (mine !== ticket.current) return;
        setResult(next);
        setError("");
        setActive(0);
      } catch (failure) {
        if (mine === ticket.current) setError(failureText(failure));
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [text]);

  const hits = text.trim() ? (result?.results ?? []) : [];
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (hits.length) setActive((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
    } else if (event.key === "Enter" && hits[active]) {
      event.preventDefault();
      onPick(hits[active]);
    }
  };
  const status = !text.trim()
    ? "Type part of a file name."
    : error
      ? error
      : result === null
        ? "Searching…"
        : !hits.length
          ? result.timedOut
            ? "No match found before the 3 second search limit."
            : "No files match."
          : `${hits.length}${result.truncated ? "+" : ""} ${hits.length === 1 ? "match" : "matches"}${result.timedOut ? ", search stopped at 3 seconds" : ""}`;
  return (
    <div
      ref={box}
      className="wb-files-quick"
      role="dialog"
      aria-label="Go to file"
      onBlur={(event) => {
        // Tabbing away closes it and leaves focus where it went.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) onClose(false);
      }}
    >
      <div className="wb-files-quick-field">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          role="combobox"
          aria-label="File name"
          aria-expanded={hits.length > 0}
          aria-controls="wb-files-quick-list"
          aria-activedescendant={hits[active] ? `wb-files-hit-${active}` : undefined}
          aria-autocomplete="list"
          placeholder="Go to file…"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
        />
      </div>
      <ul id="wb-files-quick-list" role="listbox" aria-label="Matching files">
        {hits.map((hit, index) => {
          const Icon = hit.type === "dir" ? Folder : entryIcon({ name: baseName(hit.path), type: "file", size: 0, modified: 0, hidden: false }, false);
          return (
            <li
              key={hit.path}
              id={`wb-files-hit-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(hit)}
            >
              <Icon size={15} aria-hidden="true" />
              <span className="wb-files-hit-name">{baseName(hit.path)}</span>
              <span className="wb-files-hit-dir">{parentPath(hit.path)}</span>
            </li>
          );
        })}
      </ul>
      <p className="wb-files-quick-status" role="status">
        {status}
      </p>
    </div>
  );
}
