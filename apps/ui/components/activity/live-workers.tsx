"use client";

import { Bot, ChevronRight, Square, Workflow as WorkflowIcon } from "lucide-react";
import StatusMark, { type StatusMarkStatus } from "@/components/react-bits/StatusMark";
import { formatDuration } from "@/components/ai/tool-adapter";
import { useWorkspace } from "@/components/workspace-context";
import type { LiveSnapshot } from "@/lib/pi/live-state";
import "./activity.css";

const markByStatus: Record<string, StatusMarkStatus> = {
  pending: "pending",
  queued: "pending",
  running: "running",
  waiting: "running",
  completed: "done",
  complete: "done",
  succeeded: "done",
  done: "done",
  failed: "failed",
  error: "failed",
  aborted: "cancelled",
  cancelled: "cancelled",
  stopped: "cancelled",
};
const stoppable = (status: string) => ["pending", "queued", "running", "waiting"].includes(status);
const live = (status: string) => ["running", "waiting"].includes(status);
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

function Status({ status }: { status: string }) {
  return (
    <StatusMark
      status={markByStatus[status] ?? "pending"}
      size={13}
      doneColor="var(--green)"
      errorColor="var(--red)"
    />
  );
}

function Usage({ usage }: { usage: LiveSnapshot["usage"] }) {
  return (
    <dl className="live-usage">
      {usage.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LiveWorkers({
  workers,
  workflows,
  onOpen,
  onStopWorkflow,
  usage,
  pending,
  onStop,
}: {
  workers: LiveSnapshot["workers"];
  workflows: LiveSnapshot["workflows"];
  onOpen: (id: string) => void;
  onStopWorkflow: (id: string) => void;
  usage: LiveSnapshot["usage"];
  pending: boolean;
  onStop: (workerId: string) => void;
}) {
  const { hasMessages } = useWorkspace();
  if (!workers.length && !workflows.length)
    return hasMessages && usage.length ? <Usage usage={usage} /> : null;
  const running = [...workers, ...workflows].filter((item) => live(item.status)).length;
  return (
    <details className="live-workers">
      <summary>
        {running ? <StatusMark status="running" size={13} /> : <WorkflowIcon size={14} />}
        <span>
          {[
            workflows.length ? plural(workflows.length, "workflow") : "",
            workers.length ? plural(workers.length, "task") : "",
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
        {running > 0 && <small>{running} running</small>}
        <ChevronRight size={14} className="live-chevron" aria-hidden />
      </summary>
      <div className="live-workers-body">
        {workflows.map((workflow) => (
          <details className="live-workflow live-task-card" key={workflow.id}>
            <summary>
              <Status status={workflow.status} />
              <span className="live-task-title">{workflow.title || `Workflow ${workflow.id}`}</span>
              <small>{workflow.status}</small>
              <ChevronRight size={13} className="live-chevron" aria-hidden />
            </summary>
            <ol>
              {workflow.steps.map((step) => (
                <li key={step.index} className="live-workflow-phase">
                  <Status status={step.status} />
                  <div>
                    <button
                      type="button"
                      className="live-task-link"
                      disabled={!step.conversationId}
                      onClick={() => onOpen(step.conversationId)}
                    >
                      {step.title}
                    </button>
                    <p>
                      {[
                        step.status,
                        step.modelId,
                        step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
                        ...step.usage.map((item) => `${item.label} ${item.value.toLocaleString()}`),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            {stoppable(workflow.status) && (
              <button
                type="button"
                className="live-task-stop"
                disabled={pending}
                onClick={() => onStopWorkflow(workflow.id)}
              >
                <Square size={10} aria-hidden />
                Stop workflow
              </button>
            )}
          </details>
        ))}
        {workers.map((worker) => (
          <div className="live-worker live-task-card" key={worker.id}>
            <div className="live-worker-heading">
              <Bot size={14} aria-hidden />
              <button type="button" className="live-task-link" onClick={() => onOpen(worker.id)}>
                {worker.title || worker.task || `Task ${worker.id}`}
              </button>
              <Status status={worker.status} />
              <span className="live-worker-status">{worker.status}</span>
              {stoppable(worker.status) && (
                <button
                  type="button"
                  className="live-icon live-worker-stop"
                  disabled={pending}
                  aria-label={`Stop worker ${worker.id}`}
                  onClick={() => onStop(worker.id)}
                >
                  <Square size={11} />
                </button>
              )}
            </div>
            {(worker.modelId || (worker.task && worker.task !== worker.title)) && (
              <p className="live-worker-meta">
                {[worker.task !== worker.title ? worker.task : "", worker.modelId]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
            {worker.error && (
              <p className="live-worker-error" role="status">
                {worker.error}
              </p>
            )}
            {worker.result && (
              <details className="live-worker-result">
                <summary>
                  Result
                  <ChevronRight size={12} className="live-chevron" aria-hidden />
                </summary>
                <pre>{worker.result}</pre>
              </details>
            )}
          </div>
        ))}
        {usage.length > 0 && <Usage usage={usage} />}
      </div>
    </details>
  );
}
