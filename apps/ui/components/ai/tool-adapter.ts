import type { ToolActivity } from "@/lib/pi/live-state";
import type { StepState, TimelineStep } from "@/components/vendor/agent-elements/types/timeline";

// Pure mapping from Pi tool calls to the props the 21st Agent Elements cards
// take. Type-only imports: node --test loads this file directly.

export type ToolStatus = "running" | "complete" | "failed" | "cancelled";
export type DiffLine = { type: "add" | "remove" | "context"; content: string };
export type FileDiff = { path: string; lines: DiffLine[]; added: number; removed: number };
export type ToolCategory =
  | "command"
  | "read"
  | "edit"
  | "write"
  | "patch"
  | "web"
  | "fetch"
  | "tools"
  | "code"
  | "other";
type Kind = "command" | "edit" | "read" | "search" | "generic";
type Phrase = "command" | "read" | "edit" | "write" | "web" | "fetch" | "tools" | "code" | "other";
type ToolStep = Extract<TimelineStep, { type: "tool-call" }>;

type Common = {
  id: string;
  name: string;
  category: ToolCategory;
  status: ToolStatus;
  title: string;
  activeTitle: string;
  detail: string;
  rawInput: string;
  output?: string;
  durationMs?: number;
};
export type ToolView =
  | (Common & { kind: "command"; command: string; exitCode?: number; truncated: boolean })
  | (Common & { kind: "edit"; files: FileDiff[]; created: boolean })
  | (Common & { kind: "read"; path: string })
  | (Common & { kind: "search"; query: string })
  | (Common & { kind: "generic" });

const categoryByName: Record<string, ToolCategory> = {
  bash: "command",
  powershell: "command",
  host_exec: "command",
  read: "read",
  host_read: "read",
  edit: "edit",
  write: "write",
  host_write: "write",
  apply_patch: "patch",
  web_search: "web",
  web_fetch: "fetch",
  tool_search: "tools",
  codemode: "code",
};

const categories: Record<ToolCategory, { kind: Kind; title: string; active: string; phrase: Phrase }> = {
  command: { kind: "command", title: "Run command", active: "Running command", phrase: "command" },
  read: { kind: "read", title: "Read file", active: "Reading file", phrase: "read" },
  edit: { kind: "edit", title: "Edit file", active: "Editing file", phrase: "edit" },
  write: { kind: "edit", title: "Write file", active: "Writing file", phrase: "write" },
  patch: { kind: "edit", title: "Apply patch", active: "Applying patch", phrase: "edit" },
  web: { kind: "search", title: "Search the web", active: "Searching the web", phrase: "web" },
  fetch: { kind: "search", title: "Fetch page", active: "Fetching page", phrase: "fetch" },
  tools: { kind: "search", title: "Find tools", active: "Finding tools", phrase: "tools" },
  code: { kind: "generic", title: "Run code", active: "Running code", phrase: "code" },
  other: { kind: "generic", title: "", active: "", phrase: "other" },
};

