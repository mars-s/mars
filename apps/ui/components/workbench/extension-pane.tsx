"use client";

import { ExtensionPanel } from "@/components/settings/extensions-page";
import { useWorkspace } from "@/components/workspace-context";
import type { WorkbenchTab } from "./workbench-state";

/**
 * An installed extension's UI in its own workbench tab, mounted exactly as the
 * Extensions page mounts it. An extension that is disabled or removed since the tab
 * was opened says so instead of loading.
 */
export function ExtensionPane({ tab }: { tab: Extract<WorkbenchTab, { kind: "extension" }> }) {
  const { snapshot } = useWorkspace();
  const installed = snapshot?.extensions.find((item) => item.hash === tab.hash);
  if (snapshot && (!installed || installed.enabled === false || installed.uiEnabled === false))
    return (
      <div className="wb-empty" role="status">
        <p>{tab.title} is no longer installed with an interface. Turn it on in Extensions to open it here.</p>
      </div>
    );
  return (
    <div className="wb-extension">
      <ExtensionPanel extension={{ hash: tab.hash, title: installed?.title ?? tab.title }} />
    </div>
  );
}
