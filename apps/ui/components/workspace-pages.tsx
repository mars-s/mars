"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity, ArrowDownAZ, ArrowLeft, ArrowRight, BarChart3, Bell, BookOpen,
  Check, ChevronDown, Clock3, Code2, Copy, Database, Download,
  FileCode2, FileText, FlaskConical, Folder, GitBranch, GitPullRequest,
  Globe2, Info, LayoutGrid, ListTodo, Mail, Monitor, MoreHorizontal, Pencil,
  Play, Plug, Plus, Puzzle, Search, ShieldCheck, SlidersHorizontal, Sparkles,
  Sun, Timer, Trash2, X, type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceStore } from "@/lib/store";
import type { MarsMessage, Routine } from "@/lib/types";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import "./workspace-pages.css";

type PageView = "routines" | "customize" | "artifacts";
type CatalogKind = "skills" | "connectors" | "plugins";
type CatalogItem = {
  id: string;
  name: string;
  description: string;
  author: string;
  kind: CatalogKind;
  icon: string;
  instructions: string;
};
type Artifact = { id: string; name: string; description: string; content: string; kind: "document" | "code"; createdAt: number };
type LocalPageState = { installed: string[]; instructions: Record<string, string>; customItems: CatalogItem[]; artifacts: Artifact[] };

const CATALOG_ICONS: Record<string, LucideIcon> = {
  chart: BarChart3, database: Database, mail: Mail, sparkles: Sparkles,
  layout: LayoutGrid, code: Code2, book: BookOpen, list: ListTodo,
  globe: Globe2, git: GitBranch, bell: Bell, plug: Plug,
  puzzle: Puzzle, shield: ShieldCheck, folder: Folder, timer: Timer,
};

const CATALOG: CatalogItem[] = [
  { id: "data", name: "Data", description: "Explore data, answer questions, and turn findings into useful charts.", author: "Mars starter", kind: "skills", icon: "chart", instructions: "Understand the question before analyzing data. Check the source, identify missing values, and explain assumptions. Present clear findings with the evidence needed to verify them." },
  { id: "finance", name: "Finance", description: "Work through financial statements, forecasts, and business models.", author: "Mars starter", kind: "skills", icon: "chart", instructions: "Keep calculations traceable. Separate supplied figures from assumptions and show the effect of different scenarios. Cite the source of each input." },
  { id: "sales", name: "Sales", description: "Research accounts, prepare for calls, and keep follow-ups moving.", author: "Mars starter", kind: "skills", icon: "globe", instructions: "Prepare a concise account brief using available sources. Draft follow-ups for review. Ask before sending messages or changing records." },
  { id: "support", name: "Support", description: "Triage requests and draft thoughtful, consistent customer replies.", author: "Mars starter", kind: "skills", icon: "mail", instructions: "Read the whole request, identify the underlying issue, and draft a clear response. Flag missing information and leave external replies for approval." },
  { id: "marketing", name: "Marketing", description: "Plan campaigns, write copy, and make sense of performance.", author: "Mars starter", kind: "skills", icon: "sparkles", instructions: "Start with the audience and objective. Use the supplied brand voice. Make specific recommendations and distinguish measured results from estimates." },
  { id: "product-design", name: "Product design", description: "Explore ideas, review interfaces, and shape thoughtful experiences.", author: "Mars starter", kind: "skills", icon: "layout", instructions: "Connect design decisions to the user's task. Review interaction states, accessibility, hierarchy, and responsive behavior. Prefer familiar patterns when they serve the task." },
  { id: "engineering", name: "Engineering", description: "Review code, investigate issues, and plan reliable changes.", author: "Mars starter", kind: "skills", icon: "code", instructions: "Read the relevant code and project guidance first. Make focused changes, verify meaningful behavior, and explain remaining limitations. Never claim a test passed unless it ran." },
  { id: "research", name: "Research", description: "Find dependable sources and bring the important details together.", author: "Mars starter", kind: "skills", icon: "book", instructions: "Use primary sources where possible. Check dates, compare conflicting evidence, and cite factual claims. State what remains uncertain." },
  { id: "writing", name: "Writing", description: "Turn rough notes into clear documents that sound like you.", author: "Mars starter", kind: "skills", icon: "book", instructions: "Lead with the main point. Use plain words and concrete examples. Preserve the author's voice, remove repetition, and keep source claims accurate." },
  { id: "planning", name: "Planning", description: "Break down a project into practical, reviewable next steps.", author: "Mars starter", kind: "skills", icon: "list", instructions: "Define the intended outcome and constraints. Identify dependencies and approval points. Keep work items concrete and describe how completion will be checked." },
  { id: "discord", name: "Discord", description: "Bring conversations, channels, and your Mars assistant together.", author: "Connector example", kind: "connectors", icon: "mail", instructions: "Read selected channels and draft responses. Sending messages and changing server settings require approval." },
  { id: "github", name: "GitHub", description: "Work with repositories, issues, pull requests, and code reviews.", author: "Connector example", kind: "connectors", icon: "git", instructions: "Read repositories and issues. Prepare changes for review. Ask before merging, publishing, or deleting remote resources." },
  { id: "filesystem", name: "Workspace files", description: "Read and organize files in your agent's connected workspace.", author: "Connector example", kind: "connectors", icon: "folder", instructions: "Limit file access to the configured workspace. Preserve existing work and ask before destructive changes." },
  { id: "web", name: "Web search", description: "Find up-to-date information and keep sources alongside answers.", author: "Connector example", kind: "connectors", icon: "globe", instructions: "Search for current information, prefer primary sources, and retain citations in the response." },
  { id: "hindsight", name: "Hindsight", description: "Keep useful long-term context available across conversations.", author: "Connector example", kind: "connectors", icon: "database", instructions: "Recall relevant context before responding. Retain useful facts only when appropriate and keep their origin available." },
  { id: "calendar", name: "Calendar", description: "Prepare daily briefings and make room for focused work.", author: "Connector example", kind: "connectors", icon: "list", instructions: "Read upcoming events and draft scheduling suggestions. Confirm before adding events or inviting others." },
  { id: "durable-tasks", name: "Durable tasks", description: "A starter configuration for work that continues between messages.", author: "Plugin example", kind: "plugins", icon: "timer", instructions: "Run independent tasks separately from chat. Preserve progress and display dependencies. Require approval before consequential actions." },
  { id: "extension-workshop", name: "Extension workshop", description: "Draft, review, and test new tools for your Mars workspace.", author: "Plugin example", kind: "plugins", icon: "puzzle", instructions: "Create extensions in an isolated directory. Validate the manifest and run relevant tests. Keep the prior version available before activation." },
  { id: "approval-inbox", name: "Approval inbox", description: "Keep pending decisions easy to review without losing context.", author: "Plugin example", kind: "plugins", icon: "shield", instructions: "Present the exact proposed action, relevant context, and available alternatives. Record the user's decision and resume only the associated task." },
  { id: "notifications", name: "Notifications", description: "Choose which task updates deserve your attention.", author: "Plugin example", kind: "plugins", icon: "bell", instructions: "Surface completed work, blocked tasks, and required approvals. Group routine status changes and respect quiet hours." },
];

