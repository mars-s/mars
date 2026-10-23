"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspace } from "@/components/workspace-context";
import {
  DAYS,
  RUN_LABELS,
  createSchedule,
  deleteSchedule,
  loadSchedules,
  runScheduleNow,
  setScheduleEnabled,
  timeZones,
  type DayName,
  type Schedule,
  type ScheduleKind,
  type ScheduleList,
  type ScheduleWhen,
} from "@/lib/pi/schedules";
import "./connection-settings.css";
import "./gateway-settings.css";
import "./schedule-settings.css";

const FREQUENCIES: { id: ScheduleKind; label: string }[] = [
  { id: "weekdays", label: "Weekdays" },
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "On chosen days" },
  { id: "interval", label: "Every few minutes or hours" },
  { id: "once", label: "Once" },
];

const when = (at: number) => {
  const date = new Date(at);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/** The browser's zone, unless it is plain UTC, when the host's default is likelier to be the owner's. */
function browserZone(fallback: string) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && !/^(UTC|Etc\/.*)$/.test(zone) ? zone : fallback || "Australia/Sydney";
}

function ScheduleRow({ schedule, busy, onAct, onOpen }: {
  schedule: Schedule;
  busy: string;
  onAct: (key: string, work: () => Promise<unknown>) => void;
  onOpen?: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const run = schedule.lastRun;
  const disabled = !!busy;
  return (
    <li className="gateway-row schedule-row" data-enabled={schedule.enabled}>
      <div className="gateway-row-text">
        <strong>{schedule.title}</strong>
        <span>
          {schedule.summary}
          {schedule.enabled ? (schedule.nextRun ? `. Next ${schedule.nextRun}` : "") : ". Paused"}
        </span>
        {run ? (
          <span className={run.reason ? "gateway-row-detail schedule-last" : "schedule-last"}>
            Last run{" "}
            <span className="schedule-status" data-status={run.status}>{RUN_LABELS[run.status]}</span>, {when(run.at)}
            {run.manual ? " (run now)" : ""}
            {run.reason ? `: ${run.reason}` : ""}
            {run.conversationId && onOpen && (
              <>
                {" "}
                <button type="button" className="gateway-link schedule-open" onClick={() => onOpen(run.conversationId)}>
                  Open
                </button>
              </>
            )}
          </span>
        ) : (
          <span>No runs yet</span>
        )}
      </div>
      <div className="gateway-row-actions">
        <Button size="sm" variant="outline" disabled={disabled} aria-label={`Run ${schedule.title} now`}
          onClick={() => onAct("run" + schedule.id, () => runScheduleNow(schedule.id))}>
          {busy === "run" + schedule.id ? "Starting…" : "Run now"}
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} aria-label={`${schedule.enabled ? "Pause" : "Resume"} ${schedule.title}`}
          onClick={() => onAct("toggle" + schedule.id, () => setScheduleEnabled(schedule.id, !schedule.enabled))}>
          {schedule.enabled ? "Pause" : "Resume"}
        </Button>
        {confirming ? (
          <Button size="sm" variant="destructive" disabled={disabled} aria-label={`Confirm delete ${schedule.title}`}
            onClick={() => { setConfirming(false); onAct("delete" + schedule.id, () => deleteSchedule(schedule.id)); }}
            onBlur={() => setConfirming(false)}>
            Confirm delete
          </Button>
        ) : (
          <Button size="sm" variant="ghost" disabled={disabled} aria-label={`Delete ${schedule.title}`} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>
    </li>
  );
}

function ScheduleForm({ defaultZone, busy, onCreate }: {
  defaultZone: string;
  busy: boolean;
  onCreate: (draft: Parameters<typeof createSchedule>[0]) => Promise<boolean>;
}) {
  const { selectedId, conversations } = useWorkspace();
  const id = useId();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("weekdays");
  const [time, setTime] = useState("08:00");
  const [days, setDays] = useState<DayName[]>(["mon"]);
  const [every, setEvery] = useState("30");
  const [unit, setUnit] = useState<"minutes" | "hours">("minutes");
  const [at, setAt] = useState("");
  const [zone, setZone] = useState("");
  const [where, setWhere] = useState<"new" | "current">("new");
  const timezone = zone || browserZone(defaultZone);
  const zones = useMemo(() => timeZones(timezone), [timezone]);
  const current = conversations.find((row) => row.id === selectedId);
  const minutes = Number(every) * (unit === "hours" ? 60 : 1);
  const problem =
    kind === "interval" && !(Number.isInteger(Number(every)) && minutes >= 5) ? "Choose at least 5 minutes between runs."
      : kind === "weekly" && !days.length ? "Choose at least one day."
        : kind === "once" && !at ? "Choose the date and time."
          : "";
  const ready = !!title.trim() && !!prompt.trim() && !problem && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const schedule: ScheduleWhen =
      kind === "interval" ? { kind, every: Number(every), unit }
        : kind === "weekly" ? { kind, days, time }
          : kind === "once" ? { kind, at }
            : { kind, time };
    const created = await onCreate({
      title: title.trim(), prompt: prompt.trim(), when: schedule, timezone,
      ...(where === "current" && current ? { conversationId: current.id } : {}),
    });
    if (created) { setTitle(""); setPrompt(""); }
  };

  return (
    <form className="schedule-form" onSubmit={(event) => void submit(event)} aria-labelledby={`${id}-heading`}>
      <div className="connection-settings-heading">
        <h3 id={`${id}-heading`}>New schedule</h3>
      </div>
      <label htmlFor={`${id}-title`}>Title</label>
      <Input id={`${id}-title`} value={title} maxLength={60} placeholder="GitHub notifications" onChange={(event) => setTitle(event.target.value)} />
      <label htmlFor={`${id}-prompt`}>Prompt</label>
      <Textarea id={`${id}-prompt`} value={prompt} maxLength={20000} rows={3} placeholder="Summarise my unread GitHub notifications."
        onChange={(event) => setPrompt(event.target.value)} />
      <div className="schedule-form-grid">
        <div>
          <label htmlFor={`${id}-kind`}>Frequency</label>
          <select id={`${id}-kind`} className="schedule-select" value={kind} onChange={(event) => setKind(event.target.value as ScheduleKind)}>
            {FREQUENCIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </div>
        {kind === "interval" ? (
          <div className="schedule-every">
            <div>
              <label htmlFor={`${id}-every`}>Every</label>
              <Input id={`${id}-every`} type="number" inputMode="numeric" min={1} value={every} onChange={(event) => setEvery(event.target.value)} />
            </div>
            <div>
              <label htmlFor={`${id}-unit`}>Unit</label>
              <select id={`${id}-unit`} className="schedule-select" value={unit} onChange={(event) => setUnit(event.target.value as "minutes" | "hours")}>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </select>
            </div>
          </div>
        ) : kind === "once" ? (
          <div>
            <label htmlFor={`${id}-at`}>Date and time</label>
            <Input id={`${id}-at`} type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
          </div>
        ) : (
          <div>
            <label htmlFor={`${id}-time`}>Time</label>
            <Input id={`${id}-time`} type="time" value={time} onChange={(event) => setTime(event.target.value || "08:00")} />
          </div>
        )}
      </div>
      {kind === "weekly" && (
        <fieldset className="schedule-days">
          <legend>Days</legend>
          {DAYS.map((day) => (
            <button key={day.id} type="button" aria-pressed={days.includes(day.id)} aria-label={day.name}
              onClick={() => setDays((list) => list.includes(day.id) ? list.filter((item) => item !== day.id) : [...list, day.id])}>
              {day.label}
            </button>
          ))}
        </fieldset>
      )}
      <div className="schedule-form-grid">
        <div>
          <label htmlFor={`${id}-zone`}>Time zone</label>
          <select id={`${id}-zone`} className="schedule-select" value={timezone} onChange={(event) => setZone(event.target.value)}>
            {zones.map((name) => <option key={name} value={name}>{name.replace(/_/g, " ")}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-where`}>Where runs go</label>
          <select id={`${id}-where`} className="schedule-select" value={where} onChange={(event) => setWhere(event.target.value as "new" | "current")}>
            <option value="new">A new chat each run, grouped under the title</option>
            {current && <option value="current">{`Add to "${current.title}"`}</option>}
          </select>
        </div>
      </div>
      {problem && (title || prompt) && <p className="connection-settings-help">{problem}</p>}
      <div className="connection-settings-save">
        <Button type="submit" disabled={!ready}>{busy ? "Adding…" : "Add schedule"}</Button>
      </div>
    </form>
  );
}

/** Settings, Schedules: prompts Mars runs on a timetable, with their next run and last result. */
export function ScheduleSettings({ onOpenConversation }: { onOpenConversation?: (id: string) => void }) {
  const { refresh } = useWorkspace();
  const [list, setList] = useState<ScheduleList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      loadSchedules(controller.signal)
        .then((next) => { setList(next); setError(""); })
        .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load schedules."); });
    void load();
    const timer = setInterval(load, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reload]);

  const act = useCallback(async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await work();
      setList(await loadSchedules());
      // A run makes a new chat: show it in Recents straight away.
      void refresh().catch(() => {});
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work. Try again.");
      return false;
    } finally { setBusy(""); }
  }, [refresh]);

  return (
    <div className="connection-settings gateway-settings schedule-settings" aria-busy={!!busy}>
      <p className="connection-settings-intro">
        Mars sends each prompt at its time, even after a restart, and answers it like a message from you. A run more
        than an hour late is skipped, and so is a run while the last one is still going.
      </p>
      {error && <p className="connection-settings-error" role="alert">{error}</p>}
      {!list ? (
        <div className="connection-settings-loading">
          {!error ? <p role="status">Loading schedules…</p> : <Button variant="outline" onClick={() => setReload((n) => n + 1)}>Try again</Button>}
        </div>
      ) : (
        <>
          <section aria-labelledby="schedule-list-heading">
            <div className="connection-settings-heading">
              <h3 id="schedule-list-heading">Schedules</h3>
              {list.schedules.length > 0 && <span>{list.schedules.length}</span>}
            </div>
            {list.schedules.length ? (
              <ul className="gateway-list">
                {list.schedules.map((schedule) => (
                  <ScheduleRow key={schedule.id} schedule={schedule} busy={busy}
                    onAct={(key, work) => void act(key, work)} onOpen={onOpenConversation} />
                ))}
              </ul>
            ) : (
              <p className="connection-settings-help">
                Nothing is scheduled. Add one below, or ask Mars in any chat, for example &ldquo;every weekday at 8am,
                summarise my GitHub notifications&rdquo;.
              </p>
            )}
          </section>
          <section>
            <ScheduleForm defaultZone={list.timezone} busy={busy === "create"}
              onCreate={(draft) => act("create", () => createSchedule(draft))} />
          </section>
        </>
      )}
    </div>
  );
}
