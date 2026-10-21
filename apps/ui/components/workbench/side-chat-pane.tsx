"use client";

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessageNotSentError,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
} from "@assistant-ui/react";
import { ArrowUp, ChevronLeft, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useWorkspace } from "@/components/workspace-context";
import { AssistantMessage, UserMessage, convertMessage } from "@/components/thread/messages";
import { parseCreatedConversation, parseSnapshot, piRequest, type LiveMessage, type LiveSnapshot } from "@/lib/pi/live-state";
import { useWorkbench } from "./workbench-context";
import type { WorkbenchTab } from "./workbench-state";
import "./side-chat-pane.css";

type SideChatTab = Extract<WorkbenchTab, { kind: "side-chat" }>;
const POLL_MS = 1500;
const NO_MESSAGES: LiveMessage[] = [];
const messageOf = (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback);

/**
 * A second Pi conversation inside the workbench. It has its own assistant-ui runtime,
 * poll and composer, and never touches the main chat's selection, draft or scroll.
 */
export function SideChatPane({ tab }: { tab: SideChatTab }) {
  const { dispatch } = useWorkbench();
  const choose = (conversationId: string | undefined) => dispatch({ type: "update", id: tab.id, patch: { conversationId } });
  return tab.conversationId ? (
    <SideConversation key={tab.conversationId} conversationId={tab.conversationId} onChange={() => choose(undefined)} />
  ) : (
    <ConversationPicker onPick={choose} />
  );
}

