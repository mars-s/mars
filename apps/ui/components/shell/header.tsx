"use client";

import { Menu, Settings, X } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import "./shell.css";

export function WorkspaceHeader() {
  const { snapshot, connectionError, actionError, setActionError, extensionsOpen, setSidebarOpen, refresh, selectConversation, openSettings } = useWorkspace();
  return (
    <>
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
    </>
  );
}
