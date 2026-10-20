"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps, type Dispatch, type ReactNode, type SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowLeft, ArrowRight, ArrowUp, BookOpen, Braces, Check, ChevronDown,
  ChevronRight, Code2, Copy, Download, ExternalLink,
  File, FileCode2, FileDiff, FileText, Folder, FolderOpen, GitBranch, Globe,
  Info, Layers, Maximize2, MessageSquare, Minimize2, Monitor,
  MoreHorizontal, PanelRightClose, PanelRightOpen, Pause, Play, Plus,
  Radio, RefreshCw, Search, Settings2, ShieldCheck, Terminal, Trash2,
  Undo2, Unplug, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import StatusMark, { type StatusMarkStatus } from "@/components/react-bits/StatusMark";
import WarmTooltip from "@/components/react-bits/WarmTooltip";
import { useWorkspaceStore } from "@/lib/store";
import type { MarsMessage, Panel, Task, TaskStatus } from "@/lib/types";

export interface WorkspacePanelProps {
  panel: Exclude<Panel, null>;
  onClose: () => void;
  onSelectPanel: (panel: Panel) => void;
  onOpenSession: (id: string) => void;
  expanded: boolean;
  onToggleExpand: () => void;
}

const PANEL_NAMES: Record<Exclude<Panel, null>, string> = {
  context: "Context", files: "Files", terminal: "Terminal", browser: "Browser",
  changes: "Changes", tasks: "Background tasks", sidechat: "Side chat",
};
const PANEL_ICONS = { context: Layers, files: Folder, terminal: Terminal, browser: Globe, changes: FileDiff, tasks: Layers, sidechat: MessageSquare };

const BASE_FILES: Record<string, string> = {
  "README.md": `# Project Mars

A personal AI workspace that stays with the work.

Mars brings conversations, background tasks, project files, and tools into one quiet place. This workspace is a local interface demo: edits and preferences are saved in your browser.

## The workspace

- **Chat** — a place to think, plan, and work through a project.
- **Background tasks** — keep track of longer pieces of work.
- **Files** — read and edit the project alongside the conversation.
- **Memory** — carry useful context between sessions.

## Getting started

Open the **Background tasks** panel to review the sample tasks. You can pause a task, approve its next step, or mark a demo step complete.

The terminal supports a small set of local commands:

\`\`\`sh
help
ls
cat README.md
status
\`\`\`

## Architecture

The interface is prepared for a Mars runtime through a separate adapter. A production gateway would own model calls, permissions, files, and durable jobs.

| Layer | Responsibility |
| --- | --- |
| Workspace | Conversations and controls |
| Gateway | Authenticated runtime connection |
| Agent | Reasoning and tools |
| Task service | Durable background work |
| Memory | Searchable project context |

See [the architecture notes](docs/architecture.md) for more detail.

> This preview does not connect to a model provider, run a shell, or execute background jobs.
`,
  "AGENTS.md": `# Working in Mars

## Principles

Keep the interface calm and the state clear. A conversation should remain available while other work continues.

## Development

- Use TypeScript and small React components.
- Keep runtime services behind a typed adapter.
- Treat permissions as explicit user choices.
- Show waiting, running, and completed states clearly.

## Demo boundaries

Local controls update browser state. Do not present a simulated connection as a live service.
`,
  "package.json": JSON.stringify({ name: "project-mars", version: "0.1.0", private: true, scripts: { dev: "next dev", build: "next build", start: "next start" }, dependencies: { next: "16.4.2", react: "19.3.1", "@assistant-ui/react": "0.15.30" } }, null, 2) + "\n",
  "app/page.tsx": `import { MarsWorkspace } from "@/components/mars-workspace";

export default function Home() {
  return <MarsWorkspace mode="demo" />;
}
`,
  "app/globals.css": `:root {
  --background: #141414;
  --foreground: #d9d9d6;
  --surface: #1a1a1a;
  --border: #2b2b29;
  --accent: #d9987d;
}

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: Arial, Helvetica, sans-serif;
}
`,
  "components/mars-workspace.tsx": `"use client";

type WorkspaceMode = "demo" | "connected";

export function MarsWorkspace({ mode }: { mode: WorkspaceMode }) {
  return (
    <main aria-label="Mars workspace">
      <aside aria-label="Sessions" />
      <section aria-label="Conversation" />
      <aside aria-label="Workbench" />
      <span>{mode === "demo" ? "Demo workspace" : "Connected"}</span>
    </main>
  );
}
`,
  "docs/architecture.md": `# Architecture notes

## One conversation, many pieces of work

The chat surface stays responsive while tasks have their own lifecycle. A production implementation should store each task and its checkpoint outside the browser.

## Runtime boundary

The UI talks to a gateway adapter. The gateway authenticates the session and streams messages, tool events, approvals, and task updates.

### The agent

Pi can supply the interactive agent loop. Durable execution belongs in a task service with persisted checkpoints and idempotent external actions.

### The workspace

Files, a terminal, and a browser are runtime capabilities. This demo uses local fixtures until a real capability adapter is connected.

### Memory

A memory service can index useful facts and retrieve relevant context. The UI should show where that context came from.

## Next steps

1. Define the authenticated gateway contract.
2. Connect the streaming chat adapter.
3. Add durable task events and approval handling.
4. Replace fixture files with scoped workspace access.
`,
  "docs/memory.md": `# Project memory

## Working preferences

- Quiet interfaces with useful detail close at hand.
- Keyboard shortcuts for common actions.
- Long tasks can continue independently of a conversation.

## Current focus

Build a faithful desktop-style workspace. Keep the runtime connection explicit and leave room for tools, subagents, and durable jobs.

These are editable sample notes, stored locally in this browser.
`,
  "lib/runtime.ts": `export interface RuntimeAdapter {
  connect(endpoint: string): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(sessionId: string, content: string): Promise<void>;
  approveTask(taskId: string): Promise<void>;
}

// A production adapter is intentionally not connected in this UI demo.
export const runtimeMode = "demo" as const;
`,
  "plugins/discord-presence.ts": `export const discordPresence = {
  name: "discord-presence",
  enabled: false,
  activity: "Working in Mars",
  showProject: false,
};
`,
  ".env.example": `# Configure the server-side gateway in a production deployment.
# Never put provider secrets in client-side environment variables.
MARS_GATEWAY_URL=http://localhost:8787
`,
};
const INITIAL_FILES: Record<string, string> = { ...BASE_FILES, "plugins/discord-presence.ts": BASE_FILES["plugins/discord-presence.ts"].replace('activity: "Working in Mars"', 'activity: "Building Project Mars"') };
const FILE_STORAGE_KEY = "mars-ui:demo-files:v1";

