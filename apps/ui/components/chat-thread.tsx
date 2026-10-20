"use client";

import {
  AuiIf,
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Compass,
  FileText,
  ListChecks,
  ListTodo,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { demoTransport } from "@/lib/pi/demo-transport";
import { isAbortError, type MarsTransport } from "@/lib/pi/transport";
import { createId, hydrateWorkspaceStore, useWorkspaceStore } from "@/lib/store";
import type { MarsMessage, Panel, PermissionMode } from "@/lib/types";
import StatusMark from "./react-bits/StatusMark";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type OpenPanel = (panel: Panel) => void;
const PanelContext = createContext<OpenPanel>(() => undefined);
const ResumeContext = createContext<{ canResume: boolean; resume: (messageId: string) => Promise<void> }>({ canResume: false, resume: async () => undefined });
const EMPTY_MESSAGES: MarsMessage[] = [];

function convertMessage(message: MarsMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    content: [{ type: "text", text: message.content }],
    ...(message.role === "assistant" ? {
      status: message.streamState === "detached"
        ? { type: "incomplete" as const, reason: "other" as const }
        : message.status === "running"
        ? { type: "running" as const }
        : message.status === "cancelled" || message.status === "error"
          ? { type: "incomplete" as const, reason: message.status }
          : { type: "complete" as const, reason: "stop" as const },
    } : {}),
    metadata: { custom: { activity: message.activity ?? [], localStatus: message.status ?? "complete", streamState: message.streamState } },
  };
}

function getText(message: AppendMessage) {
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
}

export interface ChatThreadProps {
  sessionId: string;
  onOpenPanel: OpenPanel;
  /** Replace with an adapter for your server's actual protocol when connecting Mars. */
  transport?: MarsTransport;
}

export function ChatThread({ sessionId, onOpenPanel, transport = demoTransport }: ChatThreadProps) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let mounted = true;
    void hydrateWorkspaceStore().then(() => { if (mounted) setHydrated(true); });
    return () => { mounted = false; };
  }, []);
  // The composer, edit state, scroll state, and run owner are scoped to one session.
  return <ChatSession key={sessionId} sessionId={sessionId} onOpenPanel={onOpenPanel} transport={transport} hydrated={hydrated} />;
}

