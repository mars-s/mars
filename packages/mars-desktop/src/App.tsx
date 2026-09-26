import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Bot,
  Brain,
  Globe2,
  ChevronLeft,
  Command,
  FileText,
  Folder,
  GitPullRequest,
  Hammer,
  Loader2,
  MessageSquarePlus,
  Plug,
  Search,
  Send,
  Settings,
  Sparkles,
  Square,
  TerminalSquare,
  Webhook,
  Wrench,
} from "lucide-react";
import { GatewayClient, type HealthState, type ServerEvent, type SessionSummary } from "./gateway";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
type ToolActivity = { id: string; name: string; status: "running" | "done" };

type Capability = { icon: ComponentType<{ size?: number }>; label: string; active?: boolean };
const capabilities: Capability[] = [
  { icon: Brain, label: "Memory" },
  { icon: Bot, label: "Subagents" },
  { icon: Plug, label: "Plugins" },
  { icon: Webhook, label: "MCP Servers" },
  { icon: Sparkles, label: "Skills" },
  { icon: Command, label: "Commands" },
  { icon: Wrench, label: "Hooks" },
];

const gateway = new GatewayClient();

function ProviderSetup({ health, onReady }: { health: HealthState; onReady: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState(health.provider.modelId);
  const [baseUrl, setBaseUrl] = useState(health.provider.baseUrl || "https://opencode.ai/zen/go/v1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!apiKey.trim() || !modelId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const input = { apiKey, modelId, baseUrl };
      if (window.marsDesktop?.configureProvider) {
        await window.marsDesktop.configureProvider(input);
      } else {
        await gateway.configureProvider(input);
      }
      setApiKey("");
      await onReady();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-shell">
      <div className="setup-card glass-card">
        <div className="mars-mark">M</div>
        <div className="eyebrow">Mars local gateway</div>
        <h1>Connect your model</h1>
        <p className="muted">
          Mars is running locally and headless. Configure OpenCode Go now. Remote gateways will use
          the same client protocol later.
        </p>

        <div className="mode-grid">
          <div className="mode-card selected">
            <div><strong>Local</strong><span className="status-dot online" /></div>
            <span>127.0.0.1 · Strands</span>
          </div>
          <div className="mode-card disabled">
            <div><strong>Remote</strong></div>
            <span>Planned</span>
          </div>
        </div>

        <label>
          <span>OpenCode Go API key</span>
          <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Enter API key" />
        </label>
        <label>
          <span>Model ID</span>
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="Model exposed by OpenCode Go" />
        </label>
        <label>
          <span>OpenAI-compatible endpoint</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        {error ? <div className="error-box">{error}</div> : null}
        <button className="primary-button" disabled={busy || !apiKey.trim() || !modelId.trim()} onClick={save}>
          {busy ? <Loader2 className="spin" size={17} /> : null}
          Start Mars
        </button>
        <div className="setup-note">
          Desktop saves provider metadata under <code>~/.mars/config/v1</code> and persists the API
          key only when OS-backed secure storage is available. Stored secrets are never read back
          into the renderer.
        </div>
      </div>
    </div>
  );
}

function SidePanel({ kind, onClose }: { kind: "terminal" | "browser" | "files"; onClose: () => void }) {
  const labels = { terminal: "Terminal", browser: "Globe2", files: "Files" } as const;
  const Icon = kind === "terminal" ? TerminalSquare : kind === "browser" ? Globe2 : Folder;
  return (
    <aside className="workbench-panel">
      <div className="workbench-header">
        <div className="workbench-title"><Icon size={15} /> {labels[kind]}</div>
        <button className="icon-button" onClick={onClose}><ChevronLeft size={16} /></button>
      </div>
      <div className="workbench-empty">
        <Icon size={30} />
        <strong>{labels[kind]} bridge is next</strong>
        <span>This pane already belongs to the Mars workbench. It will execute on the local gateway host, then the same interface can point at a Linux server.</span>
      </div>
    </aside>
  );
}

export default function App() {
  const [health, setHealth] = useState<HealthState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [rightPane, setRightPane] = useState<"terminal" | "browser" | "files" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const activeRequest = useRef<string | null>(null);
  const assistantId = useRef<string | null>(null);

  const refreshSessions = () => {
    const requestId = crypto.randomUUID();
    gateway.send({ type: "session.list", requestId });
  };

  const connect = async () => {
    const nextHealth = await gateway.health();
    setHealth(nextHealth);
    if (!nextHealth.provider.providerReady) return;
    await gateway.connect();
    refreshSessions();
  };

  useEffect(() => {
    const boot = async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await connect();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      setBootError(lastError instanceof Error ? lastError.message : String(lastError));
    };
    void boot();
    return gateway.onEvent((event: ServerEvent) => {
      if (event.type === "session.created") {
        setSessionId(event.sessionId);
        setMessages([]);
        setTools([]);
        refreshSessions();
      } else if (event.type === "session.list") {
        setSessions(event.sessions);
      } else if (event.type === "chat.started") {
        setRunning(true);
      } else if (event.type === "chat.delta") {
        const id = assistantId.current;
        if (!id) return;
        setMessages((current) => current.map((message) => message.id === id ? { ...message, content: message.content + event.text } : message));
      } else if (event.type === "tool.started") {
        setTools((current) => [...current.filter((tool) => tool.id !== event.requestId + event.name), { id: event.requestId + event.name, name: event.name, status: "running" }]);
      } else if (event.type === "tool.finished") {
        setTools((current) => current.map((tool) => tool.id === event.requestId + event.name ? { ...tool, status: "done" } : tool));
      } else if (event.type === "chat.done" || event.type === "chat.cancelled") {
        setRunning(false);
        activeRequest.current = null;
        assistantId.current = null;
        refreshSessions();
      } else if (event.type === "error") {
        setRunning(false);
        setMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: `Error: ${event.message}` }]);
      }
    });
  }, []);

  const newChat = () => {
    const requestId = crypto.randomUUID();
    gateway.send({ type: "session.create", requestId });
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || running) return;
    let targetSession = sessionId;
    if (!targetSession) {
      targetSession = await new Promise<string>((resolve) => {
        const requestId = crypto.randomUUID();
        const off = gateway.onEvent((event) => {
          if (event.type === "session.created" && event.requestId === requestId) {
            off();
            resolve(event.sessionId);
          }
        });
        gateway.send({ type: "session.create", requestId });
      });
      setSessionId(targetSession);
    }
    const requestId = crypto.randomUUID();
    const nextAssistantId = crypto.randomUUID();
    activeRequest.current = requestId;
    assistantId.current = nextAssistantId;
    setInput("");
    setTools([]);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: text },
      { id: nextAssistantId, role: "assistant", content: "" },
    ]);
    gateway.send({ type: "chat.send", requestId, sessionId: targetSession, text });
  };

  const cancel = () => {
    if (!sessionId || !activeRequest.current) return;
    gateway.send({ type: "chat.cancel", requestId: crypto.randomUUID(), sessionId });
  };

  const ready = health?.provider.providerReady === true;
  const hasConversation = messages.length > 0;
  const activeSessionTitle = useMemo(() => sessions.find((session) => session.id === sessionId)?.title ?? "New chat", [sessions, sessionId]);

  if (bootError) {
    return <div className="fatal"><div className="glass-card"><h1>Mars gateway unavailable</h1><p>{bootError}</p><code>pnpm dev:desktop</code></div></div>;
  }
  if (!health) return <div className="boot"><div className="mars-mark">M</div><Loader2 className="spin" /></div>;
  if (!ready) return <ProviderSetup health={health} onReady={connect} />;

  return (
    <div className="app-shell">
      <aside className="sidebar glass-sidebar">
        <div className="traffic-space" />
        <button className="nav-button primary-nav" onClick={newChat}><MessageSquarePlus size={17} /><span>New chat</span><kbd>⌘ N</kbd></button>
        <button className="nav-button"><Search size={17} /><span>Search</span><kbd>⌘ K</kbd></button>
        <div className="sidebar-section-label">Chats</div>
        <div className="session-list">
          {sessions.length === 0 ? <div className="empty-side">No chats yet</div> : sessions.map((session) => (
            <button key={session.id} className={`session-row ${session.id === sessionId ? "active" : ""}`} onClick={() => setSessionId(session.id)}>
              <span>{session.title}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-section-label capability-label">Capabilities</div>
        <div className="capability-list">
          {capabilities.map(({ icon: Icon, label }) => <button key={label} className="capability-row" onClick={() => setSettingsOpen(true)}><Icon size={16} /><span>{label}</span></button>)}
        </div>
        <div className="sidebar-footer">
          <div className="gateway-pill"><span className="status-dot online" /> Local Strands</div>
          <button className="icon-button" onClick={() => setSettingsOpen((value) => !value)}><Settings size={17} /></button>
        </div>
      </aside>

      <main className="main-pane">
        <header className="topbar">
          <div className="top-title">{activeSessionTitle}</div>
          <div className="view-buttons">
            <button className="icon-button" onClick={() => setRightPane("browser")} title="Globe2"><Globe2 size={16} /></button>
            <button className="icon-button" onClick={() => setRightPane("terminal")} title="Terminal"><TerminalSquare size={16} /></button>
            <button className="icon-button" onClick={() => setRightPane("files")} title="Files"><Folder size={16} /></button>
            <button className="icon-button" title="Review"><GitPullRequest size={16} /></button>
          </div>
        </header>

        <div className="conversation">
          {!hasConversation ? (
            <div className="empty-chat">
              <div className="hero-mark">M</div>
              <h1>What should Mars handle?</h1>
              <p>Local Strands gateway · OpenCode Go · {health.workspace}</p>
            </div>
          ) : (
            <div className="message-stack">
              {messages.map((message) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <div className="message-role">{message.role === "user" ? "You" : "Mars"}</div>
                  <div className="message-content">{message.content || (running && message.id === assistantId.current ? <span className="thinking"><i /><i /><i /></span> : "")}</div>
                </div>
              ))}
              {tools.length > 0 ? <div className="tool-strip">{tools.map((tool) => <span key={tool.id} className="tool-chip">{tool.status === "running" ? <Loader2 className="spin" size={12} /> : <Hammer size={12} />}{tool.name}</span>)}</div> : null}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer glass-card">
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder="Ask Mars anything" rows={1} />
            <div className="composer-footer">
              <div className="composer-meta"><span className="status-dot online" /> OpenCode Go</div>
              {running ? <button className="send-button" onClick={cancel}><Square size={14} fill="currentColor" /></button> : <button className="send-button" disabled={!input.trim()} onClick={() => void submit()}><Send size={16} /></button>}
            </div>
          </div>
        </div>
      </main>

      {rightPane ? <SidePanel kind={rightPane} onClose={() => setRightPane(null)} /> : null}
      {settingsOpen ? (
        <div className="settings-drawer glass-card">
          <div className="settings-head"><strong>Mars settings</strong><button className="icon-button" onClick={() => setSettingsOpen(false)}>×</button></div>
          <div className="settings-section"><span>Connection</span><strong>Local gateway</strong><small>Remote gateway support uses the same protocol and is planned next.</small></div>
          <div className="settings-section"><span>Agent runtime</span><strong>Strands Agents</strong><small>Provider: OpenCode Go via OpenAI-compatible Chat Completions.</small></div>
          <button className="secondary-button" onClick={async () => { setHealth({ ...health, provider: { ...health.provider, providerReady: false } }); setSettingsOpen(false); }}>Reconfigure provider</button>
        </div>
      ) : null}
    </div>
  );
}
