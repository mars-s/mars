"use client";

import { ThreadPrimitive } from "@assistant-ui/react";
import { MarsMark } from "@/components/mars-mark";
import { AgentActivity } from "@/components/activity/activity-timeline";
import { LiveWorkers } from "@/components/activity/live-workers";
import { Composer } from "@/components/composer/composer";
import { UserMessage, AssistantMessage } from "./messages";
import { useWorkspace } from "@/components/workspace-context";
import { PlanCard } from "@/components/ai/plan-card";
import { RunProgress } from "@/components/ai/run-progress";
import { runSteps } from "@/components/ai/run-steps";
import { toolViews } from "@/components/ai/tool-adapter";
import "./thread.css";

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
          <PlanCard plan={snapshot?.plan ?? null} running={!!snapshot?.running} />
          {snapshot && <AgentActivity workers={workers} />}
          <RunProgress steps={runSteps(snapshot, toolViews)} />
        </div>
        <ThreadPrimitive.ViewportFooter className="live-composer-wrap">
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
