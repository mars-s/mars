import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";

/**
 * Current context-window usage for one conversation, measured the way Pi Durable
 * decides compaction (pi-durable harness/compaction.js `estimateContext`): the
 * newest assistant usage after the head marker, plus estimates for later messages.
 * Categories split that same total, so they never exceed what Pi counted.
 *
 * Returns `basis: "unavailable"` rather than inventing numbers when the model or
 * its context window is unknown.
 */
export function contextMeter(view, model, compaction = DEFAULT_COMPACTION_POLICY) {
  const limit = Number(model?.contextWindow);
  if (!Number.isFinite(limit) || limit <= 0) return { basis: "unavailable" };
  const messages = view?.messages ?? [];
  const after = view?.head?.id ?? Number.NEGATIVE_INFINITY;
  let measured;
  for (let index = (view?.entries?.length ?? 0) - 1; index >= 0 && measured === undefined; index--) {
    if (view.entries[index].id <= after) continue;
    measured = view.contributions[index]?.findLast(
      (message) => message.role === "assistant" && calculateContextTokens(message.usage) > 0,
    );
  }
  const from = measured === undefined ? 0 : messages.lastIndexOf(measured) + 1;
  const reported = measured === undefined ? 0 : calculateContextTokens(measured.usage);

  const categoryOf = (message) =>
    message.role === "system" ? "instructions" : message.role === "toolResult" ? "tools" : "messages";
  const estimated = { instructions: 0, tools: 0, messages: 0 };
  for (const message of messages) estimated[categoryOf(message)] += estimateMessageTokens(message);
  const trailing = messages.slice(from).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const used = reported + trailing;

  // Split Pi's total in proportion to per-category estimates; the split is an estimate, the total is Pi's.
  const estimateTotal = estimated.instructions + estimated.tools + estimated.messages;
  const labels = { instructions: "Instructions", tools: "Tool results", messages: "Messages" };
  let assigned = 0;
  const keys = Object.keys(labels);
  const segments = keys.map((id, index) => {
    const tokens =
      index === keys.length - 1
        ? Math.max(0, used - assigned)
        : estimateTotal > 0
          ? Math.round((used * estimated[id]) / estimateTotal)
          : 0;
    assigned += tokens;
    return { id, label: labels[id], tokens };
  });

  const compactAt = Math.max(0, limit - compaction.reserveTokens) / limit;
  return {
    basis: measured === undefined ? "estimated" : "reported",
    limit,
    used,
    compactAt,
    autoCompact: compaction.enabled,
    segments: segments.filter((segment) => segment.tokens > 0),
  };
}

/**
 * The compaction the meter's "Compact now" button reports, from the conversation's pi.live doc:
 * running while a compaction task is live (with its retry error when it is waiting to try again),
 * and the error of the last one that failed since a summary was last written.
 */
export function compactionStatus(live) {
  const running = Array.isArray(live?.compactions) ? live.compactions : [];
  const current = running[0];
  return {
    running: running.length > 0,
    ...(current ? { attempt: Number(current.attempt) || 1, manual: current.reason === "manual" } : {}),
    ...(current?.retry?.error ? { retryError: String(current.retry.error).slice(0, 300) } : {}),
    ...(live?.compactionFailure?.error ? { failure: String(live.compactionFailure.error).slice(0, 300) } : {}),
  };
}
