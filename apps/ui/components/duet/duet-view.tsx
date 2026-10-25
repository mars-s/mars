"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, CornerUpLeft, ExternalLink, Square, ThumbsDown, X } from "lucide-react";
import { piRequest } from "@/lib/pi/live-state";
import {
  cacheLabel,
  cacheTitle,
  canMarkWrong,
  groupQuiet,
  isActive,
  parseDuet,
  quietSummary,
  stateWord,
  type DuetMessage,
  type DuetTask,
  type DuetView as DuetData,
} from "@/lib/pi/duet";
import { useWorkspace } from "@/components/workspace-context";
import "./duet.css";

const POLL_MS = 1200;
/** A host from before Duet answers its routes with 404. */
const missing = (failure: unknown) => failure instanceof Error && /\(404\)|not found/i.test(failure.message);
/** Consecutive bubbles from the same sender and task share one tail. */
const sameGroup = (a: DuetMessage | undefined, b: DuetMessage | undefined) =>
  !!a && !!b && a.from === b.from && a.from !== "system" && a.taskId === b.taskId;
type Pending = { id: string; text: string; taskId: string; label: string };
/** A touch held this long on a Duet bubble opens Not right, as hovering does on a desktop. */
const LONG_PRESS_MS = 550;

/** The Duet page: one iMessage-style thread with the owner's assistant and its background tasks. */
export function DuetView() {
  const { selectConversation } = useWorkspace();
  const [data, setData] = useState<DuetData | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState<{ taskId: string; label: string } | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  // Typing dots from the moment the owner sends to the front desk, before the host reports the
  // turn: until Duet answers, its turn ends, or 20 seconds pass.
  const [awaiting, setAwaiting] = useState(false);
  const waitFor = useRef<{ since: number; replies: number; sawTyping: boolean } | null>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const seenResults = useRef<Set<string> | null>(null);
  const [quietOpen, setQuietOpen] = useState<Set<string>>(new Set());
  const [answers, setAnswers] = useState<Map<string, "yes" | "no">>(new Map());
  const [answering, setAnswering] = useState("");
  const [wrongOpen, setWrongOpen] = useState("");
  const [markedWrong, setMarkedWrong] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const next = parseDuet(await piRequest("/api/duet"));
      setData(next);
      const wait = waitFor.current;
      if (wait) {
        const replies = next.messages.filter((m) => m.from === "duet").length;
        if (next.typing) wait.sawTyping = true;
        if (replies > wait.replies || (wait.sawTyping && !next.typing) || Date.now() - wait.since > 20000) {
          waitFor.current = null;
          setAwaiting(false);
        }
      }
      setError("");
      setUnavailable(false);
      // Delivered messages replace their optimistic copies.
      setPending((rows) => rows.filter((row) => !next.messages.some((m) => m.from === "owner" && m.text === row.text && m.taskId === row.taskId)));
      const results = next.messages.filter((m) => m.from === "duet" && m.taskId && !m.quiet && ["result", "question", "failed", "confirm"].includes(m.kind));
      if (seenResults.current) {
        const fresh = results.filter((m) => !seenResults.current?.has(m.id));
        const said = (m: DuetMessage) =>
          m.kind === "question" ? m.label + " has a question" : m.kind === "confirm" ? m.label + " asks before going ahead" : m.kind === "failed" ? m.label + " failed" : m.label + " finished";
        if (fresh.length) setAnnouncement(fresh.map(said).join(". "));
      }
      seenResults.current = new Set(results.map((m) => m.id));
    } catch (failure) {
      if (missing(failure)) setUnavailable(true);
      else setError(failure instanceof Error ? failure.message : "Cannot reach Duet.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await load();
      if (active) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void piRequest("/api/duet/open", {}).then(() => poll(), (failure: unknown) => {
      if (missing(failure)) setUnavailable(true);
      else setError(failure instanceof Error ? failure.message : "Cannot open Duet.");
      void poll();
    });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load]);

  const messages = data?.messages ?? [];
  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const active = tasks.filter(isActive);
  const recent = useMemo(() => {
    const live = tasks.filter(isActive);
    const done = tasks.filter((task) => !isActive(task)).slice(-6).reverse();
    return [...live, ...done];
  }, [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const count = messages.length + pending.length;

  // Keep to the bottom while the owner is there; otherwise offer a jump instead of moving them.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [count, data?.typing, awaiting, atBottom]);
  const onScroll = () => {
    const element = scroller.current;
    if (element) setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
  };
  const toBottom = () => {
    const element = scroller.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  const replyTo = (task: { taskId: string; label: string }) => {
    setTarget(task);
    input.current?.focus();
  };
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const requestId = crypto.randomUUID();
    const row = { id: requestId, text, taskId: target?.taskId ?? "", label: target?.label ?? "" };
    setPending((rows) => [...rows, row]);
    if (!target) {
      waitFor.current = { since: Date.now(), replies: (data?.messages ?? []).filter((m) => m.from === "duet").length, sawTyping: false };
      setAwaiting(true);
    }
    setDraft("");
    setAtBottom(true);
    try {
      await piRequest("/api/duet/message", { text, requestId, ...(target ? { taskId: target.taskId } : {}) });
      void load();
    } catch (failure) {
      setPending((rows) => rows.filter((item) => item.id !== requestId));
      setDraft(text);
      setError(failure instanceof Error ? failure.message : "Message not sent. Your text is kept.");
    }
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
    if (event.key === "Escape" && target) setTarget(null);
  };
  const stop = async (task: DuetTask) => {
    setStopping((rows) => new Set(rows).add(task.id));
    try {
      await piRequest("/api/duet/stop", { taskId: task.id });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not stop " + task.label + ".");
    } finally {
      setStopping((rows) => {
        const next = new Set(rows);
        next.delete(task.id);
        return next;
      });
    }
  };

  const answer = async (confirmId: string, choice: "yes" | "no") => {
    setAnswering(confirmId);
    try {
      await piRequest("/api/duet/confirm", { confirmId, answer: choice });
      setAnswers((rows) => new Map(rows).set(confirmId, choice));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send your answer.");
    } finally {
      setAnswering("");
    }
  };
  const markWrong = async (messageId: string, note: string) => {
    try {
      await piRequest("/api/duet/feedback", { messageId, note: note.trim() });
      setMarkedWrong((rows) => new Set(rows).add(messageId));
      setWrongOpen("");
      void load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send that.");
    }
  };
  const toggleQuiet = (id: string) =>
    setQuietOpen((rows) => {
      const next = new Set(rows);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const shown: DuetMessage[] = [
    ...messages,
    ...pending.map((row) => ({
      id: "pending-" + row.id,
      from: "owner" as const,
      kind: "pending",
      text: row.text,
      taskId: row.taskId,
      label: row.label,
      quote: "",
      quiet: false,
      feedback: "" as const,
      confirm: null,
    })),
  ];
  const items = groupQuiet(shown);
  const bubble = (message: DuetMessage, previous: DuetMessage | undefined, next: DuetMessage | undefined) =>
    message.from === "system" ? (
      <li key={message.id} className="duet-system" data-kind={message.kind}>
        {message.kind === "mail" ? message.text : message.text + (message.taskId ? " · " + message.taskId : "")}
      </li>
    ) : (
      <Bubble
        key={message.id}
        message={message}
        first={!sameGroup(previous, message)}
        last={!sameGroup(message, next)}
        task={taskById.get(message.taskId)}
        onReply={replyTo}
        answer={message.confirm ? (message.confirm.state === "pending" ? answers.get(message.confirm.id) : message.confirm.state) : undefined}
        answering={!!message.confirm && answering === message.confirm.id}
        onAnswer={(choice) => message.confirm && void answer(message.confirm.id, choice)}
        wrong={message.feedback === "wrong" || markedWrong.has(message.id)}
        wrongOpen={wrongOpen === message.id}
        onWrongOpen={(open) => setWrongOpen(open ? message.id : "")}
        onWrong={(note) => markWrong(message.id, note)}
      />
    );
  const cache = cacheLabel(data?.context ?? null);
  const cacheNote = cache && (
    <span className="duet-cache" title={cacheTitle(data?.context ?? null)}>
      {cache}
    </span>
  );
  const queued = active.filter((task) => task.state === "queued").length;
  const needsYou = tasks.filter((task) => task.state === "waiting").length;
  const summary =
    [active.length - queued ? active.length - queued + " working" : "", queued ? queued + " waiting" : "", needsYou ? needsYou + " needs you" : ""].filter(Boolean).join(" · ") ||
    (tasks.length ? "Nothing running" : "");

  return (
    <section className="duet" aria-label="Duet">
      <div className="duet-scroll" ref={scroller} onScroll={onScroll}>
        <ol className="duet-thread">
          {!messages.length && !pending.length && (
            <li className="duet-empty">
              <span className="duet-avatar" aria-hidden="true">D</span>
              {unavailable ? (
                <p role="status">Duet is here in the interface, but the Mars host has not been updated yet. It starts working after the next host deploy.</p>
              ) : (
                <p>Ask Duet for anything. Send another message while it works and it starts on that too.</p>
              )}
            </li>
          )}
          {items.map((item, index) => {
            const neighbour = (at: number) => {
              const other = items[at];
              return other?.kind === "message" ? other.message : undefined;
            };
            if (item.kind === "message") return bubble(item.message, neighbour(index - 1), neighbour(index + 1));
            const open = quietOpen.has(item.id);
            const labels = [...new Set(item.messages.map((m) => m.label).filter(Boolean))].join(", ");
            return (
              <li key={item.id} className="duet-quiet" data-open={open ? "" : undefined}>
                <button type="button" className="duet-quiet-toggle" aria-expanded={open} onClick={() => toggleQuiet(item.id)}>
                  {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  <span>{quietSummary(item.messages)}</span>
                  {labels && <small>{labels}</small>}
                </button>
                {open && (
                  <ol className="duet-quiet-list">
                    {item.messages.map((message, at) => bubble(message, item.messages[at - 1], item.messages[at + 1]))}
                  </ol>
                )}
              </li>
            );
          })}
          {(data?.typing || awaiting) && (
            <li className="duet-row" data-from="duet">
              <div className="duet-bubble duet-typing" data-tail="" aria-label="Duet is typing">
                <span />
                <span />
                <span />
              </div>
            </li>
          )}
        </ol>
      </div>
      {!atBottom && (
        <button type="button" className="duet-jump" onClick={toBottom}>
          <ArrowDown size={14} /> New messages
        </button>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {error && (
        <div className="duet-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <footer className="duet-footer">
        {tasks.length === 0 && cacheNote && <div className="duet-meta">{cacheNote}</div>}
        {tasks.length > 0 && (
          <div className="duet-tasks" data-open={tasksOpen ? "" : undefined}>
            <div className="duet-strip-row">
              <button type="button" className="duet-strip" aria-expanded={tasksOpen} onClick={() => setTasksOpen(!tasksOpen)}>
                {active.length > 0 && <span className="duet-pulse" aria-hidden="true" />}
                <span>{summary}</span>
                {tasksOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              {cacheNote}
            </div>
            {tasksOpen && (
              <ul className="duet-task-list">
                {recent.map((task) => (
                  <li key={task.id} className="duet-task" data-state={task.running ? "running" : task.state}>
                    <div className="duet-task-text">
                      <span className="duet-task-name">
                        {task.label} <small>{task.id}</small>
                      </span>
                      <span className="duet-task-state">
                        {stateWord(task)}
                        {task.progress?.text ? " · " + task.progress.text : ""}
                        {task.progress?.total ? " (" + (task.progress.done ?? 0) + " of " + task.progress.total + ")" : ""}
                      </span>
                    </div>
                    <div className="duet-task-actions">
                      <button type="button" className="duet-icon" aria-label={"Reply to " + task.label} title="Reply to this task" onClick={() => replyTo({ taskId: task.id, label: task.label })}>
                        <CornerUpLeft size={14} />
                      </button>
                      {task.conversationId && (
                        <button type="button" className="duet-icon" aria-label={"Open " + task.label} title="Open the task chat" onClick={() => selectConversation(task.conversationId)}>
                          <ExternalLink size={14} />
                        </button>
                      )}
                      {isActive(task) && task.state !== "stopping" && (
                        <button type="button" className="duet-icon duet-stop" aria-label={"Stop " + task.label} title="Stop this task" disabled={stopping.has(task.id)} onClick={() => void stop(task)}>
                          <Square size={12} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {target && (
          <div className="duet-target">
            <CornerUpLeft size={13} aria-hidden="true" />
            <span>
              Replying to <strong>{target.label}</strong> · {target.taskId}
            </span>
            <button type="button" aria-label="Stop replying to this task" onClick={() => setTarget(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        <form
          className="duet-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={target ? "Message " + target.label : "Message Duet"}
            aria-label={target ? "Message " + target.label : "Message Duet"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKey}
          />
          <button type="submit" className="duet-send" aria-label="Send" disabled={!draft.trim() || unavailable}>
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        </form>
      </footer>
    </section>
  );
}

function Bubble({
  message,
  first,
  last,
  task,
  onReply,
  answer,
  answering,
  onAnswer,
  wrong,
  wrongOpen,
  onWrongOpen,
  onWrong,
}: {
  message: DuetMessage;
  first: boolean;
  last: boolean;
  task: DuetTask | undefined;
  onReply: (task: { taskId: string; label: string }) => void;
  /** On a confirm: the owner's answer once given. */
  answer: "yes" | "no" | undefined;
  answering: boolean;
  onAnswer: (choice: "yes" | "no") => void;
  /** Marked Not right. */
  wrong: boolean;
  wrongOpen: boolean;
  onWrongOpen: (open: boolean) => void;
  onWrong: (note: string) => Promise<void>;
}) {
  const fromTask = message.from === "duet" && message.taskId;
  const toTask = message.from === "owner" && message.taskId;
  const markable = canMarkWrong(message) && !wrong;
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const endPress = () => clearTimeout(press.current);
  useEffect(() => () => clearTimeout(press.current), []);
  const touch = markable
    ? {
        onPointerDown: (event: PointerEvent) => {
          if (event.pointerType !== "touch") return;
          endPress();
          press.current = setTimeout(() => onWrongOpen(true), LONG_PRESS_MS);
        },
        onPointerUp: endPress,
        onPointerCancel: endPress,
        onPointerMove: (event: PointerEvent) => {
          if (event.pointerType === "touch" && Math.hypot(event.movementX, event.movementY) > 6) endPress();
        },
      }
    : {};
  return (
    <li className="duet-row" data-from={message.from} data-first={first ? "" : undefined} data-pending={message.kind === "pending" ? "" : undefined}>
      {fromTask && first && (
        <span className="duet-label">
          {message.label} · {message.taskId}
          {message.kind === "question" || message.kind === "confirm" ? " asks" : message.kind === "update" ? " update" : message.kind === "failed" ? " failed" : ""}
        </span>
      )}
      {toTask && first && (
        <span className="duet-label">
          To {message.label} · {message.taskId}
        </span>
      )}
      <div className="duet-line">
        <div className="duet-bubble" data-tail={last ? "" : undefined} data-kind={message.kind} {...touch}>
          {fromTask && message.quote && message.kind === "result" && <p className="duet-quote">↳ “{message.quote}”</p>}
          {message.from === "duet" ? (
            <div className="duet-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
              >
                {message.text}
              </ReactMarkdown>
            </div>
          ) : (
            <p className="duet-plain">{message.text}</p>
          )}
          {message.confirm && (
            <div className="duet-confirm" data-state={answer ?? "pending"}>
              {message.confirm.action && <p className="duet-confirm-action">{message.confirm.action}</p>}
              {answer ? (
                <p className="duet-confirm-said">{answer === "yes" ? "You said go ahead" : "You said don't"}</p>
              ) : (
                <div className="duet-confirm-buttons">
                  <button type="button" disabled={answering} onClick={() => onAnswer("yes")}>
                    Go ahead
                  </button>
                  <button type="button" disabled={answering} onClick={() => onAnswer("no")}>
                    Don&apos;t
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {fromTask && (
          <button
            type="button"
            className="duet-icon duet-reply"
            aria-label={"Reply to " + message.label}
            title={task && isActive(task) ? "Reply: it reaches the task at its next step" : "Reply: the task picks it up again"}
            onClick={() => onReply({ taskId: message.taskId, label: message.label })}
          >
            <CornerUpLeft size={14} />
          </button>
        )}
        {markable && !wrongOpen && (
          <button type="button" className="duet-icon duet-wrong" aria-label="Not right" title="Not right: tell Duet this missed" onClick={() => onWrongOpen(true)}>
            <ThumbsDown size={13} />
          </button>
        )}
      </div>
      {markable && wrongOpen && <WrongNote onSend={onWrong} onCancel={() => onWrongOpen(false)} />}
      {wrong && <span className="duet-wrong-note">Marked not right</span>}
    </li>
  );
}

/** The one-line "What was wrong?" box under a Duet bubble. */
function WrongNote({ onSend, onCancel }: { onSend: (note: string) => Promise<void>; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <form
      className="duet-wrong-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSending(true);
        void onSend(note).finally(() => setSending(false));
      }}
    >
      <input
        ref={field}
        value={note}
        maxLength={500}
        placeholder="What was wrong? (optional)"
        aria-label="What was wrong? (optional)"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      />
      <button type="submit" disabled={sending}>
        Send
      </button>
      <button type="button" className="duet-wrong-cancel" aria-label="Cancel" onClick={onCancel}>
        <X size={13} />
      </button>
    </form>
  );
}