function ChatSession({ sessionId, onOpenPanel, transport = demoTransport, hydrated }: ChatThreadProps & { hydrated: boolean }) {
  const session = useWorkspaceStore(state => state.sessions.find(item => item.id === sessionId));
  const compact = useWorkspaceStore(state => state.settings.compact);
  const messages = session?.messages ?? EMPTY_MESSAGES;
  const currentRun = useRef<{ controller: AbortController; messageId: string; sessionId: string } | null>(null);

  const stopCurrentRun = useCallback((reason: "detach" | "cancel" = "detach") => {
    const run = currentRun.current;
    if (!run) return;
    currentRun.current = null;
    run.controller.abort();
    const store = useWorkspaceStore.getState();
    const thread = store.sessions.find(item => item.id === run.sessionId);
    if (thread) store.setMessages(run.sessionId, thread.messages.map(message => {
      if (message.id !== run.messageId || message.status !== "running") return message;
      if (message.transport === "remote" && reason === "detach") return { ...message, streamState: "detached" };
      return { ...message, status: "cancelled", streamState: undefined, content: message.content || "Response stopped.", activity: message.activity?.filter(item => item.status === "complete") };
    }));
  }, []);

  useEffect(() => () => stopCurrentRun(), [stopCurrentRun]);

  const run = useCallback(async (history: MarsMessage[], resumeMessage?: MarsMessage) => {
    if (resumeMessage && !transport.resume) return;
    stopCurrentRun();
    const store = useWorkspaceStore.getState();
    if (!store.sessions.some(item => item.id === sessionId && !item.archived)) return;
    const controller = new AbortController();
    const messageId = resumeMessage?.id ?? createId("assistant");
    const owner = { controller, messageId, sessionId };
    currentRun.current = owner;
    store.setMessages(sessionId, resumeMessage
      ? history.map(message => message.id === messageId ? { ...message, status: "running", streamState: undefined } : message)
      : [...history, { id: messageId, role: "assistant", content: "", createdAt: Date.now(), status: "running", transport: transport.mode }]);

    const update = (patch: (message: MarsMessage) => MarsMessage) => {
      if (controller.signal.aborted || currentRun.current !== owner) return;
      const nextStore = useWorkspaceStore.getState();
      const thread = nextStore.sessions.find(item => item.id === sessionId && !item.archived);
      if (!thread) { controller.abort(); return; }
      nextStore.setMessages(sessionId, thread.messages.map(message => message.id === messageId ? patch(message) : message));
    };

    let completed = false;
    try {
      const events = resumeMessage ? transport.resume!({ sessionId, runId: messageId }, controller.signal) : transport.stream({
        runId: messageId,
        sessionId,
        messages: history,
        model: store.settings.model,
        permissionMode: store.settings.permissionMode,
        context: { tasks: store.tasks },
      }, controller.signal);
      for await (const event of events) {
        if (controller.signal.aborted || currentRun.current !== owner) break;
        if (event.type === "text-delta") update(message => ({ ...message, content: message.content + event.delta }));
        if (event.type === "text-snapshot") update(message => ({ ...message, content: event.text }));
        if (event.type === "activity") update(message => ({ ...message, activity: event.activity }));
        if (event.type === "complete") {
          completed = true;
          update(message => ({ ...message, status: "complete", streamState: undefined }));
          break;
        }
      }
      if (!completed && !controller.signal.aborted) throw new Error("The response stream ended before completion.");
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) {
        update(message => transport.mode === "remote"
          ? { ...message, streamState: "detached" }
          : { ...message, status: "error", content: message.content || "The response stopped unexpectedly. Please retry." });
      }
    } finally {
      if (currentRun.current === owner) currentRun.current = null;
    }
  }, [sessionId, stopCurrentRun, transport]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const content = getText(message);
    if (!content) return;
    stopCurrentRun();
    const store = useWorkspaceStore.getState();
    const thread = store.sessions.find(item => item.id === sessionId);
    if (!thread) return;
    if (thread.title === "New conversation") store.renameSession(sessionId, content.replace(/\s+/g, " ").slice(0, 64));
    await run([...thread.messages, { id: createId("user"), role: "user", content, createdAt: Date.now() }]);
  }, [sessionId, run, stopCurrentRun]);

  const onEdit = useCallback(async (message: AppendMessage) => {
    const content = getText(message);
    if (!content) return;
    stopCurrentRun();
    const thread = useWorkspaceStore.getState().sessions.find(item => item.id === sessionId);
    if (!thread) return;
    const index = thread.messages.findIndex(item => item.id === message.sourceId);
    const parentIndex = thread.messages.findIndex(item => item.id === message.parentId);
    const history = index >= 0 ? thread.messages.slice(0, index) : thread.messages.slice(0, parentIndex + 1);
    await run([...history, { id: createId("user"), role: "user", content, createdAt: Date.now() }]);
  }, [sessionId, run, stopCurrentRun]);

  const onReload = useCallback(async (parentId: string | null) => {
    stopCurrentRun();
    const thread = useWorkspaceStore.getState().sessions.find(item => item.id === sessionId);
    if (!thread) return;
    const parentIndex = thread.messages.findIndex(item => item.id === parentId);
    if (parentIndex < 0) return;
    await run(thread.messages.slice(0, parentIndex + 1));
  }, [sessionId, run, stopCurrentRun]);

  const onResume = useCallback(async (messageId: string) => {
    const thread = useWorkspaceStore.getState().sessions.find(item => item.id === sessionId);
    const message = thread?.messages.find(item => item.id === messageId && item.streamState === "detached");
    if (thread && message) await run(thread.messages, message);
  }, [sessionId, run]);

  const onCancel = useCallback(async () => {
    const owner = currentRun.current;
    if (!owner) return;
    if (transport.mode === "remote") {
      if (!transport.cancel) return;
      try { await transport.cancel({ sessionId: owner.sessionId, runId: owner.messageId }); }
      catch { toast.error("Cancellation was not confirmed. The server may still be working."); return; }
      if (currentRun.current?.messageId !== owner.messageId || currentRun.current.sessionId !== owner.sessionId) {
        // Cancellation can finish after the user switches sessions. Apply its
        // confirmed result to the original run, without touching a new owner.
        const store = useWorkspaceStore.getState();
        const thread = store.sessions.find(item => item.id === owner.sessionId);
        if (thread) store.setMessages(owner.sessionId, thread.messages.map(message => message.id === owner.messageId && message.status === "running"
          ? { ...message, status: "cancelled", streamState: undefined, activity: message.activity?.filter(item => item.status === "complete") }
          : message));
        return;
      }
    }
    stopCurrentRun("cancel");
  }, [stopCurrentRun, transport]);

  const runtime = useExternalStoreRuntime<MarsMessage>({
    messages,
    isRunning: messages.some(message => message.status === "running" && message.streamState !== "detached"),
    convertMessage,
    setMessages: next => useWorkspaceStore.getState().setMessages(sessionId, [...next]),
    onNew,
    onEdit,
    onReload,
    onCancel: transport.mode === "demo" || transport.cancel ? onCancel : undefined,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PanelContext.Provider value={onOpenPanel}>
        <ResumeContext.Provider value={{ canResume: Boolean(transport.resume), resume: onResume }}>
        <ThreadPrimitive.Root className={`mars-chat${compact ? " mars-chat-compact" : ""}`} aria-label="Conversation" data-hydrated={hydrated}>
          <ThreadPrimitive.Viewport className="mars-chat-viewport" autoScroll>
            <div className="mars-chat-messages">
              <AuiIf condition={state => state.thread.isEmpty}>
                <Welcome project={session?.project ?? "Recents"} />
              </AuiIf>
              <ThreadPrimitive.Messages>
                {({ message }) => message.composer.isEditing
                  ? <EditComposer />
                  : message.role === "user" ? <UserMessage /> : <AssistantMessage />}
              </ThreadPrimitive.Messages>
            </div>
            <ThreadPrimitive.ViewportFooter className="mars-chat-footer">
              <div className="mars-composer-wrap">
                <ThreadPrimitive.ScrollToBottom className="mars-scroll-bottom" aria-label="Scroll to latest message">
                  <ArrowDown size={15} />
                </ThreadPrimitive.ScrollToBottom>
                <ChatComposer />
                <div className="mars-composer-hint"><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span></div>
              </div>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
        </ResumeContext.Provider>
      </PanelContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="mars-markdown" />;
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mars-message mars-user-message">
      <div className="mars-user-bubble"><MessagePrimitive.Parts /></div>
      <ActionBarPrimitive.Root className="mars-message-actions mars-user-actions" autohide="never" hideWhenRunning>
        <CopyAction />
        <ActionBarPrimitive.Edit className="mars-icon-button" aria-label="Edit message" title="Edit message"><Pencil size={14} /></ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function CopyAction() {
  return (
    <ActionBarPrimitive.Copy className="mars-icon-button mars-copy-button" aria-label="Copy message" title="Copy message">
      <Clipboard className="mars-copy-icon" size={14} />
      <Check className="mars-copy-done" size={14} />
    </ActionBarPrimitive.Copy>
  );
}

function AssistantMessage() {
  const status = useAuiState(state => state.message.status?.type);
  const localStatus = useAuiState(state => state.message.metadata.custom?.localStatus);
  const empty = useAuiState(state => state.message.content.every(part => part.type !== "text" || !part.text));
  const detached = useAuiState(state => state.message.metadata.custom?.streamState === "detached");
  const messageId = useAuiState(state => state.message.id);
  const { canResume, resume } = useContext(ResumeContext);
  return (
    <MessagePrimitive.Root className="mars-message mars-assistant-message">
      {!detached && <MessageActivity />}
      {status === "running" && empty ? <div className="mars-thinking"><StatusMark status="running" size={14} /><span>Thinking</span><span className="mars-thinking-dots" aria-hidden="true">···</span></div> : null}
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      {localStatus === "cancelled" ? <div className="mars-message-status"><Square size={10} />Response stopped</div> : null}
      {localStatus === "error" ? <div className="mars-message-status mars-message-error">The response was interrupted. Try again.</div> : null}
      {detached ? <div className="mars-message-status">Live view disconnected. Server work may continue.{canResume && <button type="button" className="mars-reconnect-button" onClick={() => void resume(messageId)}>Reconnect</button>}</div> : null}
      <ActionBarPrimitive.Root className="mars-message-actions" autohide="never" hideWhenRunning>
        <CopyAction />
        {!detached && <ActionBarPrimitive.Reload className="mars-icon-button" aria-label="Retry response" title="Retry response"><RotateCcw size={14} /></ActionBarPrimitive.Reload>}
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function MessageActivity() {
  const onOpenPanel = useContext(PanelContext);
  const showActivity = useWorkspaceStore(state => state.settings.showActivity);
  const activity = useAuiState(state => state.message.metadata.custom?.activity) as MarsMessage["activity"];
  if (!showActivity || !activity?.length) return null;
  const allDone = activity.every(item => item.status === "complete");
  return (
    <details className="mars-activity">
      <summary><StatusMark status={allDone ? "done" : "running"} size={13} /><span>{allDone ? "Reviewed project context" : "Working through the steps"}</span><ChevronDown size={12} /></summary>
      <div className="mars-activity-content">
        {activity.map((item, index) => <div className="mars-activity-item" key={`${item.title}-${index}`}>
          <StatusMark status={item.status === "complete" ? "done" : "running"} size={12} />
          <div><span>{item.title}</span><p>{item.detail}</p></div>
        </div>)}
        <button type="button" className="mars-activity-link" onClick={() => onOpenPanel("tasks")}><ListTodo size={13} />View tasks</button>
      </div>
    </details>
  );
}

function EditComposer() {
  return (
    <MessagePrimitive.Root className="mars-message mars-edit-message">
      <ComposerPrimitive.Root className="mars-edit-composer">
        <ComposerPrimitive.Input className="mars-edit-input" autoFocus aria-label="Edit your message" submitMode="enter" />
        <div className="mars-edit-actions">
          <ComposerPrimitive.Cancel asChild><Button variant="ghost" size="sm">Cancel</Button></ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild><Button size="sm">Save & send</Button></ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

function Welcome({ project }: { project: string }) {
  const aui = useAui();
  const onOpenPanel = useContext(PanelContext);
  const suggestions = [
    { label: "Build something", icon: Code2, prompt: "Help me plan something I want to build." },
    { label: "Explore an idea", icon: Compass, prompt: "I have an idea I’d like to think through." },
    { label: "Make a plan", icon: ListChecks, prompt: "Help me make a clear plan for Project Mars." },
  ];
  const fill = (prompt: string) => {
    aui.composer().setText(prompt);
    document.querySelector<HTMLTextAreaElement>(".mars-composer-input")?.focus();
  };
  return <div className="mars-welcome">
    <h1 className="sr-only">Start a new conversation</h1>
    <div className="mars-welcome-suggestions">
      {suggestions.map(({ label, icon: Icon, prompt }) => <button type="button" key={label} onClick={() => fill(prompt)}><Icon size={14} /><span>{label}</span></button>)}
      <button type="button" className="mars-welcome-project" onClick={() => onOpenPanel("context")}><span>{project === "Recents" ? "Workspace context" : project}</span><ChevronDown size={12} /></button>
    </div>
    <div className="mars-welcome-next">
      <button type="button" onClick={() => fill("Help me plan the connection to my Pi runtime.")}>Plan the connection to Pi</button>
      <button type="button" onClick={() => fill("What should Mars remember between conversations?")}>Think through memory and continuity</button>
      <div>Suggested starting points</div>
    </div>
  </div>;
}

const PERMISSIONS: { value: PermissionMode; label: string; description: string }[] = [
  { value: "ask", label: "Ask before changes", description: "Request approval for actions" },
  { value: "auto", label: "Allow edits", description: "Prefer automatic workspace edits" },
  { value: "plan", label: "Plan mode", description: "Think through the work first" },
];

const COMMANDS = [
  { name: "/context", detail: "Open project context", panel: "context" as Panel, icon: BookOpen },
  { name: "/tasks", detail: "See the work in progress", panel: "tasks" as Panel, icon: ListTodo },
  { name: "/files", detail: "Browse workspace files", panel: "files" as Panel, icon: FileText },
  { name: "/terminal", detail: "Open the terminal preview", panel: "terminal" as Panel, icon: Terminal },
  { name: "/plan", detail: "Start with a plan", prompt: "Help me plan the next milestone for Project Mars.", icon: ListChecks },
];

function ChatComposer() {
  const aui = useAui();
  const onOpenPanel = useContext(PanelContext);
  const settings = useWorkspaceStore(state => state.settings);
  const updateSettings = useWorkspaceStore(state => state.updateSettings);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const text = useAuiState(state => state.composer.text);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const commandQuery = /^\/\w*$/.test(text) ? text.toLowerCase() : "";
  const filteredCommands = COMMANDS.filter(command => !commandQuery || command.name.startsWith(commandQuery));
  const permission = PERMISSIONS.find(item => item.value === settings.permissionMode) ?? PERMISSIONS[0];

  useEffect(() => {
    setCommandsOpen(commandQuery.length > 0 && filteredCommands.length > 0);
    setSelectedCommand(0);
  }, [commandQuery, filteredCommands.length]);

  const selectCommand = (command: typeof COMMANDS[number]) => {
    aui.composer().setText("prompt" in command && command.prompt ? command.prompt : "");
    if ("panel" in command && command.panel) onOpenPanel(command.panel);
    setCommandsOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!commandsOpen || !filteredCommands.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedCommand(current => (current + direction + filteredCommands.length) % filteredCommands.length);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      selectCommand(filteredCommands[selectedCommand] ?? filteredCommands[0]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCommandsOpen(false);
    }
  };

  return <ComposerPrimitive.Root className="mars-composer">
    <ComposerPrimitive.Input
      ref={inputRef}
      className="mars-composer-input"
      placeholder="Reply to Mars…"
      aria-label="Message Mars"
      rows={1}
      minRows={1}
      maxRows={7}
      submitMode="enter"
      addAttachmentOnPaste={false}
      onKeyDown={onKeyDown}
      aria-controls={commandsOpen ? "mars-command-list" : undefined}
      aria-expanded={commandsOpen}
      aria-autocomplete="list"
      aria-activedescendant={commandsOpen ? `mars-command-${selectedCommand}` : undefined}
    />
    <div className="mars-composer-toolbar">
      <div className="mars-composer-tools">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className="mars-icon-button mars-composer-add" aria-label="Add context" title="Add context"><Plus size={18} /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" sideOffset={12} className="mars-chat-menu">
            <DropdownMenuLabel>Add context</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onOpenPanel("context")}><BookOpen size={14} />Project brief</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenPanel("files")}><FileText size={14} />Workspace files</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenPanel("tasks")}><ListTodo size={14} />Tasks</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Popover open={commandsOpen} onOpenChange={setCommandsOpen}>
          <PopoverTrigger asChild><button type="button" className={`mars-icon-button mars-command-trigger${commandsOpen ? " is-active" : ""}`} aria-label="Open commands" title="Commands (type /)"><span>/</span></button></PopoverTrigger>
          <PopoverContent className="mars-command-menu" align="start" side="top" sideOffset={14} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} onInteractOutside={event => {
            // The textarea is the command menu's input, even though the portal
            // sits elsewhere in the DOM. Keep it open while that input is used.
            if (event.target === inputRef.current) event.preventDefault();
          }}>
            <div className="mars-command-heading"><span>Commands</span><button type="button" className="mars-icon-button" aria-label="Close commands" onClick={() => setCommandsOpen(false)}><X size={13} /></button></div>
            <div id="mars-command-list" role="listbox" aria-label="Commands">
              {filteredCommands.map((command, index) => <button type="button" role="option" aria-selected={selectedCommand === index} id={`mars-command-${index}`} key={command.name} className="mars-command-option" onMouseEnter={() => setSelectedCommand(index)} onClick={() => selectCommand(command)}>
                <command.icon size={15} /><span><strong>{command.name}</strong><small>{command.detail}</small></span><span className="mars-command-enter" aria-hidden="true">↵</span>
              </button>)}
            </div>
            <div className="mars-command-help">↑ ↓ to navigate <span>↵ to select</span></div>
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className="mars-composer-select mars-model-select" aria-label={`Model: ${settings.model}`}><span>{settings.model}</span><ChevronDown size={12} /></button></DropdownMenuTrigger>
          <DropdownMenuContent className="mars-chat-menu" align="start" side="top" sideOffset={12}>
            <DropdownMenuLabel>Model preference</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={settings.model} onValueChange={model => updateSettings({ model })}>
              {[...new Set(["Claude Sonnet", "Claude Opus", "Local model", "Default model", settings.model])].map(model => <DropdownMenuRadioItem key={model} value={model}>{model}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <div className="mars-menu-note">Applied when a compatible runtime is connected.</div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="mars-composer-tools mars-composer-tools-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" className="mars-composer-select mars-permission-select" aria-label={`Permission mode: ${permission.label}`}><ShieldCheck size={13} /><span>{permission.label}</span><ChevronDown size={11} /></button></DropdownMenuTrigger>
          <DropdownMenuContent className="mars-chat-menu mars-permission-menu" align="end" side="top" sideOffset={12}>
            <DropdownMenuLabel>Permission preference</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={settings.permissionMode} onValueChange={permissionMode => updateSettings({ permissionMode: permissionMode as PermissionMode })}>
              {PERMISSIONS.map(item => <DropdownMenuRadioItem key={item.value} value={item.value}><span className="mars-permission-item"><span>{item.label}</span><small>{item.description}</small></span></DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <div className="mars-menu-note">Your server must enforce these permissions. This preview saves the preference locally.</div>
          </DropdownMenuContent>
        </DropdownMenu>
        <AuiIf condition={state => !state.thread.isRunning}><ComposerPrimitive.Send className="mars-send-button" aria-label="Send message" title="Send message"><ArrowUp size={17} strokeWidth={2} /></ComposerPrimitive.Send></AuiIf>
        <AuiIf condition={state => state.thread.isRunning}><ComposerPrimitive.Cancel className="mars-send-button mars-stop-button" aria-label="Stop response" title="Stop response"><Square size={12} fill="currentColor" /></ComposerPrimitive.Cancel></AuiIf>
      </div>
    </div>
  </ComposerPrimitive.Root>;
}
