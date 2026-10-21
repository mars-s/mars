"use client";

import { useState, useSyncExternalStore } from "react";
import { WorkspaceContext, type Workspace } from "@/components/workspace-context";
import { WorkbenchPane } from "@/components/workbench/workbench";
import { WorkbenchProvider } from "@/components/workbench/workbench-context";
import type { TabTarget, WorkbenchState } from "@/components/workbench/workbench-state";
import { installSampleHost } from "./sample-host";

/**
 * Each workbench pane as it renders in the app: the real components, answered by an
 * in-page sample host (./sample-host.ts) so nothing reaches Pi. Data is illustrative.
 */
const SPECIMENS: { label: string; tab: TabTarget }[] = [
  { label: "New tab", tab: { kind: "launcher" } },
  { label: "Files", tab: { kind: "files", path: "README.md" } },
  { label: "Changes", tab: { kind: "changes", repo: "mars" } },
  { label: "Terminal", tab: { kind: "terminal" } },
  { label: "Side chat", tab: { kind: "side-chat", conversationId: "902" } },
  { label: "Page", tab: { kind: "page", name: "release-plan" } },
  // Frame navigation cannot be answered in-page, so the Browser specimen shows its
  // real chrome in the empty state; tests/workbench-browser-check.mjs shows it loaded.
  { label: "Browser", tab: { kind: "browser" } },
];

const noop = () => undefined;
const sampleWorkspace: Workspace = {
  snapshot: null,
  conversations: [
    { id: "901", title: "Tidy the Pi host deploy script", modelId: "", provider: "", running: false, sideChats: [] },
    { id: "902", title: "Name the release", modelId: "", provider: "", running: false, sideChats: [] },
  ],
  selectedId: "901",
  pending: false,
  connectionError: "",
  actionError: "",
  setActionError: noop,
  canChat: false,
  connected: true,
  hasMessages: false,
  rootId: undefined,
  extensionsOpen: false,
  setExtensionsOpen: noop,
  sidebarOpen: false,
  setSidebarOpen: noop,
  settingsOpen: false,
  setSettingsOpen: noop,
  settingsTab: "account",
  setSettingsTab: noop,
  refresh: async () => undefined,
  action: async () => undefined,
  safely: noop,
  newConversation: async () => undefined,
  selectConversation: noop,
  openSettings: noop,
};

// The sample host is installed once for the page, before any pane fetches.
let installed = false;
const subscribe = () => {
  if (!installed && typeof window !== "undefined") {
    installed = true;
    installSampleHost();
  }
  return noop;
};

function seed(tab: TabTarget): WorkbenchState {
  const id = `ds-${tab.kind}`;
  return { open: true, expanded: true, width: 560, tabs: [{ ...tab, id } as WorkbenchState["tabs"][number]], activeId: id };
}

export function WorkbenchSpecimen() {
  const ready = useSyncExternalStore(subscribe, () => installed, () => false);
  const [current, setCurrent] = useState(0);
  const specimen = SPECIMENS[current];
  return (
    <div className="ds-workbench-specimens">
      <div className="ds-workbench-picker" role="tablist" aria-label="Workbench panes">
        {SPECIMENS.map((item, index) => (
          <button
            key={item.label}
            type="button"
            role="tab"
            aria-selected={index === current}
            data-selected={index === current ? "" : undefined}
            onClick={() => setCurrent(index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="ds-workbench" role="tabpanel" aria-label={`${specimen.label} pane specimen`}>
        {ready && (
          <WorkspaceContext.Provider value={sampleWorkspace}>
            <WorkbenchProvider key={specimen.label} initial={seed(specimen.tab)} persist={false}>
              <div className="ds-workbench-stage">
                <WorkbenchPane />
              </div>
            </WorkbenchProvider>
          </WorkspaceContext.Provider>
        )}
      </div>
    </div>
  );
}
