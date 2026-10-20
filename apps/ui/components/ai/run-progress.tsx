"use client";

import AILoadingState from "@/components/vendor/kokonut/ai-loading";
import type { RunStep } from "./run-steps";

/**
 * The Kokonut AI State Loading list for the run in progress. Steps are always
 * passed in, so the component never plays its demo; it is unmounted when Pi
 * reports no running work.
 */
export function RunProgress({ steps }: { steps: RunStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="live-run-progress">
      <AILoadingState steps={steps} collapseWhenDone={false} className="live-run-progress-inner" />
    </div>
  );
}
