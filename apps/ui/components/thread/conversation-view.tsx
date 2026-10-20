"use client";

import { ThreadPrimitive } from "@assistant-ui/react";
import { MarsMark } from "@/components/mars-mark";
import StatusMark from "@/components/react-bits/StatusMark";
import { AgentActivity } from "@/components/activity/activity-timeline";
import { LiveWorkers } from "@/components/activity/live-workers";
import { Composer } from "@/components/composer/composer";
import { UserMessage, AssistantMessage } from "./messages";
import { useWorkspace } from "@/components/workspace-context";
import "./thread.css";

export function ConversationView() {
  const { snapshot, pending, hasMessages, action, safely, selectConversation } = useWorkspace();
  return (
              <ThreadPrimitive.Root
                className={`live-thread ${!hasMessages ? "live-thread-empty" : ""}`}
              >
                <ThreadPrimitive.Viewport className="live-viewport">
                  <div className="live-transcript">
                    {!hasMessages && (
                      <div className="live-welcome">
                        <h1>
                          <MarsMark width={43} height={43} />
                          What shall we work on?
                        </h1>
                      </div>
                    )}
                    <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
                    {snapshot && (
                      <LiveWorkers
                        workers={snapshot.workers.filter(
                          (worker) => worker.conversationId === snapshot.conversationId,
                        )}
                        workflows={snapshot.workflows}
                        onOpen={selectConversation}
                        onStopWorkflow={(workflowId) =>
                          safely(action("/api/workflows/stop", { workflowId }))
                        }
                        usage={snapshot.usage}
                        pending={pending}
                        onStop={(workerId) => safely(action("/api/workers/stop", { workerId }))}
                      />
                    )}
                    {snapshot && (
                      <AgentActivity
                        workers={snapshot.workers.filter(
                          (worker) => worker.conversationId === snapshot.conversationId,
                        )}
                      />
                    )}
                    {snapshot?.running && (
                      <div className="live-working" role="status">
                        <StatusMark status="running" size={14} />
                        {snapshot.messages.some((message) =>
                          message.tools.some(
                            (tool) =>
                              tool.output === undefined ||
                              tool.state === "running" ||
                              tool.children?.some((child) => child.state === "running"),
                          ),
                        )
                          ? "Working"
                          : "Thinking"}
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
