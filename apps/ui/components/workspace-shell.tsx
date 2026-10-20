"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive, Check, ChevronDown, FileDiff, Folder, Globe2, ListTodo,
  MessageSquarePlus, MoreVertical, PanelLeft, PanelRight, PanelTop,
  Search, Settings2, Share2, SquarePen, SquareTerminal, X,
} from "lucide-react";
import { MotionConfig } from "motion/react";
import { Toaster, toast } from "sonner";
import { ChatThread } from "@/components/chat-thread";
import { WorkspaceSidebar } from "@/components/workspace-sidebar";
import { WorkspacePanel } from "@/components/workspace-panel";
import { WorkspacePages } from "@/components/workspace-pages";
import { WorkspaceDialogs } from "@/components/workspace-dialogs";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WarmTooltipGroup } from "@/components/react-bits/WarmTooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hydrateWorkspaceStore, useWorkspaceStore } from "@/lib/store";
import type { Panel, Session, View } from "@/lib/types";
import { cn } from "@/lib/utils";

const panels: { id: Exclude<Panel, null>; label: string; icon: typeof PanelRight }[] = [
  { id: "context", label: "Context", icon: PanelTop },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "changes", label: "Changes", icon: FileDiff },
  { id: "browser", label: "Browser", icon: Globe2 },
  { id: "files", label: "Files", icon: Folder },
  { id: "tasks", label: "Background tasks", icon: ListTodo },
];