const DEFAULT_LOCAL: LocalPageState = { installed: ["research", "planning", "filesystem"], instructions: {}, customItems: [], artifacts: [] };
const LOCAL_KEY = "mars-workspace-pages-v1";

function useLocalPageState() {
  const [state, setState] = useState<LocalPageState>(DEFAULT_LOCAL);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
      if (saved && typeof saved === "object") {
        setState({
          installed: Array.isArray(saved.installed) ? saved.installed.filter((id: unknown) => typeof id === "string") : DEFAULT_LOCAL.installed,
          instructions: saved.instructions && typeof saved.instructions === "object" ? Object.fromEntries(Object.entries(saved.instructions).filter(([, value]) => typeof value === "string")) as Record<string, string> : {},
          customItems: Array.isArray(saved.customItems) ? saved.customItems.filter((item: CatalogItem) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.description === "string" && typeof item.instructions === "string" && ["skills", "connectors", "plugins"].includes(item.kind)) : [],
          artifacts: Array.isArray(saved.artifacts) ? saved.artifacts.filter((item: Artifact) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.content === "string") : [],
        });
      }
    } catch { /* A fresh workspace remains usable if browser storage is unavailable. */ }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch { /* Keep the current tab usable when storage is full. */ }
  }, [state, hydrated]);
  return [state, setState, hydrated] as const;
}

export function WorkspacePages({ view, onOpenSession }: { view: PageView; onOpenSession: (id: string) => void }) {
  const [local, setLocal, hydrated] = useLocalPageState();
  return (
    <div className="pages-root">
      {view === "routines" && <RoutinesPage onOpenSession={onOpenSession} />}
      {view === "customize" && <CustomizePage local={local} setLocal={setLocal} hydrated={hydrated} />}
      {view === "artifacts" && <ArtifactsPage local={local} setLocal={setLocal} />}
    </div>
  );
}

type RoutineTemplate = { name: string; description: string; prompt: string; schedule: string; time: string; icon: LucideIcon };
const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  { name: "Briefing", description: "A useful summary of your calendar, messages, and priorities.", prompt: "Prepare a concise morning briefing. Review the available calendar, messages, and pending tasks. Highlight today's commitments, decisions that need me, and the next useful step. Cite the source of each update.", schedule: "Weekdays", time: "08:30", icon: Sun },
  { name: "Email triage", description: "Categorize your inbox and draft replies to messages that need attention.", prompt: "Review new messages and group them into urgent, needs a reply, and informational. Draft responses for my review. Do not send any messages.", schedule: "Weekdays", time: "09:00", icon: Mail },
  { name: "System health check", description: "Review services for errors, outages, and performance issues.", prompt: "Check the available service status and recent logs. Summarize failures, unusual resource use, and anything that needs attention. Suggest the smallest useful follow-up; ask before changing services.", schedule: "Daily", time: "07:30", icon: Activity },
  { name: "Issue triage", description: "Review incoming issues, bugs, and feature requests.", prompt: "Review newly opened issues. Suggest categories and priorities, identify likely duplicates, and list any missing reproduction details. Leave repository changes for review.", schedule: "Weekdays", time: "10:00", icon: ListTodo },
  { name: "PR review digest", description: "An overview of open pull requests and what needs your attention.", prompt: "Summarize open pull requests, their review status, failing checks, and requests for my input. Link to the relevant pull requests and identify a practical next action for each.", schedule: "Weekdays", time: "16:00", icon: GitPullRequest },
  { name: "Dependency update check", description: "Look for outdated packages and changes worth planning for.", prompt: "Review project dependencies against available release information. Summarize updates and breaking changes, with links to primary release notes. Do not install packages or modify the lockfile.", schedule: "Weekly · Monday", time: "09:00", icon: ShieldCheck },
  { name: "Release notes drafter", description: "Turn recent merged work into clear, useful release notes.", prompt: "Review changes merged since the last release. Draft release notes grouped by features, fixes, and other changes. Keep internal implementation details out of user-facing copy.", schedule: "Weekly · Friday", time: "15:00", icon: FileText },
  { name: "Flaky test tracker", description: "Find tests that pass and fail intermittently across recent runs.", prompt: "Review recent test results for intermittent failures. Group repeated failures by test, show the evidence, and suggest focused investigations. Do not disable tests.", schedule: "Weekly · Tuesday", time: "09:00", icon: FlaskConical },
];

