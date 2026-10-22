"use client";

import { useId } from "react";
import { Blocks, MessageSquare, PanelLeft, Plus, X } from "lucide-react";
import { MarsMark } from "@/components/mars-mark";
import { useWorkspace } from "@/components/workspace-context";
import { ConversationList } from "./conversation-list";
import { setSidebarCollapsed } from "./sidebar-collapse";

/** The navigation shared by the desktop sidebar and the mobile drawer, so both keep one order. */
export function SidebarContent({ collapsed = false, drawer = false }: { collapsed?: boolean; drawer?: boolean }) {
  const {
    snapshot,
    pending,
    canChat,
    extensionsOpen,
    setExtensionsOpen,
    setSidebarOpen,
    safely,
    newConversation,
    openSettings,
  } = useWorkspace();
  const accountId = useId();
  const hint = (label: string) => (collapsed ? label : undefined);
  const show = (extensions: boolean) => {
    setExtensionsOpen(extensions);
    setSidebarOpen(false);
  };
  const extensionCount = snapshot?.extensions.length ?? 0;
  const updateReady = snapshot?.update.state === "fast_forward" || snapshot?.update.state === "merge";
  const readiness = !snapshot
    ? "Connecting"
    : snapshot.update.state === "updating"
      ? "Updating Mars"
      : updateReady
        ? "Update available"
        : canChat
          ? "Model ready"
          : "Model not connected";
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
        <ConversationList />
      </div>
      <button
        type="button"
        className="live-nav live-account"
        aria-label="Open settings"
        aria-describedby={accountId}
        title={hint(`Pi workspace, ${readiness}`)}
        onClick={() => openSettings(updateReady || snapshot?.update.state === "updating" ? "updates" : undefined)}
      >
        <span className="live-avatar" aria-hidden="true">
          P
          <span className={`live-connection-dot ${canChat ? "is-connected" : ""}`} />
        </span>
        <span className="live-nav-label live-account-text" id={accountId}>
          <span>Pi workspace</span>
          <small data-update={updateReady || snapshot?.update.state === "updating" ? "" : undefined}>{readiness}</small>
        </span>
      </button>
    </>
  );
}
