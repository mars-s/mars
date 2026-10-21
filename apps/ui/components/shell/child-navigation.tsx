"use client";

import { useWorkspace } from "@/components/workspace-context";
import { NestedList } from "./conversation-list";

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

/** Sub-threads (helper conversations) of the open chat, archivable like side chats. */
export function ChildNavigation() {
  const { snapshot, rootId } = useWorkspace();
  const children = snapshot?.subthreads.filter((child) => child.conversationId === rootId) ?? [];
  // A child's own snapshot does not list its siblings, so keep the open child visible under its
  // parent. A side chat is not a sub-thread: it is already listed with the side chats.
  if (
    snapshot?.parentConversationId &&
    !snapshot.sideChatOf &&
    !children.some((child) => child.id === snapshot.conversationId)
  )
    children.push({
      id: snapshot.conversationId,
      conversationId: snapshot.parentConversationId,
      title: snapshot.conversationTitle || `Subthread ${snapshot.conversationId}`,
      status: "",
      modelId: "",
      provider: "",
      archived: false,
    });
  return (
    <NestedList
      label="Sub-threads"
      rows={children.map((child) => ({
        id: child.id,
        title: child.title,
        archived: child.archived,
        status: child.status ? statusText(child.status) : "",
      }))}
    />
  );
}