type RoutineDraft = { id?: string; name: string; description: string; instructions: string; schedule: string; time: string; cron: string; weekday: string; enabled: boolean };
const SCHEDULES = ["Manual", "Hourly", "Daily", "Weekdays", "Weekly", "Custom"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
function blankRoutine(): RoutineDraft { return { name: "", description: "", instructions: "", schedule: "Daily", time: "09:00", cron: "0 9 * * *", weekday: "Monday", enabled: true }; }
function draftFromRoutine(routine: Routine): RoutineDraft {
  const paragraphs = routine.prompt.split(/\n\n/);
  const description = paragraphs.length > 1 ? paragraphs.shift()! : "";
  return { ...blankRoutine(), id: routine.id, name: routine.name, description, instructions: paragraphs.join("\n\n"), schedule: SCHEDULES.find(item => routine.schedule.toLowerCase().startsWith(item.toLowerCase())) || "Daily", time: routine.time || "09:00", cron: routine.schedule.startsWith("Custom:") ? routine.schedule.slice(7).trim() : "0 9 * * *", weekday: routine.schedule.split(" · ")[1] || "Monday", enabled: routine.enabled };
}
function scheduleLabel(schedule: string, time: string) {
  if (schedule === "Manual") return "Run manually";
  if (schedule === "Hourly") return "Every hour";
  if (schedule.startsWith("Custom:")) return schedule.slice(7).trim();
  const [hour, minute] = (time || "09:00").split(":");
  const hourNumber = Number(hour);
  const formatted = `${hourNumber % 12 || 12}:${minute} ${hourNumber >= 12 ? "PM" : "AM"}`;
  if (schedule.startsWith("Weekly")) return `Every ${schedule.split(" · ")[1] || "Monday"} at ${formatted}`;
  return `${schedule} at ${formatted}`;
}

function RoutinesPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const { routines, addRoutine, updateRoutine, deleteRoutine, createSession, renameSession, setMessages, settings, updateSettings } = useWorkspaceStore();
  const [tab, setTab] = useState<"yours" | "templates">("yours");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [draft, setDraft] = useState<RoutineDraft | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const visibleRoutines = routines.filter(item => `${item.name} ${item.prompt}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "enabled" ? item.enabled : !item.enabled))).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : (b.lastRun || "").localeCompare(a.lastRun || ""));
  const templates = ROUTINE_TEMPLATES.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const useTemplate = (item: RoutineTemplate) => setDraft({ ...blankRoutine(), name: item.name, description: item.description, instructions: item.prompt, schedule: item.schedule.split(" · ")[0], weekday: item.schedule.split(" · ")[1] || "Monday", time: item.time });
  const runNow = (routine: Routine) => {
    const id = createSession("Project Mars");
    renameSession(id, `${routine.name} · demo run`);
    const now = Date.now();
    const messages: MarsMessage[] = [
      { id: `routine-user-${now}`, role: "user", content: routine.prompt, createdAt: now, status: "complete" },
      { id: `routine-preview-${now}`, role: "assistant", content: `## ${routine.name}\n\nThis is a demo run of your saved routine. The instructions above are ready to send to your Mars runtime.\n\n**Schedule:** ${scheduleLabel(routine.schedule, routine.time)}\n\nNo tools were executed and no external services were contacted. Connect your runtime in Settings to build on this workflow.`, createdAt: now + 1, status: "complete" },
    ];
    setMessages(id, messages);
    updateRoutine(routine.id, { lastRun: new Date().toISOString() });
    toast.success("Demo run opened");
    onOpenSession(id);
  };
  const saveRoutine = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !draft.name.trim() || !draft.instructions.trim()) return;
    const schedule = draft.schedule === "Custom" ? `Custom: ${draft.cron.trim()}` : draft.schedule === "Weekly" ? `Weekly · ${draft.weekday}` : draft.schedule;
    const input = { name: draft.name.trim(), prompt: [draft.description.trim(), draft.instructions.trim()].filter(Boolean).join("\n\n"), schedule, time: draft.time, enabled: draft.enabled };
    if (draft.id) updateRoutine(draft.id, input); else addRoutine(input);
    toast.success(draft.id ? "Routine saved" : "Routine created");
    setDraft(null); setTab("yours"); setQuery(""); setFilter("all");
  };

  if (draft) {
    const set = (partial: Partial<RoutineDraft>) => setDraft({ ...draft, ...partial });
    const validCron = draft.schedule !== "Custom" || /^[\d*/?,\-A-Za-z]+(?:\s+[\d*/?,\-A-Za-z]+){4}$/.test(draft.cron.trim());
    return <div className="routine-editor-shell">
      <div className="routine-breadcrumb"><button onClick={() => setDraft(null)}><ArrowLeft size={13} /> Routines</button><span>/</span><span>{draft.id ? "Edit routine" : "New VM routine"}</span></div>
      <div className="pages-scroll"><form className="routine-editor" onSubmit={saveRoutine}>
        <div className="routine-info"><Info size={14} /><span>Routines are saved here. Automatic runs need a connected Mars runtime.</span></div>
        <div className="routine-field"><label htmlFor="routine-name">Name <span>*</span></label><input autoFocus id="routine-name" required maxLength={100} placeholder="Daily code review" className="pages-input" value={draft.name} onChange={e => set({ name: e.target.value })} /></div>
        <div className="routine-field"><label htmlFor="routine-description">Description</label><input id="routine-description" maxLength={240} placeholder="Review yesterday's commits and flag anything worth a look" className="pages-input" value={draft.description} onChange={e => set({ description: e.target.value })} /></div>
        <div className="routine-field"><label htmlFor="routine-instructions">Instructions <span>*</span></label>
          <div className="routine-composer"><textarea id="routine-instructions" required placeholder="Describe what Mars should do in each run…" value={draft.instructions} onChange={e => set({ instructions: e.target.value })} />
            <div className="routine-composer-controls"><label className="routine-select-label"><ShieldCheck size={12} /><select aria-label="Workspace default permission mode" value={settings.permissionMode} onChange={e => updateSettings({ permissionMode: e.target.value as "ask" | "auto" | "plan" })}><option value="ask">Ask permission</option><option value="auto">Auto approve</option><option value="plan">Plan mode</option></select></label><label className="routine-select-label"><ChevronDown size={12} /><select aria-label="Workspace default model" value={settings.model} onChange={e => updateSettings({ model: e.target.value })}>{Array.from(new Set([settings.model, "Claude Sonnet", "Claude Opus", "Local model", "Default model"])).map(model => <option key={model} value={model}>{model}</option>)}</select></label></div>
            <div className="routine-folder-strip"><span><Folder size={12} /> Project Mars</span><span><Monitor size={12} /> VM workspace</span></div>
          </div><span className="routine-field-note">Model and permission choices update your workspace defaults.</span>
        </div>
        <fieldset className="routine-schedule"><legend>Schedule</legend><div className="pages-segmented" role="group" aria-label="Schedule frequency">{SCHEDULES.map(item => <button type="button" key={item} aria-pressed={draft.schedule === item} className={draft.schedule === item ? "pages-segment-active" : ""} onClick={() => set({ schedule: item })}>{item}</button>)}</div>
          {draft.schedule === "Custom" ? <div className="routine-cron"><label htmlFor="routine-cron">Cron expression</label><input id="routine-cron" className="pages-input" value={draft.cron} onChange={e => set({ cron: e.target.value })} aria-invalid={!validCron} aria-describedby="routine-cron-help" /><span id="routine-cron-help" className="routine-field-note">{validCron ? "Five fields: minute, hour, day, month, weekday." : "Enter a five-field cron expression, for example 0 9 * * 1-5."}</span></div> : draft.schedule === "Manual" ? <p className="routine-field-note">Start this routine whenever you need it.</p> : draft.schedule === "Hourly" ? <p className="routine-field-note">Run at the beginning of every hour.</p> : <div className="routine-time-row">{draft.schedule === "Weekly" && <label>On <select aria-label="Day of the week" value={draft.weekday} onChange={e => set({ weekday: e.target.value })}>{WEEKDAYS.map(day => <option key={day}>{day}</option>)}</select></label>}<label htmlFor="routine-time">At</label><input id="routine-time" aria-label="Run time" type="time" required value={draft.time} onChange={e => set({ time: e.target.value })} /><span className="routine-timezone">your local time</span></div>}
        </fieldset>
        <div className="routine-editor-bottom"><label className="routine-enable-label"><Switch checked={draft.enabled} onCheckedChange={enabled => set({ enabled })} aria-label="Enable routine" />Enabled</label><div className="pages-actions"><button type="button" className="pages-button" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="pages-button pages-button-primary" disabled={!draft.name.trim() || !draft.instructions.trim() || !validCron}>{draft.id ? "Save changes" : "Create"}</button></div></div>
      </form></div>
    </div>;
  }

  return <div className="pages-scroll"><section className="pages-container routine-page"><h1 className="pages-title">Routines</h1>
    <div className="pages-toolbar"><div className="pages-tabs" role="tablist" aria-label="Routine views"><button role="tab" aria-selected={tab === "yours"} className={tab === "yours" ? "pages-tab-active" : ""} onClick={() => setTab("yours")}>Yours</button><button role="tab" aria-selected={tab === "templates"} className={tab === "templates" ? "pages-tab-active" : ""} onClick={() => setTab("templates")}>Templates</button></div>
      <div className="pages-toolbar-actions">{searchOpen && <input autoFocus className="pages-input pages-toolbar-search" aria-label="Search routines" placeholder="Search routines…" value={query} onChange={e => setQuery(e.target.value)} />}<button className="pages-icon-button" aria-label={searchOpen ? "Close routine search" : "Search routines"} onClick={() => { setSearchOpen(!searchOpen); if (searchOpen) setQuery(""); }}>{searchOpen ? <X size={15} /> : <Search size={15} />}</button>
        {tab === "yours" && <><DropdownMenu><DropdownMenuTrigger asChild><button className={`pages-icon-button ${filter !== "all" ? "pages-icon-active" : ""}`} aria-label="Filter routines"><SlidersHorizontal size={15} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Show routines</DropdownMenuLabel><DropdownMenuRadioGroup value={filter} onValueChange={setFilter}><DropdownMenuRadioItem value="all">All routines</DropdownMenuRadioItem><DropdownMenuRadioItem value="enabled">Enabled</DropdownMenuRadioItem><DropdownMenuRadioItem value="paused">Paused</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><DropdownMenu><DropdownMenuTrigger asChild><button className="pages-icon-button" aria-label="Sort routines"><ArrowDownAZ size={15} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={sort} onValueChange={setSort}><DropdownMenuRadioItem value="recent">Recently run</DropdownMenuRadioItem><DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu></>}
        <DropdownMenu><DropdownMenuTrigger asChild><button className="pages-button pages-button-primary">New routine <ChevronDown size={12} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => setDraft(blankRoutine())}><Monitor size={14} /> VM routine</DropdownMenuItem><DropdownMenuItem onSelect={() => { setTab("templates"); setQuery(""); }}><LayoutGrid size={14} /> From a template</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div></div>
    {tab === "yours" && (routines.length === 0 ? <div className="routine-empty"><Timer size={63} strokeWidth={0.85} /><p>No routines yet.</p></div> : <div className="routine-list">{visibleRoutines.length ? visibleRoutines.map(routine => <article key={routine.id} className="routine-list-row"><div className="routine-row-icon"><Timer size={19} /></div><button className="routine-row-main" onClick={() => setDraft(draftFromRoutine(routine))}><span className="routine-row-title">{routine.name}</span><span className="routine-row-description">{routine.prompt.split("\n")[0]}</span><span className="routine-row-meta"><Clock3 size={11} />{scheduleLabel(routine.schedule, routine.time)}{routine.lastRun && <span>· Last demo run {formatRelative(routine.lastRun)}</span>}</span></button><Switch checked={routine.enabled} onCheckedChange={enabled => { updateRoutine(routine.id, { enabled }); toast.success(enabled ? "Routine enabled in demo" : "Routine paused"); }} aria-label={`${routine.enabled ? "Pause" : "Enable"} ${routine.name}`} /><DropdownMenu><DropdownMenuTrigger asChild><button className="pages-icon-button" aria-label={`Actions for ${routine.name}`}><MoreHorizontal size={17} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => runNow(routine)}><Play size={14} /> Run now</DropdownMenuItem><DropdownMenuItem onSelect={() => setDraft(draftFromRoutine(routine))}><Pencil size={14} /> Edit routine</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => setDeleting(routine)}><Trash2 size={14} /> Delete routine</DropdownMenuItem></DropdownMenuContent></DropdownMenu></article>) : <div className="pages-empty-small"><Search size={24} /><p>No routines match your search.</p><button className="pages-text-button" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div>}</div>)}
    {(tab === "templates" || routines.length === 0) && <><div className={tab === "yours" ? "routine-zigzag" : "routine-template-gap"} />{templates.length ? <div className="routine-template-grid">{templates.map(template => <button className="routine-template" key={template.name} onClick={() => useTemplate(template)}><span className="routine-template-icon"><template.icon size={17} strokeWidth={1.5} /></span><span className="routine-template-body"><span className="routine-template-title">{template.name}</span><span className="routine-template-description">{template.description}</span><span className="routine-template-schedule"><Clock3 size={11} />{scheduleLabel(template.schedule, template.time)}</span></span></button>)}</div> : <div className="pages-empty-small"><Search size={24} /><p>No templates match your search.</p></div>}</>}
    <Dialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }}><DialogContent className="pages-dialog pages-confirm-dialog"><DialogHeader><DialogTitle>Delete “{deleting?.name}”?</DialogTitle><DialogDescription>This removes the saved routine. Its existing conversations stay in your workspace.</DialogDescription></DialogHeader><DialogFooter><button className="pages-button" onClick={() => setDeleting(null)}>Cancel</button><button className="pages-button pages-button-danger" onClick={() => { if (deleting) deleteRoutine(deleting.id); setDeleting(null); toast.success("Routine deleted"); }}>Delete routine</button></DialogFooter></DialogContent></Dialog>
  </section></div>;
}

