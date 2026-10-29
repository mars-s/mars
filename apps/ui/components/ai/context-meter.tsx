"use client";

import { Popover } from "radix-ui";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ContextUsage } from "@/lib/pi/live-state";
import type { Compaction } from "@/lib/pi/host-extras";
import "./context-meter.css";

type MeasuredContext = Exclude<ContextUsage, { basis: "unavailable" }>;

/*
 * Ring, single segmented bar, compact tick and legend follow the Kokonut AI
 * Context Meter (MIT, kokonutui.com). It is rebuilt here, not wrapped, because
 * the vendored component animates a demo conversation whenever data is missing,
 * labels itself with a hard-coded model and cannot mark estimates. This one has
 * no data of its own: every number comes from Pi's `snapshot.context`.
 */
const SEGMENT_COLOURS: Record<string, string> = {
  instructions: "var(--text-faint)",
  tools: "var(--blue)",
  messages: "var(--text)",
};
const SPARE_COLOURS = ["var(--text-muted)", "var(--green)", "var(--amber)"];

const formatTokens = (tokens: number) =>
  tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : `${Math.round(tokens)}`;
const percent = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

function level(share: number, compactAt: number) {
  if (share >= compactAt) return "full";
  if (share >= compactAt - 0.1) return "near";
  return "normal";
}

function Ring({ share }: { share: number }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden="true" className="mars-context-ring" viewBox="0 0 16 16" width={16} height={16}>
      <circle cx="8" cy="8" r={radius} className="mars-context-ring-track" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        className="mars-context-ring-fill"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, share))}
      />
    </svg>
  );
}

type MeterProps = {
  canCompact: boolean;
  onCompact: () => Promise<unknown> | void;
  /** The host's compaction status (host-extras.ts); absent from older hosts. */
  compaction?: Compaction;
};

/** How long a click waits to see the host report the compaction before giving up on it. */
const ASK_MS = 15000;
const DONE_MS = 8000;

/**
 * A compaction takes a minute or so, and the host reports it only once it is admitted, so the
 * click shows "Compacting" at once; it lasts while the host reports one running, then says it is
 * done (or failed) for a few seconds.
 */
function useCompactionState(compaction: Compaction | undefined, onCompact: MeterProps["onCompact"]) {
  const running = compaction?.running === true;
  const [asked, setAsked] = useState(false);
  const [done, setDone] = useState(false);
  const seen = useRef(false);
  useEffect(() => {
    if (running) {
      seen.current = true;
      setDone(false);
      return;
    }
    if (!seen.current) return;
    seen.current = false;
    setAsked(false);
    if (!compaction?.failure) setDone(true);
  }, [running, compaction?.failure]);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), DONE_MS);
    return () => clearTimeout(timer);
  }, [done]);
  useEffect(() => {
    if (!asked || running) return;
    const timer = setTimeout(() => setAsked(false), ASK_MS);
    return () => clearTimeout(timer);
  }, [asked, running]);
  const start = () => {
    setAsked(true);
    setDone(false);
    void Promise.resolve(onCompact()).catch(() => setAsked(false));
  };
  return { busy: running || asked, done, start };
}

export function ContextMeter({ context, ...props }: MeterProps & { context: ContextUsage }) {
  return context.basis === "unavailable" ? null : <Meter context={context} {...props} />;
}

