"use client";

import { ThreadPrimitive } from "@assistant-ui/react";
import { MarsMark } from "@/components/mars-mark";
import { AgentActivity } from "@/components/activity/activity-timeline";
import { LiveWorkers } from "@/components/activity/live-workers";
import { Composer } from "@/components/composer/composer";
import { UserMessage, AssistantMessage } from "./messages";
import { useWorkspace } from "@/components/workspace-context";
import type { LiveSnapshot } from "@/lib/pi/live-state";
import "./thread.css";

function hasRunningTool(snapshot: LiveSnapshot) {
  return snapshot.messages.some((message) =>
    message.tools.some(
      (tool) =>
        tool.output === undefined ||
        tool.state === "running" ||
        tool.children?.some((child) => child.state === "running"),
    ),
  );
}

export function ConversationView() {
  const { snapshot, pending, hasMessages, action, safely, selectConversation } = useWorkspace();
  const workers = snapshot
    ? snapshot.workers.filter((worker) => worker.conversationId === snapshot.conversationId)
    : [];
  // An empty chat keeps the greeting and composer together; usage alone has nothing to report yet.
  const showWorkers =
    !!snapshot && (hasMessages || workers.length > 0 || snapshot.workflows.length > 0);
  return (
    <ThreadPrimitive.Root className={`live-thread ${!hasMessages ? "live-thread-empty" : ""}`}>
      <ThreadPrimitive.Viewport className="live-viewport">
        <div className="live-transcript">
          {!hasMessages && (
            <div className="live-welcome">
              <h1>
                <MarsMark className="live-welcome-mark" />
                What shall we work on?
              </h1>
            </div>
          )}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {snapshot && showWorkers && (
            <LiveWorkers
              workers={workers}
              workflows={snapshot.workflows}
              onOpen={selectConversation}
              onStopWorkflow={(workflowId) => safely(action("/api/workflows/stop", { workflowId }))}
              usage={snapshot.usage}
              pending={pending}
              onStop={(workerId) => safely(action("/api/workers/stop", { workerId }))}
            />
          )}
          {snapshot && <AgentActivity workers={workers} />}
          {snapshot?.running && (
            <div className="live-working" role="status">
              <MarsMark className="live-working-mark" />
              {hasRunningTool(snapshot) ? "Working" : "Thinking"}
            </div>
          )}
        </div>
        <ThreadPrimitive.ViewportFooter className="live-composer-wrap">
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
