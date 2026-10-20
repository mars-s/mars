// Boundary parsers for /api/workbench/* (docs/WORKBENCH.md). Type-only imports so node --test loads it.

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export type ToolCapability = { available: boolean; reason: string };
export type Capabilities = Record<
  "changes" | "files" | "terminal" | "side-chat" | "page" | "browser",
  ToolCapability
>;
const TOOLS = ["changes", "files", "terminal", "side-chat", "page", "browser"] as const;

/** Unknown or missing tools are unavailable with the host's reason, or a generic one. */
export function parseCapabilities(value: unknown): Capabilities {
  const row = record(record(value).tools);
  return Object.fromEntries(
    TOOLS.map((tool) => {
      const item = record(row[tool]);
      return [
        tool,
        item.available === true
          ? { available: true, reason: "" }
          : { available: false, reason: str(item.reason) || "This Pi host does not offer it yet." },
      ];
    }),
  ) as Capabilities;
}

/** A workspace-relative path the host returned; anything absolute or with `..` is dropped. */
const relPath = (value: unknown) => {
  const path = str(value);
  return path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => part === "..") ? "" : path;
};

export type LinkTarget = { type: "dir" | "file"; path: string } | { type: "outside" | "missing" };
export type FileEntry = {
  name: string;
  type: "file" | "dir" | "link";
  size: number;
  modified: number;
  hidden: boolean;
  /** Only for links: where the link resolves inside the workspace, or why it cannot be opened. */
  target?: LinkTarget;
};
export type Listing = { path: string; entries: FileEntry[]; truncated: boolean };
function parseLinkTarget(value: unknown): LinkTarget {
  const row = record(value);
  const path = relPath(row.path);
  if ((row.type === "dir" || row.type === "file") && (path || row.path === "")) return { type: row.type, path };
  return { type: row.type === "missing" ? "missing" : "outside" };
}
export function parseListing(value: unknown): Listing {
  const row = record(value);
  return {
    path: relPath(row.path),
    truncated: row.truncated === true,
    entries: list(row.entries)
      .map(record)
      .flatMap((entry) => {
        const name = str(entry.name);
        const type = entry.type === "dir" || entry.type === "link" ? entry.type : "file";
        if (!name || name.includes("/") || name === "." || name === "..") return [];
        const parsed: FileEntry = { name, type, size: num(entry.size), modified: num(entry.modified), hidden: name.startsWith(".") };
        if (type === "link") parsed.target = parseLinkTarget(entry.target);
        return [parsed];
      }),
  };
}

const IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type FileContent = {
  path: string;
  size: number;
  modified: number;
  kind: "text" | "image" | "binary";
  text: string;
  truncated: boolean;
  /** Sniffed by the host from the bytes; empty unless kind is image. */
  mime: string;
};
export function parseFile(value: unknown): FileContent {
  const row = record(value);
  const kind = row.kind === "image" || row.kind === "binary" ? row.kind : "text";
  const mime = str(row.mime);
  return {
    path: relPath(row.path),
    size: num(row.size),
    modified: num(row.modified),
    kind,
    text: kind === "text" ? str(row.text) : "",
    truncated: kind === "text" && row.truncated === true,
    mime: kind === "image" && (IMAGE_MIME as readonly string[]).includes(mime) ? mime : "",
  };
}

export type SearchHit = { path: string; type: "file" | "dir" };
export type SearchResult = { results: SearchHit[]; truncated: boolean; timedOut: boolean };
export function parseSearch(value: unknown): SearchResult {
  const row = record(value);
  return {
    truncated: row.truncated === true,
    timedOut: row.timedOut === true,
    results: list(row.results)
      .map(record)
      .flatMap((hit) => {
        const path = relPath(hit.path);
        return path ? [{ path, type: hit.type === "dir" ? "dir" : "file" } as SearchHit] : [];
      }),
  };
}

export type Repo = { path: string; branch: string; ahead: number; behind: number; dirty: boolean };
export function parseRepos(value: unknown): Repo[] {
  return list(record(value).repos)
    .map(record)
    .flatMap((repo) =>
      typeof repo.path === "string"
        ? [{ path: repo.path, branch: str(repo.branch), ahead: num(repo.ahead), behind: num(repo.behind), dirty: repo.dirty === true }]
        : [],
    );
}

