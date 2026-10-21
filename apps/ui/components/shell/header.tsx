"use client";

import { ChevronLeft, CircleAlert, CloudOff, Menu, Plus, Settings, X } from "lucide-react";
import { useWorkspace } from "@/components/workspace-context";
import { useWorkbench } from "@/components/workbench/workbench-context";
import { problemTitle, useHostVersion } from "@/components/settings/host-version";
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
  const workbench = useWorkbench();
  const hostVersion = useHostVersion();
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
        {!extensionsOpen && (
          <button
            type="button"
            className="live-icon live-workbench-toggle"
            aria-label="Open workbench"
            aria-pressed={workbench.state.open}
            title="Open workbench (⌃⇧E)"
            data-open={workbench.state.open ? "" : undefined}
            onClick={() => workbench.dispatch({ type: workbench.state.open ? "close" : "open" })}
          >
            <Plus size={18} />
          </button>
        )}
        <button
          type="button"
          className="live-icon live-header-settings"
          aria-label="Open settings"
          onClick={() => openSettings()}
        >
          <Settings size={18} />
        </button>
      </header>
      {hostVersion?.problem && (
        <div role="status" className="live-notice">
          <CircleAlert size={16} />
          <p>{problemTitle(hostVersion.problem.status)}. The host may be running an older build.</p>
          <button type="button" className="live-notice-action" onClick={() => openSettings("connection")}>
            Details
          </button>
        </div>
      )}
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
