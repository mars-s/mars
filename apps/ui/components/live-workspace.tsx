"use client";

import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  useExternalStoreRuntime,
  type AppendMessage,
  type Attachment,
  type AttachmentAdapter,
} from "@assistant-ui/react";
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { createImageAdapter } from "@/lib/pi/image-attachments";
import "./shared.css";
import { WorkspaceContext, type Workspace } from "./workspace-context";
import { Sidebar } from "./shell/sidebar";
import { MobileNav } from "./shell/mobile-nav";
import { WorkspaceHeader } from "./shell/header";
import { ConversationView } from "./thread/conversation-view";
import { convertMessage } from "./thread/messages";
import { ExtensionsPage } from "./settings/extensions-page";
import { SettingsDialog } from "./settings/settings-dialog";
import { WorkbenchProvider } from "./workbench/workbench-context";
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
        "/api/effort",
        "/api/abort",
        "/api/compact",
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
    openSettings,
  };
  return (
    <MotionConfig reducedMotion="user">
      <WorkspaceContext.Provider value={workspace}>
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
          <Sidebar />
          <WorkbenchProvider>
            <div className="live-stage">
              <main className="live-main">
                <WorkspaceHeader />
                {extensionsOpen ? <ExtensionsPage /> : <ConversationView />}
              </main>
              {!extensionsOpen && <WorkbenchPane />}
            </div>
          </WorkbenchProvider>
        </div>
        <MobileNav />
        <SettingsDialog />
      </ConversationRuntime>
      </WorkspaceContext.Provider>
    </MotionConfig>
  );
}