export function WorkspaceShell() {
  const sessions = useWorkspaceStore((s) => s.sessions);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const settings = useWorkspaceStore((s) => s.settings);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const createSession = useWorkspaceStore((s) => s.createSession);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const archiveSession = useWorkspaceStore((s) => s.archiveSession);
  const [view, setView] = useState<View>("workspace");
  const [panel, setPanel] = useState<Panel>("context");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panelWidth, setPanelWidth] = useState(49);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "connection" | "keyboard">("general");
  const [renameSession, setRenameSession] = useState<Session | null>(null);
  const [deleteSession, setDeleteSession] = useState<Session | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const session = sessions.find((s) => s.id === activeSessionId);
  const activeTasks = tasks.filter((task) => ["running", "queued", "waiting_approval"].includes(task.status)).length;

  useEffect(() => { void hydrateWorkspaceStore(); }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const onChange = () => setIsMobile(media.matches);
    onChange(); media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
    };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme, settings.reducedMotion]);
  useEffect(() => () => dragCleanup.current?.(), []);

  const openSettings = useCallback((tab: "general" | "connection" | "keyboard" = "general") => {
    setSettingsTab(tab); setSettingsOpen(true); setMobileSidebarOpen(false);
  }, []);
  const navigate = useCallback((next: View) => {
    setView(next); setMobileSidebarOpen(false); setExpanded(false);
  }, []);
  const openSession = useCallback((id: string) => {
    setActiveSession(id); setView("workspace"); setMobileSidebarOpen(false); setMobilePanelOpen(false); setExpanded(false);
  }, [setActiveSession]);
  const newSession = useCallback((project?: string) => {
    const id = createSession(project); openSession(id);
  }, [createSession, openSession]);
  const selectPanel = useCallback((next: Panel) => {
    setView("workspace"); setPanel(next); setExpanded(false); setMobilePanelOpen(Boolean(next));
  }, []);
  const toggleSidebar = useCallback(() => {
    if (isMobile) setMobileSidebarOpen((v) => !v);
    else setSidebarOpen((v) => !v);
  }, [isMobile]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") { event.preventDefault(); setSearchOpen((v) => !v); }
      else if (key === "b") { event.preventDefault(); toggleSidebar(); }
      else if (key === ",") { event.preventDefault(); openSettings(); }
      else if (key === "o" && event.shiftKey) { event.preventDefault(); newSession(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newSession, openSettings, toggleSidebar]);

  function startResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanup.current?.();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (e: PointerEvent) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (rect) setPanelWidth(Math.max(30, Math.min(72, (rect.right - e.clientX) / rect.width * 100)));
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      dragCleanup.current = null;
    };
    dragCleanup.current = stop;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
  }

  function downloadConversation() {
    if (!session) return;
    const data = { version: 1, exportedAt: new Date().toISOString(), session };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `mars-${session.id}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Conversation exported");
  }

  const sidebar = <WorkspaceSidebar view={view} onNavigate={navigate} onOpenSession={openSession} onNewSession={newSession} onSearch={() => { setMobileSidebarOpen(false); setSearchOpen(true); }} onSettings={openSettings} onCollapse={toggleSidebar} onRename={setRenameSession} onDelete={setDeleteSession} />;
  const showPanel = panel !== null && (!isMobile || mobilePanelOpen);
  const title = view === "workspace" ? session?.title || "New session" : view === "routines" ? "Routines" : view === "customize" ? "Customize" : "Artifacts";

  return (
    <MotionConfig reducedMotion={settings.reducedMotion ? "always" : "user"}>
      <TooltipProvider delayDuration={400}>
        <WarmTooltipGroup>
          <div className={cn("app-frame", !sidebarOpen && "sidebar-is-collapsed", settings.compact && "compact-ui")}>
            {sidebarOpen && <aside className="desktop-sidebar" aria-label="Workspace sidebar">{sidebar}</aside>}
            <main className="workspace-main" id="main-content">
              <header className="workspace-header">
                <div className="workspace-header-start">
                  <span className={cn("sidebar-reopen", sidebarOpen && "only-mobile")}><IconButton label="Show sidebar" shortcut="⌘ B" onClick={toggleSidebar}><PanelLeft size={16} /></IconButton></span>
                  {view === "workspace" ? <DropdownMenu>
                    <DropdownMenuTrigger asChild><button className="workspace-title"><span>{title}</span><ChevronDown size={13} /></button></DropdownMenuTrigger>
                    <DropdownMenuContent className="mars-menu" align="start">
                      <DropdownMenuLabel>{session?.project || "Project Mars"}</DropdownMenuLabel>
                      <DropdownMenuItem disabled={!session} onSelect={() => session && setRenameSession(session)}><SquarePen />Rename session</DropdownMenuItem>
                      <DropdownMenuItem disabled={!session} onSelect={downloadConversation}><Share2 />Export conversation</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={!session} onSelect={() => { if (session) { archiveSession(session.id); toast("Session archived"); } }}><Archive />Archive session</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu> : <span className="page-breadcrumb">{title}</span>}
                </div>
                <div className="workspace-header-end">
                  <button className="header-preview-label" onClick={() => openSettings("connection")}>Demo workspace</button>
                  {view === "workspace" && <div className="workspace-toolbar" aria-label="Workspace panels">
                    {panels.map(({ id, label, icon: Icon }) => (
                      <IconButton key={id} label={label} active={panel === id && showPanel} onClick={() => selectPanel(panel === id && showPanel ? null : id)}>
                        <Icon size={15} strokeWidth={1.65} />
                        {id === "tasks" && activeTasks > 0 && <span className="toolbar-task-dot" />}
                      </IconButton>
                    ))}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><button className="icon-button" aria-label="View options"><MoreVertical size={16} /></button></DropdownMenuTrigger>
                      <DropdownMenuContent className="mars-menu" align="end">
                        <DropdownMenuLabel>View options</DropdownMenuLabel>
                        <DropdownMenuItem onSelect={toggleSidebar}><PanelLeft />Sidebar{sidebarOpen && <Check className="menu-check" />}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => selectPanel(panel ? null : "context")}><PanelRight />Side panel{showPanel && <Check className="menu-check" />}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => selectPanel("sidechat")}><MessageSquarePlus />Start a side chat</DropdownMenuItem>
                        {isMobile && <><DropdownMenuSeparator />{panels.filter((item) => ["terminal", "changes", "browser"].includes(item.id)).map(({ id, label, icon: Icon }) => <DropdownMenuItem key={id} onSelect={() => selectPanel(id)}><Icon />{label}</DropdownMenuItem>)}</>}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => navigate("routines")}><ListTodo />Routines</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setSearchOpen(true)}><Search />Search sessions<span className="menu-shortcut">⌘ K</span></DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openSettings()}><Settings2 />Settings</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>}
                </div>
              </header>

              {view === "workspace" ? (
                <div ref={bodyRef} className={cn("workspace-body", expanded && showPanel && "panel-is-expanded", isMobile && showPanel && "mobile-panel-is-open")}>
                  <section className="conversation-region" aria-label="Conversation">
                    {session ? <ChatThread key={session.id} sessionId={session.id} onOpenPanel={selectPanel} /> : <div className="no-active-session"><p>Your workspace is ready.</p><Button size="sm" variant="secondary" onClick={() => newSession()}>Start a session</Button></div>}
                  </section>
                  {showPanel && panel !== "context" && !expanded && <div className="panel-resize-handle" role="separator" aria-label="Resize side panel" aria-orientation="vertical" aria-valuemin={30} aria-valuemax={72} aria-valuenow={Math.round(panelWidth)} tabIndex={0} onPointerDown={startResize} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); setPanelWidth((w) => Math.max(30, Math.min(72, w + (e.key === "ArrowLeft" ? 2 : -2)))); } }} />}
                  {showPanel && panel && <aside className={cn("workspace-panel-container", isMobile && "is-mobile-panel-open")} data-panel={panel} style={panel === "context" || expanded || isMobile ? undefined : { width: `${panelWidth}%` }} aria-label={`${panel === "tasks" ? "Background tasks" : panel} panel`}>
                    <WorkspacePanel panel={panel} onClose={() => { setPanel(null); setExpanded(false); setMobilePanelOpen(false); }} onSelectPanel={selectPanel} onOpenSession={openSession} expanded={expanded} onToggleExpand={() => setExpanded((v) => !v)} />
                  </aside>}
                </div>
              ) : <WorkspacePages view={view} onOpenSession={openSession} />}
            </main>
          </div>

          <Dialog open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
            <DialogContent className="mobile-sidebar-dialog" showCloseButton={false}>
              <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
              <DialogDescription className="sr-only">Navigate sessions, artifacts, routines and settings.</DialogDescription>
              {sidebar}
              <button className="mobile-sidebar-close icon-button" onClick={() => setMobileSidebarOpen(false)} aria-label="Close navigation"><X size={17} /></button>
            </DialogContent>
          </Dialog>

          <WorkspaceDialogs searchOpen={searchOpen} setSearchOpen={setSearchOpen} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen} settingsTab={settingsTab} setSettingsTab={setSettingsTab} renameSession={renameSession} setRenameSession={setRenameSession} deleteSession={deleteSession} setDeleteSession={setDeleteSession} onOpenSession={openSession} onNewSession={newSession} onNavigate={navigate} onOpenPanel={selectPanel} />
        </WarmTooltipGroup>
        <Toaster theme={settings.theme} position="bottom-right" richColors closeButton toastOptions={{ className: "mars-toast", style: { fontFamily: "var(--font-sans)", fontSize: "12px", background: "var(--popover)", color: "var(--text)", borderColor: "var(--border)" } }} />
      </TooltipProvider>
    </MotionConfig>
  );
}