function ConversationPicker({ onPick }: { onPick: (id: string) => void }) {
  const { conversations, selectedId, snapshot, refresh } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [problem, setProblem] = useState("");
  const create = async () => {
    setCreating(true);
    setProblem("");
    try {
      // Same model as the main chat, created directly so the main selection stays put.
      const model = snapshot?.model ?? "";
      const [provider, ...rest] = model.includes("/") ? model.split("/") : ["openai", model];
      const modelId = rest.join("/");
      // Nested under the chat in the main view (its parent, if that is itself a side chat).
      const parentId = snapshot?.sideChatOf || snapshot?.parentConversationId || selectedId;
      const created = parseCreatedConversation(
        await piRequest("/api/conversations", {
          title: "Side chat",
          ...(parentId ? { parentId } : {}),
          ...(modelId ? { provider, modelId } : {}),
        }),
      );
      void refresh();
      onPick(created.id);
    } catch (failure) {
      setProblem(messageOf(failure, "Could not create a conversation."));
      setCreating(false);
    }
  };
  return (
    <div className="wb-chat-pick">
      <header>
        <h2>Side chat</h2>
        <p className="wb-note">A second Pi conversation beside this one. The main chat stays where it is.</p>
      </header>
      <button type="button" className="wb-chat-new" onClick={() => void create()} disabled={creating}>
        <MessageSquarePlus size={16} aria-hidden="true" />
        {creating ? "Creating…" : "New side conversation"}
      </button>
      {problem && (
        <p className="wb-note wb-chat-problem" role="alert">
          {problem}
        </p>
      )}
      {conversations.length > 0 && (
        <section aria-labelledby="wb-chat-existing">
          <h3 id="wb-chat-existing">Or open an existing conversation</h3>
          <ul className="wb-chat-list">
            {conversations
              .flatMap((conversation) => [
                { ...conversation, side: false },
                ...conversation.sideChats.map((side) => ({ ...side, side: true })),
              ])
              .map((conversation) => {
                const main = conversation.id === selectedId;
                return (
                  <li key={conversation.id} data-side={conversation.side ? "" : undefined}>
                    <button type="button" onClick={() => onPick(conversation.id)} disabled={main} aria-describedby={main ? "wb-chat-main-note" : undefined}>
                      <MessagesSquare size={15} aria-hidden="true" />
                      <span>{conversation.side ? <span className="sr-only">Side chat: </span> : null}{conversation.title}</span>
                      {main ? <small id="wb-chat-main-note">Open in the chat</small> : conversation.running ? <small>Working</small> : null}
                    </button>
                  </li>
                );
              })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** True while `element` is laid out on screen and the document is visible. */
function useVisible(element: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let shown = false;
    const update = () => setVisible(shown && document.visibilityState === "visible");
    const observer = new IntersectionObserver(([entry]) => {
      shown = entry.isIntersecting;
      update();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [element]);
  return visible;
}

function SideConversation({ conversationId, onChange }: { conversationId: string; onChange: () => void }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const visible = useVisible(root);
  const latest = useRef(0);
  const request = useRef<{ key: string; id: string } | null>(null);

  const refresh = useCallback(async () => {
    const ticket = ++latest.current;
    try {
      const next = parseSnapshot(await piRequest(`/api/state?conversationId=${encodeURIComponent(conversationId)}`));
      if (ticket !== latest.current) return;
      if (next.conversationId !== conversationId) throw Error("Pi returned a different conversation for this side chat.");
      setSnapshot(next);
      setError("");
    } catch (failure) {
      if (ticket === latest.current) setError(messageOf(failure, "Cannot reach Pi."));
    }
  }, [conversationId]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [visible, refresh]);

  const onNew = async (message: AppendMessage) => {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text) return;
    // A retry of the same text reuses its requestId so Pi never runs it twice.
    const previous = request.current;
    const current = previous?.key === text ? previous : { key: text, id: crypto.randomUUID() };
    request.current = current;
    setSending(true);
    try {
      await piRequest("/api/chat", { conversationId, text, requestId: current.id });
      request.current = null;
      setError("");
    } catch (failure) {
      setError(messageOf(failure, "Message delivery was not confirmed."));
      throw new MessageNotSentError("Message delivery was not confirmed. Your text is kept for retry.");
    } finally {
      setSending(false);
      void refresh();
    }
  };
  const onCancel = async () => {
    try {
      await piRequest("/api/abort", { conversationId });
    } catch (failure) {
      setError(messageOf(failure, "Pi did not confirm the stop."));
    }
    void refresh();
  };

  const runtime = useExternalStoreRuntime({
    messages: snapshot?.messages ?? NO_MESSAGES,
    convertMessage,
    isRunning: snapshot?.running ?? false,
    onNew,
    onCancel,
  });
  const canChat = !!snapshot && snapshot.providerReady && !sending;
  const model = snapshot?.models.find((item) => item.id === snapshot.model);
  return (
    <div className="wb-chat" ref={root}>
      <header className="wb-chat-head">
        <button type="button" className="wb-icon" aria-label="Choose another conversation" title="Choose another conversation" onClick={onChange}>
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className="wb-chat-heading">
          <h2>{snapshot?.conversationTitle || `Conversation ${conversationId}`}</h2>
          <small>
            {!snapshot ? "Connecting to Pi…" : snapshot.running ? `${model?.name ?? "Pi"} is working` : `${model?.name ?? snapshot.model} on Pi`}
          </small>
        </div>
      </header>
      {error && (
        <p className="wb-note wb-chat-problem" role="alert">
          {error}
        </p>
      )}
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="wb-chat-thread">
          <ThreadPrimitive.Viewport className="wb-chat-viewport">
            {snapshot && !snapshot.messages.length && <p className="wb-note wb-chat-empty">No messages yet. Ask Pi something on the side.</p>}
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>
          <SideComposer blocked={!canChat} notice={snapshot && !snapshot.providerReady ? "Connect a model in Settings to use the side chat." : ""} />
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </div>
  );
}

function SideComposer({ blocked, notice }: { blocked: boolean; notice: string }) {
  const running = useAuiState((state) => state.thread.isRunning);
  const hasText = useAuiState((state) => state.composer.text.trim().length > 0);
  return (
    <ComposerPrimitive.Root className="wb-chat-composer">
      {notice && <p className="wb-note">{notice}</p>}
      <div className="wb-chat-box">
        <ComposerPrimitive.Input
          aria-label="Message side chat"
          placeholder={running ? "Replying… keep typing, or press Stop" : "Reply in the side chat"}
          className="wb-chat-input"
          disabled={blocked}
          rows={1}
          minRows={1}
          maxRows={6}
          submitMode="enter"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing && event.key === "Enter") event.stopPropagation();
          }}
        />
        {running ? (
          <ComposerPrimitive.Cancel className="wb-chat-send" data-ready="" aria-label="Stop side chat">
            <span className="wb-chat-stop" aria-hidden="true" />
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send className="wb-chat-send" data-ready={hasText && !blocked ? "" : undefined} aria-label="Send to side chat" disabled={blocked}>
            <ArrowUp size={15} strokeWidth={2.25} aria-hidden="true" />
          </ComposerPrimitive.Send>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
}
