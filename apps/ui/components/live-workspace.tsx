"use client";

import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  useExternalStoreRuntime,
  type AppendMessage,
  type Attachment,
  type AttachmentAdapter,
  type ExternalThreadQueueAdapter,
  type QueueItemState,
} from "@assistant-ui/react";
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  parseSnapshot,
  parseConversations,
  parseCreatedConversation,
  piRequest,
  record,
  type ConversationSummary,
  type LiveMessage,
  type LiveSnapshot,
  type QueuedMessage,
} from "@/lib/pi/live-state";
import { createImageAdapter } from "@/lib/pi/image-attachments";
import { resolveImageChips } from "@/lib/pi/image-chips";
import "./shared.css";
import { WorkspaceContext, type ConversationChange, type Workspace } from "./workspace-context";
import { Sidebar } from "./shell/sidebar";
import { MobileNav } from "./shell/mobile-nav";
import { WorkspaceHeader } from "./shell/header";
import { ConversationView } from "./thread/conversation-view";
import { convertMessage } from "./thread/messages";
import { ExtensionsPage } from "./settings/extensions-page";
import { DuetView } from "./duet/duet-view";
import { SettingsDialog } from "./settings/settings-dialog";
import { useWorkbenchSheet, WorkbenchProvider } from "./workbench/workbench-context";
import { WorkbenchPane } from "./workbench/workbench";

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
const queueItem = (message: QueuedMessage): QueueItemState => ({
  id: message.id,
  prompt: message.text,
  parts: [{ type: "text", text: message.text || (message.images ? "Image" : "") }],
});
function ConversationRuntime({
  snapshot,
  onNew,
  onCancel,
  onQueue,
  draft,
  children,
}: {
  snapshot: LiveSnapshot | null;
  onNew: (message: AppendMessage, mode?: "queue" | "steer") => Promise<void>;
  onCancel: () => Promise<void>;
  onQueue: (submissionId: string, change: "steer" | "remove") => Promise<void>;
  draft: ConversationDraft;
  children: ReactNode;
}) {
  // Pi's inbox is the queue (docs: apps/ui/docs/FULL-CONTROL.md "Queue and steer"). This adapter
  // only lets the composer send while a reply runs and shows what Pi has queued; it keeps no copy.
  const queued = snapshot?.queue;
  const restore = useRef<(message: AppendMessage) => void>(() => {});
  const queue = useMemo<ExternalThreadQueueAdapter>(() => {
    const deliver = (message: AppendMessage, mode?: "queue" | "steer") =>
      void onNew(message, mode).catch(() => restore.current(message));
    return {
      items: (queued ?? []).filter((item) => item.mode === "queue").map(queueItem),
      steerItems: (queued ?? []).filter((item) => item.mode === "steer").map(queueItem),
      enqueue: (message) => deliver(message),
      // assistant-ui sends here whenever a reply runs; only an explicit steer interrupts.
      steer: (message) => deliver(message, message.steer === true ? "steer" : "queue"),
      move: (id, placement) => {
        if (placement.lane === "steer") void onQueue(id, "steer").catch(() => undefined);
      },
      edit: () => {},
      remove: (id) => void onQueue(id, "remove").catch(() => undefined),
    };
  }, [queued, onNew, onQueue]);
  const runtime = useExternalStoreRuntime({
    adapters: { attachments: draft.adapter },
    messages: snapshot?.messages ?? EMPTY_MESSAGES,
    convertMessage,
    isRunning: snapshot?.running ?? false,
    onNew,
    onCancel,
    // Only while a reply runs: an idle send keeps assistant-ui's own retry, which restores
    // both the text and the images of a message the host did not confirm.
    queue: snapshot?.running ? queue : undefined,
  });
  // A message the host did not accept goes back into an empty composer so it is not lost.
  restore.current = (message) => {
    const composer = runtime.thread.composer;
    if (composer.getState().text.trim()) return;
    composer.setText(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  };
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
/** The chat column; inert while the phone workbench sheet covers it. */
function StageMain({ children }: { children: ReactNode }) {
  return (
    <main className="live-main" inert={useWorkbenchSheet()}>
      {children}
    </main>
  );
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
  const [duetOpen, setDuetOpenState] = useState(false);
  /** Duet has its own address, ?view=duet, so it can be bookmarked on a phone. */
  const setDuetOpen = useCallback((open: boolean) => {
    setDuetOpenState(open);
    const url = new URL(location.href);
    if (open === (url.searchParams.get("view") === "duet")) return;
    if (open) url.searchParams.set("view", "duet");
    else url.searchParams.delete("view");
    history.replaceState({}, "", url);
  }, []);
  useEffect(() => {
    if (new URL(location.href).searchParams.get("view") === "duet") setDuetOpenState(true);
  }, []);
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
                sideChats: [],
                sideChatTotal: 0,
                group: "",
                archived: false,
                pinned: false,
                channel: "",
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
    setDuetOpen(false);
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
    if (saved === "dark" || saved === "light" || saved === "oled" || saved === "cyberpunk")
      document.documentElement.dataset.theme = saved;
  }, []);
  const action = useCallback(
    async (path: string, body: unknown = {}) => {
      const epoch = selectionEpoch.current;
      const conversationId = selected.current;
      const scoped = [
        "/api/chat",
        "/api/model",
        "/api/effort",
        "/api/abort",
        "/api/compact",
        "/api/trial",
        "/api/workers/stop",
        "/api/workflows/stop",
        "/api/queue/steer",
        "/api/queue/remove",
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
      // With a default model set in Settings, the host starts the chat on it; otherwise the new
      // chat copies the current model and effort (the host clamps the effort).
      const thinking = snapshot?.thinkingLevel || undefined;
      const created = parseCreatedConversation(
        await action(
          "/api/conversations",
          snapshot?.modelSettings.defaultModel ? {} : modelId ? { provider, modelId, thinking } : { thinking },
        ),
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
  /** Rename, regroup, pin or archive a top-level chat. Rows update at once and the host confirms. */
  const organiseConversation = async (id: string, change: ConversationChange) => {
    const before = conversations;
    setConversations((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              ...(change.title !== undefined ? { title: change.title.trim() || row.title } : {}),
              ...(change.group !== undefined ? { group: change.group.trim() } : {}),
              ...(change.archived !== undefined ? { archived: change.archived } : {}),
              ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
            }
          : row.sideChats.some((side) => side.id === id)
            ? {
                ...row,
                sideChats: row.sideChats.map((side) =>
                  side.id === id
                    ? {
                        ...side,
                        ...(change.title !== undefined ? { title: change.title.trim() || side.title } : {}),
                        ...(change.archived !== undefined ? { archived: change.archived } : {}),
                      }
                    : side,
                ),
              }
            : row,
      ),
    );
    try {
      await action("/api/conversations/organise", { conversationId: id, ...change });
    } catch {
      setConversations(before);
    }
  };
  const onNew = async (message: AppendMessage, mode?: "queue" | "steer") => {
    const conversationId = selected.current;
    const hostIdOf = (attachment: NonNullable<AppendMessage["attachments"]>[number]) =>
      attachment.content.flatMap((part) =>
        part.type === "image" &&
        typeof part.image === "string" &&
        /^\/api\/attachments\/[a-f0-9]{64}$/.test(part.image)
          ? [part.image.slice("/api/attachments/".length)]
          : [],
      )[0];
    // Image chips in the text name the draft attachment; the host knows the uploaded one.
    const hostIds = new Map(
      (message.attachments ?? []).flatMap((attachment) => {
        const id = hostIdOf(attachment);
        return id ? [[attachment.id, id] as const] : [];
      }),
    );
    const text = resolveImageChips(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim(),
      hostIds,
    );
    const attachmentIds = [...new Set(hostIds.values())];
    if ((!text && !attachmentIds.length) || !snapshot || snapshot.conversationId !== conversationId)
      return;
    const deliveryKey = JSON.stringify([text, attachmentIds]);
    const previous = requestKeys.current.get(conversationId);
    const request =
      previous?.text === deliveryKey ? previous : { text: deliveryKey, id: crypto.randomUUID() };
    requestKeys.current.set(conversationId, request);
    try {
      await action("/api/chat", { text, attachmentIds, requestId: request.id, ...(mode ? { mode } : {}) });
      requestKeys.current.delete(conversationId);
    } catch {
      throw new MessageNotSentError(
        "Message delivery was not confirmed. Your text is kept for retry.",
      );
    }
  };
  const rootId = snapshot?.parentConversationId || snapshot?.conversationId;
  const connected = snapshot?.auth.connected === true;
  const canChat = snapshot?.providerReady ?? connected;
  const hasMessages = !!snapshot?.messages.length;
  const openSettings = (tab = "account") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setSidebarOpen(false);
  };
  const workspace: Workspace = {
    snapshot,
    conversations,
    selectedId,
    pending,
    connectionError,
    actionError,
    setActionError,
    canChat,
    connected,
    hasMessages,
    rootId,
    extensionsOpen,
    setExtensionsOpen,
    duetOpen,
    setDuetOpen,
    sidebarOpen,
    setSidebarOpen,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    setSettingsTab,
    refresh,
    action,
    safely,
    newConversation,
    selectConversation,
    organiseConversation,
    openSettings,
  };
  return (
    <MotionConfig reducedMotion="user">
      <WorkspaceContext.Provider value={workspace}>
        <div className="live-workspace">
          <Sidebar />
          <WorkbenchProvider>
            <div className="live-stage">
              {/* Only the main chat is keyed by conversation, so switching chats never remounts the workbench. */}
              <ConversationRuntime
                key={selectedId || "root"}
                snapshot={snapshot}
                onNew={onNew}
                onQueue={async (submissionId, change) => {
                  await action(`/api/queue/${change}`, { submissionId });
                }}
                onCancel={async () => {
                  await action("/api/abort");
                }}
                draft={draft}
              >
                <StageMain>
                  <WorkspaceHeader />
                  {duetOpen ? <DuetView /> : extensionsOpen ? <ExtensionsPage /> : <ConversationView />}
                </StageMain>
              </ConversationRuntime>
              {!extensionsOpen && !duetOpen && <WorkbenchPane />}
            </div>
          </WorkbenchProvider>
        </div>
        <MobileNav />
        <SettingsDialog />
      </WorkspaceContext.Provider>
    </MotionConfig>
  );
}
