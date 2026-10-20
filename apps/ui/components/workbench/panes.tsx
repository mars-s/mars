"use client";

import type { WorkbenchTab } from "./workbench-state";
import { toolTitle } from "./tools";
import { FilesPane } from "./files-pane";
import { ChangesPane } from "./changes-pane";
// One import and one case per lane; each lane owns its pane file.

/** Routes a tab to its pane. A tool without a pane says so plainly. */
export function PaneFor({ tab }: { tab: WorkbenchTab }) {
  switch (tab.kind) {
    case "files":
      return <FilesPane tab={tab} />;
    case "changes":
      return <ChangesPane tab={tab} />;
    // lane: pages    -> case "page": return <PagePane tab={tab} />;
    // lane: terminal -> case "terminal": return <TerminalPane tab={tab} />;
    // lane: browser  -> case "browser": return <BrowserPane tab={tab} />;
    default:
      return (
        <div className="wb-empty" role="status">
          <p>{toolTitle(tab.kind)} is not available in this build yet.</p>
        </div>
      );
  }
}
