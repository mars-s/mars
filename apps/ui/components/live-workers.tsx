"use client";

import { Square } from "lucide-react";
import type { LiveSnapshot } from "@/lib/pi/live-state";

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
  if (!workers.length && !usage.length && !workflows.length) return null;
  return (
    <details className="live-workers">
      <summary>
        {workflows.length
          ? `Workflows (${workflows.length})`
          : workers.length
            ? `Tasks (${workers.length})`
            : "Usage"}
      </summary>
      {workflows.map((workflow) => (
        <details className="live-workflow" key={workflow.id}>
          <summary>
            <span>{workflow.title}</span>
            <small>{workflow.status}</small>
          </summary>
          {["pending", "queued", "running", "waiting"].includes(workflow.status) && (
            <button
              className="live-text-button"
              disabled={pending}
              onClick={() => onStopWorkflow(workflow.id)}
            >
              Stop workflow
            </button>
          )}
          <ol>
            {workflow.steps.map((step) => (
              <li key={step.index} className="live-workflow-phase">
                <div>
                  <button
                    type="button"
                    className="live-text-button"
                    disabled={!step.conversationId}
                    onClick={() => onOpen(step.conversationId)}
                  >
                    {step.title}
                  </button>
                  <small>{step.status}</small>
                </div>
                <p>
                  {[step.provider, step.modelId].filter(Boolean).join(" / ")}
                  {step.durationMs !== undefined
                    ? ` · ${(step.durationMs / 1000).toFixed(1)}s`
                    : ""}
                </p>
                {step.usage.map((item) => (
                  <small key={item.label}>
                    {item.label} {item.value.toLocaleString()}{" "}
                  </small>
                ))}
              </li>
            ))}
          </ol>
        </details>
      ))}
      {workers.map((worker) => (
        <div className="live-worker" key={worker.id}>
          <div className="live-worker-heading">
            <button type="button" className="live-text-button" onClick={() => onOpen(worker.id)}>
              {worker.title || worker.task || `Task ${worker.id}`}
            </button>
            <span className="live-worker-status">{worker.status}</span>
            {["pending", "queued", "running", "waiting"].includes(worker.status) && (
              <button
                type="button"
                className="live-icon"
                disabled={pending}
                aria-label={`Stop worker ${worker.id}`}
                onClick={() => onStop(worker.id)}
              >
                <Square size={12} />
              </button>
            )}
          </div>
          {worker.task && <p>{worker.task}</p>}
          {worker.error && <p role="status">{worker.error}</p>}
          {worker.result && (
            <details>
              <summary>Result</summary>
              <pre>{worker.result}</pre>
            </details>
          )}
        </div>
      ))}
      {usage.length > 0 && (
        <dl className="live-usage">
          {usage.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.value.toLocaleString()}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}
