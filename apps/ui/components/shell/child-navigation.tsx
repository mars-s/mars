"use client";

import { useWorkspace } from "@/components/workspace-context";

export function useChildNavigation() {
  const { snapshot, rootId, selectedId, selectConversation } = useWorkspace();
  const children = snapshot?.subthreads.filter((child) => child.conversationId === rootId) ?? [];
  return children.map((child) => (
    <button
      key={child.id}
      type="button"
      className="live-nav live-subthread"
      aria-current={selectedId === child.id ? "page" : undefined}
      onClick={() => selectConversation(child.id)}
    >
      <span>↳ {child.title}</span>
      <small>{child.status}</small>
    </button>
  ));
}
