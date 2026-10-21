"use client";

import { createContext, useContext } from "react";
import type { ConversationSummary, LiveSnapshot } from "@/lib/pi/live-state";

/**
 * The live workspace controller owns Pi state and every server action. Presentation
 * components read it here instead of receiving props through each layer.
 */
/** A change to how a chat is filed. Only the given fields change; group "" means ungrouped. */
export type ConversationChange = { title?: string; group?: string; archived?: boolean };

export type Workspace = {
  snapshot: LiveSnapshot | null;
  conversations: ConversationSummary[];
  selectedId: string;
  pending: boolean;
  connectionError: string;
  actionError: string;
  setActionError: (message: string) => void;
  canChat: boolean;
  connected: boolean;
  hasMessages: boolean;
  rootId: string | undefined;
  extensionsOpen: boolean;
  setExtensionsOpen: (open: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  settingsTab: string;
  setSettingsTab: (tab: string) => void;
  refresh: () => Promise<void>;
  action: (path: string, body?: unknown) => Promise<unknown>;
  safely: (operation: Promise<unknown>) => void;
  newConversation: () => Promise<void>;
  selectConversation: (id: string) => void;
  organiseConversation: (id: string, change: ConversationChange) => Promise<void>;
  openSettings: (tab?: string) => void;
};

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw Error("useWorkspace must be used inside the live workspace.");
  return workspace;
}
