"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown, ArrowUp, Check, Clock3, Code2, CornerDownLeft, Folder,
  Keyboard, Laptop, ListTodo, MessageSquare, Moon, Plus, Search,
  Server, Settings2, SlidersHorizontal, Sun,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspaceStore } from "@/lib/store";
import type { Panel, Session, View } from "@/lib/types";
import { cn } from "@/lib/utils";

type SettingsTab = "general" | "connection" | "keyboard";
interface Props {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  renameSession: Session | null;
  setRenameSession: (session: Session | null) => void;
  deleteSession: Session | null;
  setDeleteSession: (session: Session | null) => void;
  onOpenSession: (id: string) => void;
  onNewSession: (project?: string) => void;
  onNavigate: (view: View) => void;
  onOpenPanel: (panel: Panel) => void;
}

export function WorkspaceDialogs(props: Props) {
  const sessions = useWorkspaceStore((s) => s.sessions);
  const settings = useWorkspaceStore((s) => s.settings);
  const updateSettings = useWorkspaceStore((s) => s.updateSettings);
  const rename = useWorkspaceStore((s) => s.renameSession);
  const remove = useWorkspaceStore((s) => s.deleteSession);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  const [endpointError, setEndpointError] = useState("");
  const [resetOpen, setResetOpen] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setName(props.renameSession?.title ?? ""); }, [props.renameSession]);
  useEffect(() => { setEndpoint(settings.endpoint); }, [settings.endpoint, props.settingsOpen]);
  useEffect(() => { setQuery(""); setSelected(0); }, [props.searchOpen]);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { resultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selected]);

  const results = useMemo(() => {
    const actions = [
      { id: "new", title: "New session", detail: "Start a conversation", icon: Plus, run: () => props.onNewSession() },
      { id: "routines", title: "Routines", detail: "Scheduled and recurring work", icon: Clock3, run: () => props.onNavigate("routines") },
      { id: "tasks", title: "Background tasks", detail: "See what Mars is working on", icon: ListTodo, run: () => props.onOpenPanel("tasks") },
      { id: "files", title: "Files", detail: "Browse this workspace", icon: Folder, run: () => props.onOpenPanel("files") },
      { id: "customize", title: "Customize", detail: "Skills, plugins and connectors", icon: SlidersHorizontal, run: () => props.onNavigate("customize") },
    ];
    const matches = sessions.filter((s) => !s.archived && `${s.title} ${s.project} ${s.messages.map((m) => m.content).join(" ")}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt).map((s) => ({ id: s.id, title: s.title, detail: s.project, icon: MessageSquare, run: () => props.onOpenSession(s.id) }));
    return [...(query ? [] : actions.slice(0, 1)), ...matches, ...actions.filter((a) => query ? `${a.title} ${a.detail}`.toLowerCase().includes(query.toLowerCase()) : a.id !== "new")].slice(0, 16);
  }, [sessions, query, props.onNewSession, props.onNavigate, props.onOpenPanel, props.onOpenSession]);

  function choose(index: number) { results[index]?.run(); props.setSearchOpen(false); }
  function saveEndpoint(event: React.FormEvent) {
    event.preventDefault();
    const value = endpoint.trim();
    if (value) {
      try {
        const url = new URL(value);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid address");
        if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
          setEndpointError("Use your HTTPS Tailscale address, or HTTP for localhost."); return;
        }
      } catch { setEndpointError("Enter a complete URL without credentials, query strings or fragments."); return; }
    }
    updateSettings({ endpoint: value }); setEndpointError(""); toast("Gateway address saved", { description: "This preview remains local until you connect a Pi transport." });
  }

  return (
    <>
      <Dialog open={props.searchOpen} onOpenChange={props.setSearchOpen}>
        <DialogContent className="search-dialog" showCloseButton={false}>
          <DialogTitle className="sr-only">Search sessions and commands</DialogTitle>
          <DialogDescription className="sr-only">Search session titles, conversation text, projects and workspace commands.</DialogDescription>
          <div className="search-dialog-input">
            <Search size={18} />
            <input aria-label="Search sessions and commands" role="combobox" aria-expanded={true} aria-controls="workspace-search-results" aria-activedescendant={results.length ? `search-result-${selected}` : undefined} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sessions or jump to…" autoComplete="off" onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected((v) => Math.min(results.length - 1, v + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((v) => Math.max(0, v - 1)); }
              else if (e.key === "Enter" && results.length) { e.preventDefault(); choose(selected); }
            }} />
            <button onClick={() => props.setSearchOpen(false)} aria-label="Close search"><kbd>esc</kbd></button>
          </div>
          <div className="search-results-label">{query ? `${results.length} results` : "Recent sessions"}</div>
          <div className="search-results" role="listbox" aria-label="Results" id="workspace-search-results" ref={resultsRef}>
            {results.map((result, index) => <button key={result.id} id={`search-result-${index}`} role="option" aria-selected={index === selected} className={cn("search-result", index === selected && "selected")} onMouseEnter={() => setSelected(index)} onClick={() => choose(index)}><result.icon size={16} /><span><strong>{result.title}</strong><small>{result.detail}</small></span>{index === selected && <CornerDownLeft size={14} />}</button>)}
            {!results.length && <p className="search-no-results">No sessions found. Try another word.</p>}
          </div>
          <div className="search-dialog-footer"><span><ArrowUp size={11} /><ArrowDown size={11} /> to navigate</span><span><CornerDownLeft size={11} /> to open</span><span className="search-footer-brand">Mars</span></div>
        </DialogContent>
      </Dialog>

      <Dialog open={props.settingsOpen} onOpenChange={props.setSettingsOpen}>
        <DialogContent className="settings-dialog">
          <DialogTitle className="sr-only">Workspace settings</DialogTitle>
          <DialogDescription className="sr-only">Appearance, Pi connection and keyboard shortcuts.</DialogDescription>
          <nav className="settings-navigation" aria-label="Settings categories">
            <div className="settings-title">Settings</div>
            {([{ id: "general", icon: Settings2, title: "General" }, { id: "connection", icon: Server, title: "Pi connection" }, { id: "keyboard", icon: Keyboard, title: "Shortcuts" }] as const).map((item) => <button key={item.id} aria-current={props.settingsTab === item.id ? "page" : undefined} className={cn(props.settingsTab === item.id && "selected")} onClick={() => props.setSettingsTab(item.id)}><item.icon size={14} />{item.title}</button>)}
            <div className="settings-version"><Code2 size={13} />Mars 0.1.0</div>
          </nav>
          <div className="settings-content">
            {props.settingsTab === "general" && <>
              <h2>General</h2><p className="settings-intro">Make the workspace feel like yours.</p>
              <div className="settings-section">
                <h3>Appearance</h3>
                <div className="theme-options" aria-label="Colour theme">
                  {([{ id: "light", label: "Light", icon: Sun }, { id: "dark", label: "Dark", icon: Moon }, { id: "system", label: "System", icon: Laptop }] as const).map(({ id, label, icon: Icon }) => <button aria-pressed={settings.theme === id} className={cn(settings.theme === id && "selected")} key={id} onClick={() => updateSettings({ theme: id })}><div className={`theme-swatch ${id}`}><span /><i /><b /></div><span><Icon size={12} />{label}{settings.theme === id && <Check size={12} />}</span></button>)}
                </div>
              </div>
              <div className="settings-row"><div><label htmlFor="compact-ui">Compact sidebar</label><p>Keep more sessions in view.</p></div><Switch id="compact-ui" checked={settings.compact} onCheckedChange={(compact) => updateSettings({ compact })} /></div>
              <div className="settings-row"><div><label htmlFor="show-activity">Show tool activity</label><p>Display tool calls above responses.</p></div><Switch id="show-activity" checked={settings.showActivity} onCheckedChange={(showActivity) => updateSettings({ showActivity })} /></div>
              <div className="settings-row"><div><label htmlFor="reduced-motion">Reduce motion</label><p>Use immediate transitions and static indicators.</p></div><Switch id="reduced-motion" checked={settings.reducedMotion} onCheckedChange={(reducedMotion) => updateSettings({ reducedMotion })} /></div>
              <div className="settings-section settings-reset"><h3>Local preview data</h3><p>Sessions, preferences and routines are saved in this browser.</p><Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>Reset sessions and routines</Button></div>
            </>}
            {props.settingsTab === "connection" && <>
              <h2>Pi connection</h2><p className="settings-intro">Your agent lives on the VM. Mars is its workspace.</p>
              <div className="connection-status-card"><Server size={21} /><div><strong>Local preview</strong><p>No Pi server connected</p></div><span className="preview-tag">Demo</span></div>
              <form onSubmit={saveEndpoint} className="connection-form">
                <label htmlFor="gateway-address">Gateway URL</label>
                <Input id="gateway-address" type="url" placeholder="https://mars.your-tailnet.ts.net" value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setEndpointError(""); }} aria-invalid={Boolean(endpointError)} aria-describedby="gateway-description" autoComplete="off" />
                <p id="gateway-description">Save your private address for integration. Saving it does not connect this demo.</p>
                {endpointError && <p className="form-error" role="alert">{endpointError}</p>}
                <Button type="submit" variant="secondary" size="sm">Save address</Button>
              </form>
              <div className="connection-guide"><h3>Connecting your Pi agent</h3><ol><li>Run Pi and a web gateway on your VM.</li><li>Map its events and actions to the included transport interface.</li><li>Use Tailscale to access the workspace privately.</li></ol><p>The source includes a step-by-step guide in <code>docs/PI-INTEGRATION.md</code>. Provider keys stay on your VM.</p></div>
            </>}
            {props.settingsTab === "keyboard" && <>
              <h2>Keyboard shortcuts</h2><p className="settings-intro">A few ways to move without leaving the keyboard.</p>
              <div className="keyboard-shortcut-list">
                {[ ["Search sessions and commands", "⌘ / Ctrl", "K"], ["Show or hide sidebar", "⌘ / Ctrl", "B"], ["New session", "⌘ / Ctrl", "⇧", "O"], ["Open settings", "⌘ / Ctrl", ","], ["Send a message", "Enter"], ["Insert a new line", "Shift", "Enter"], ["Close a menu or dialog", "Esc"] ].map(([label, ...keys]) => <div key={label}><span>{label}</span><span>{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></div>)}
              </div>
              <p className="keyboard-note">In the composer, type <kbd>/</kbd> to browse commands. Use the left and right arrow keys on a panel divider to resize it.</p>
            </>}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(props.renameSession)} onOpenChange={(open) => { if (!open) props.setRenameSession(null); }}>
        <DialogContent className="small-dialog"><DialogHeader><DialogTitle>Rename session</DialogTitle><DialogDescription>Give this conversation a name you can find later.</DialogDescription></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (props.renameSession && name.trim()) { rename(props.renameSession.id, name.trim()); props.setRenameSession(null); toast("Session renamed"); } }}>
            <Input aria-label="Session name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
            <DialogFooter className="mt-5"><Button type="button" variant="ghost" size="sm" onClick={() => props.setRenameSession(null)}>Cancel</Button><Button size="sm" type="submit" disabled={!name.trim()}>Save name</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(props.deleteSession)} onOpenChange={(open) => { if (!open) props.setDeleteSession(null); }}>
        <DialogContent className="small-dialog"><DialogHeader><DialogTitle>Delete this session?</DialogTitle><DialogDescription>“{props.deleteSession?.title}” and its messages will be removed from this browser.</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" size="sm" onClick={() => props.setDeleteSession(null)}>Keep session</Button><Button variant="destructive" size="sm" onClick={() => { if (props.deleteSession) remove(props.deleteSession.id); props.setDeleteSession(null); toast("Session deleted"); }}>Delete session</Button></DialogFooter></DialogContent>
      </Dialog>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="small-dialog"><DialogHeader><DialogTitle>Reset the demo workspace?</DialogTitle><DialogDescription>This removes your locally saved sessions, routines and workspace preferences. The sample workspace will load again. Download any conversations you want to keep first.</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" size="sm" onClick={() => setResetOpen(false)}>Cancel</Button><Button variant="destructive" size="sm" onClick={async () => { await useWorkspaceStore.persist.clearStorage(); window.location.reload(); }}>Reset demo</Button></DialogFooter></DialogContent>
      </Dialog>
    </>
  );
}
