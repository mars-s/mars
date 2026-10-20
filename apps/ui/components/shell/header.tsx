"use client";

import { ChevronLeft, CircleAlert, CloudOff, Menu, Settings, X } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import "./shell.css";

export function WorkspaceHeader() {
  const {
    snapshot,
    connectionError,
    actionError,
    setActionError,
    extensionsOpen,
    setSidebarOpen,
    refresh,
    selectConversation,
    openSettings,
  } = useWorkspace();
  const parentId = snapshot?.parentConversationId;
  return (
    <>
      <header className="live-header">
        <button
          type="button"
          className="live-icon live-menu"
          aria-label="Open navigation"
          onClick={() => setSidebarOpen(true)}
        >
          <Menu size={20} />
        </button>
        {parentId && (
          <button type="button" className="live-back" onClick={() => selectConversation(parentId)}>
            <ChevronLeft size={16} />
            Back to parent
          </button>
        )}
        <span className="live-header-title">
          {extensionsOpen ? "Extensions" : snapshot?.conversationTitle || "Pi workspace"}
        </span>
        <button
          type="button"
          className="live-icon live-header-settings"
          aria-label="Open settings"
          onClick={() => openSettings()}
        >
          <Settings size={18} />
        </button>
      </header>
      {connectionError && (
        <div role="alert" className="live-notice">
          <CloudOff size={16} />
          <p>{connectionError}</p>
          <button type="button" className="live-notice-action" onClick={() => void refresh()}>
            Reconnect
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="live-notice">
          <CircleAlert size={16} />
          <p>{actionError}</p>
          <button
            type="button"
            className="live-icon live-notice-dismiss"
            aria-label="Dismiss error"
            onClick={() => setActionError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  );
}
