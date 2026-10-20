"use client";
import { Check, Circle, Terminal, FileText, Pencil, Wrench } from "lucide-react";
import { record, type WorkerSummary } from "@/lib/pi/live-state";
import "./activity.css";

function argumentsOf(value: unknown) {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}
function actionLabel(action: Record<string, unknown>) {
  const name = String(action.name || "Tool");
  const args = argumentsOf(action.input);
  const path = [args.path, args.filePath, args.file, args.target].find(
    (value) => typeof value === "string",
  );
  const command = [args.command, args.cmd].find((value) => typeof value === "string");
  if (/exec|shell|terminal|command/.test(name))
    return {
      Icon: Terminal,
      title: "Run command",
      detail: typeof command === "string" ? command.slice(0, 160) : name,
    };
  if (/read|cat|open_file/.test(name))
    return { Icon: FileText, title: "Read file", detail: typeof path === "string" ? path : name };
  if (/write|edit|patch/.test(name))
    return { Icon: Pencil, title: "Update file", detail: typeof path === "string" ? path : name };
  if (name === "codemode") return { Icon: Terminal, title: "Run code", detail: "" };
  if (name === "tool_search")
    return {
      Icon: Wrench,
      title: "Find tools",
      detail: typeof args.query === "string" ? args.query : "",
    };
  return { Icon: Wrench, title: name.replaceAll("_", " "), detail: "" };
}
function stateLabel(action: Record<string, unknown>) {
  if (action.failed || action.state === "failed") return "Failed";
  if (action.state === "cancelled") return "Stopped";
  if (action.state === "running") return "Working";
  return action.output === undefined && action.state !== "complete" ? "Requested" : "Complete";
}
export function ActivityTimeline({ tools }: { tools: Record<string, unknown>[] }) {
  const actions = tools.flatMap((tool) =>
    Array.isArray(tool.children) && tool.children.length ? tool.children.map(record) : [tool],
  );
  if (!actions.length) return null;
  const failed = actions.filter((action) => stateLabel(action) === "Failed").length;
  const active = actions.some((action) => ["Working", "Requested"].includes(stateLabel(action)));
  return (
    <details className="live-activity">
      <summary>
        {active ? <Circle size={13} /> : <Check size={13} />}
        <span>
          {active ? "Working" : `${actions.length} ${actions.length === 1 ? "action" : "actions"}`}
        </span>
        {failed > 0 && <small>{failed} failed</small>}
      </summary>
      <ol>
        {actions.map((action, index) => {
          const { Icon, title, detail } = actionLabel(action);
          return (
            <li key={String(action.id ?? index)}>
              <Icon size={14} />
              <details>
                <summary>
                  <span>{title}</span>
                  <small>{stateLabel(action)}</small>
                </summary>
                {detail && <p className="live-activity-label">{detail}</p>}
                {typeof action.durationMs === "number" && (
                  <p>{(action.durationMs / 1000).toFixed(1)}s</p>
                )}
                {typeof action.exitCode === "number" && <p>Exit code {action.exitCode}</p>}
                {typeof action.input === "string" && action.input.length > 0 && (
                  <>
                    <span className="live-detail-label">Input</span>
                    <pre>{String(action.input)}</pre>
                  </>
                )}
                {action.output !== undefined && (
                  <>
                    <span className="live-detail-label">Result</span>
                    <pre>{String(action.output)}</pre>
                  </>
                )}
              </details>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
export function AgentActivity({ workers }: { workers: WorkerSummary[] }) {
  const working = workers.filter((worker) => ["running", "waiting"].includes(worker.status)).length;
  const finished = workers.filter((worker) =>
    ["completed", "complete", "succeeded", "done"].includes(worker.status),
  ).length;
  if (!working && !finished) return null;
  return (
    <p className="live-agent-activity" role="status">
      {[
        working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "",
        finished ? `${finished} finished` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    </p>
  );
}
