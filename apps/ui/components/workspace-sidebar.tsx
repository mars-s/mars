"use client";

import { useState } from "react";
import {
  Archive, ArrowDownAZ, ChevronDown, ChevronRight, Clock3, Code2, FileBox,
  Home, Keyboard, MoreHorizontal, PanelLeftClose, Pin, Plus, Search, Settings2,
  SlidersHorizontal, SquarePen, Trash2, Workflow,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { MarsMark } from "@/components/mars-mark";
import { useWorkspaceStore } from "@/lib/store";
import type { Session, View } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Props {
  view: View;
  onNavigate: (view: View) => void;
  onOpenSession: (id: string) => void;
  onNewSession: (project?: string) => void;
  onSearch: () => void;
  onSettings: (tab?: "general" | "connection" | "keyboard") => void;
  onCollapse: () => void;
  onRename: (session: Session) => void;
  onDelete: (session: Session) => void;
}

export function WorkspaceSidebar({ view, onNavigate, onOpenSession, onNewSession, onSearch, onSettings, onCollapse, onRename, onDelete }: Props) {
  const sessions = useWorkspaceStore((s) => s.sessions);
  const activeId = useWorkspaceStore((s) => s.activeSessionId);
  const togglePin = useWorkspaceStore((s) => s.togglePin);
  const archiveSession = useWorkspaceStore((s) => s.archiveSession);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [sortAlphabetical, setSortAlphabetical] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const visible = sessions.filter((s) => Boolean(s.archived) === showArchived);
  const projects = Array.from(new Set(["Project Mars", "Personal", "Recents", ...visible.map((s) => s.project)]));

  return (
    <div className="sidebar-inner">
      <div className="sidebar-heading">
        <button className="mars-wordmark" onClick={() => onNavigate("workspace")} aria-label="Mars workspace">
          <MarsMark width={25} height={25} />
          <span>mars</span>
        </button>
        <div className="sidebar-heading-actions">
          <IconButton label="Hide sidebar" shortcut="⌘ B" onClick={onCollapse}><PanelLeftClose size={15} /></IconButton>
          <IconButton label="Search sessions" shortcut="⌘ K" onClick={onSearch}><Search size={15} /></IconButton>
        </div>
      </div>

      <div className="sidebar-mode" aria-label="Workspace mode">
        <button onClick={() => onNewSession("Personal")}><Home size={13} />Home</button>
        <button className={view === "workspace" ? "selected" : ""} onClick={() => onNavigate("workspace")}><Code2 size={14} />Code</button>
      </div>

      <nav className="primary-navigation" aria-label="Main navigation">
        <button onClick={() => onNewSession()}><span className="new-icon"><Plus size={12} /></span>New session<span className="nav-shortcut">⇧ ⌘ O</span></button>
        <button className={cn(view === "artifacts" && "selected")} onClick={() => onNavigate("artifacts")}><FileBox size={15} />Artifacts</button>
        <button className={cn(view === "customize" && "selected")} onClick={() => onNavigate("customize")}><SlidersHorizontal size={15} />Customize</button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button className={cn(view === "routines" && "selected")}><MoreHorizontal size={15} />More<ChevronDown className="more-chevron" size={12} /></button></DropdownMenuTrigger>
          <DropdownMenuContent className="mars-menu" align="start" side="right" sideOffset={8}>
            <DropdownMenuItem onSelect={() => onNavigate("routines")}><Clock3 />Routines</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNavigate("customize")}><Workflow />Skills and connectors</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setShowArchived(!showArchived)}><Archive />{showArchived ? "Show active sessions" : "Archived sessions"}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings("keyboard")}><Keyboard />Keyboard shortcuts</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSettings()}><Settings2 />Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      <div className="session-list-scroll">
        {showArchived && <div className="archive-label"><Archive size={12} />Archived sessions<button onClick={() => setShowArchived(false)}>Done</button></div>}
        {projects.map((project) => {
          const list = visible.filter((s) => s.project === project).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (sortAlphabetical ? a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt));
          if (showArchived && !list.length) return null;
          const closed = collapsed.includes(project);
          return (
            <section className="session-group" key={project} aria-label={project}>
              <div className="session-group-heading">
                <button aria-expanded={!closed} onClick={() => setCollapsed((v) => closed ? v.filter((p) => p !== project) : [...v, project])}>
                  <span>{project}</span><ChevronRight size={11} className={cn("group-chevron", !closed && "open")} />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button className="group-sort" aria-label={`Sort ${project} sessions`}><MoreHorizontal size={13} /></button></DropdownMenuTrigger>
                  <DropdownMenuContent className="mars-menu" align="start">
                    <DropdownMenuLabel>Sort sessions</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => setSortAlphabetical(false)}><Clock3 />Last updated{!sortAlphabetical && <span className="menu-check">✓</span>}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setSortAlphabetical(true)}><ArrowDownAZ />Alphabetically{sortAlphabetical && <span className="menu-check">✓</span>}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button className="group-add" aria-label={`New session in ${project}`} onClick={() => onNewSession(project)}><Plus size={13} /></button>
              </div>
              {!closed && (
                <div className="session-group-items">
                  {list.map((session) => (
                    <div className={cn("session-item", view === "workspace" && activeId === session.id && "selected", session.parentId && "is-child")} key={session.id}>
                      <button className="session-select" title={session.title} onClick={() => onOpenSession(session.id)}>
                        {session.parentId && <span className="session-branch" aria-hidden="true" />}
                        <span className="session-title-text">{session.title}</span>
                        {session.messages.some((m) => m.status === "running" && m.streamState !== "detached") && <span className="session-running" aria-label="Running" />}
                        {session.pinned && <Pin className="session-pin" size={10} />}
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><button className="session-menu-trigger" aria-label={`Actions for ${session.title}`}><MoreHorizontal size={15} /></button></DropdownMenuTrigger>
                        <DropdownMenuContent className="mars-menu" align="start" side="right">
                          <DropdownMenuItem onSelect={() => onRename(session)}><SquarePen />Rename</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => togglePin(session.id)}><Pin />{session.pinned ? "Unpin session" : "Pin session"}</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {!session.archived ? <DropdownMenuItem onSelect={() => { archiveSession(session.id); toast("Session archived"); }}><Archive />Archive</DropdownMenuItem> : <DropdownMenuItem onSelect={() => { useWorkspaceStore.setState((s) => ({ sessions: s.sessions.map((item) => item.id === session.id ? { ...item, archived: false } : item) })); toast("Session restored"); }}><Archive />Restore session</DropdownMenuItem>}
                          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(session)}><Trash2 />Delete session</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
                  {!list.length && <p className="empty-session-group">{showArchived ? "No archived sessions" : "No sessions yet"}</p>}
                </div>
              )}
            </section>
          );
        })}
        {showArchived && !visible.length && <p className="sidebar-empty">Archived sessions will appear here.</p>}
      </div>

      <div className="sidebar-footer">
        <button className="runtime-indicator" onClick={() => onSettings("connection")}><span className="runtime-dot" /><span>Pi workspace</span><span className="preview-tag">Preview</span></button>
        <div className="profile-row">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button className="profile-trigger"><span className="profile-avatar">A</span><span>Avi<span className="profile-plan"> · Personal</span></span><ChevronDown size={12} /></button></DropdownMenuTrigger>
            <DropdownMenuContent className="mars-menu" side="top" align="start">
              <DropdownMenuLabel>Personal workspace</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => onSettings()}><Settings2 />Settings</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSettings("connection")}><Code2 />Pi connection</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSettings("keyboard")}><Keyboard />Keyboard shortcuts</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <IconButton label="Settings" shortcut="⌘ ," onClick={() => onSettings()}><Settings2 size={15} /></IconButton>
        </div>
      </div>
    </div>
  );
}
