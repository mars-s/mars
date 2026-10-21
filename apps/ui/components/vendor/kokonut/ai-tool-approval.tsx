"use client";

/**
 * @author: @kokonutui
 * @description: AI Tool Approval
 * @version: 1.0.0
 * @date: 2026-10-15
 * @license: MIT
 * @website: https://kokonutui.com
 * @github: https://github.com/kokonut-labs/kokonutui
 */

import {
  ChevronRight,
  FilePen,
  Globe,
  Send,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The same states the AI SDK gives a tool part, so a part can be passed
 * straight through: `approval-requested` asks, `approval-responded` runs,
 * and the `output-*` states are the result.
 */
export type ToolCallState =
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-denied"
  | "output-error";

export interface ToolCall {
  id: string;
  /** The tool's name, such as `bash` or `write_file`. Picks the icon. */
  tool: string;
  /** What the agent wants to do, in plain words: "Run a command". */
  title: string;
  /** A command or text shows as code; an object shows as fields. */
  input: string | Record<string, string | number | boolean>;
  /** Why the agent wants this, shown under the input. */
  reason?: string;
  /** Destructive calls need a press and hold, and are never auto-approved. */
  destructive?: boolean;
  state: ToolCallState;
  /** Output lines, streamed while running and kept once done. */
  output?: string[];
  icon?: ReactNode;
}

interface AIToolApprovalProps {
  /**
   * The conversation's tool calls, oldest first. When omitted, a demo run
   * plays with three calls to approve.
   */
  calls?: ToolCall[];
  /**
   * Called when the user allows or denies a call. `always` is true when they
   * chose to stop asking for this tool.
   */
  onRespond?: (id: string, approved: boolean, always: boolean) => void;
  className?: string;
}

const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const HOLD_MS = 900;

const DEMO_CALLS: Omit<ToolCall, "state">[] = [
  {
    id: "test",
    tool: "bash",
    title: "Run a command",
    input: "bun test --filter checkout",
    reason: "Check the checkout tests before changing the form.",
    output: [
      "bun test v1.3.0",
      "checkout/cart.test.ts  ✓ 6 passed",
      "checkout/form.test.ts  ✗ 1 failed",
      "7 tests, 1 failure (412ms)",
    ],
  },
  {
    id: "edit",
    tool: "write_file",
    title: "Edit a file",
    input: {
      path: "app/checkout/form.tsx",
      changes: "+4 −2",
    },
    reason: "Validate the postcode before submitting.",
    output: ["Wrote app/checkout/form.tsx (+4 −2)"],
  },
  {
    id: "clean",
    tool: "bash",
    title: "Run a command",
    input: "rm -rf .next && bun run build",
    reason: "Clear the stale build cache, then rebuild.",
    destructive: true,
    output: [
      "removed .next",
      "▲ Next.js 16.2.10",
      "Creating an optimized production build",
      "✓ Compiled in 8.4s",
    ],
  },
];

const OUTPUT_TICK_MS = 380;

const TERMINAL_TOOL = /bash|shell|terminal|exec|command/;
const FILE_TOOL = /write|edit|file|patch/;
const WEB_TOOL = /fetch|web|browse|http|search/;
const SEND_TOOL = /mail|send|message|post/;

/**
 * Plays DEMO_CALLS: each waits for a decision, then streams its output. Tools
 * the user always allows skip the question, unless the call is destructive.
 */
function useDemoCalls(enabled: boolean) {
  const [calls, setCalls] = useState<ToolCall[]>(() =>
    DEMO_CALLS.slice(0, 1).map((call) => ({
      ...call,
      state: "approval-requested",
      output: [],
    }))
  );
  const alwaysRef = useRef(new Set<string>());

  const update = useCallback((id: string, patch: Partial<ToolCall>) => {
    setCalls((list) =>
      list.map((call) => (call.id === id ? { ...call, ...patch } : call))
    );
  }, []);

  const next = useCallback(() => {
    setCalls((list) => {
      const source = DEMO_CALLS[list.length];
      if (!source) {
        return list;
      }
      const auto = alwaysRef.current.has(source.tool) && !source.destructive;
      return [
        ...list,
        {
          ...source,
          state: auto ? "approval-responded" : "approval-requested",
          output: [],
        },
      ];
    });
  }, []);

  // Streams the output of whichever call is running, then moves on.
  const running = calls.find((call) => call.state === "approval-responded");
  useEffect(() => {
    if (!(enabled && running)) {
      return;
    }
    const lines = DEMO_CALLS.find((call) => call.id === running.id)?.output;
    const shown = running.output?.length ?? 0;
    const id = setTimeout(() => {
      if (lines && shown < lines.length) {
        update(running.id, { output: lines.slice(0, shown + 1) });
        return;
      }
      update(running.id, { state: "output-available" });
      next();
    }, OUTPUT_TICK_MS);
    return () => clearTimeout(id);
  }, [enabled, running, update, next]);

  const respond = useCallback(
    (id: string, approved: boolean, always: boolean) => {
      const call = DEMO_CALLS.find((item) => item.id === id);
      if (always && call) {
        alwaysRef.current.add(call.tool);
      }
      update(id, { state: approved ? "approval-responded" : "output-denied" });
      if (!approved) {
        setTimeout(next, 240);
      }
    },
    [update, next]
  );

  const reset = useCallback(() => {
    alwaysRef.current.clear();
    setCalls(
      DEMO_CALLS.slice(0, 1).map((call) => ({
        ...call,
        state: "approval-requested",
        output: [],
      }))
    );
  }, []);

  return { calls, respond, reset };
}

function ToolIcon({ call }: { call: ToolCall }) {
  if (call.icon) {
    return <>{call.icon}</>;
  }
  const name = call.tool.toLowerCase();
  const className = "size-4";
  if (TERMINAL_TOOL.test(name)) {
    return <SquareTerminal aria-hidden="true" className={className} />;
  }
  if (FILE_TOOL.test(name)) {
    return <FilePen aria-hidden="true" className={className} />;
  }
  if (WEB_TOOL.test(name)) {
    return <Globe aria-hidden="true" className={className} />;
  }
  if (SEND_TOOL.test(name)) {
    return <Send aria-hidden="true" className={className} />;
  }
  return <Wrench aria-hidden="true" className={className} />;
}

const inputSummary = (input: ToolCall["input"]) =>
  typeof input === "string" ? input : Object.values(input)[0]?.toString();

function ToolInput({ input }: { input: ToolCall["input"] }) {
  if (typeof input === "string") {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-background px-3 py-2.5 font-mono text-[13px] text-foreground leading-relaxed ring-1 ring-foreground/5 dark:bg-foreground/5 dark:text-foreground dark:ring-foreground/10">
        <span aria-hidden="true" className="select-none text-muted-foreground">
          ${" "}
        </span>
        {input}
      </pre>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-background px-3 py-2.5 text-[13px] ring-1 ring-foreground/5 dark:bg-foreground/5 dark:ring-foreground/10">
      {Object.entries(input).map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="text-muted-foreground dark:text-muted-foreground">{key}</dt>
          <dd className="min-w-0 truncate font-mono text-foreground dark:text-foreground">
            {String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Allow for destructive calls. The red fill wipes across while held and
 * runs back quickly when let go early, so a slip never confirms.
 */
function HoldToAllow({ onConfirm }: { onConfirm: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = () => {
    setHolding(true);
    timer.current = setTimeout(() => {
      setHolding(false);
      onConfirm();
    }, HOLD_MS);
  };
  const stop = () => {
    setHolding(false);
    if (timer.current) {
      clearTimeout(timer.current);
    }
  };
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const label = "Hold to allow";
  return (
    <button
      aria-label="Allow. Press and hold to confirm"
      className="relative h-8 select-none overflow-hidden rounded-lg bg-destructive px-3 font-medium text-destructive text-sm outline-hidden ring-1 ring-destructive/15 focus-visible:ring-2 focus-visible:ring-destructive dark:bg-destructive/10 dark:text-destructive dark:ring-destructive/20"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          stop();
        }
      }}
      onPointerCancel={stop}
      onPointerDown={start}
      onPointerLeave={stop}
      onPointerUp={stop}
      type="button"
    >
      {label}
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center bg-destructive text-background"
        style={{
          clipPath: holding ? "inset(0 0 0 0)" : "inset(0 100% 0 0)",
          transition: holding
            ? `clip-path ${HOLD_MS}ms linear`
            : "clip-path 200ms cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        {label}
      </span>
    </button>
  );
}

function ApprovalCard({
  call,
  onRespond,
}: {
  call: ToolCall;
  onRespond: (approved: boolean, always: boolean) => void;
}) {
  const [always, setAlways] = useState(false);
  const alwaysId = useId();
  const titleId = useId();

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape bubbles up from the card's own buttons and checkbox
    <section
      aria-labelledby={titleId}
      className="rounded-xl bg-background p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-foreground/5 dark:bg-muted dark:ring-foreground/10"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onRespond(false, false);
        }
      }}
    >
      <header className="mb-2.5 flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground dark:bg-foreground/10 dark:text-foreground">
          <ToolIcon call={call} />
        </span>
        <h3
          className="font-medium text-sm text-foreground dark:text-foreground"
          id={titleId}
        >
          {call.title}
        </h3>
        <span className="font-mono text-xs text-muted-foreground dark:text-muted-foreground">
          {call.tool}
        </span>
        {call.destructive && (
          <span className="ml-auto rounded-md bg-destructive px-1.5 py-0.5 font-medium text-[11px] text-destructive dark:bg-destructive/10 dark:text-destructive">
            Destructive
          </span>
        )}
      </header>
      <ToolInput input={call.input} />
      {call.reason && (
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed dark:text-muted-foreground">
          {call.reason}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {call.destructive ? (
          <span className="text-xs text-muted-foreground dark:text-muted-foreground">
            Asks every time
          </span>
        ) : (
          <label
            className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground dark:text-muted-foreground"
            htmlFor={alwaysId}
          >
            <input
              checked={always}
              className="size-3.5 cursor-pointer accent-foreground dark:accent-foreground"
              id={alwaysId}
              onChange={(event) => setAlways(event.target.checked)}
              type="checkbox"
            />
            Don't ask again for <code className="font-mono">{call.tool}</code>
          </label>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="h-8 rounded-lg px-3 text-sm text-muted-foreground outline-hidden transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-input/50 dark:text-foreground dark:hover:bg-foreground/10 dark:hover:text-foreground"
            onClick={() => onRespond(false, false)}
            type="button"
          >
            Deny
          </button>
          {call.destructive ? (
            <HoldToAllow onConfirm={() => onRespond(true, false)} />
          ) : (
            <button
              className="h-8 rounded-lg bg-foreground px-3 font-medium text-sm text-background outline-hidden transition-colors duration-150 hover:bg-foreground focus-visible:ring-2 focus-visible:ring-input/60 focus-visible:ring-offset-1 dark:bg-foreground dark:text-muted-foreground dark:focus-visible:ring-offset-muted dark:hover:bg-foreground"
              onClick={() => onRespond(true, always)}
              type="button"
            >
              Allow
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function StatusIcon({ state }: { state: ToolCallState }) {
  if (state === "approval-responded") {
    return (
      <svg
        aria-hidden="true"
        className="size-3.5 motion-safe:animate-spin"
        fill="none"
        style={{ animationDuration: "0.8s" }}
        viewBox="0 0 16 16"
      >
        <circle
          className="stroke-border dark:stroke-input"
          cx="8"
          cy="8"
          r="6.25"
          strokeWidth="1.5"
        />
        <path
          className="stroke-foreground dark:stroke-foreground"
          d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
          strokeLinecap="round"
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (state === "output-available") {
    return (
      <svg
        aria-hidden="true"
        className="size-3.5 text-foreground dark:text-foreground"
        fill="none"
        viewBox="0 0 16 16"
      >
        <motion.path
          animate={{ pathLength: 1 }}
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          initial={{ pathLength: 0 }}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          transition={{ duration: 0.3, ease: EASE_OUT }}
        />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      className={cn(
        "size-3.5",
        state === "output-error" ? "text-destructive" : "text-muted-foreground"
      )}
      fill="none"
      viewBox="0 0 16 16"
    >
      <path
        d="M4.5 4.5l7 7m0-7-7 7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

/** What the trace line says, as [while running, once done]. */
function verbsFor(tool: string): [string, string] {
  const name = tool.toLowerCase();
  if (TERMINAL_TOOL.test(name)) {
    return ["Running", "Ran"];
  }
  if (FILE_TOOL.test(name)) {
    return ["Editing", "Edited"];
  }
  if (WEB_TOOL.test(name)) {
    return ["Fetching", "Fetched"];
  }
  if (SEND_TOOL.test(name)) {
    return ["Sending", "Sent"];
  }
  return ["Using", "Used"];
}

function verbOf(call: ToolCall) {
  const [running, done] = verbsFor(call.tool);
  switch (call.state) {
    case "approval-responded":
      return running;
    case "output-denied":
      return "Denied";
    case "output-error":
      return "Failed";
    default:
      return done;
  }
}

/**
 * A decided call, folded to one line. Running calls show their output as it
 * streams; finished ones open it on click.
 */
function TraceLine({ call }: { call: ToolCall }) {
  const state = call.state as Exclude<ToolCallState, "approval-requested">;
  const isRunning = state === "approval-responded";
  const hasOutput = Boolean(call.output?.length) && state !== "output-denied";
  const [open, setOpen] = useState(false);
  const outputId = useId();
  const showOutput = hasOutput && (isRunning || open);

  return (
    <div>
      <button
        aria-controls={hasOutput ? outputId : undefined}
        aria-expanded={hasOutput ? showOutput : undefined}
        className="group/line flex w-full items-center gap-2.5 rounded-md py-1.5 text-left text-[13px] leading-5 outline-hidden focus-visible:ring-2 focus-visible:ring-input/40 disabled:cursor-default"
        disabled={!hasOutput || isRunning}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <StatusIcon state={state} />
        </span>
        <span
          className={cn(
            "shrink-0",
            state === "output-denied"
              ? "text-muted-foreground dark:text-muted-foreground"
              : "text-muted-foreground dark:text-foreground"
          )}
        >
          {verbOf(call)}
        </span>
        <code
          className={cn(
            "min-w-0 truncate font-mono text-[12.5px]",
            state === "output-denied"
              ? "text-muted-foreground line-through decoration-input dark:text-muted-foreground dark:decoration-input"
              : "text-foreground dark:text-foreground"
          )}
        >
          {inputSummary(call.input)}
        </code>
        {hasOutput && !isRunning && (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover/line:text-muted-foreground dark:group-hover/line:text-muted-foreground",
              open && "rotate-90"
            )}
          />
        )}
      </button>
      <AnimatePresence initial={false}>
        {showOutput && (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            className="overflow-hidden"
            exit={{ height: 0, opacity: 0 }}
            id={outputId}
            initial={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
          >
            <pre className="mb-1.5 ml-6.5 overflow-x-auto rounded-lg bg-background px-3 py-2 font-mono text-xs text-muted-foreground leading-5 ring-1 ring-foreground/5 dark:bg-foreground/5 dark:text-muted-foreground dark:ring-foreground/10">
              {call.output?.join("\n")}
            </pre>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function AIToolApproval({
  calls: callsProp,
  onRespond,
  className,
}: AIToolApprovalProps) {
  const demo = useDemoCalls(callsProp === undefined);
  const calls = callsProp ?? demo.calls;
  const respond = (id: string, approved: boolean, always: boolean) => {
    if (callsProp === undefined) {
      demo.respond(id, approved, always);
    }
    onRespond?.(id, approved, always);
  };

  const pending = calls.filter((call) => call.state === "approval-requested");
  const decided = calls.filter((call) => call.state !== "approval-requested");
  const current = pending[0];
  const demoFinished =
    callsProp === undefined &&
    calls.length === DEMO_CALLS.length &&
    pending.length === 0 &&
    calls.every((call) => call.state !== "approval-responded");

  return (
    <MotionConfig reducedMotion="user">
      <div className={cn("w-full max-w-md", className)}>
        <div className="rounded-2xl bg-foreground/5 p-1.5 dark:bg-foreground/5">
          {decided.length > 0 && (
            <div className="px-2.5 pt-1 pb-1.5">
              {decided.map((call) => (
                <motion.div
                  animate={{ opacity: 1, height: "auto" }}
                  initial={{ opacity: 0, height: 0 }}
                  key={call.id}
                  transition={{ duration: 0.24, ease: EASE_OUT }}
                >
                  <TraceLine call={call} />
                </motion.div>
              ))}
            </div>
          )}
          <AnimatePresence initial={false} mode="popLayout">
            {current ? (
              <motion.div
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -6, filter: "blur(2px)" }}
                initial={{ opacity: 0, y: 8, filter: "blur(2px)" }}
                key={current.id}
                transition={{ duration: 0.22, ease: EASE_OUT }}
              >
                {pending.length > 1 && (
                  <p className="px-2.5 pb-1.5 text-xs text-muted-foreground tabular-nums dark:text-muted-foreground">
                    1 of {pending.length} waiting
                  </p>
                )}
                <ApprovalCard
                  call={current}
                  onRespond={(approved, always) =>
                    respond(current.id, approved, always)
                  }
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
          {demoFinished && (
            <div className="flex justify-end px-2.5 pb-1">
              <button
                className="rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-hidden transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-input/40 dark:text-muted-foreground dark:hover:text-foreground"
                onClick={demo.reset}
                type="button"
              >
                Replay
              </button>
            </div>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}
