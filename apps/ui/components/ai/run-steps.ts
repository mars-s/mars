import type { LiveSnapshot } from "@/lib/pi/live-state";
import type { ToolView } from "./tool-adapter";

// Type-only imports: node --test loads this file directly, so the tool mapping is passed in.
type ToolViews = (tools: readonly unknown[]) => ToolView[];

/** One step for the Kokonut AI State Loading list. Same shape as its AgentStep. */
export type RunStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string[];
};

const MAX_STEPS = 6;

function stepFor(view: ToolView): RunStep {
  const label = view.status === "running" ? view.activeTitle : view.title;
  return {
    id: view.id,
    label: view.detail ? `${label} ${view.detail}` : label,
    status:
      view.status === "running"
        ? "running"
        : view.status === "failed" || view.status === "cancelled"
          ? "error"
          : "done",
    ...(view.status === "running" && view.detail ? { detail: [view.detail] } : {}),
  };
}

/**
 * Steps for the run in progress, built only from Pi's live snapshot: the tool
 * calls made since the user's latest message, then one step for the model's own
 * turn ("Thinking" before any text, "Writing the reply" once text streams).
 * Returns [] when nothing is running, so the loading state disappears with the run.
 */
export function runSteps(snapshot: LiveSnapshot | null, toolViews: ToolViews): RunStep[] {
  if (!snapshot?.running) return [];
  const lastUser = snapshot.messages.findLastIndex((message) => message.role === "user");
  const turn = snapshot.messages.slice(lastUser + 1).filter((message) => message.role === "assistant");
  const views = toolViews(turn.flatMap((message) => message.tools));
  const steps = views.map(stepFor);
  const live = turn.find((message) => message.running);
  const toolRunning = steps.some((step) => step.status === "running");
  if (!toolRunning) {
    steps.push({
      id: "model-turn",
      label: live?.text.trim() ? "Writing the reply" : "Thinking",
      status: "running",
    });
  }
  return steps.slice(-MAX_STEPS);
}