function formatRelative(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return value;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type LocalProps = { local: LocalPageState; setLocal: React.Dispatch<React.SetStateAction<LocalPageState>> };

function CustomizePage({ local, setLocal, hydrated }: LocalProps & { hydrated: boolean }) {
  const [kind, setKind] = useState<CatalogKind>("skills");
  const [collection, setCollection] = useState<"yours" | "discover">("discover");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("featured");
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [instructions, setInstructions] = useState("");
  const [creating, setCreating] = useState<CatalogKind | null>(null);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const catalog = [...CATALOG, ...local.customItems];
  const filtered = catalog.filter(item => item.kind === kind && (collection === "discover" || local.installed.includes(item.id)) && (filter !== "added" || local.installed.includes(item.id)) && `${item.name} ${item.description} ${item.author}`.toLowerCase().includes(query.toLowerCase()));
  if (sort === "name") filtered.sort((a, b) => a.name.localeCompare(b.name));
  const showFeatured = kind === "skills" && collection === "discover" && !query && filter === "all" && sort === "featured";
  const primary = showFeatured ? filtered.filter(item => !["data", "research", "writing", "planning"].includes(item.id)).slice(0, 6) : filtered;
  const secondary = showFeatured ? filtered.filter(item => ["research", "writing", "planning"].includes(item.id)) : [];
  const toggle = (item: CatalogItem) => {
    const added = local.installed.includes(item.id);
    setLocal(current => ({ ...current, installed: added ? current.installed.filter(id => id !== item.id) : [...current.installed, item.id] }));
    toast.success(added ? `${item.name} removed from workspace` : `${item.name} added to demo workspace`);
  };
  const openItem = (item: CatalogItem) => { setSelected(item); setInstructions(local.instructions[item.id] ?? item.instructions); };
  const startCreate = (value: CatalogKind) => { setCreating(value); setCustomName(""); setCustomDescription(""); setCustomInstructions(""); };
  const createItem = (event: FormEvent) => {
    event.preventDefault();
    if (!creating || !customName.trim() || !customDescription.trim()) return;
    const item: CatalogItem = { id: `custom-${Date.now()}`, name: customName.trim(), description: customDescription.trim(), author: "You", kind: creating, icon: creating === "connectors" ? "plug" : creating === "plugins" ? "puzzle" : "book", instructions: customInstructions.trim() };
    setLocal(current => ({ ...current, customItems: [...current.customItems, item], installed: [...current.installed, item.id] }));
    setKind(creating); setCollection("yours"); setCreating(null); setQuery(""); toast.success(`${item.name} created`);
  };
  const renderCard = (item: CatalogItem) => {
    const Icon = CATALOG_ICONS[item.icon] || Puzzle;
    const added = local.installed.includes(item.id);
    return <article className="customize-card" key={item.id}><button className="customize-card-main" onClick={() => openItem(item)}><span className={`customize-card-icon customize-icon-${item.icon}`}><Icon size={24} strokeWidth={1.3} /></span><span className="customize-card-copy"><span className="customize-card-title">{item.name}</span><span className="customize-card-description">{item.description}</span><span className="customize-card-author">{item.author}{added && " · In workspace"}</span></span></button><button disabled={!hydrated} className={`customize-add-button ${added ? "customize-added" : ""}`} aria-label={`${added ? "Remove" : "Add"} ${item.name}${added ? " from" : " to"} workspace`} title={added ? "Remove from workspace" : "Add to workspace"} onClick={() => toggle(item)}>{added ? <Check size={15} /> : <Plus size={16} />}</button></article>;
  };
  return <div className="pages-scroll"><section className="pages-container customize-page"><h1 className="pages-title">Customize</h1>
    <div className="pages-toolbar customize-toolbar"><div className="pages-tabs" role="tablist" aria-label="Customization category">{(["skills", "connectors", "plugins"] as CatalogKind[]).map(value => <button key={value} role="tab" aria-selected={kind === value} className={kind === value ? "pages-tab-active" : ""} onClick={() => { setKind(value); setQuery(""); }}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><span className="customize-toolbar-divider" /><div className="pages-tabs customize-collection-tabs" role="tablist" aria-label="Collection"><button role="tab" aria-selected={collection === "yours"} className={collection === "yours" ? "pages-tab-active" : ""} onClick={() => setCollection("yours")}>Yours</button><button role="tab" aria-selected={collection === "discover"} className={collection === "discover" ? "pages-tab-active" : ""} onClick={() => setCollection("discover")}>Discover</button></div>
      <div className="pages-toolbar-actions customize-toolbar-actions"><label className="pages-search"><Search size={14} /><input aria-label={`Search ${kind}`} placeholder="Search" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="pages-icon-button" aria-label="Clear search" onClick={() => setQuery("")}><X size={13} /></button>}</label><DropdownMenu><DropdownMenuTrigger asChild><button className={`pages-icon-button ${filter !== "all" ? "pages-icon-active" : ""}`} aria-label="Filter collection"><SlidersHorizontal size={15} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={filter} onValueChange={setFilter}><DropdownMenuRadioItem value="all">All items</DropdownMenuRadioItem><DropdownMenuRadioItem value="added">In workspace</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><DropdownMenu><DropdownMenuTrigger asChild><button className="pages-icon-button" aria-label="Sort collection"><ArrowDownAZ size={15} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={sort} onValueChange={setSort}><DropdownMenuRadioItem value="featured">Featured</DropdownMenuRadioItem><DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><DropdownMenu><DropdownMenuTrigger asChild><button className="pages-button pages-button-primary"><Plus size={13} />Add<ChevronDown size={12} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => startCreate("skills")}><BookOpen size={14} />Create skill</DropdownMenuItem><DropdownMenuItem onSelect={() => startCreate("connectors")}><Plug size={14} />Add connector</DropdownMenuItem><DropdownMenuItem onSelect={() => startCreate("plugins")}><Puzzle size={14} />Create plugin</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>
    </div>
    {showFeatured && <div className="customize-featured"><div className="customize-featured-copy"><span className="customize-featured-eyebrow">For your workspace</span><h2>Data</h2><p>Turn data into answers you can act on.</p><button className="pages-button pages-button-primary" disabled={!hydrated} onClick={() => toggle(CATALOG[0])}>{local.installed.includes("data") ? <><Check size={13} />Added</> : "Add"}</button></div><DataIllustration /></div>}
    <div className="customize-section-heading"><h2>{showFeatured ? "New skills" : collection === "yours" ? `Your ${kind}` : `Discover ${kind}`}</h2>{showFeatured && <button className="pages-text-button" onClick={() => setSort("name")}>Show all <ArrowRight size={13} /></button>}<span className="customize-result-count">{!showFeatured && `${filtered.length} ${filtered.length === 1 ? "item" : "items"}`}</span></div>
    {primary.length ? <div className="customize-grid">{primary.map(renderCard)}</div> : <div className="pages-empty-small customize-empty"><Puzzle size={29} strokeWidth={1.2} /><h3>{query ? "No matches" : `No ${kind} here yet`}</h3><p>{query ? "Try a different name or a shorter search." : `Add ${kind} from Discover or create your own.`}</p><button className="pages-button" onClick={() => { setQuery(""); setFilter("all"); setCollection("discover"); }}>Explore {kind}</button></div>}
    {secondary.length > 0 && <><div className="customize-section-heading"><h2>More for your workspace</h2></div><div className="customize-grid">{secondary.map(renderCard)}</div></>}
    {kind === "connectors" && <p className="customize-demo-note"><Info size={13} />These are demo configurations. Adding a connector does not connect an external account.</p>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="pages-dialog customize-detail-dialog"><DialogHeader><div className="customize-detail-icon">{selected && (() => { const Icon = CATALOG_ICONS[selected.icon] || Puzzle; return <Icon size={26} strokeWidth={1.4} />; })()}</div><DialogTitle>{selected?.name}</DialogTitle><DialogDescription>{selected?.description}</DialogDescription></DialogHeader><div className="customize-detail-meta"><span>{selected?.author}</span><span>{selected?.kind === "connectors" ? "Demo connector" : selected?.kind === "plugins" ? "Demo plugin" : "Workspace skill"}</span></div><label className="pages-field-label" htmlFor="customize-instructions">{selected?.kind === "connectors" ? "Access instructions" : "Instructions"}</label><textarea id="customize-instructions" className="pages-textarea customize-instructions" value={instructions} onChange={e => setInstructions(e.target.value)} /><p className="pages-dialog-note">{selected?.kind === "connectors" ? "Saved locally for your workspace. Account authorization is not configured in this demo." : "Edit these instructions to make this example your own. Runtime installation is not performed by this demo."}</p><DialogFooter><button className="pages-button" onClick={() => { if (selected) toggle(selected); }}>{selected && local.installed.includes(selected.id) ? "Remove from workspace" : "Add to workspace"}</button><button className="pages-button pages-button-primary" onClick={() => { if (selected) { setLocal(current => ({ ...current, instructions: { ...current.instructions, [selected.id]: instructions } })); toast.success("Instructions saved"); setSelected(null); } }}>Save instructions</button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!creating} onOpenChange={open => { if (!open) setCreating(null); }}><DialogContent className="pages-dialog"><form onSubmit={createItem}><DialogHeader><DialogTitle>{creating === "skills" ? "Create a skill" : creating === "connectors" ? "Add a connector" : "Create a plugin"}</DialogTitle><DialogDescription>Save a reusable configuration in your demo workspace.</DialogDescription></DialogHeader><div className="pages-dialog-form"><label className="pages-field-label" htmlFor="customize-name">Name<input id="customize-name" autoFocus required maxLength={80} className="pages-input" placeholder={creating === "skills" ? "My writing style" : creating === "connectors" ? "My connector" : "My plugin"} value={customName} onChange={e => setCustomName(e.target.value)} /></label><label className="pages-field-label" htmlFor="customize-description">Description<input id="customize-description" required maxLength={180} className="pages-input" placeholder="What does it help you do?" value={customDescription} onChange={e => setCustomDescription(e.target.value)} /></label><label className="pages-field-label" htmlFor="customize-new-instructions">Instructions<textarea id="customize-new-instructions" className="pages-textarea" rows={6} placeholder="Describe how Mars should use this…" value={customInstructions} onChange={e => setCustomInstructions(e.target.value)} /></label></div><DialogFooter><button type="button" className="pages-button" onClick={() => setCreating(null)}>Cancel</button><button type="submit" disabled={!customName.trim() || !customDescription.trim()} className="pages-button pages-button-primary">Create</button></DialogFooter></form></DialogContent></Dialog>
  </section></div>;
}

function DataIllustration() {
  return <svg className="customize-data-illustration" viewBox="0 0 300 150" fill="none" aria-hidden="true"><g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d="m59 36 111-13 61 30-113 17-59-34Z"/><path d="m59 36 3 79 60 32 109-20V53M118 70l4 77M62 60l59 33 110-18M62 86l60 35 109-21M87 30l62 35 2 76M114 27l64 33 1 76M145 23l61 34 2 75"/><path d="m79 48 1 61M194 46l13-32 13 28M165 46l8-41 10 18M153 113l7-8 8 4 10-19 9 6 10-27 13 5 6-15"/><path d="m228 82 11-5 3-39 11-7 6 62-10 8 3 42M247 46l6-1M238 67l18-7M104 133l-18 8-7-4 20-9M75 119l-15 6"/></g></svg>;
}

const ARTIFACTS: Artifact[] = [
  { id: "architecture", name: "mars-architecture.md", description: "A starting point for the Mars workspace", kind: "document", createdAt: 3, content: "# Project Mars\n\nA personal agent workspace for a Pi agent running on your VM.\n\n## The workspace\n\n- Chat with the agent and revisit previous sessions.\n- Inspect files, proposed changes, and task progress.\n- Review approvals while independent work continues.\n- Keep reusable instructions in your workspace.\n\n## Connecting the pieces\n\nThe browser UI connects to a runtime adapter on the VM. Tailscale provides private access to that machine. The runtime owns agent execution, credentials, durable work, and tools.\n\n## This file\n\nThis is an example artifact included with the UI demo. It is not a record of work executed by an agent." },
  { id: "activity-extension", name: "activity-extension.ts", description: "An example Discord activity tool", kind: "code", createdAt: 2, content: "// Example only — wire this into your trusted runtime.\nimport { ActivityType, type Client } from 'discord.js';\n\nexport function createActivityTool(client: Client) {\n  return {\n    name: 'set_activity',\n    description: 'Update the bot activity',\n    async execute(input: { text: string }) {\n      if (!client.user) throw new Error('Bot is not ready');\n      client.user.setActivity(input.text, {\n        type: ActivityType.Playing,\n      });\n      return { updated: true, text: input.text };\n    },\n  };\n}\n" },
  { id: "briefing", name: "morning-briefing.md", description: "A reusable briefing format", kind: "document", createdAt: 1, content: "# Morning briefing\n\n## Today\n\nStart with the commitments and decisions that matter today.\n\n## Needs your attention\n\nList pending approvals, blocked work, and messages that need a reply. Keep each item short and include a link to its source.\n\n## In progress\n\nSummarize active tasks and the next visible milestone.\n\n## A useful next step\n\nSuggest one concrete action based on the available context.\n\nThis is a template. A connected runtime can fill it with real information." },
  { id: "manifest", name: "extension-manifest.json", description: "A sample extension record for review", kind: "code", createdAt: 0, content: '{\n  "name": "discord-activity",\n  "version": "0.1.0",\n  "description": "Example activity extension",\n  "entry": "./activity-extension.ts",\n  "tools": ["set_activity"],\n  "status": "example",\n  "note": "Illustrative workspace metadata, not a runtime schema"\n}\n' },
];

function ArtifactsPage({ local, setLocal }: LocalProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [source, setSource] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Artifact | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const visible = useMemo(() => [...local.artifacts, ...ARTIFACTS].filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || item.kind === filter)).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.createdAt - a.createdAt), [local.artifacts, query, filter, sort]);
  const download = (artifact: Artifact) => {
    const url = URL.createObjectURL(new Blob([artifact.content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = artifact.name.replace(/[\\/:*?"<>|]/g, "-"); link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); toast.success("Download started");
  };
  const copy = async (artifact: Artifact) => { try { await navigator.clipboard.writeText(artifact.content); toast.success("Copied to clipboard"); } catch { toast.error("Clipboard unavailable. Use Download to save the file."); } };
  const editArtifact = (artifact: Artifact) => { setEditingId(artifact.id); setName(artifact.name); setContent(artifact.content); setSelected(null); setCreating(true); };
  return <div className="pages-scroll"><section className="pages-container artifact-page"><h1 className="pages-title">Artifacts</h1><div className="pages-toolbar"><div className="pages-tabs" role="tablist" aria-label="Artifact type">{[["all", "All"], ["document", "Documents"], ["code", "Code"]].map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "pages-tab-active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="pages-toolbar-actions"><label className="pages-search"><Search size={14} /><input aria-label="Search artifacts" placeholder="Search artifacts" value={query} onChange={e => setQuery(e.target.value)} /></label><DropdownMenu><DropdownMenuTrigger asChild><button className="pages-icon-button" aria-label="Sort artifacts"><ArrowDownAZ size={15} /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={sort} onValueChange={setSort}><DropdownMenuRadioItem value="recent">Newest first</DropdownMenuRadioItem><DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu><button className="pages-button pages-button-primary" onClick={() => { setCreating(true); setEditingId(null); setName(""); setContent(""); }}><Plus size={13} />New artifact</button></div></div>
    <div className="artifact-section-label"><h2>Your workspace files</h2><span>{visible.length} {visible.length === 1 ? "artifact" : "artifacts"}</span></div>
    {visible.length ? <div className="artifact-grid">{visible.map(item => <button key={item.id} className="artifact-tile" onClick={() => { setSelected(item); setSource(item.kind === "code"); }}><div className={`artifact-tile-preview artifact-preview-${item.kind}`}>{item.kind === "code" ? <><Code2 size={18} /><pre>{item.content.split("\n").slice(0, 7).join("\n")}</pre></> : <><FileText size={18} /><strong>{item.content.split("\n")[0].replace(/^#\s*/, "")}</strong><p>{item.content.split("\n").filter(line => line && !line.startsWith("#")).slice(0, 3).join(" ")}</p><span className="artifact-preview-lines"><i /><i /><i /></span></>}</div><div className="artifact-tile-footer"><span className="artifact-file-icon">{item.kind === "code" ? <FileCode2 size={16} /> : <FileText size={16} />}</span><span><strong>{item.name}</strong><small>{item.createdAt > 10 ? "Created by you" : "Example file"}</small></span><MoreHorizontal size={15} /></div></button>)}</div> : <div className="pages-empty-small"><Search size={26} /><h3>No artifacts found</h3><p>Try a different search or create a new file.</p><button className="pages-button" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</button></div>}
    <Dialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null); }}><DialogContent className="pages-dialog artifact-dialog"><DialogHeader><DialogTitle className="artifact-dialog-title">{selected?.kind === "code" ? <FileCode2 size={18} /> : <FileText size={18} />}{selected?.name}</DialogTitle><DialogDescription>{selected?.description}</DialogDescription></DialogHeader><div className="artifact-preview-toolbar"><div className="pages-tabs" role="tablist" aria-label="File view"><button role="tab" aria-selected={!source} className={!source ? "pages-tab-active" : ""} onClick={() => setSource(false)}>Preview</button><button role="tab" aria-selected={source} className={source ? "pages-tab-active" : ""} onClick={() => setSource(true)}>Source</button></div><div className="pages-actions">{selected && local.artifacts.some(item => item.id === selected.id) && <><button className="pages-icon-button" aria-label="Edit artifact" onClick={() => editArtifact(selected)}><Pencil size={15} /></button><button className="pages-icon-button" aria-label="Delete artifact" onClick={() => { setDeleting(selected); setSelected(null); }}><Trash2 size={15} /></button></>}<button className="pages-icon-button" aria-label="Copy file contents" onClick={() => selected && copy(selected)}><Copy size={15} /></button><button className="pages-icon-button" aria-label="Download artifact" onClick={() => selected && download(selected)}><Download size={15} /></button></div></div><div className="artifact-content">{selected && (source || selected.kind === "code" ? <pre className="artifact-source"><code>{selected.content}</code></pre> : <ArtifactMarkdown content={selected.content} />)}</div><DialogFooter><button className="pages-button" onClick={() => setSelected(null)}>Close</button><button className="pages-button pages-button-primary" onClick={() => selected && download(selected)}><Download size={13} />Download</button></DialogFooter></DialogContent></Dialog>
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent className="pages-dialog"><form onSubmit={event => { event.preventDefault(); if (!name.trim() || !content.trim()) return; const artifact: Artifact = { id: editingId || `artifact-${Date.now()}`, name: /\.[a-z0-9]+$/i.test(name.trim()) ? name.trim() : `${name.trim()}.md`, description: "A file created in your workspace", kind: /\.(tsx?|jsx?|json|css|py|sh)$/i.test(name) ? "code" : "document", content, createdAt: Date.now() }; setLocal(current => ({ ...current, artifacts: editingId ? current.artifacts.map(item => item.id === editingId ? artifact : item) : [artifact, ...current.artifacts] })); setCreating(false); setQuery(""); setFilter("all"); toast.success(editingId ? "Artifact saved" : "Artifact created"); }}><DialogHeader><DialogTitle>{editingId ? "Edit artifact" : "New artifact"}</DialogTitle><DialogDescription>Write a file and keep it in your workspace.</DialogDescription></DialogHeader><div className="pages-dialog-form"><label className="pages-field-label" htmlFor="artifact-name">File name<input id="artifact-name" autoFocus required className="pages-input" value={name} onChange={e => setName(e.target.value)} placeholder="project-notes.md" maxLength={120} /></label><label className="pages-field-label" htmlFor="artifact-content">Content<textarea id="artifact-content" required className="pages-textarea artifact-new-content" rows={10} value={content} onChange={e => setContent(e.target.value)} placeholder="# Project notes" /></label></div><DialogFooter><button type="button" className="pages-button" onClick={() => setCreating(false)}>Cancel</button><button type="submit" className="pages-button pages-button-primary" disabled={!name.trim() || !content.trim()}>{editingId ? "Save changes" : "Create artifact"}</button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={!!deleting} onOpenChange={open => { if (!open) setDeleting(null); }}><DialogContent className="pages-dialog pages-confirm-dialog"><DialogHeader><DialogTitle>Delete “{deleting?.name}”?</DialogTitle><DialogDescription>This removes the file from your workspace. Download a copy first if you want to keep it.</DialogDescription></DialogHeader><DialogFooter><button className="pages-button" onClick={() => setDeleting(null)}>Cancel</button><button className="pages-button pages-button-danger" onClick={() => { if (deleting) setLocal(current => ({ ...current, artifacts: current.artifacts.filter(item => item.id !== deleting.id) })); setDeleting(null); toast.success("Artifact deleted"); }}>Delete file</button></DialogFooter></DialogContent></Dialog>
  </section></div>;
}

function ArtifactMarkdown({ content }: { content: string }) {
  return <div className="artifact-markdown">{content.split("\n").map((line, index) => line.startsWith("# ") ? <h1 key={index}>{line.slice(2)}</h1> : line.startsWith("## ") ? <h2 key={index}>{line.slice(3)}</h2> : line.startsWith("- ") ? <div className="artifact-markdown-list" key={index}><span>•</span><p>{line.slice(2)}</p></div> : line.trim() ? <p key={index}>{line}</p> : <div key={index} className="artifact-markdown-space" />)}</div>;
}
