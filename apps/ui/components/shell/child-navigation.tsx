"use client";

import { useWorkspace } from "@/components/workspace-context";

// Pi reports raw run states; the sidebar shows them as quiet words.
const STATUS_TEXT: Record<string, string> = {
  running: "Working",
  started: "Working",
  pending: "Queued",
  scheduled: "Queued",
  stopping: "Stopping",
  completed: "Done",
  complete: "Done",
  failed: "Failed",
  aborted: "Stopped",
  terminal: "Ended",
};

function statusText(status: string) {
  return STATUS_TEXT[status] ?? status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

export function ChildNavigation() {
  const { snapshot, rootId, selectedId, extensionsOpen, selectConversation } = useWorkspace();
  const children = snapshot?.subthreads.filter((child) => child.conversationId === rootId) ?? [];
  // A child's own snapshot does not list its siblings, so keep the open child visible under its parent.
  if (snapshot?.parentConversationId && !children.some((child) => child.id === snapshot.conversationId))
    children.push({
      id: snapshot.conversationId,
      conversationId: snapshot.parentConversationId,
      title: snapshot.conversationTitle || `Subthread ${snapshot.conversationId}`,
      status: "",
      modelId: "",
      provider: "",
    });
  return children.map((child) => (
    <button
      key={child.id}
      type="button"
      className="live-nav live-subthread"
      aria-current={!extensionsOpen && selectedId === child.id ? "page" : undefined}
      onClick={() => selectConversation(child.id)}
    >
      <span className="live-nav-label">{child.title}</span>
      {child.status && <small>{statusText(child.status)}</small>}
    </button>
  ));
}