function Meter({ context, canCompact, onCompact, compaction }: MeterProps & { context: MeasuredContext }) {
  const [open, setOpen] = useState(false);
  const { busy, done, start } = useCompactionState(compaction, onCompact);
  const failure = !busy && !done ? (compaction?.failure ?? "") : "";
  // Hovered segment: the bar and legend row light up together (Kokonut meter behaviour).
  const [active, setActive] = useState<string | null>(null);
  // Hover intent: open after a short rest, close after the pointer leaves both trigger and panel.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const hover = (next: boolean) => {
    clearTimeout(timer.current);
    if (pinned.current) return;
    timer.current = setTimeout(() => setOpen(next), next ? 120 : 220);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const finePointer = (event: ReactPointerEvent) => event.pointerType === "mouse" || event.pointerType === "pen";
  const { limit, used, compactAt, autoCompact, basis } = context;
  const share = used / limit;
  const free = Math.max(0, limit - used);
  const estimated = basis === "estimated";
  const rows = context.segments
    .filter((segment) => segment.tokens > 0)
    .map((segment, index) => ({
      ...segment,
      colour: SEGMENT_COLOURS[segment.id] ?? SPARE_COLOURS[index % SPARE_COLOURS.length],
    }));
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        clearTimeout(timer.current);
        // A click pins the panel open until it is dismissed; hover alone does not.
        pinned.current = next;
        if (!next) setActive(null);
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="mars-context-trigger"
          data-open={open ? "" : undefined}
          onPointerEnter={(event) => finePointer(event) && hover(true)}
          onPointerLeave={(event) => finePointer(event) && hover(false)}
          onFocus={(event) => {
            if (event.currentTarget.matches(":focus-visible")) {
              clearTimeout(timer.current);
              setOpen(true);
            }
          }}
          data-level={level(share, compactAt)}
          data-compacting={busy ? "" : undefined}
          aria-label={busy ? "Compacting the context. Show details" : `Context ${percent(share)} full${estimated ? ", estimated" : ""}. Show breakdown`}
        >
          <Ring share={share} />
          <span className="mars-context-trigger-value">{busy ? "Compacting" : percent(share)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="mars-context-panel"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Context window"
          onPointerEnter={(event) => finePointer(event) && hover(true)}
          onPointerLeave={(event) => finePointer(event) && hover(false)}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="mars-context-head">
            <p>Context</p>
            <p className="mars-context-total">
              {estimated ? "About " : ""}
              {formatTokens(used)} of {formatTokens(limit)}
            </p>
          </div>
          <div className="mars-context-bar">
            <div className="mars-context-bar-track" onPointerLeave={() => setActive(null)}>
              {rows.map((segment) => (
                <span
                  key={segment.id}
                  data-dim={active && active !== segment.id ? "" : undefined}
                  onPointerEnter={() => setActive(segment.id)}
                  style={{ width: `${(segment.tokens / limit) * 100}%`, background: segment.colour }}
                />
              ))}
            </div>
            <span aria-hidden="true" className="mars-context-tick" style={{ left: `${compactAt * 100}%` }} />
          </div>
          <p className="mars-context-note">
            {autoCompact ? `Compacts automatically at ${Math.round(compactAt * 100)}%` : "Automatic compaction is off"}
          </p>
          <ul className="mars-context-legend">
            {rows.map((segment) => (
              <li
                key={segment.id}
                data-active={active === segment.id ? "" : undefined}
                onPointerEnter={() => setActive(segment.id)}
                onPointerLeave={() => setActive(null)}
              >
                <span className="mars-context-swatch" style={{ background: segment.colour }} />
                <span>{segment.label}</span>
                <span className="mars-context-num">{formatTokens(segment.tokens)}</span>
                <span className="mars-context-num mars-context-share">{percent(segment.tokens / limit)}</span>
              </li>
            ))}
            <li>
              <span className="mars-context-swatch mars-context-swatch-free" />
              <span className="mars-context-free">Free</span>
              <span className="mars-context-num">{formatTokens(free)}</span>
              <span className="mars-context-num mars-context-share">{percent(free / limit)}</span>
            </li>
          </ul>
          <p className="mars-context-basis">
            {estimated
              ? "Estimated. The model has not reported usage for this conversation yet."
              : "Total reported by the model. The split by type is estimated."}
          </p>
          <div className="mars-context-compact" aria-live="polite">
            <p>
              {busy
                ? compaction?.retryError
                  ? `Retrying after an error: ${compaction.retryError}`
                  : "Summarising older turns. This takes a minute or so; you can keep working."
                : done
                  ? "Compacted. Older turns are now a summary."
                  : failure
                    ? `The last compaction failed: ${failure}`
                    : "Summarise older turns to free space"}
            </p>
            <button type="button" disabled={!canCompact || busy} onClick={start}>
              {busy ? "Compacting…" : failure ? "Try again" : "Compact now"}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
