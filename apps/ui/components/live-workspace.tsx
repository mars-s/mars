"use client";

import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  MessageNotSentError,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type Attachment,
  type AttachmentAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clipboard,
  Menu,
  MessageSquare,
  PanelLeft,
  Plus,
  Settings,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import {
  parseSnapshot,
  parseConversations,
  parseCreatedConversation,
  piRequest,
  record,
  type ConversationSummary,
  type LiveMessage,
  type LiveSnapshot,
} from "@/lib/pi/live-state";
import { MarsMark } from "./mars-mark";
import StatusMark from "./react-bits/StatusMark";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import "./live-workspace.css";
import { ConnectionSettings } from "./connection-settings";
import { ThemeSettings } from "./theme-settings";
import { createImageAdapter } from "@/lib/pi/image-attachments";
import { LiveImageAttachment } from "./live-image-attachment";
import { PluginManager } from "./plugin-manager";
import { ActivityTimeline, AgentActivity } from "./activity-timeline";
import { LiveWorkers } from "./live-workers";

const EMPTY_MESSAGES: LiveMessage[] = [];
type ConversationDraft = {
  text: string;
  attachments: readonly Attachment[];
  adapter: AttachmentAdapter;
};
function createDraft(onError: (message: string) => void): ConversationDraft {
  const draft: ConversationDraft = {
    text: "",
    attachments: [],
    adapter: createImageAdapter(onError, () => draft.attachments.length),
  };
  return draft;
}
function convertMessage(message: LiveMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }],
    metadata: {
      custom: {
        tools: message.tools,
        outcome: message.outcome,
        images: message.images,
      },
    },
    ...(message.role === "assistant"
      ? {
          status: message.running
            ? { type: "running" }
            : message.outcome
              ? { type: "incomplete", reason: message.outcome }
              : { type: "complete", reason: "stop" },
        }
      : {}),
  };
}
function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="mars-markdown" />;
}
function UserMessage() {
  const images = useAuiState((state) => state.message.metadata.custom?.images);
  return (
    <MessagePrimitive.Root className="live-message live-user">
      <div className="live-user-bubble">
        {Array.isArray(images) && (
          <div className="live-message-images">
            {images.map(record).map((image) => (
              <a key={String(image.id)} href={String(image.url)} target="_blank" rel="noreferrer">
                <img src={String(image.url)} alt={String(image.name)} />
              </a>
            ))}
          </div>
        )}
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}
function AssistantMessage() {
  const hasText = useAuiState((state) =>
    state.message.content.some((part) => part.type === "text" && part.text.trim().length > 0),
  );
  const raw = useAuiState((state) => state.message.metadata.custom?.tools);
  const outcome = useAuiState((state) => state.message.metadata.custom?.outcome);
  const tools = Array.isArray(raw) ? raw.map(record) : [];
  return (
    <MessagePrimitive.Root className="live-message live-assistant">
      <ActivityTimeline tools={tools} />
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      {outcome === "error" && (
        <p className="live-outcome" role="status">
          The provider could not complete this response. Try a new message.
        </p>
      )}
      {outcome === "cancelled" && <p className="live-outcome">Response stopped.</p>}
      {hasText && (
        <ActionBarPrimitive.Root className="live-actions" autohide="never" hideWhenRunning>
          <ActionBarPrimitive.Copy className="live-icon" aria-label="Copy response">
            <Clipboard size={14} />
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
function ExtensionPanel({ extension }: { extension: LiveSnapshot["extensions"][number] }) {
  const target = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const root = target.current;
    if (!root) return;
    let detached = false;
    let cleanup: (() => void) | undefined;
    root.replaceChildren();
    // Native host modules are trusted installed code. Hashes are validated at the snapshot boundary.
    const load = async () => {
      try {
        const module: unknown = await import(
          /* webpackIgnore: true */ `/extensions/${extension.hash}/client.js`
        );
        const mount = record(module).mount;
        if (typeof mount !== "function") throw Error("This extension does not provide a UI.");
        if (detached) return;
        const result: unknown = mount(root);
        if (typeof result === "function") cleanup = () => result();
      } catch (failure) {
        if (!detached)
          setError(failure instanceof Error ? failure.message : "Extension could not load.");
      }
    };
    void load();
    return () => {
      detached = true;
      cleanup?.();
      root.replaceChildren();
    };
  }, [extension.hash]);
  return (
    <section className="live-extension" role="region" aria-label={extension.title}>
      {error && <p role="alert">{error}</p>}
      <div ref={target} />
    </section>
  );
}
function ConversationRuntime({
  snapshot,
  onNew,
  onCancel,
  draft,
  children,
}: {
  snapshot: LiveSnapshot | null;
  onNew: (message: AppendMessage) => Promise<void>;
  onCancel: () => Promise<void>;
  draft: ConversationDraft;
  children: ReactNode;
}) {
  const runtime = useExternalStoreRuntime({
    adapters: { attachments: draft.adapter },
    messages: snapshot?.messages ?? EMPTY_MESSAGES,
    convertMessage,
    isRunning: snapshot?.running ?? false,
    onNew,
    onCancel,
  });
  useEffect(() => {
    runtime.thread.composer.setText(draft.text);
    const restored = draft.attachments;
    if (!runtime.thread.composer.getState().attachments.length) {
      draft.attachments = [];
      for (const attachment of restored) {
        if (attachment.file)
          void runtime.thread.composer.addAttachment(attachment.file).catch(() => undefined);
      }
    }
    return runtime.thread.composer.subscribe(() => {
      const state = runtime.thread.composer.getState();
      draft.text = state.text;
      draft.attachments = state.attachments;
    });
  }, [runtime, draft]);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
export function LiveWorkspace() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingCount, setPendingCount] = useState(0);
  const pending = pendingCount > 0;
  const [selectedId, setSelectedId] = useState("");
  const selected = useRef("");
  const selectionEpoch = useRef(0);
  const latestRefresh = useRef(0);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const drafts = useRef(new Map<string, ConversationDraft>());
  let draft = drafts.current.get(selectedId);
  if (!draft) {
    draft = createDraft((message) => {
      if (selected.current === selectedId) setActionError(message);
    });
    drafts.current.set(selectedId, draft);
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("account");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [callback, setCallback] = useState("");
  const [claudeCode, setClaudeCode] = useState("");
  const requestKeys = useRef(new Map<string, { text: string; id: string }>());
  const refresh = useCallback(async () => {
    const conversationId = selected.current;
    const epoch = selectionEpoch.current;
    const request = ++latestRefresh.current;
    try {
      const next = parseSnapshot(
        await piRequest(
          `/api/state${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`,
        ),
      );
      let rows = next.conversations;
      if (!rows.length) {
        try {
          rows = parseConversations(record(await piRequest("/api/conversations")).conversations);
        } catch {
          /* Older hosts expose only their root conversation. */
        }
      }
      // Selection and request order, rather than arrival order, own the visible conversation.
      if (epoch !== selectionEpoch.current || request !== latestRefresh.current) return;
      if (conversationId && next.conversationId !== conversationId)
        throw Error("Pi returned a different conversation. Reconnect before sending a message.");
      if (!selected.current) {
        selected.current = next.conversationId;
        const url = new URL(location.href);
        url.searchParams.set("conversation", next.conversationId);
        history.replaceState({}, "", url);
        setSelectedId(next.conversationId);
      }
      setConversations(
        rows.length
          ? rows
          : [
              {
                id: next.conversationId,
                title: `Pi conversation ${next.conversationId}`,
                modelId: next.model,
                provider: "",
                running: next.running,
              },
            ],
      );
      setSnapshot(next);
      setConnectionError("");
    } catch (failure) {
      if (epoch === selectionEpoch.current && request === latestRefresh.current)
        setConnectionError(failure instanceof Error ? failure.message : "Cannot reach Pi.");
    }
  }, []);
  const selectConversation = (id: string) => {
    if (selected.current !== id) {
      selected.current = id;
      selectionEpoch.current++;
      const url = new URL(location.href);
      url.searchParams.set("conversation", id);
      history.pushState({}, "", url);
      setSelectedId(id);
      setSnapshot(null);
      setActionError("");
      setConnectionError("");
      void refresh();
    }
    setExtensionsOpen(false);
    setSidebarOpen(false);
  };
  useEffect(() => {
    const fromUrl = new URL(location.href).searchParams.get("conversation");
    if (fromUrl && /^[1-9]\d*$/.test(fromUrl)) {
      selected.current = fromUrl;
      setSelectedId(fromUrl);
    }
    const pop = () => {
      const id = new URL(location.href).searchParams.get("conversation");
      if (id && /^[1-9]\d*$/.test(id)) {
        selected.current = id;
        selectionEpoch.current++;
        setSelectedId(id);
        setSnapshot(null);
        void refresh();
      }
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [refresh]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("mars-live-theme");
    } catch {
      /* Browser storage is optional. */
    }
    if (saved === "dark" || saved === "light" || saved === "oled")
      document.documentElement.dataset.theme = saved;
  }, []);
  const action = useCallback(
    async (path: string, body: unknown = {}) => {
      const epoch = selectionEpoch.current;
      const conversationId = selected.current;
      const scoped = [
        "/api/chat",
        "/api/model",
        "/api/abort",
        "/api/trial",
        "/api/workers/stop",
        "/api/workflows/stop",
      ].includes(path);
      setPendingCount((count) => count + 1);
      setActionError("");
      try {
        const response = await piRequest(path, scoped ? { ...record(body), conversationId } : body);
        if (epoch === selectionEpoch.current) await refresh();
        return response;
      } catch (failure) {
        if (epoch === selectionEpoch.current)
          setActionError(
            failure instanceof Error ? failure.message : "The action failed. Try again.",
          );
        throw failure;
      } finally {
        setPendingCount((count) => count - 1);
      }
    },
    [refresh],
  );
  const safely = (operation: Promise<unknown>) => {
    void operation.catch(() => undefined);
  };
  const newConversation = async () => {
    const epoch = selectionEpoch.current;
    try {
      const [provider, ...modelParts] = snapshot?.model.includes("/")
        ? snapshot.model.split("/")
        : ["openai", snapshot?.model ?? ""];
      const modelId = modelParts.join("/");
      const created = parseCreatedConversation(
        await action("/api/conversations", modelId ? { provider, modelId } : {}),
      );
      setConversations((rows) =>
        rows.some((row) => row.id === created.id) ? rows : [...rows, created],
      );
      if (epoch === selectionEpoch.current) selectConversation(created.id);
    } catch (failure) {
      if (epoch === selectionEpoch.current)
        setActionError(
          failure instanceof Error ? failure.message : "Could not create a conversation.",
        );
    }
  };
  const onNew = async (message: AppendMessage) => {
    const conversationId = selected.current;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const attachmentIds = [
      ...new Set(
        (message.attachments ?? []).flatMap((attachment) =>
          attachment.content.flatMap((part) =>
            part.type === "image" &&
            typeof part.image === "string" &&
            /^\/api\/attachments\/[a-f0-9]{64}$/.test(part.image)
              ? [part.image.slice("/api/attachments/".length)]
              : [],
          ),
        ),
      ),
    ];
    if ((!text && !attachmentIds.length) || !snapshot || snapshot.conversationId !== conversationId)
      return;
    const deliveryKey = JSON.stringify([text, attachmentIds]);
    const previous = requestKeys.current.get(conversationId);
    const request =
      previous?.text === deliveryKey ? previous : { text: deliveryKey, id: crypto.randomUUID() };
    requestKeys.current.set(conversationId, request);
    try {
      await action("/api/chat", { text, attachmentIds, requestId: request.id });
      requestKeys.current.delete(conversationId);
    } catch {
      throw new MessageNotSentError(
        "Message delivery was not confirmed. Your text is kept for retry.",
      );
    }
  };
  const rootId = snapshot?.parentConversationId || snapshot?.conversationId;
  const children = snapshot?.subthreads.filter((child) => child.conversationId === rootId) ?? [];
  const childNavigation = children.map((child) => (
    <button
      key={child.id}
      type="button"
      className="live-nav live-subthread"
      aria-current={selectedId === child.id ? "page" : undefined}
      onClick={() => selectConversation(child.id)}
    >
      <span>↳ {child.title}</span>
      <small>{child.status}</small>
    </button>
  ));
  const connected = snapshot?.auth.connected === true;
  const canChat = snapshot?.providerReady ?? connected;
  const hasMessages = !!snapshot?.messages.length;
  const openSettings = (tab = "account") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setSidebarOpen(false);
  };
  return (
    <MotionConfig reducedMotion="user">
      <ConversationRuntime
        key={selectedId || "root"}
        snapshot={snapshot}
        onNew={onNew}
        onCancel={async () => {
          await action("/api/abort");
        }}
        draft={draft}
      >
        <div className="live-workspace">
          <aside className="live-sidebar" aria-label="Workspace navigation">
            <div className="live-brand">
              <a href="/" aria-label="Mars home">
                <MarsMark width={25} height={25} />
                <span>Mars</span>
              </a>
              <button
                type="button"
                className="live-icon live-mobile-close"
                aria-label="Close navigation"
                onClick={() => setSidebarOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <nav>
              <button
                type="button"
                className="live-nav"
                disabled={pending || !snapshot}
                onClick={() => safely(newConversation())}
              >
                <Plus size={16} />
                New chat
              </button>
              <button
                type="button"
                className={`live-nav ${!extensionsOpen ? "live-nav-selected" : ""}`}
                onClick={() => {
                  setExtensionsOpen(false);
                  setSidebarOpen(false);
                }}
              >
                <MessageSquare size={16} />
                Conversation
              </button>
              <button
                type="button"
                className={`live-nav ${extensionsOpen ? "live-nav-selected" : ""}`}
                onClick={() => {
                  setExtensionsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Wrench size={16} />
                Extensions
                {snapshot && snapshot.extensions.length > 0 && (
                  <span className="live-count">{snapshot.extensions.length}</span>
                )}
              </button>
            </nav>
            <div className="live-sidebar-history">
              <p>Conversations</p>
              {conversations.map((conversation) => (
                <div key={conversation.id}>
                  <button
                    type="button"
                    className="live-nav"
                    aria-current={selectedId === conversation.id ? "page" : undefined}
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <MessageSquare size={14} />
                    <span>{conversation.title}</span>
                    {conversation.running && (
                      <span className="live-conversation-running" aria-label="Running" />
                    )}
                  </button>
                  {conversation.id === rootId && childNavigation}
                </div>
              ))}
            </div>
            <button type="button" className="live-settings-button" onClick={() => openSettings()}>
              <Settings size={16} />
              <span>Settings</span>
              <span
                className={`live-connection-dot ${canChat ? "is-connected" : ""}`}
                aria-label={canChat ? "Model available" : "Model not connected"}
              />
            </button>
          </aside>
          <main className="live-main">
            <header className="live-header">
              <div>
                <button
                  type="button"
                  className="live-icon live-menu"
                  aria-label="Open navigation"
                  onClick={() => setSidebarOpen(true)}
                >
                  <Menu size={19} />
                </button>
                {snapshot?.parentConversationId && (
                  <button
                    className="live-text-button"
                    onClick={() => selectConversation(snapshot.parentConversationId)}
                  >
                    Back to parent
                  </button>
                )}
                <span>
                  {extensionsOpen ? "Extensions" : snapshot?.conversationTitle || "Pi workspace"}
                </span>
              </div>
              <button
                type="button"
                className="live-icon"
                aria-label="Open settings"
                onClick={() => openSettings()}
              >
                <Settings size={17} />
              </button>
            </header>
            {connectionError && (
              <div role="alert" className="live-notice">
                {connectionError}
                <button type="button" onClick={() => void refresh()}>
                  Reconnect
                </button>
              </div>
            )}
            {actionError && (
              <div role="alert" className="live-notice">
                {actionError}
                <button type="button" aria-label="Dismiss error" onClick={() => setActionError("")}>
                  <X size={14} />
                </button>
              </div>
            )}
            {extensionsOpen ? (
              <div className="live-extensions-page">
                <h1>Your extensions</h1>
                <p>Capabilities installed into this Pi agent, including their own interface.</p>
                <PluginManager
                  renderInterface={(name) => {
                    const extension = snapshot?.extensions.find((item) => item.name === name);
                    return extension &&
                      extension.enabled !== false &&
                      extension.uiEnabled !== false ? (
                      <ExtensionPanel extension={extension} />
                    ) : (
                      <p role="status">The interface is unavailable. Refresh after installation.</p>
                    );
                  }}
                />
              </div>
            ) : (
              <ThreadPrimitive.Root
                className={`live-thread ${!hasMessages ? "live-thread-empty" : ""}`}
              >
                <ThreadPrimitive.Viewport className="live-viewport">
                  <div className="live-transcript">
                    {!hasMessages && (
                      <div className="live-welcome">
                        <h1>
                          <MarsMark width={43} height={43} />
                          What shall we work on?
                        </h1>
                      </div>
                    )}
                    <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
                    {snapshot && (
                      <LiveWorkers
                        workers={snapshot.workers.filter(
                          (worker) => worker.conversationId === snapshot.conversationId,
                        )}
                        workflows={snapshot.workflows}
                        onOpen={selectConversation}
                        onStopWorkflow={(workflowId) =>
                          safely(action("/api/workflows/stop", { workflowId }))
                        }
                        usage={snapshot.usage}
                        pending={pending}
                        onStop={(workerId) => safely(action("/api/workers/stop", { workerId }))}
                      />
                    )}
                    {snapshot && (
                      <AgentActivity
                        workers={snapshot.workers.filter(
                          (worker) => worker.conversationId === snapshot.conversationId,
                        )}
                      />
                    )}
                    {snapshot?.running && (
                      <div className="live-working" role="status">
                        <StatusMark status="running" size={14} />
                        {snapshot.messages.some((message) =>
                          message.tools.some(
                            (tool) =>
                              tool.output === undefined ||
                              tool.state === "running" ||
                              tool.children?.some((child) => child.state === "running"),
                          ),
                        )
                          ? "Working"
                          : "Thinking"}
                      </div>
                    )}
                  </div>
                  <ThreadPrimitive.ViewportFooter className="live-composer-wrap">
                    <ComposerPrimitive.AttachmentDropzone disabled={!canChat || !snapshot}>
                      <ComposerPrimitive.Root className="live-composer">
                        <div className="live-image-drafts">
                          <ComposerPrimitive.Attachments
                            components={{ Attachment: LiveImageAttachment }}
                          />
                        </div>
                        <ComposerPrimitive.Input
                          aria-label="Message Mars"
                          placeholder={
                            canChat
                              ? "How can I help you today?"
                              : "Connect a model to start a conversation"
                          }
                          className="live-composer-input"
                          disabled={!snapshot || !canChat || pending || !!connectionError}
                          rows={2}
                          minRows={2}
                          maxRows={9}
                          submitMode="enter"
                          addAttachmentOnPaste={true}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing && event.key === "Enter")
                              event.stopPropagation();
                          }}
                        />
                        <div className="live-composer-toolbar">
                          <ComposerPrimitive.AddAttachment
                            className="live-icon"
                            aria-label="Attach images"
                            disabled={!snapshot || !canChat || pending}
                          >
                            <Plus size={17} />
                          </ComposerPrimitive.AddAttachment>
                          <button
                            type="button"
                            className="live-mode"
                            onClick={() => openSettings("connection")}
                          >
                            <PanelLeft size={14} />
                            Pi Durable
                          </button>
                          <div className="live-composer-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className="live-model"
                                  disabled={!snapshot || pending}
                                  aria-label="Choose model"
                                >
                                  {snapshot?.model || "Model"}
                                  <ChevronDown size={12} />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent side="top" align="end">
                                <DropdownMenuRadioGroup
                                  value={snapshot?.model || ""}
                                  onValueChange={(model) => safely(action("/api/model", { model }))}
                                >
                                  {snapshot?.models.map((model) => (
                                    <DropdownMenuRadioItem key={model.id} value={model.id}>
                                      {model.name}
                                    </DropdownMenuRadioItem>
                                  ))}
                                </DropdownMenuRadioGroup>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {snapshot?.running ? (
                              <ComposerPrimitive.Cancel
                                className="live-send"
                                aria-label="Stop response"
                              >
                                <Square size={15} fill="currentColor" />
                              </ComposerPrimitive.Cancel>
                            ) : (
                              <ComposerPrimitive.Send
                                className="live-send"
                                aria-label="Send message"
                                disabled={!snapshot || !canChat || pending || !!connectionError}
                              >
                                <ArrowUp size={18} />
                              </ComposerPrimitive.Send>
                            )}
                          </div>
                        </div>
                      </ComposerPrimitive.Root>
                    </ComposerPrimitive.AttachmentDropzone>
                    {!canChat && snapshot ? (
                      <p className="live-composer-footnote">
                        <button type="button" onClick={() => openSettings()}>
                          Connect a model in Settings
                        </button>{" "}
                        to start. Conversations stay in this workspace.
                      </p>
                    ) : (
                      <p className="live-composer-footnote">
                        {snapshot ? "Saved in this workspace" : "Connecting to Pi…"}
                      </p>
                    )}
                  </ThreadPrimitive.ViewportFooter>
                </ThreadPrimitive.Viewport>
              </ThreadPrimitive.Root>
            )}
          </main>
        </div>
        <Dialog open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <DialogContent className="live-mobile-nav" placement="left">
            <DialogHeader>
              <DialogTitle>Mars workspace</DialogTitle>
              <DialogDescription>Your conversations and installed extensions.</DialogDescription>
            </DialogHeader>
            <nav>
              <button
                type="button"
                className="live-nav"
                disabled={pending || !snapshot}
                onClick={() => safely(newConversation())}
              >
                <Plus size={16} />
                New chat
              </button>
              {conversations.map((conversation) => (
                <div key={conversation.id}>
                  <button
                    type="button"
                    className="live-nav"
                    key={conversation.id}
                    aria-current={selectedId === conversation.id ? "page" : undefined}
                    onClick={() => selectConversation(conversation.id)}
                  >
                    <MessageSquare size={16} />
                    <span>{conversation.title}</span>
                  </button>
                  {conversation.id === rootId && childNavigation}
                </div>
              ))}

              <button
                type="button"
                className="live-nav"
                onClick={() => {
                  setExtensionsOpen(false);
                  setSidebarOpen(false);
                }}
              >
                <MessageSquare size={16} />
                Conversation
              </button>
              <button
                type="button"
                className="live-nav"
                onClick={() => {
                  setExtensionsOpen(true);
                  setSidebarOpen(false);
                }}
              >
                <Wrench size={16} />
                Extensions
              </button>
              <button type="button" className="live-nav" onClick={() => openSettings()}>
                <Settings size={16} />
                Settings
              </button>
            </nav>
          </DialogContent>
        </Dialog>
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="live-settings">
            <DialogHeader>
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>Your account and workspace preferences.</DialogDescription>
            </DialogHeader>
            <Tabs value={settingsTab} onValueChange={setSettingsTab}>
              <TabsList>
                <TabsTrigger value="account">Account</TabsTrigger>
                <TabsTrigger value="appearance">Appearance</TabsTrigger>
                <TabsTrigger value="connection">Connection</TabsTrigger>
                <TabsTrigger value="apps">Apps</TabsTrigger>
              </TabsList>
              <TabsContent value="account">
                <h2>ChatGPT</h2>
                <p className="live-account-state">
                  {connected ? (
                    <>
                      <Check size={15} />
                      Connected
                    </>
                  ) : snapshot?.auth.state === "pending" ? (
                    "Waiting for sign-in"
                  ) : (
                    "Connect your account to chat with Pi."
                  )}
                </p>
                {snapshot?.auth.error && <p role="alert">{snapshot.auth.error}</p>}
                <Button
                  disabled={pending || snapshot?.auth.state === "pending"}
                  onClick={() => safely(action("/api/login"))}
                >
                  {connected ? "Reconnect ChatGPT" : "Sign in with ChatGPT"}
                </Button>
                {snapshot?.auth.url && snapshot.auth.state === "pending" && (
                  <div className="live-auth-flow">
                    <a href={snapshot.auth.url} target="_blank" rel="noopener noreferrer">
                      Continue to ChatGPT sign-in
                    </a>
                    {snapshot.auth.code && (
                      <p>
                        Pairing code: <code>{snapshot.auth.code}</code>
                      </p>
                    )}
                  </div>
                )}
                {snapshot?.auth.prompt && (
                  <form
                    className="live-callback"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const answer = callback;
                      setCallback("");
                      safely(action("/api/login-answer", { answer }));
                    }}
                  >
                    <label htmlFor="chatgpt-callback">Final callback URL</label>
                    <p>
                      If sign-in ends at a localhost address on your Mac, paste that full address
                      here. It goes directly to Pi and is not saved in this browser.
                    </p>
                    <Input
                      id="chatgpt-callback"
                      value={callback}
                      onChange={(event) => setCallback(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={snapshot.auth.prompt}
                      required
                    />
                    <Button type="submit" disabled={pending || !callback.trim()}>
                      Complete sign-in
                    </Button>
                  </form>
                )}
                <section aria-label="Claude account" className="mt-8">
                  <h2>Claude</h2>
                  <p className="live-account-state">
                    {snapshot?.anthropicAuth.connected ? (
                      <>
                        <Check size={15} />
                        Connected
                      </>
                    ) : snapshot?.anthropicAuth.state === "pending" ? (
                      "Waiting for Claude sign-in"
                    ) : (
                      "Connect your Claude account through Pi to use Anthropic models."
                    )}
                  </p>
                  {snapshot?.anthropicAuth.error && (
                    <p role="alert">{snapshot.anthropicAuth.error}</p>
                  )}
                  <Button
                    disabled={pending || !snapshot || snapshot.anthropicAuth.state === "pending"}
                    onClick={() => safely(action("/api/login", { provider: "anthropic" }))}
                  >
                    {snapshot?.anthropicAuth.connected ? "Reconnect Claude" : "Sign in with Claude"}
                  </Button>
                  {snapshot?.anthropicAuth.url && snapshot.anthropicAuth.state === "pending" && (
                    <div className="live-auth-flow">
                      <a
                        href={snapshot.anthropicAuth.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Continue to Claude sign-in
                      </a>
                    </div>
                  )}
                  {snapshot?.anthropicAuth.prompt && (
                    <form
                      className="live-callback"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const answer = claudeCode;
                        setClaudeCode("");
                        safely(
                          action("/api/login-answer", {
                            provider: "anthropic",
                            answer,
                          }),
                        );
                      }}
                    >
                      <label htmlFor="claude-code">Claude authorisation code</label>
                      <p>
                        After signing in, paste the code Claude gives you here. Pi stores the
                        account credentials on the host.
                      </p>
                      <Input
                        id="claude-code"
                        type="password"
                        value={claudeCode}
                        onChange={(event) => setClaudeCode(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={snapshot.anthropicAuth.prompt}
                        required
                      />
                      <Button type="submit" disabled={pending || !claudeCode.trim()}>
                        Complete Claude sign-in
                      </Button>
                    </form>
                  )}
                  {snapshot?.anthropicAuth.connected && (
                    <p>
                      Choose Claude Opus 5.5 from the conversation model menu to work on the UI.
                    </p>
                  )}
                </section>
              </TabsContent>
              <TabsContent value="apps">
                <ConnectionSettings />
              </TabsContent>
              <TabsContent value="appearance">
                <ThemeSettings />
              </TabsContent>
              <TabsContent value="connection">
                <h2>Pi host</h2>
                <dl className="live-connection-details">
                  <div>
                    <dt>Runtime</dt>
                    <dd>{snapshot?.runtime || "Connecting…"}</dd>
                  </div>
                  <div>
                    <dt>Conversation</dt>
                    <dd>{snapshot?.conversationId || "Unavailable"}</dd>
                  </div>
                  <div>
                    <dt>Connection</dt>
                    <dd>
                      {connectionError ? "Disconnected" : snapshot ? "Connected" : "Connecting"}
                    </dd>
                  </div>
                </dl>
                <p>
                  Closing this page leaves durable work running. Stop a response explicitly in the
                  conversation.
                </p>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
      </ConversationRuntime>
    </MotionConfig>
  );
}
