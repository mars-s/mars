"use client";

import type { WorkbenchTab } from "./workbench-state";
import { toolTitle } from "./tools";

/**
 * Routes a tab to its pane. Each tool phase replaces its case with the real pane;
 * until then the tab states plainly that the pane is not built.
 */
export function PaneFor({ tab }: { tab: WorkbenchTab }) {
  return (
    <div className="wb-empty" role="status">
      <p>{toolTitle(tab.kind)} is not available in this build yet.</p>
    </div>
  );
}