const count = (n: number, word: string, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;
const times = (phrase: string) => (n: number) => (n === 1 ? phrase : `${phrase} ${n} times`);
const phrases: Record<Phrase, (n: number) => string> = {
  command: (n) => `ran ${count(n, "command")}`,
  read: (n) => `read ${count(n, "file")}`,
  edit: (n) => `edited ${count(n, "file")}`,
  write: (n) => `wrote ${count(n, "file")}`,
  web: times("searched the web"),
  fetch: (n) => `fetched ${count(n, "page")}`,
  tools: times("looked up tools"),
  code: times("ran code"),
  other: (n) => `used ${count(n, "tool")}`,
};

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const optionalString = (value: unknown) => (typeof value === "string" ? value : undefined);
const optionalNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const states: readonly NonNullable<ToolActivity["state"]>[] = ["running", "complete", "failed", "cancelled"];

/** Message metadata arrives untyped through assistant-ui; parse it back into ToolActivity. */
export function parseToolActivity(value: unknown): ToolActivity | undefined {
  if (!isRecord(value)) return undefined;
  const details = isRecord(value.details) ? value.details : undefined;
  return {
    id: str(value.id),
    name: str(value.name) || "Tool",
    input: str(value.input),
    output: optionalString(value.output),
    failed: value.failed === true,
    state: states.find((state) => state === value.state),
    durationMs: optionalNumber(value.durationMs),
    exitCode: optionalNumber(value.exitCode),
    details: details && {
      patch: optionalString(details.patch),
      diff: optionalString(details.diff),
      truncated: typeof details.truncated === "boolean" ? details.truncated : undefined,
      fullOutputPath: optionalString(details.fullOutputPath),
    },
    children: Array.isArray(value.children)
      ? value.children.flatMap((child) => parseToolActivity(child) ?? [])
      : undefined,
  };
}

function parseArguments(input: string): Json {
  try {
    const value: unknown = JSON.parse(input);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function toolStatus(tool: ToolActivity): ToolStatus {
  if (tool.failed) return "failed";
  if (tool.state === "cancelled") return "cancelled";
  if (tool.state === "running" || (tool.output === undefined && tool.state !== "complete"))
    return "running";
  return "complete";
}

/** Unified or git patch text to per-file line lists. Headers and hunk ranges are honoured. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = patch.split("\n");
  const git = lines.some((line) => line.startsWith("diff --git "));
  const clean = (path: string, prefix: string) => {
    const bare = path.split("\t")[0].trim();
    return git && bare.startsWith(prefix) ? bare.slice(prefix.length) : bare;
  };
  let oldPath = "";
  let current: FileDiff | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      oldPath = clean(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = clean(line.slice(4), "b/");
      current = { path: newPath === "/dev/null" ? oldPath : newPath, lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!hunk || !current) continue;
    let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    let newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    while ((oldLeft > 0 || newLeft > 0) && index + 1 < lines.length) {
      const body = lines[++index];
      if (body.startsWith("\\")) continue;
      const content = body.slice(1);
      if (body.startsWith("+")) {
        current.lines.push({ type: "add", content });
        current.added++;
        newLeft--;
      } else if (body.startsWith("-")) {
        current.lines.push({ type: "remove", content });
        current.removed++;
        oldLeft--;
      } else {
        current.lines.push({ type: "context", content });
        oldLeft--;
        newLeft--;
      }
    }
  }
  return files.filter((file) => file.lines.length > 0);
}

function replacementDiff(path: string, pairs: { oldText: string; newText: string }[]): FileDiff[] {
  const lines = pairs.flatMap(({ oldText, newText }): DiffLine[] => [
    ...(oldText ? oldText.split("\n") : []).map((content) => ({ type: "remove" as const, content })),
    ...(newText ? newText.split("\n") : []).map((content) => ({ type: "add" as const, content })),
  ]);
  if (!lines.length) return [];
  const added = lines.filter((line) => line.type === "add").length;
  return [{ path, lines, added, removed: lines.length - added }];
}

function editFiles(category: ToolCategory, args: Json, path: string, patch?: string): FileDiff[] {
  const fromPatch = parsePatch(patch ?? (category === "patch" ? str(args.patch) : ""));
  if (fromPatch.length) return fromPatch;
  if (category === "write") return replacementDiff(path, [{ oldText: "", newText: str(args.content) }]);
  const edits = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [args];
  return replacementDiff(
    path,
    edits.map((edit) => ({
      oldText: str(edit.oldText) || str(edit.old_string),
      newText: str(edit.newText) || str(edit.new_string),
    })),
  );
}

const humanise = (name: string) => {
  const words = name.replace(/^mcp__/, "").replaceAll("__", " ").replaceAll("_", " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Tool";
};

export function toolView(tool: ToolActivity): ToolView {
  const category = categoryByName[tool.name] ?? "other";
  const spec = categories[category];
  const args = parseArguments(tool.input);
  const path = str(args.path) || str(args.file_path) || str(args.filePath);
  const label = humanise(tool.name);
  const common: Common = {
    id: tool.id,
    name: tool.name,
    category,
    status: toolStatus(tool),
    title: spec.title || label,
    activeTitle: spec.active || label,
    detail: path,
    rawInput: tool.input,
    output: tool.output,
    durationMs: tool.durationMs,
  };
  switch (spec.kind) {
    case "command": {
      const command = str(args.command) || str(args.cmd);
      return {
        ...common,
        kind: "command",
        detail: command.split("\n")[0],
        command,
        exitCode: tool.exitCode,
        truncated: tool.details?.truncated === true,
      };
    }
    case "edit": {
      const files = editFiles(category, args, path, tool.details?.patch);
      const detail = path || files.map((file) => file.path).join(", ") || str(args.cwd);
      return { ...common, kind: "edit", detail, files, created: category === "write" };
    }
    case "read":
      return { ...common, kind: "read", path };
    case "search": {
      const query = str(args.query) || str(args.url);
      return { ...common, kind: "search", detail: query, query };
    }
    case "generic":
      return { ...common, kind: "generic", detail: "" };
  }
}

/** A codemode call stands for the nested calls it made, so those are what the group lists. */
export function toolViews(tools: readonly unknown[]): ToolView[] {
  return tools
    .flatMap((value) => parseToolActivity(value) ?? [])
    .flatMap((tool) => (tool.children?.length ? tool.children : [tool]))
    .map(toolView);
}

/** Claude-style group line: "Ran 2 commands, read 1 file". */
export function summarise(views: readonly ToolView[]): string {
  const totals = new Map<Phrase, number>();
  for (const view of views) {
    const phrase = categories[view.category].phrase;
    const weight = view.kind === "edit" && view.category === "patch" ? Math.max(1, view.files.length) : 1;
    totals.set(phrase, (totals.get(phrase) ?? 0) + weight);
  }
  const text = [...totals].map(([phrase, n]) => phrases[phrase](n)).join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

export const actionCount = (n: number) => count(n, "action");

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const stepState = (status: ToolStatus): StepState => (status === "running" ? "animating" : "complete");

export function bashStep(view: Extract<ToolView, { kind: "command" }>): ToolStep {
  return {
    id: view.id,
    type: "tool-call",
    toolName: "Bash",
    toolDetail: view.command,
    duration: 0,
    bashCommand: view.command,
    bashOutput: view.output,
    bashSuccess: view.status !== "failed",
  };
}

export function editStep(view: Extract<ToolView, { kind: "edit" }>, file: FileDiff): ToolStep {
  const stats = [file.added ? `+${file.added}` : "", file.removed ? `-${file.removed}` : ""].filter(Boolean);
  return {
    id: `${view.id}:${file.path}`,
    type: "tool-call",
    toolName: view.created ? "Write" : "Edit",
    toolDetail: file.path,
    duration: 0,
    filePath: file.path,
    diffStats: stats.length ? stats.join(" ") : undefined,
    diffLines: file.lines,
  };
}

/** Old and new text for the diff card; each side is whole lines, so it ends in a newline. */
export function diffInput(file: FileDiff): { old_string: string; new_string: string } {
  const side = (skip: DiffLine["type"]) => {
    const lines = file.lines.filter((line) => line.type !== skip).map((line) => line.content);
    return lines.length ? `${lines.join("\n")}\n` : "";
  };
  return { old_string: side("add"), new_string: side("remove") };
}
