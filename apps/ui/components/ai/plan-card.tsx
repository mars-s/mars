"use client";

import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import type { Plan } from "@/lib/pi/live-state";
import "./plan-card.css";

/**
 * The agent's checklist (docs/TOOLS.md "plan_update"), shown above the run status: an
 * empty circle for pending, a spinner for in progress, a tick for done. A finished plan
 * collapses to its count and opens on click.
 */
export function PlanCard({ plan }: { plan: Plan | null }) {
  const [open, setOpen] = useState(false);
  if (!plan) return null;
  const finished = plan.done === plan.total;
  const label = `${plan.done} of ${plan.total} done`;
  const expanded = !finished || open;
  return (
    <section className="live-plan" aria-label="Plan" data-finished={finished ? "" : undefined}>
      {finished && (
        <button type="button" className="live-plan-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="live-plan-mark" data-status="completed" aria-hidden="true">
            <Check size={10} strokeWidth={3} />
          </span>
          <span>Plan: {label}</span>
          <ChevronDown size={14} aria-hidden="true" className="live-plan-chevron" />
        </button>
      )}
      {expanded && (
        <ol className="live-plan-steps">
          {plan.steps.map((row, index) => (
            <li key={`${index}-${row.step}`} data-status={row.status}>
              <span className="live-plan-mark" data-status={row.status} aria-hidden="true">
                {row.status === "completed" && <Check size={10} strokeWidth={3} />}
              </span>
              <span className="live-plan-text">{row.step}</span>
              <span className="sr-only">
                {row.status === "completed" ? ", done" : row.status === "in_progress" ? ", in progress" : ", to do"}
              </span>
            </li>
          ))}
        </ol>
      )}
      {!finished && (
        <p className="sr-only" aria-live="polite">
          {label}
        </p>
      )}
    </section>
  );
}
