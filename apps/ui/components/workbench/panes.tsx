"use client";

import type { WorkbenchTab } from "./workbench-state";
import { TerminalPane } from "./terminal-pane";
import { toolTitle } from "./tools";
import { FilesPane } from "./files-pane";
import { ChangesPane } from "./changes-pane";
import { PagePane } from "./page-pane";
import { SideChatPane } from "./side-chat-pane";
// One import and one case per lane; each lane owns its pane file.

/** Routes a tab to its pane. A tool without a pane says so plainly. */
export function PaneFor({ tab }: { tab: WorkbenchTab }) {
  switch (tab.kind) {
    case "files":
      return <FilesPane tab={tab} />;
    case "changes":
      return <ChangesPane tab={tab} />;
    case "page":
      return <PagePane tab={tab} />;
    case "side-chat":
      return <SideChatPane tab={tab} />;
    case "terminal":
      return <TerminalPane tab={tab} />;
    // lane: browser  -> case "browser": return <BrowserPane tab={tab} />;
    default:
      return (
        <div className="wb-empty" role="status">
          <p>{toolTitle(tab.kind)} is not available in this build yet.</p>
        </div>
      );
  }
}