export type ChangedFile = { path: string; status: string; added: number; removed: number; binary: boolean };
export type Changes = { repo: string; branch: string; files: ChangedFile[]; patch: string; truncated: boolean };
export function parseChanges(value: unknown): Changes {
  const row = record(value);
  return {
    repo: str(row.repo),
    branch: str(row.branch),
    patch: str(row.patch),
    truncated: row.truncated === true,
    files: list(row.files)
      .map(record)
      .flatMap((file) =>
        str(file.path)
          ? [{ path: str(file.path), status: str(file.status) || "M", added: num(file.added), removed: num(file.removed), binary: file.binary === true }]
          : [],
      ),
  };
}

export type PageSummary = { name: string; title: string; modified: number; size: number };
export const PAGE_NAME = /^[a-z0-9-]{1,64}$/;
export function parsePages(value: unknown): PageSummary[] {
  return list(record(value).pages)
    .map(record)
    .flatMap((page) => {
      const name = str(page.name);
      return PAGE_NAME.test(name) ? [{ name, title: str(page.title) || name, modified: num(page.modified), size: num(page.size) }] : [];
    });
}
export type Page = { name: string; text: string; modified: number };
export function parsePage(value: unknown): Page {
  const row = record(record(value).page ?? value);
  return { name: str(row.name), text: str(row.text), modified: num(row.modified) };
}
/** A POST /api/workbench/pages answer: the saved page's name, title and new modified time. */
export type SavedPage = PageSummary;
export function parseSavedPage(value: unknown): SavedPage {
  const row = record(value);
  const name = str(row.name);
  if (!PAGE_NAME.test(name) || !num(row.modified)) throw Error("Pi did not confirm the page save. Your text is kept; try again.");
  return { name, title: str(row.title) || name, modified: num(row.modified), size: num(row.size) };
}
/** Title shown for a page: its first `# heading`, else its name. Mirrors the host. */
export const pageTitle = (text: string, name: string) => /^# +(.+?)\s*#*\s*$/m.exec(text)?.[1].trim() || name;

export type TerminalChunk = { offset: number; data: string; exited: boolean; exitCode?: number; dropped: boolean };
/** `data` stays base64 here; the pane decodes bytes for xterm. */
export function parseTerminalChunk(value: unknown): TerminalChunk {
  const row = record(value);
  return {
    offset: num(row.offset),
    data: str(row.data),
    exited: row.exited === true,
    exitCode: typeof row.exitCode === "number" ? row.exitCode : undefined,
    dropped: row.dropped === true,
  };
}

/** `POST /api/workbench/terminal` answers `{ id }`; anything else is not a session. */
export function parseTerminalCreated(value: unknown): string {
  const id = str(record(value).id);
  return /^[a-f0-9]{24}$/.test(id) ? id : "";
}

export type Service = { port: number; title: string; status: number };
export function parseServices(value: unknown): Service[] {
  return list(record(value).services)
    .map(record)
    .flatMap((service) => {
      const port = num(service.port);
      return Number.isInteger(port) && port > 0 && port < 65536
        ? [{ port, title: str(service.title), status: num(service.status) }]
        : [];
    });
}

export type Suggestion =
  | { kind: "service"; title: string; port: number }
  | { kind: "extension"; title: string; hash: string }
  | { kind: "page"; title: string; name: string };
export function parseSuggestions(value: unknown): Suggestion[] {
  return list(record(value).suggestions)
    .map(record)
    .flatMap((item): Suggestion[] => {
      const title = str(item.title);
      if (item.kind === "service" && Number.isInteger(item.port)) return [{ kind: "service", title: title || `localhost:${item.port}`, port: Number(item.port) }];
      if (item.kind === "extension" && /^[a-f0-9]{64}$/.test(str(item.hash))) return [{ kind: "extension", title: title || "Extension", hash: str(item.hash) }];
      if (item.kind === "page" && PAGE_NAME.test(str(item.name))) return [{ kind: "page", title: title || str(item.name), name: str(item.name) }];
      return [];
    });
}

/** Browser pane URLs: local proxied ports become /api/workbench/browse/<port>/<path>; anything else is external. */
export function browseTarget(input: string): { kind: "local"; port: number; path: string } | { kind: "external"; url: string } | { kind: "invalid" } {
  const text = input.trim();
  if (!text) return { kind: "invalid" };
  const portOnly = /^:?(\d{2,5})(\/.*)?$/.exec(text);
  if (portOnly) return { kind: "local", port: Number(portOnly[1]), path: portOnly[2] || "/" };
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { kind: "invalid" };
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.protocol === "http:") {
    const port = Number(url.port || 80);
    return { kind: "local", port, path: `${url.pathname}${url.search}` };
  }
  return url.protocol === "https:" || url.protocol === "http:" ? { kind: "external", url: url.href } : { kind: "invalid" };
}
