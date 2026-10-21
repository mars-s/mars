"use client";

import { useState, type ComponentType } from "react";
import {
  ChevronRight,
  Code,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { WorkerSummary } from "@/lib/pi/live-state";
import { BashToolTerminalCard } from "@/components/vendor/agent-elements/tools/bash-tool";
import { EditToolDiffCard } from "@/components/vendor/agent-elements/tools/edit-tool";
import { TextShimmer } from "@/components/vendor/agent-elements/text-shimmer";
import { DiffHighlighterReady } from "@/components/ai/diff-highlighter";
import {
  actionCount,
  bashStep,
  diffInput,
  editStep,
  formatDuration,
  stepState,
  summarise,
  toolViews,
  type ToolCategory,
  type ToolView,
} from "@/components/ai/tool-adapter";
import "@/components/vendor/agent-elements/agent-ui.css";
import "./activity.css";

const icons: Record<ToolCategory, ComponentType<{ size?: number }>> = {
  command: Terminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  patch: FilePen,
  web: Globe,
  fetch: Globe,
  tools: Search,
  code: Code,
  other: Wrench,
};
const noop = () => {};

function Output({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <>
      <span className="live-detail-label">{label}</span>
      <pre>{text}</pre>
    </>
  );
}

function Facts({ view }: { view: ToolView }) {
  const facts = [
    view.kind === "command" && view.exitCode !== undefined ? `Exit code ${view.exitCode}` : "",
    view.kind === "command" && view.truncated ? "Earlier output trimmed" : "",
    view.durationMs !== undefined ? formatDuration(view.durationMs) : "",
  ].filter(Boolean);
  return facts.length ? <p className="live-tool-facts">{facts.join(" · ")}</p> : null;
}

function ToolBody({ view }: { view: ToolView }) {
  const state = stepState(view.status);
  switch (view.kind) {
    case "command":
      return view.command ? (
        <BashToolTerminalCard step={bashStep(view)} state={state} onComplete={noop} />
      ) : (
        <Output label="Result" text={view.output} />
      );
    case "edit":
      return view.files.length ? (
        <DiffHighlighterReady fallback={<p className="live-tool-facts">Loading diff</p>}>
          {view.files.map((file) => (
            <EditToolDiffCard
              key={file.path}
              step={editStep(view, file)}
              input={diffInput(file)}
              state={state}
              onComplete={noop}
              isCollapsible={file.lines.length > 14}
            />
          ))}
        </DiffHighlighterReady>
      ) : (
        <Output label="Result" text={view.output} />
      );
    case "read":
      return <Output label="Result" text={view.output} />;
    case "search":
      return (
        <div className="live-tool-search">
          {view.query && (
            <header>
              <span>{view.category === "fetch" ? "Fetched" : "Searched for"}</span>
              <span>{view.query}</span>
            </header>
          )}
          {view.output && <pre>{view.output}</pre>}
        </div>
      );
    case "generic":
      return (
        <>
          <Output label="Input" text={view.rawInput === "{}" ? "" : view.rawInput} />
          <Output label="Result" text={view.output} />
        </>
      );
  }
}

function ToolRow({ view }: { view: ToolView }) {
  const [open, setOpen] = useState(false);
  const Icon = icons[view.category];
  const running = view.status === "running";
  return (
    <li data-status={view.status}>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <Icon size={14} />
          {running ? (
            <TextShimmer as="span" duration={1.2} className="live-tool-title">
              {view.activeTitle}
            </TextShimmer>
          ) : (
            <span className="live-tool-title">{view.title}</span>
          )}
          <span className="live-tool-detail">{view.detail}</span>
          {view.status === "failed" && <small className="live-tool-state">Failed</small>}
          {view.status === "cancelled" && <small className="live-tool-state">Stopped</small>}
          <ChevronRight size={13} className="live-chevron" aria-hidden />
        </summary>
        {open && (
          <div className="live-tool-body">
            <ToolBody view={view} />
            <Facts view={view} />
          </div>
        )}
      </details>
    </li>
  );
}

export function ActivityTimeline({ tools, summary }: { tools: readonly unknown[]; summary?: string }) {
  const views = toolViews(tools);
  if (!views.length) return null;
  const failed = views.filter((view) => view.status === "failed").length;
  const active = views.findLast((view) => view.status === "running");
  // "Ran 3 commands" already says how many; the total only helps when kinds are mixed.
  const mixed = new Set(views.map((view) => view.category)).size > 1;
  return (
    <details className="live-activity" data-active={active ? "" : undefined}>
      <summary>
        {active ? (
          <TextShimmer as="span" duration={1.2} className="live-activity-title">
            {active.detail ? `${active.activeTitle} ${active.detail}` : active.activeTitle}
          </TextShimmer>
        ) : (
          <span className="live-activity-title">{summary || summarise(views)}</span>
        )}
        <ChevronRight size={14} className="live-chevron" aria-hidden />
        <small>
          {/* With a written summary, the counts move here so nothing is lost. */}
          {summary && !active ? <span>{summarise(views)}</span> : mixed && <span>{actionCount(views.length)}</span>}
          {failed > 0 && <span className="live-activity-failed">{failed} failed</span>}
        </small>
      </summary>
      <ol>
        {views.map((view, index) => (
          <ToolRow key={view.id || index} view={view} />
        ))}
      </ol>
    </details>
  );
}

/** Screen-reader announcement only: the background work disclosure shows the same counts. */
export function AgentActivity({ workers }: { workers: WorkerSummary[] }) {
  const working = workers.filter((worker) => ["running", "waiting"].includes(worker.status)).length;
  const finished = workers.filter((worker) =>
    ["completed", "complete", "succeeded", "done"].includes(worker.status),
  ).length;
  if (!working && !finished) return null;
  return (
    <p className="sr-only" role="status">
      {[
        working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "",
        finished ? `${finished} finished` : "",
      ]
        .filter(Boolean)
        .join(", ")}
    </p>
  );
}