function useLocalState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) setValue(JSON.parse(saved) as T);
    } catch { /* A fresh in-memory demo still works if storage is unavailable. */ }
    setReady(true);
  }, [key]);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Best-effort local persistence. */ }
  }, [key, value, ready]);
  return [value, setValue];
}

function PanelIconButton({ label, children, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <WarmTooltip content={label} side="bottom"><Button type="button" variant="ghost" size="icon-xs" className="workbench-icon-button" aria-label={label} {...props}>{children}</Button></WarmTooltip>;
}

function PanelHeader({ title, actions, children, ...props }: WorkspacePanelProps & { title?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return <header className="workbench-header">
    <div className="workbench-header-title">{title ?? PANEL_NAMES[props.panel]}</div>
    {children}
    <div className="workbench-header-actions">
      {actions}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="workbench-icon-button" aria-label="Panel options"><MoreHorizontal size={15} /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="workbench-menu">
          <DropdownMenuLabel>Open panel</DropdownMenuLabel>
          {(Object.keys(PANEL_NAMES) as Exclude<Panel, null>[]).map((panel) => { const Icon = PANEL_ICONS[panel]; return <DropdownMenuItem key={panel} onSelect={() => props.onSelectPanel(panel)}><Icon size={14} />{PANEL_NAMES[panel]}{panel === props.panel && <Check className="workbench-menu-check" size={13} />}</DropdownMenuItem>; })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={props.onToggleExpand}>{props.expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{props.expanded ? "Restore panel size" : "Expand panel"}</DropdownMenuItem>
          <DropdownMenuItem onSelect={props.onClose}><X size={14} />Close panel</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PanelIconButton label={props.expanded ? "Restore panel size" : "Expand panel"} onClick={props.onToggleExpand}>{props.expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</PanelIconButton>
      <PanelIconButton label="Close panel" onClick={props.onClose}><X size={15} /></PanelIconButton>
    </div>
  </header>;
}

async function copyText(value: string, label = "Copied") {
  try { await navigator.clipboard.writeText(value); toast.success(label); }
  catch { toast.error("Clipboard access is unavailable in this browser."); }
}

function downloadFile(path: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split("/").pop() || "mars-file.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

function ContextCard({ title, children, defaultOpen = true, aside, headerAction }: { title: string; children: ReactNode; defaultOpen?: boolean; aside?: ReactNode; headerAction?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <section className="context-card">
    <div className="context-card-header">
    <button className="context-card-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
      <span>{title}</span><span className="context-card-aside">{aside}{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
    </button>
    {headerAction}
    </div>
    {open && <div className="context-card-body">{children}</div>}
  </section>;
}

function ContextPanel(props: WorkspacePanelProps) {
  const settings = useWorkspaceStore((s) => s.settings);
  const sessions = useWorkspaceStore((s) => s.sessions);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const updateSettings = useWorkspaceStore((s) => s.updateSettings);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  const [contextDetails, setContextDetails] = useState(false);
  const session = sessions.find((item) => item.id === activeSessionId);
  const tokens = Math.ceil((session?.messages.reduce((sum, message) => sum + message.content.length, 0) || 0) / 4);
  const activeTasks = tasks.filter((task) => ["running", "queued", "waiting_approval", "paused"].includes(task.status)).length;
  const showFile = (path: string) => {
    try {
      const opened = JSON.parse(localStorage.getItem("mars-ui:open-files:v1") || '["README.md"]') as string[];
      localStorage.setItem("mars-ui:active-file:v1", JSON.stringify(path));
      localStorage.setItem("mars-ui:open-files:v1", JSON.stringify(Array.from(new Set([...opened, path]))));
    } catch { /* The file tree is still available if storage is unavailable. */ }
    props.onSelectPanel("files");
  };
  return <div className={`context-panel${props.expanded ? " context-panel-expanded" : ""}`}>
    <ContextCard title="Environment" headerAction={<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-xs" className="context-environment-menu" aria-label="Environment options"><MoreHorizontal size={13} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="workbench-menu"><DropdownMenuLabel>Local demo environment</DropdownMenuLabel><DropdownMenuItem onSelect={() => { setEndpoint(settings.endpoint); setConnectionOpen(true); }}><Unplug size={13} />Runtime connection settings</DropdownMenuItem><DropdownMenuItem onSelect={() => props.onSelectPanel("files")}><Folder size={13} />Open project files</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}>
      <div className="context-row"><Monitor size={14} /><span>This browser</span><span className="context-pill">Demo</span></div>
      <button className="context-row context-row-button" onClick={() => props.onSelectPanel("files")}><Folder size={14} /><span className="context-truncate">{session?.project || "Project Mars"}</span><ChevronRight size={12} /></button>
      <div className="context-row"><GitBranch size={14} /><span className="context-truncate">mars/workspace</span><span className="context-secondary">Local</span></div>
      <div className="context-row context-remote-row"><Radio size={14} /><span>Remote Control</span><WarmTooltip content="Connect a Mars runtime to enable remote control"><span className="context-switch-wrap"><Switch disabled size="sm" checked={false} aria-label="Remote Control requires a runtime connection" /></span></WarmTooltip></div>
    </ContextCard>

    <ContextCard title="Context" defaultOpen={false} aside={<span title="Estimated from conversation text">~{tokens.toLocaleString()} tokens</span>}>
      <div className="context-usage"><span>{tokens.toLocaleString()} tokens</span><span>estimated</span></div>
      <div className="context-usage-track" aria-hidden="true"><i style={{ width: `${Math.max(3, Math.min(80, tokens / 300))}%` }} /><i /><i /></div>
      <p className="context-small-note">Conversation text · approximately 4 characters per token</p>
      <div className="context-metric-row"><span className="context-dot context-dot-blue" /><span>Messages</span><span>{session?.messages.length || 0}</span></div>
      <button className="context-metric-row context-row-button" onClick={() => props.onSelectPanel("files")}><span className="context-dot context-dot-orange" /><span>Project files</span><span>{Object.keys(BASE_FILES).length}</span></button>
      <button className="context-metric-row context-row-button" onClick={() => props.onSelectPanel("tasks")}><span className="context-dot context-dot-green" /><span>Active tasks</span><span>{activeTasks}</span></button>
      <div className="context-metric-row"><span className="context-dot context-dot-gray" /><span>Connected tools</span><span>0</span></div>
      <div className="context-divider" />
      <button className="context-disclosure" onClick={() => setContextDetails(!contextDetails)} aria-expanded={contextDetails}>{contextDetails ? <ChevronDown size={12} /> : <ChevronRight size={12} />}Memory files<span>2</span></button>
      {contextDetails && <div className="context-memory-list"><button onClick={() => showFile("AGENTS.md")}><FileText size={12} />AGENTS.md</button><button onClick={() => showFile("docs/memory.md")}><FileText size={12} />docs/memory.md</button><span>Editable local samples</span></div>}
      <button className="context-disclosure" onClick={() => { setEndpoint(settings.endpoint); setConnectionOpen(true); }}><ChevronRight size={12} />MCP tools<span>Not connected</span></button>
      <button className="context-disclosure" onClick={() => props.onSelectPanel("tasks")}><ChevronRight size={12} />Background tasks<span>{tasks.length}</span></button>
    </ContextCard>

    <ContextCard title="Connectors" defaultOpen={false} aside={<span>3 available</span>}>
      {[{ name: "GitHub", Icon: GitBranch }, { name: "Discord", Icon: MessageSquare }, { name: "Hindsight", Icon: BookOpen }].map(({ name, Icon }) => <div key={name} className="context-row"><Icon size={14} /><span>{name}</span><span className="context-secondary">Not connected</span></div>)}
      <Button variant="outline" size="sm" className="context-connection-button" onClick={() => { setEndpoint(settings.endpoint); setConnectionOpen(true); }}><Settings2 size={13} />Connection settings</Button>
    </ContextCard>
    <div className="context-panel-actions"><button className="context-close" onClick={props.onToggleExpand}>{props.expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}{props.expanded ? "Restore context size" : "Expand context"}</button><button className="context-close" onClick={props.onClose}><PanelRightClose size={13} />Hide context</button></div>

    <Dialog open={connectionOpen} onOpenChange={setConnectionOpen}>
      <DialogContent className="workbench-dialog">
        <DialogHeader><DialogTitle>Mars runtime</DialogTitle><DialogDescription>This interface is running as a local demo. Save a gateway URL for a future runtime adapter.</DialogDescription></DialogHeader>
        <div className="context-connection-status"><Unplug size={16} /><div><strong>Not connected</strong><p>Model calls, remote control, and connectors are unavailable in demo mode.</p></div></div>
        <label className="workbench-field-label" htmlFor="mars-gateway-url">Gateway URL</label>
        <Input id="mars-gateway-url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="http://localhost:8787" />
        <p className="workbench-help">This stores the URL in this browser. It does not authenticate or connect to the gateway.</p>
        <DialogFooter><Button variant="outline" onClick={() => setConnectionOpen(false)}>Cancel</Button><Button onClick={() => {
          if (endpoint.trim()) { try { const parsed = new URL(endpoint); if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) throw new Error(); } catch { toast.error("Enter an HTTP, HTTPS, WS, or WSS gateway URL."); return; } }
          updateSettings({ endpoint: endpoint.trim() }); setConnectionOpen(false); toast.success("Gateway URL saved locally");
        }}>Save URL</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

type TreeEntry = { name: string; path: string; children?: TreeEntry[] };
function buildTree(paths: string[]): TreeEntry[] {
  const root: TreeEntry[] = [];
  for (const path of paths) {
    let level = root;
    const parts = path.split("/");
    parts.forEach((part, index) => {
      const fullPath = parts.slice(0, index + 1).join("/");
      let entry = level.find((item) => item.path === fullPath);
      if (!entry) { entry = { name: part, path: fullPath, ...(index < parts.length - 1 ? { children: [] } : {}) }; level.push(entry); }
      if (entry.children) level = entry.children;
    });
  }
  const sort = (entries: TreeEntry[]) => { entries.sort((a, b) => Number(!!b.children) - Number(!!a.children) || a.name.localeCompare(b.name)); entries.forEach((item) => { if (item.children) sort(item.children); }); };
  sort(root);
  return root;
}

function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  if (/\.md$/.test(path)) return <FileText size={size} />;
  if (/\.(tsx?|jsx?)$/.test(path)) return <FileCode2 className="file-type-code" size={size} />;
  if (/\.json$/.test(path)) return <Braces className="file-type-json" size={size} />;
  if (/\.css$/.test(path)) return <Code2 className="file-type-css" size={size} />;
  return <File size={size} />;
}

function FilesPanel(props: WorkspacePanelProps) {
  const [files, setFiles] = useLocalState(FILE_STORAGE_KEY, INITIAL_FILES);
  const [openFiles, setOpenFiles] = useLocalState<string[]>("mars-ui:open-files:v1", ["README.md"]);
  const [activeFile, setActiveFile] = useLocalState<string>("mars-ui:active-file:v1", "README.md");
  const [treeOpen, setTreeOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [source, setSource] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newPath, setNewPath] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const paths = Object.keys(files).filter((path) => path.toLowerCase().includes(search.toLowerCase()));
  const tree = useMemo(() => buildTree(paths), [paths.join("\n")]);
  const content = files[activeFile];
  const markdown = /\.md$/i.test(activeFile);
  const openFile = (path: string) => { if (files[path] === undefined) return; setActiveFile(path); setOpenFiles((previous) => previous.includes(path) ? previous : [...previous, path]); setSource(false); };
  const closeFile = (path: string) => {
    const next = openFiles.filter((item) => item !== path);
    setOpenFiles(next);
    if (activeFile === path) setActiveFile(next[Math.max(0, openFiles.indexOf(path) - 1)] || "");
  };
  const renderTree = (entries: TreeEntry[], depth = 0): ReactNode => entries.map((entry) => {
    const isCollapsed = collapsed.includes(entry.path) && !search;
    return <div key={entry.path}>
      <button className={`file-tree-row${activeFile === entry.path ? " file-tree-row-active" : ""}`} style={{ paddingLeft: 9 + depth * 14 }} onClick={() => entry.children ? setCollapsed((previous) => previous.includes(entry.path) ? previous.filter((path) => path !== entry.path) : [...previous, entry.path]) : openFile(entry.path)} aria-expanded={entry.children ? !isCollapsed : undefined} title={entry.path}>
        {entry.children ? <>{isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}{isCollapsed ? <Folder size={14} /> : <FolderOpen size={14} />}</> : <><span className="file-tree-indent" /><FileTypeIcon path={entry.path} /></>}
        <span>{entry.name}</span>{!entry.children && files[entry.path] !== BASE_FILES[entry.path] && <span className="file-modified-dot" aria-label="Modified locally" />}
      </button>
      {entry.children && !isCollapsed && renderTree(entry.children, depth + 1)}
    </div>;
  });
  return <div className="workbench-panel file-panel">
    <PanelHeader {...props} actions={<><PanelIconButton label="Search files" onClick={() => { setTreeOpen(true); setSearchOpen(!searchOpen); requestAnimationFrame(() => searchRef.current?.focus()); }}><Search size={14} /></PanelIconButton><PanelIconButton label={treeOpen ? "Hide file tree" : "Show file tree"} onClick={() => setTreeOpen(!treeOpen)}>{treeOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}</PanelIconButton></>} />
    <div className={`file-workspace${treeOpen ? " file-workspace-with-tree" : ""}`}>
      <section className="file-editor" aria-label="File editor">
        {!!openFiles.length && <div className="file-tabs" role="tablist" aria-label="Open files">{openFiles.filter((path) => files[path] !== undefined).map((path) => <div className={`file-tab${activeFile === path ? " file-tab-active" : ""}`} key={path}><button role="tab" aria-selected={activeFile === path} onClick={() => openFile(path)}><FileTypeIcon path={path} size={12} /><span>{path.split("/").pop()}</span></button><button aria-label={`Close ${path}`} onClick={() => closeFile(path)}><X size={11} /></button></div>)}</div>}
        {content !== undefined ? <>
          <div className="file-editor-toolbar"><span title={activeFile}>{activeFile}</span><div><PanelIconButton label={source ? "Show preview" : "Edit source"} onClick={() => setSource(!source)}>{source ? <BookOpen size={14} /> : <Code2 size={14} />}</PanelIconButton><PanelIconButton label="Copy file" onClick={() => copyText(content, "File contents copied")}><Copy size={13} /></PanelIconButton><PanelIconButton label="Download file" onClick={() => downloadFile(activeFile, content)}><Download size={14} /></PanelIconButton></div></div>
          {source ? <Textarea className="file-source-editor" aria-label={`Edit ${activeFile}`} spellCheck={false} value={content} onChange={(event) => setFiles((previous) => ({ ...previous, [activeFile]: event.target.value }))} onKeyDown={(event) => {
            if (event.key === "Tab") { event.preventDefault(); const target = event.currentTarget; const start = target.selectionStart; const end = target.selectionEnd; setFiles((previous) => ({ ...previous, [activeFile]: content.slice(0, start) + "  " + content.slice(end) })); requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 2; }); }
            if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); toast.success("File saved locally"); }
          }} /> : markdown ? <article className="file-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => {
            const relative = (href || "").replace(/^\.\//, "");
            if (files[relative] !== undefined) return <button className="file-markdown-link" onClick={() => openFile(relative)}>{children}</button>;
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          } }}>{content}</ReactMarkdown></article> : <div className="file-code-preview">{content.split("\n").map((line, index) => <div className="file-code-line" key={index}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div>}
          <footer className="file-statusbar"><span>{source ? "Editing · saved locally" : "Local demo file"}</span><span>{content.split("\n").length} lines<span className="file-status-separator">·</span>UTF-8</span></footer>
        </> : <div className="workbench-empty"><FileText size={30} strokeWidth={1} /><strong>Open files appear here</strong><p>Pick a file in the tree to read or edit it.</p><Button variant="outline" size="sm" onClick={() => { setTreeOpen(true); openFile("README.md"); }}>Open README.md</Button></div>}
      </section>
      {treeOpen && <aside className="file-tree" aria-label="Project file tree"><div className="file-tree-heading"><span>Project Mars</span><PanelIconButton label="New local file" onClick={() => { setNewPath(""); setNewFileOpen(true); }}><Plus size={13} /></PanelIconButton></div>{searchOpen && <div className="file-search"><Search size={13} /><Input ref={searchRef} placeholder="Search files" aria-label="Search project files" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear file search" onClick={() => setSearch("")}><X size={12} /></button>}</div>}<div className="file-tree-scroll">{paths.length ? renderTree(tree) : <p className="file-no-results">No files match “{search}”</p>}</div><footer className="file-tree-footer">{paths.length} files<span>Browser storage</span></footer></aside>}
    </div>
    <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}><DialogContent className="workbench-dialog"><DialogHeader><DialogTitle>New local file</DialogTitle><DialogDescription>Create a file in this demo workspace. It will be saved in your browser.</DialogDescription></DialogHeader><Input autoFocus aria-label="File path" placeholder="docs/new-note.md" value={newPath} onChange={(event) => setNewPath(event.target.value)} /><DialogFooter><Button variant="outline" onClick={() => setNewFileOpen(false)}>Cancel</Button><Button disabled={!newPath.trim()} onClick={() => { const path = newPath.trim().replace(/^\/+/, ""); if (path.includes("..") || !/^[\w./ -]+$/.test(path)) { toast.error("Use a relative file path with letters, numbers, dashes, or spaces."); return; } if (files[path] !== undefined) { toast.error("A file already exists at that path."); return; } setFiles((previous) => ({ ...previous, [path]: path.endsWith(".md") ? "# Untitled\n\n" : "" })); setOpenFiles((previous) => [...previous, path]); setActiveFile(path); setSource(true); setNewFileOpen(false); toast.success("Local file created"); }}>Create file</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

type DiffLine = { type: "same" | "add" | "remove"; text: string; oldLine?: number; newLine?: number };
function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n"); const right = after.split("\n");
  // A bounded LCS keeps this local preview responsive even for large pasted files.
  if (left.length * right.length > 250000) return [...left.map((text, i) => ({ type: "remove" as const, text, oldLine: i + 1 })), ...right.map((text, i) => ({ type: "add" as const, text, newLine: i + 1 }))];
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const result: DiffLine[] = []; let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { result.push({ type: "same", text: left[i], oldLine: ++i, newLine: ++j }); }
    else if (i < left.length && (j === right.length || matrix[i + 1][j] >= matrix[i][j + 1])) { result.push({ type: "remove", text: left[i], oldLine: ++i }); }
    else { result.push({ type: "add", text: right[j], newLine: ++j }); }
  }
  return result;
}

function ChangesPanel(props: WorkspacePanelProps) {
  const [files, setFiles] = useLocalState(FILE_STORAGE_KEY, INITIAL_FILES);
  const modified = Object.keys(files).filter((path) => files[path] !== BASE_FILES[path]);
  const [selected, setSelected] = useState("plugins/discord-presence.ts");
  const path = modified.includes(selected) ? selected : modified[0];
  const lines = useMemo(() => path ? diffLines(BASE_FILES[path] || "", files[path]) : [], [path, files]);
  const additions = lines.filter((line) => line.type === "add").length;
  const removals = lines.filter((line) => line.type === "remove").length;
  return <div className="workbench-panel diff-panel"><PanelHeader {...props} title={<><GitBranch size={13} /><span>Original</span><ArrowRight size={12} /><span>Local edits</span></>} />
    {modified.length ? <><div className="diff-toolbar"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="diff-file-selector"><FileTypeIcon path={path} size={13} /><span>{path}</span><ChevronDown size={12} /></Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="workbench-menu">{modified.map((file) => <DropdownMenuItem key={file} onSelect={() => setSelected(file)}><FileTypeIcon path={file} size={13} />{file}{file === path && <Check size={12} />}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu><span className="diff-add-count">+{additions}</span><span className="diff-remove-count">−{removals}</span><div className="workbench-spacer" /><PanelIconButton label="Copy diff" onClick={() => copyText(`--- a/${path}\n+++ b/${path}\n` + lines.map((line) => (line.type === "add" ? "+" : line.type === "remove" ? "-" : " ") + line.text).join("\n"), "Diff copied")}><Copy size={13} /></PanelIconButton><PanelIconButton label="Restore original file" onClick={() => { const previous = files[path]; setFiles((current) => { const next = { ...current }; if (BASE_FILES[path] === undefined) delete next[path]; else next[path] = BASE_FILES[path]; return next; }); toast.success("Original file restored locally", { action: { label: "Undo", onClick: () => setFiles((current) => ({ ...current, [path]: previous })) } }); }}><Undo2 size={14} /></PanelIconButton></div><div className="diff-content" aria-label={`Changes to ${path}`}>{lines.map((line, index) => <div className={`diff-line diff-line-${line.type}`} key={index}><span className="diff-line-number">{line.oldLine}</span><span className="diff-line-number">{line.newLine}</span><span className="diff-line-symbol">{line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}</span><code>{line.text || " "}</code></div>)}</div><footer className="file-statusbar"><span>{modified.length} changed {modified.length === 1 ? "file" : "files"}</span><span>Local demo · comparison with sample originals</span></footer></> : <div className="workbench-empty"><FileDiff size={30} strokeWidth={1} /><strong>No local changes</strong><p>Edit a demo file to see its changes here.</p><Button variant="outline" size="sm" onClick={() => props.onSelectPanel("files")}>Open files</Button></div>}
  </div>;
}

type TerminalEntry = { command?: string; output: string; error?: boolean };
function TerminalPanel(props: WorkspacePanelProps) {
  const [files] = useLocalState(FILE_STORAGE_KEY, INITIAL_FILES);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const [entries, setEntries] = useLocalState<TerminalEntry[]>("mars-ui:terminal:v1", [{ output: "Mars local demo terminal\nType help for available commands." }]);
  const [command, setCommand] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [wrap, setWrap] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const commands = entries.map((entry) => entry.command).filter((entry): entry is string => !!entry).reverse();
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: "nearest" }); }, [entries]);
  const execute = (event: React.FormEvent) => {
    event.preventDefault();
    const entered = command.trim(); if (!entered) return;
    setCommand(""); setHistoryIndex(-1);
    const [verb, ...args] = entered.split(/\s+/);
    let output = ""; let error = false;
    switch (verb) {
      case "clear": setEntries([]); return;
      case "help": output = "Available local demo commands:\n\n  help             Show this message\n  ls [directory]   List sample project files\n  pwd              Show the demo workspace path\n  cat <file>       Read a local demo file\n  status           List local task states\n  clear            Clear this terminal\n\n↑ / ↓ recall commands. No shell or runtime is connected."; break;
      case "pwd": output = "/demo/projects/mars"; break;
      case "ls": { const dir = (args[0] || "").replace(/^\.\/?/, "").replace(/\/$/, ""); const prefix = dir ? dir + "/" : ""; const matches = Object.keys(files).filter((path) => path.startsWith(prefix)); const items = [...new Set(matches.map((path) => { const rest = path.slice(prefix.length); return rest.includes("/") ? rest.split("/")[0] + "/" : rest; }))]; output = items.sort().join("\n"); if (!output) { output = `ls: ${dir}: directory not found in local demo`; error = true; } break; }
      case "cat": { const path = args.join(" ").replace(/^\.\//, "").replace(/^['"]|['"]$/g, ""); output = files[path]; if (output === undefined) { output = path ? `cat: ${path}: file not found in local demo` : "Usage: cat <file>"; error = true; } break; }
      case "status": output = tasks.length ? tasks.map((task) => `${task.status.padEnd(18)} ${task.title}`).join("\n") + "\n\nThese are local demo task states." : "No local demo tasks."; break;
      default: output = `${verb}: unavailable in this local demo.\nType help to see supported commands.`; error = true;
    }
    setEntries((previous) => [...previous, { command: entered, output, error }].slice(-80));
  };
  return <div className="workbench-panel terminal-panel"><PanelHeader {...props} title={<><Terminal size={13} /><span>Terminal</span><span className="workbench-header-hint">mars</span></>} actions={<PanelIconButton label="Clear terminal" onClick={() => setEntries([])}><Trash2 size={13} /></PanelIconButton>} />
    <div className="terminal-toolbar"><span className="terminal-local-dot" />Local demo<div className="workbench-spacer" /><button onClick={() => setWrap(!wrap)} className={wrap ? "terminal-option-active" : ""}>Wrap</button><button onClick={() => copyText(entries.map((entry) => `${entry.command ? "$ " + entry.command + "\n" : ""}${entry.output}`).join("\n\n"), "Terminal output copied")}><Copy size={11} />Copy</button></div>
    <div className={`terminal-output${wrap ? " terminal-wrap" : ""}`} onClick={(event) => { if (event.target === event.currentTarget) inputRef.current?.focus(); }}><div className="terminal-output-entries" role="log" aria-label="Local terminal output">{entries.map((entry, index) => <div className="terminal-entry" key={index}>{entry.command && <div className="terminal-command"><span className="terminal-prompt">mars ~/project $</span> {entry.command}</div>}<pre className={entry.error ? "terminal-error" : ""}>{entry.output}</pre></div>)}</div><form className="terminal-input-row" onSubmit={execute}><label htmlFor="mars-terminal-input" className="terminal-prompt">mars ~/project $</label><input id="mars-terminal-input" ref={inputRef} aria-label="Terminal command" autoComplete="off" spellCheck={false} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowUp") { event.preventDefault(); const next = Math.min(commands.length - 1, historyIndex + 1); setHistoryIndex(next); setCommand(commands[next] || ""); } else if (event.key === "ArrowDown") { event.preventDefault(); const next = Math.max(-1, historyIndex - 1); setHistoryIndex(next); setCommand(commands[next] || ""); } else if ((event.ctrlKey || event.metaKey) && event.key === "l") { event.preventDefault(); setEntries([]); } }} /></form><div ref={bottomRef} /></div><footer className="terminal-footer"><ShieldCheck size={11} />Local commands only · no shell connection</footer>
  </div>;
}

function BrowserPanel(props: WorkspacePanelProps) {
  const [history, setHistory] = useState<string[]>([""]);
  const [index, setIndex] = useState(0);
  const [address, setAddress] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [checks, setChecks] = useLocalState<boolean[]>("mars-ui:browser-checks:v1", [true, true, false, false]);
  const [note, setNote] = useLocalState("mars-ui:browser-note:v1", "Keep the conversation open while the work continues.");
  const current = history[index];
  const isSample = current.startsWith("mars://preview");
  const isNotes = current.endsWith("/notes");
  const navigate = (url: string) => { setHistory((previous) => [...previous.slice(0, index + 1), url]); setIndex(index + 1); setAddress(url); };
  const move = (next: number) => { setIndex(next); setAddress(history[next]); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); let url = address.trim();
    if (!url || url === "about:blank") { navigate(""); return; }
    if (["mars", "localhost", "localhost:3000", "http://localhost:3000", "mars://preview"].includes(url)) { navigate("mars://preview"); return; }
    if (!url.includes("://")) url = "https://" + url;
    try { const parsed = new URL(url); if (!["http:", "https:", "mars:"].includes(parsed.protocol)) throw new Error(); navigate(url); } catch { toast.error("Enter a valid URL or open the local sample below."); }
  };
  return <div className="workbench-panel browser-panel"><PanelHeader {...props} title={<><Globe size={13} /><span>{isSample ? "Project Mars" : "New tab"}</span></>} actions={<PanelIconButton label="New preview tab" onClick={() => navigate("")}><Plus size={14} /></PanelIconButton>} />
    <div className="browser-address-row"><PanelIconButton label="Go back" disabled={index === 0} onClick={() => move(index - 1)}><ArrowLeft size={13} /></PanelIconButton><PanelIconButton label="Go forward" disabled={index >= history.length - 1} onClick={() => move(index + 1)}><ArrowRight size={13} /></PanelIconButton><PanelIconButton label="Reload local preview" disabled={!current} onClick={() => { setRefreshKey((key) => key + 1); toast.success("Local preview refreshed"); }}><RefreshCw size={13} /></PanelIconButton><form onSubmit={submit}><Globe size={12} /><input value={address} onChange={(event) => setAddress(event.target.value)} aria-label="Preview URL" placeholder="Type a URL" spellCheck={false} /><button type="submit" aria-label="Open preview URL"><ArrowRight size={12} /></button></form></div>
    <div className="browser-viewport" key={refreshKey}>
      {!current ? <div className="browser-start"><Globe size={30} strokeWidth={1} /><h2>Preview alongside your work</h2><p>Open the local sample to explore the browser panel.</p><div className="browser-server-card"><div className="browser-server-icon"><Braces size={20} /></div><div><strong>Project Mars <span>Local sample</span></strong><code>mars://preview</code></div><Button variant="outline" size="sm" onClick={() => navigate("mars://preview")}>Open preview</Button></div><div className="browser-start-note"><Info size={13} /><span>A runtime connection is needed for live servers and web browsing.</span></div></div> : isSample ? <div className="browser-sample"><header className="browser-sample-nav"><button className="browser-sample-brand" onClick={() => navigate("mars://preview")}><span>✳</span>Mars</button><nav><button className={!isNotes ? "browser-sample-nav-active" : ""} onClick={() => navigate("mars://preview")}>Overview</button><button className={isNotes ? "browser-sample-nav-active" : ""} onClick={() => navigate("mars://preview/notes")}>Notes</button></nav><span className="browser-sample-avatar">A</span></header><main className="browser-sample-main">{isNotes ? <><span className="browser-sample-eyebrow">PROJECT NOTES</span><h1>A little context<br />goes a long way.</h1><p>Keep the details you want to come back to.</p><Textarea className="browser-sample-note" aria-label="Local sample project notes" value={note} onChange={(event) => setNote(event.target.value)} /><span className="browser-sample-saved"><Check size={12} />Saved in this browser</span></> : <><span className="browser-sample-eyebrow">YOUR PERSONAL WORKSPACE</span><h1>Make room<br />for good work.</h1><p>A place for your ideas, your projects,<br />and the next thing you want to build.</p><div className="browser-sample-project"><div className="browser-sample-project-header"><Folder size={16} /><strong>Project Mars</strong><span>{checks.filter(Boolean).length} of {checks.length}</span></div>{["Shape the workspace", "Create a focused chat surface", "Connect the agent runtime", "Bring background tasks to life"].map((label, item) => <button className="browser-sample-check" key={label} onClick={() => setChecks((previous) => previous.map((value, i) => i === item ? !value : value))}><span className={checks[item] ? "browser-sample-check-complete" : ""}>{checks[item] && <Check size={11} />}</span><span>{label}</span></button>)}</div><button className="browser-sample-notes-link" onClick={() => navigate("mars://preview/notes")}>Open project notes<ArrowRight size={13} /></button></>}</main><footer className="browser-sample-footer"><span>A little more space to think.</span><span>LOCAL SAMPLE</span></footer></div> : <div className="browser-start browser-unavailable"><Unplug size={30} strokeWidth={1} /><h2>Live browsing isn’t connected</h2><p>This demo can show the built-in project preview. A connected browser adapter is required to load websites here.</p><code>{current}</code><div><Button variant="outline" size="sm" onClick={() => navigate("mars://preview")}>Open local sample</Button>{/^https?:/.test(current) && <Button variant="ghost" size="sm" asChild><a href={current} target="_blank" rel="noopener noreferrer">Open in browser<ExternalLink size={12} /></a></Button>}</div></div>}
    </div><footer className="file-statusbar"><span>Local preview</span><span>No dev server connected</span></footer>
  </div>;
}

const TASK_LABELS: Record<TaskStatus, string> = { running: "Running", queued: "Queued", waiting_approval: "Needs approval", completed: "Completed", paused: "Paused", failed: "Failed", cancelled: "Cancelled" };
const TASK_MARKS: Record<TaskStatus, StatusMarkStatus> = { running: "running", queued: "pending", waiting_approval: "pending", completed: "done", paused: "pending", failed: "failed", cancelled: "cancelled" };
function TasksPanel(props: WorkspacePanelProps) {
  const tasks = useWorkspaceStore((s) => s.tasks);
  const updateTask = useWorkspaceStore((s) => s.updateTask);
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [selected, setSelected] = useState<string | null>(null);
  const visible = filter === "active" ? tasks.filter((task) => !["completed", "cancelled"].includes(task.status)) : tasks;
  const task = tasks.find((item) => item.id === selected);
  const setStatus = (item: Task, status: TaskStatus) => { updateTask(item.id, { status }); toast.success(`Demo task ${TASK_LABELS[status].toLowerCase()}`); };
  const completeStep = (item: Task) => { const index = item.steps.findIndex((step) => !step.done); if (index === -1) return; const steps = item.steps.map((step, i) => i === index ? { ...step, done: true } : step); const progress = Math.round(steps.filter((step) => step.done).length / steps.length * 100); updateTask(item.id, { steps, progress, status: progress === 100 ? "completed" : "running" }); toast.success(progress === 100 ? "Demo task completed" : "Demo step completed"); };
  const controls = (item: Task) => <div className="task-controls">{item.status === "waiting_approval" ? <Button size="sm" onClick={() => setStatus(item, "running")}><ShieldCheck size={13} />Approve demo task</Button> : item.status === "running" ? <><Button variant="outline" size="sm" onClick={() => setStatus(item, "paused")}><Pause size={12} />Pause</Button><Button variant="outline" size="sm" onClick={() => completeStep(item)} disabled={!item.steps.some((step) => !step.done)}><Check size={13} />Complete demo step</Button></> : ["paused", "queued", "failed"].includes(item.status) ? <Button variant="outline" size="sm" onClick={() => setStatus(item, "running")}><Play size={12} />{item.status === "paused" ? "Resume" : item.status === "failed" ? "Retry demo task" : "Start demo task"}</Button> : null}{!["completed", "cancelled"].includes(item.status) && <Button variant="ghost" size="sm" onClick={() => setStatus(item, "cancelled")}>Cancel</Button>}</div>;
  return <div className="workbench-panel task-panel"><PanelHeader {...props} />
    <div className="task-filter-row"><div role="tablist" aria-label="Task filter"><button role="tab" aria-selected={filter === "active"} className={filter === "active" ? "task-filter-active" : ""} onClick={() => setFilter("active")}>Active<span>{tasks.filter((item) => !["completed", "cancelled"].includes(item.status)).length}</span></button><button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "task-filter-active" : ""} onClick={() => setFilter("all")}>All tasks<span>{tasks.length}</span></button></div><span className="context-pill">Demo</span></div>
    {task ? <div className="task-detail"><button className="task-back" onClick={() => setSelected(null)}><ArrowLeft size={13} />All {filter === "active" ? "active " : ""}tasks</button><div className={`task-state task-state-${task.status}`}><StatusMark status={TASK_MARKS[task.status]} size={15} progress={task.status === "running" && task.steps.length ? task.steps.filter((step) => step.done).length / task.steps.length : undefined} /><span>{TASK_LABELS[task.status]}</span></div><h2>{task.title}</h2><p>{task.description}</p><div className="task-detail-progress"><span style={{ width: `${task.steps.length ? task.steps.filter((step) => step.done).length / task.steps.length * 100 : task.status === "completed" ? 100 : 0}%` }} /></div><div className="task-steps">{task.steps.map((step, i) => <div className={`task-step${step.done ? " task-step-done" : ""}`} key={i}><StatusMark status={step.done ? "done" : task.status === "running" && i === task.steps.findIndex((entry) => !entry.done) ? "running" : "pending"} size={14} /><span>{step.title}</span></div>)}</div>{task.status === "waiting_approval" && <div className="task-approval-note"><ShieldCheck size={16} /><div><strong>Your approval is needed</strong><p>Approving changes this sample task to running. No external action will execute.</p></div></div>}{controls(task)}<button className="task-session-link" onClick={() => props.onOpenSession(task.sessionId)}><MessageSquare size={13} />Open conversation<ArrowRight size={12} /></button></div> : visible.length ? <div className="task-list">{visible.map((item) => <div className="task-list-item" key={item.id}><button className="task-open" onClick={() => setSelected(item.id)}><StatusMark status={TASK_MARKS[item.status]} progress={item.status === "running" && item.steps.length ? item.steps.filter((step) => step.done).length / item.steps.length : undefined} size={16} /><div><strong>{item.title}</strong><span>{item.description}</span><div className={`task-list-meta task-state-${item.status}`}><span>{TASK_LABELS[item.status]}</span><span>{item.steps.filter((step) => step.done).length}/{item.steps.length} steps</span></div></div><ChevronRight size={13} /></button>{item.status === "waiting_approval" && <div className="task-inline-approval"><Button variant="outline" size="xs" onClick={() => setStatus(item, "running")}><ShieldCheck size={12} />Approve</Button><button onClick={() => setSelected(item.id)}>Review details</button></div>}</div>)}</div> : <div className="workbench-empty"><Layers size={30} strokeWidth={1} /><strong>Background tasks appear here</strong><p>{filter === "active" && tasks.length ? "All caught up. Completed tasks are in All tasks." : "Longer pieces of work have their own place."}</p>{filter === "active" && tasks.length > 0 && <Button variant="outline" size="sm" onClick={() => setFilter("all")}>View all tasks</Button>}</div>}
    <footer className="task-demo-footer"><Info size={12} /><span>Local demo states · no background worker connected</span></footer>
  </div>;
}

function SideChatPanel(props: WorkspacePanelProps) {
  const [messages, setMessages] = useLocalState<MarsMessage[]>("mars-ui:sidechat:v1", []);
  const [draft, setDraft] = useState("");
  const tasks = useWorkspaceStore((s) => s.tasks);
  const sessions = useWorkspaceStore((s) => s.sessions);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const createSession = useWorkspaceStore((s) => s.createSession);
  const setSessionMessages = useWorkspaceStore((s) => s.setMessages);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "nearest" }); }, [messages]);
  const send = (event: React.FormEvent) => { event.preventDefault(); const content = draft.trim(); if (!content) return; const active = tasks.filter((task) => !["completed", "cancelled"].includes(task.status)); const reply = /task|progress|status/i.test(content) ? `There ${active.length === 1 ? "is" : "are"} ${active.length} active sample ${active.length === 1 ? "task" : "tasks"} in this workspace.${active.length ? "\n\n" + active.map((task) => `• ${task.title} — ${TASK_LABELS[task.status].toLowerCase()}`).join("\n") : ""}\n\nOpen Background tasks to review their local state.` : /file|readme|document/i.test(content) ? "The Files panel contains the Mars README, architecture notes, sample code, and project memory. Open a file, then use the source button to edit it. Changes are saved in this browser." : "This is a local side-chat demo. You can use this space to keep a separate thought beside your main conversation. Ask about the sample tasks or project files, or move these notes into a full session. A connected model adapter would provide open-ended answers."; const now = Date.now(); setMessages((previous) => [...previous, { id: crypto.randomUUID(), role: "user", content, createdAt: now }, { id: crypto.randomUUID(), role: "assistant", content: reply, createdAt: now + 1, status: "complete" }]); setDraft(""); };
  return <div className="workbench-panel sidechat-panel"><PanelHeader {...props} actions={<><PanelIconButton label="Open side chat as a session" disabled={!messages.length} onClick={() => { const project = sessions.find((session) => session.id === activeSessionId)?.project; const id = createSession(project); setSessionMessages(id, messages.map((message) => ({ ...message, id: crypto.randomUUID() }))); props.onOpenSession(id); toast.success("Side chat opened as a session"); }}><ExternalLink size={13} /></PanelIconButton><PanelIconButton label="Clear side chat" disabled={!messages.length} onClick={() => { const previous = messages; setMessages([]); toast.success("Side chat cleared", { action: { label: "Undo", onClick: () => setMessages(previous) } }); }}><Plus size={14} /></PanelIconButton></>} />
    <div className="sidechat-messages" role="log" aria-label="Side chat messages">{messages.length ? messages.map((message) => <div key={message.id} className={`sidechat-message sidechat-message-${message.role}`}>{message.role === "assistant" && <span className="sidechat-assistant-label">Mars · demo</span>}<p>{message.content}</p></div>) : <div className="workbench-empty"><MessageSquare size={27} strokeWidth={1} /><strong>No messages yet</strong><p>A little space for a separate thought.</p></div>}<div ref={bottom} /></div>
    <form className="sidechat-composer" onSubmit={send}><Textarea aria-label="Side chat message" placeholder="Ask a quick question" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div><span>Local demo</span><Button type="submit" size="icon-xs" aria-label="Send side chat message" disabled={!draft.trim()}><ArrowUp size={13} /></Button></div></form>
  </div>;
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  switch (props.panel) {
    case "context": return <ContextPanel {...props} />;
    case "files": return <FilesPanel {...props} />;
    case "changes": return <ChangesPanel {...props} />;
    case "terminal": return <TerminalPanel {...props} />;
    case "browser": return <BrowserPanel {...props} />;
    case "tasks": return <TasksPanel {...props} />;
    case "sidechat": return <SideChatPanel {...props} />;
  }
}

export default WorkspacePanel;
