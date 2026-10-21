"use client";

import { useId } from "react";
import { Blocks, MessageSquare, MessageSquareDashed, PanelLeft, Plus, X } from "lucide-react";
import { MarsMark } from "@/components/mars-mark";
import { useWorkspace } from "@/components/workspace-context";
import { ChannelMark } from "./channel-mark";
import { ChildNavigation } from "./child-navigation";
import { setSidebarCollapsed } from "./sidebar-collapse";

/** The navigation shared by the desktop sidebar and the mobile drawer, so both keep one order. */
export function SidebarContent({ collapsed = false, drawer = false }: { collapsed?: boolean; drawer?: boolean }) {
  const {
    snapshot,
    conversations,
    selectedId,
    pending,
    canChat,
    rootId,
    extensionsOpen,
    setExtensionsOpen,
    setSidebarOpen,
    safely,
    newConversation,
    selectConversation,
    openSettings,
  } = useWorkspace();
  const accountId = useId();
  const hint = (label: string) => (collapsed ? label : undefined);
  const show = (extensions: boolean) => {
    setExtensionsOpen(extensions);
    setSidebarOpen(false);
  };
  const extensionCount = snapshot?.extensions.length ?? 0;
  const readiness = !snapshot ? "Connecting" : canChat ? "Model ready" : "Model not connected";
  return (
    <>
      <div className="live-brand">
        <span className="live-brand-name">
          <MarsMark width={22} height={22} />
          <span>Mars</span>
        </span>
        {drawer ? (
          <button
            type="button"
            className="live-icon"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="live-icon live-sidebar-toggle"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed(!collapsed)}
          >
            <PanelLeft size={18} />
          </button>
        )}
      </div>
      <nav className="live-sidebar-primary" aria-label="Workspace">
        <button
          type="button"
          className="live-nav live-new-chat"
          title={hint("New chat")}
          disabled={pending || !snapshot}
          onClick={() => safely(newConversation())}
        >
          <span className="live-new-chat-icon">
            <Plus size={14} strokeWidth={2.25} />
          </span>
          <span className="live-nav-label">New chat</span>
        </button>
        <button type="button" className="live-nav" title={hint("Chats")} onClick={() => show(false)}>
          <MessageSquare size={16} />
          <span className="live-nav-label">Chats</span>
        </button>
        <button
          type="button"
          className={`live-nav ${extensionsOpen ? "live-nav-selected" : ""}`}
          aria-current={extensionsOpen ? "page" : undefined}
          title={hint("Extensions")}
          onClick={() => show(true)}
        >
          <Blocks size={16} />
          <span className="live-nav-label">Extensions</span>
          {extensionCount > 0 && <span className="live-count">{extensionCount}</span>}
        </button>
      </nav>
      <div className="live-sidebar-history">
        {conversations.length > 0 && <p className="live-section-label">Recents</p>}
        {conversations.map((conversation) => (
          <div key={conversation.id}>
            <button
              type="button"
              className="live-nav live-conversation"
              aria-current={!extensionsOpen && selectedId === conversation.id ? "page" : undefined}
              onClick={() => selectConversation(conversation.id)}
            >
              <span className="live-nav-label">{conversation.title}</span>
              {conversation.channel && <ChannelMark channel={conversation.channel} label />}
              {conversation.running && (
                <>
                  <span className="live-running-dot" aria-hidden="true" />
                  <span className="sr-only">Running</span>
                </>
              )}
            </button>
            {conversation.id === rootId && <ChildNavigation />}
            <SideChats parentId={conversation.id} sideChats={conversation.sideChats} total={conversation.sideChatTotal} />
          </div>
        ))}
      </div>
      <button
        type="button"
        className="live-nav live-account"
        aria-label="Open settings"
        aria-describedby={accountId}
        title={hint(`Pi workspace, ${readiness}`)}
        onClick={() => openSettings()}
      >
        <span className="live-avatar" aria-hidden="true">
          P
          <span className={`live-connection-dot ${canChat ? "is-connected" : ""}`} />
        </span>
        <span className="live-nav-label live-account-text" id={accountId}>
          <span>Pi workspace</span>
          <small>{readiness}</small>
        </span>
      </button>
    </>
  );
}

/**
 * Side chats nested under the conversation they were opened from (docs/WORKBENCH.md).
 * The open side chat stays listed even before the next conversations refresh.
 */
function SideChats({
  parentId,
  sideChats,
  total,
}: {
  parentId: string;
  sideChats: { id: string; title: string; running: boolean }[];
  total: number;
}) {
  const { snapshot, selectedId, extensionsOpen, selectConversation } = useWorkspace();
  const rows = [...sideChats];
  if (snapshot?.sideChatOf === parentId && !rows.some((row) => row.id === snapshot.conversationId))
    rows.unshift({ id: snapshot.conversationId, title: snapshot.conversationTitle || "Side chat", running: snapshot.running });
  if (!rows.length) return null;
  return (
    <ul className="live-side-chats" aria-label="Side chats">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="live-nav live-subthread live-side-chat"
            aria-current={!extensionsOpen && selectedId === row.id ? "page" : undefined}
            onClick={() => selectConversation(row.id)}
          >
            <MessageSquareDashed size={13} aria-hidden="true" className="live-side-chat-icon" />
            <span className="live-nav-label">{row.title}</span>
            {row.running && (
              <>
                <span className="live-running-dot" aria-hidden="true" />
                <span className="sr-only">Running</span>
              </>
            )}
          </button>
        </li>
      ))}
      {total > rows.length && (
        <li className="live-side-chat-more">
          {total - rows.length} older side {total - rows.length === 1 ? "chat" : "chats"} (ask Mars to list them)
        </li>
      )}
    </ul>
  );
}
