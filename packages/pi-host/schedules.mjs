// Scheduled jobs (docs/SCHEDULES.md). Definitions live in one session-scoped Pi document and
// each enabled schedule has one Pi task that sleeps until its next run time, sends the prompt
// to a conversation and sleeps again. Pi owns the timing, recovery and the conversations: there
// is no other timer, file or database.
import { randomBytes, randomUUID } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import { configure, defineDoc, defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable';
import { modelSelection } from './oauth-sessions.mjs';
import { nativeTitleDoc } from './orchestration.mjs';
import { OrganiseDoc } from './organise-doc.mjs';
import {
  DAY_NAMES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, describeWhen, formatLocal, nextRun, parseLocal, parseTime, validTimeZone,
} from './schedule-time.mjs';

export const SchedulesDoc = defineDoc({ kind: 'mars.schedules', version: 1, scope: 'session', initial: () => ({ schedules: {} }) });
export const SCHEDULE_TASK = 'mars.schedule.v1';
/** A run more than this late (Mars was down) is recorded as missed instead of sent. */
export const MISSED_AFTER_MS = 3600000;
const KEEP_RUNS = 20;
const TITLE_MAX = 60;
const PROMPT_MAX = 20000;
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const KINDS = ['interval', 'daily', 'weekdays', 'weekly', 'once'];
const LIVE = new Set(['starting', 'running']);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const nativeId = (value) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const plain = (value) => JSON.parse(JSON.stringify(value));
const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const pad = (value) => String(value).padStart(2, '0');

/** The owner's time zone: MARS_TIMEZONE, else the host's zone unless it is UTC, else Australia/Sydney. */
export function defaultTimezone(env = process.env) {
  if (validTimeZone(env.MARS_TIMEZONE)) return env.MARS_TIMEZONE;
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return system && !/^(UTC|GMT|Etc\/.*)$/.test(system) && validTimeZone(system) ? system : 'Australia/Sydney';
}

function dayName(value) {
  const name = String(value ?? '').trim().toLowerCase().slice(0, 3);
  if (!DAY_NAMES.includes(name)) throw fail('days must be day names like "mon", "tue" or "sun"');
  return name;
}

/** A checked copy of a timing, in the stored form. Throws a sentence saying what to fix. */
export function cleanWhen(raw) {
  let when = raw;
  if (typeof when === 'string') {
    try { when = JSON.parse(when); } catch { throw fail('when must be an object, e.g. { kind: "daily", time: "08:00" }'); }
  }
  if (!when || typeof when !== 'object' || Array.isArray(when)) throw fail('when must be an object, e.g. { kind: "daily", time: "08:00" }');
  const kind = String(when.kind ?? '').trim().toLowerCase();
  if (!KINDS.includes(kind)) throw fail('when.kind must be "interval", "daily", "weekdays", "weekly" or "once"');
  const time = () => {
    const parsed = parseTime(when.time);
    if (!parsed) throw fail('when.time must be a 24-hour time like "08:00" or "17:30"');
    return pad(parsed.hour) + ':' + pad(parsed.minute);
  };
  if (kind === 'interval') {
    const every = Number(when.every);
    if (when.unit !== undefined && !/^(m|h)/i.test(String(when.unit))) throw fail('when.unit must be "minutes" or "hours"');
    const unit = /^h/i.test(String(when.unit ?? '')) ? 'hours' : 'minutes';
    if (!Number.isInteger(every) || every < 1) throw fail('when.every must be a whole number, e.g. 30');
    const minutes = every * (unit === 'hours' ? 60 : 1);
    if (minutes < MIN_INTERVAL_MINUTES) throw fail('A schedule can run at most every ' + MIN_INTERVAL_MINUTES + ' minutes');
    if (minutes > MAX_INTERVAL_MINUTES) throw fail('An interval can be at most 7 days; use "weekly" for longer gaps');
    return { kind, every, unit };
  }
  if (kind === 'daily' || kind === 'weekdays') return { kind, time: time() };
  if (kind === 'weekly') {
    const list = typeof when.days === 'string' ? when.days.split(/[\s,]+/).filter(Boolean) : when.days;
    if (!Array.isArray(list) || !list.length) throw fail('when.days must list at least one day, e.g. ["mon", "thu"]');
    const days = new Set(list.map(dayName));
    return { kind, days: [...DAY_NAMES.slice(1), 'sun'].filter((day) => days.has(day)), time: time() };
  }
  const at = parseLocal(when.at);
  if (!at) throw fail('when.at must be a local date and time like "2026-07-01T09:30"');
  return { kind, at: at.year + '-' + pad(at.month) + '-' + pad(at.day) + 'T' + pad(at.hour) + ':' + pad(at.minute) };
}

/** Public view of a stored schedule. */
function view(schedule) {
  const s = plain(schedule);
  const runs = s.runs ?? [];
  return {
    id: s.id, title: s.title, prompt: s.prompt, when: s.when, timezone: s.timezone,
    summary: describeWhen(s.when) + ' (' + s.timezone + ')',
    target: s.target, model: s.model, effort: s.effort, enabled: s.enabled,
    createdAt: s.createdAt, updatedAt: s.updatedAt,
    nextRunAt: s.nextRunAt ?? null, nextRun: s.nextRunAt ? formatLocal(s.nextRunAt, s.timezone) : '',
    lastRun: runs[0] ?? null, runs,
  };
}

/** Newest first: the last KEEP_RUNS runs, plus any older run still going so the overlap check still sees it. */
function record(s, run) {
  let kept = 0;
  s.runs = [run, ...(s.runs ?? []).filter((row) => row.key !== run.key).map(plain)]
    .filter((row) => LIVE.has(row.status) || ++kept <= KEEP_RUNS);
}
function patchRun(s, key, change) {
  s.runs = (s.runs ?? []).map((row) => row.key === key ? { ...plain(row), ...change } : plain(row));
}
const settled = (status) => ({ status: 'terminal', outcome: { status: 'completed', result: status } });

/**
 * Schedules over one Harness. `harness` and `rootId` are getters (the host makes them after
 * the registry); `defaults()` gives Settings, Models; `now` and `stepMs` are injectable for checks.
 */
export function createSchedules({
  harness: getHarness, rootId, context, models, defaults = async () => ({}), defaultAgent = () => ({}),
  checkConversation = async () => {}, now = Date.now, stepMs = 60000, timezone = defaultTimezone(),
}) {
  const h = () => {
    const value = getHarness();
    if (!value) throw fail('Mars is still starting. Try again in a moment.', 503);
    return value;
  };

  /** The agent a new run conversation gets: the schedule's model and effort, else the Settings default. */
  async function agentFor(s) {
    const base = await defaults().catch(() => ({}));
    const id = s.model || base.defaultModel || '';
    const effort = s.effort || (s.model ? '' : base.defaultEffort || '');
    const change = { ...defaultAgent() };
    if (id) {
      try {
        const { provider, modelId } = modelSelection(id);
        if (models.getModel(provider, modelId)) change.model = { provider, modelId };
      } catch { /* an unknown model falls back to the host default */ }
    }
    if (effort && change.model) change.thinkingLevel = clampThinkingLevel(models.getModel(change.model.provider, change.model.modelId) ?? {}, effort);
    return change;
  }

  /** Inside a commit: the conversation a run goes to, created and filed for a "new" target. */
  async function openRun(tx, s, due, agent) {
    if (s.target.kind === 'conversation') {
      const id = nativeId(s.target.conversationId);
      if (!(await tx.conversation(id))) throw fail('The conversation this schedule adds to no longer exists');
      return String(id);
    }
    const created = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await configure(tx, created.id, agent);
    const title = await tx.doc(nativeTitleDoc, created.id);
    title.title = oneLine(s.title + ', ' + formatLocal(due, s.timezone), 160);
    title.schedule = s.id;
    (await tx.doc(OrganiseDoc, created.id)).group = s.title;
    return String(created.id);
  }

  /** Inside a commit: settle live runs from their submissions; true when one is still going. */
  async function settle(tx, s) {
    let busy = false;
    for (const run of plain(s.runs ?? [])) {
      if (!LIVE.has(run.status) || !run.conversationId) continue;
      const found = await tx.submissionByRequest(nativeId(run.conversationId), run.key);
      if (!found) {
        if (run.status === 'starting' && now() - run.at < 600000) busy = true;
        else patchRun(s, run.key, { status: 'failed', reason: 'Stopped before the prompt was sent' });
      } else if (found.status === 'queued' || found.status === 'placed') {
        busy = true;
        if (run.status !== 'running') patchRun(s, run.key, { status: 'running', submissionId: found.id });
      } else if (found.status === 'done') patchRun(s, run.key, { status: 'completed', finishedAt: now() });
      else patchRun(s, run.key, { status: 'failed', reason: oneLine(found.reason || 'No answer', 300), finishedAt: now() });
    }
    return busy;
  }

  async function submit(conversation, s, key, ctx = context) {
    const submission = await conversation.submit({
      type: 'input', content: s.prompt, requestId: key,
      entry: { kind: 'mars.user', data: { attachments: [], schedule: { id: s.id, title: s.title } } },
    }, ctx);
    return submission.id;
  }

  /** Inside a commit: create the task that waits for the next run after `after`. */
  async function startTask(tx, s, after, due = nextRun(s, after)) {
    if (due === null) {
      s.enabled = false; s.taskId = null; s.nextRunAt = null;
      return;
    }
    s.taskId = await tx.createTask(task, { scheduleId: s.id, due }, { ownership: { kind: 'conversation' }, conversationId: rootId(), background: true });
    s.nextRunAt = due;
  }

  /** Inside a task commit: the next wait, or the end for a once schedule. */
  function advance(s, due, at) {
    const next = nextRun(s, Math.max(at, due));
    if (next === null) {
      s.enabled = false; s.taskId = null; s.nextRunAt = null;
      return settled('finished');
    }
    s.nextRunAt = next;
    return { status: 'running', checkpoint: { phase: 'wait', due: next } };
  }

  const task = defineTask({
    name: SCHEDULE_TASK,
    version: 1,
    initial: (input) => ({ phase: 'wait', due: input.due }),
    phases: {
      wait: async (current, runtime, ctx) => {
        const { due } = current.state.checkpoint;
        const id = current.input.scheduleId;
        // Short steps re-read the Harness clock, so a suspend or clock change is noticed.
        while (runtime.now() < due) await runtime.sleep(Math.min(due, runtime.now() + stepMs), ctx);
        const before = (await runtime.snapshot(SchedulesDoc, ctx))?.schedules?.[id];
        const agent = before ? await agentFor(before) : {};
        await runtime.commit(async (tx) => {
          const s = (await tx.doc(SchedulesDoc)).schedules[id];
          if (!s || !s.enabled || s.taskId !== runtime.taskId) return settled('replaced');
          const at = runtime.now();
          const key = 'schedule:' + id + ':' + due;
          if (at - due > MISSED_AFTER_MS) {
            record(s, { key, due, at, status: 'missed', reason: 'Mars was not running at ' + formatLocal(due, s.timezone) });
            return advance(s, due, at);
          }
          if (await settle(tx, s)) {
            record(s, { key, due, at, status: 'skipped', reason: 'The previous run was still going' });
            return advance(s, due, at);
          }
          let conversationId;
          try { conversationId = await openRun(tx, s, due, agent); } catch (error) {
            record(s, { key, due, at, status: 'failed', reason: oneLine(error.message, 300) });
            return advance(s, due, at);
          }
          record(s, { key, due, at, status: 'starting', conversationId });
          return { status: 'running', checkpoint: { phase: 'send', due, key, conversationId } };
        }, ctx);
      },
      send: async (current, runtime, ctx) => {
        const { due, key, conversationId } = current.state.checkpoint;
        const id = current.input.scheduleId;
        const s = (await runtime.snapshot(SchedulesDoc, ctx))?.schedules?.[id];
        // Paused, changed or deleted after the "send" checkpoint (a crash before the old task was
        // aborted): this task no longer owns the schedule, so it must not send.
        const owner = Boolean(s?.enabled) && s.taskId === runtime.taskId;
        let submissionId, reason;
        if (owner) {
          try {
            const conversation = await runtime.conversation(nativeId(conversationId), ctx);
            if (!conversation) throw Error('The conversation for this run is gone');
            // The run key is the request id: a repeat after a restart finds the same submission.
            submissionId = await submit(conversation, s, key, ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            reason = oneLine(error.message, 300);
          }
        }
        await runtime.commit(async (tx) => {
          const latest = (await tx.doc(SchedulesDoc)).schedules[id];
          if (!latest) return settled('deleted');
          if (owner) patchRun(latest, key, reason ? { status: 'failed', reason } : { status: 'running', submissionId });
          else {
            // Sent before a restart, the run stays tracked; otherwise it was never sent.
            const found = await tx.submissionByRequest(nativeId(conversationId), key);
            patchRun(latest, key, found ? { status: 'running', submissionId: found.id } : { status: 'failed', reason: 'Not sent: the schedule was paused or changed first' });
          }
          if (!latest.enabled || latest.taskId !== runtime.taskId) return settled('replaced');
          return advance(latest, due, runtime.now());
        }, ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });

  async function stop(taskId) {
    if (taskId === null || taskId === undefined) return;
    try {
      // Wait briefly for the abort to finish so a reply shows the task gone; it ends itself anyway.
      if ((await h().abortTask(taskId, context)) === 'marked') {
        let timer;
        await Promise.race([h().waitForTask(taskId, context), new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]).finally(() => clearTimeout(timer));
      }
    } catch { /* already finished */ }
  }

  /** Checked fields for create (base undefined) or update (base the stored schedule). */
  async function clean(input = {}, base, here) {
    const out = {};
    if (!base || input.title !== undefined) {
      out.title = oneLine(input.title, 200);
      if (!out.title) throw fail('title must be a short name, e.g. "GitHub notifications"');
      if (out.title.length > TITLE_MAX) throw fail('title must be at most ' + TITLE_MAX + ' characters');
    }
    if (!base || input.prompt !== undefined) {
      out.prompt = String(input.prompt ?? '').trim();
      if (!out.prompt) throw fail('prompt must say what Mars should do at each run');
      if (out.prompt.length > PROMPT_MAX) throw fail('prompt must be at most 20,000 characters');
    }
    if (!base || input.when !== undefined) out.when = cleanWhen(input.when);
    if (!base || input.timezone !== undefined) {
      out.timezone = input.timezone ? String(input.timezone).trim() : timezone;
      if (!validTimeZone(out.timezone)) throw fail('timezone must be an IANA zone name, e.g. "Australia/Sydney"');
    }
    const where = input.where ?? (input.conversationId !== undefined ? (input.conversationId ? String(input.conversationId) : 'new') : undefined);
    if (!base || where !== undefined) {
      if (!where || where === 'new') out.target = { kind: 'new' };
      else {
        const id = where === 'here' ? here : String(where);
        if (!id || !/^\d+$/.test(id)) throw fail('where must be "new", "here" or a conversation id');
        await checkConversation(id);
        out.target = { kind: 'conversation', conversationId: id };
      }
    }
    if (!base || input.model !== undefined) {
      out.model = String(input.model ?? '').trim();
      if (out.model) {
        const { provider, modelId } = modelSelection(out.model);
        if (!models.getModel(provider, modelId)) throw fail('Unknown model ' + out.model + '; leave model out to use the default from Settings');
      }
    }
    if (!base || input.effort !== undefined) {
      out.effort = String(input.effort ?? '').trim();
      if (out.effort && !EFFORTS.includes(out.effort)) throw fail('effort must be one of ' + EFFORTS.join(', ') + ', or "" for the default');
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw fail('enabled must be true or false');
      out.enabled = input.enabled;
    }
    return out;
  }

  async function read() {
    return (await h().snapshot(SchedulesDoc, context))?.schedules ?? {};
  }
  async function find(id) {
    const s = (await read())[String(id ?? '')];
    if (!s) throw fail('No schedule with id ' + id + '. Use schedule_list to see the ids.', 404);
    return s;
  }

  async function list() {
    let schedules = await read();
    if (Object.values(schedules).some((s) => (s.runs ?? []).some((run) => LIVE.has(run.status)))) {
      schedules = await h().commit(async (tx) => {
        const doc = await tx.doc(SchedulesDoc);
        for (const s of Object.values(doc.schedules)) await settle(tx, s);
        return plain(doc.schedules);
      }, context);
    }
    return { schedules: Object.values(schedules).map(view).sort((a, b) => b.createdAt - a.createdAt), timezone };
  }

  async function create(input = {}, { here } = {}) {
    const fields = await clean(input, undefined, here);
    const at = now();
    const enabled = fields.enabled !== false;
    const s = { id: 'sch_' + randomBytes(6).toString('hex'), ...fields, enabled, anchor: at, createdAt: at, updatedAt: at, taskId: null, nextRunAt: null, runs: [] };
    if (nextRun(s, at) === null) throw fail('That time has already passed in ' + s.timezone + '. Give a time in the future.');
    const stored = await h().commit(async (tx) => {
      const doc = await tx.doc(SchedulesDoc);
      doc.schedules[s.id] = s;
      const draft = doc.schedules[s.id];
      if (enabled) await startTask(tx, draft, at);
      return plain(draft);
    }, context);
    return view(stored);
  }

  /** One commit that changes a schedule and, when its timing or state changed, replaces its task. */
  async function update(input = {}, { here } = {}) {
    const existing = await find(input.id);
    const fields = await clean(input, existing, here);
    const at = now();
    let old = null;
    const stored = await h().commit(async (tx) => {
      const s = (await tx.doc(SchedulesDoc)).schedules[existing.id];
      if (!s) throw fail('No schedule with id ' + existing.id, 404);
      const was = s.enabled;
      Object.assign(s, fields);
      s.updatedAt = at;
      if (fields.when !== undefined) s.anchor = at;
      if (fields.when !== undefined || fields.timezone !== undefined || was !== s.enabled) {
        if (s.enabled && nextRun(s, at) === null) throw fail('That time has already passed in ' + s.timezone + '. Give a new time with when.');
        old = s.taskId ?? null;
        s.taskId = null; s.nextRunAt = null;
        if (s.enabled) await startTask(tx, s, at);
      }
      return plain(s);
    }, context);
    await stop(old);
    return view(stored);
  }

  async function remove({ id } = {}) {
    const existing = await find(id);
    await h().commit(async (tx) => { delete (await tx.doc(SchedulesDoc)).schedules[existing.id]; }, context);
    await stop(existing.taskId);
    return { deleted: true, id: existing.id };
  }

  /** Send the prompt now, outside the timetable. Refused while the last run is still going. */
  async function runNow({ id } = {}) {
    const existing = await find(id);
    const agent = await agentFor(existing);
    const key = 'schedule:' + existing.id + ':manual:' + randomUUID();
    const at = now();
    const conversationId = await h().commit(async (tx) => {
      const s = (await tx.doc(SchedulesDoc)).schedules[existing.id];
      if (!s) throw fail('No schedule with id ' + existing.id, 404);
      if (await settle(tx, s)) throw fail('The last run of this schedule is still going. Wait for it to finish, or stop it in its conversation.', 409);
      const cid = await openRun(tx, s, at, agent);
      record(s, { key, due: at, at, status: 'starting', conversationId: cid, manual: true });
      return cid;
    }, context);
    let change;
    try {
      const conversation = await h().conversation(nativeId(conversationId), context);
      change = { status: 'running', submissionId: await submit(conversation, existing, key) };
    } catch (error) {
      change = { status: 'failed', reason: oneLine(error.message, 300) };
    }
    const stored = await h().commit(async (tx) => {
      const s = (await tx.doc(SchedulesDoc)).schedules[existing.id];
      if (!s) return null;
      patchRun(s, key, change);
      return plain(s);
    }, context);
    const schedule = stored ? view(stored) : view({ ...existing, runs: [] });
    return { schedule, run: schedule.runs.find((run) => run.key === key) ?? { key, at, status: change.status, conversationId } };
  }

  /** At start-up: give every enabled schedule whose task is missing or finished a new one. */
  async function boot() {
    const schedules = await read();
    for (const s of Object.values(schedules)) {
      if (!s.enabled) continue;
      const current = s.taskId === null || s.taskId === undefined ? undefined : await h().getTask(s.taskId, context);
      if (current && current.state.status !== 'terminal' && !current.abortRequested) continue;
      await h().commit(async (tx) => {
        const draft = (await tx.doc(SchedulesDoc)).schedules[s.id];
        if (!draft || !draft.enabled || draft.taskId !== s.taskId) return;
        // A run time missed while the task was missing still follows the missed-run rule.
        await startTask(tx, draft, now(), draft.nextRunAt ?? nextRun(draft, now()));
      }, context);
    }
  }

  /** HTTP (the host checks owner auth first). Undefined when the path is not ours. */
  async function route(method, pathname, body) {
    if (pathname === '/api/schedules' && method === 'GET') return list();
    if (method !== 'POST') return undefined;
    if (pathname === '/api/schedules') return { schedule: await create(body) };
    if (pathname === '/api/schedules/update') return { schedule: await update(body) };
    if (pathname === '/api/schedules/delete') return remove(body);
    if (pathname === '/api/schedules/run-now') return runNow(body);
    return undefined;
  }

  const store = { list, create, update, remove, runNow };
  return { ...store, extension: createScheduleExtension(store, task), task, boot, route, timezone };
}

const RunView = Type.Object({
  status: Type.String({ description: '"running", "completed", "failed", "missed" (Mars was down) or "skipped" (the previous run was still going).' }),
  at: Type.Number({ description: 'When it happened, milliseconds since 1970.' }),
  conversationId: Type.Optional(Type.String({ description: 'The conversation the run went to, once it was sent.' })),
  reason: Type.Optional(Type.String({ description: 'Why it failed, was missed or was skipped.' })),
}, { additionalProperties: true });
const ScheduleView = Type.Object({
  id: Type.String({ description: 'Schedule id, e.g. "sch_3f9a0c1d2e4b". Pass it to schedule_update, schedule_delete or schedule_run_now.' }),
  title: Type.String({ description: 'Its name; runs are filed in a Recents group with this name.' }),
  summary: Type.String({ description: 'The timing in words, e.g. "Weekdays at 08:00 (Australia/Sydney)".' }),
  enabled: Type.Boolean({ description: 'False while paused.' }),
  nextRun: Type.String({ description: 'Next run in local time, e.g. "Mon 6 Oct, 08:00"; "" when paused or finished.' }),
  nextRunAt: Type.Union([Type.Number(), Type.Null()], { description: 'Next run, milliseconds since 1970, or null.' }),
  lastRun: Type.Union([RunView, Type.Null()], { description: 'The newest run, or null before the first.' }),
}, { additionalProperties: true });
const DAY = Type.Union(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => Type.Literal(day)));
const When = (description) => Type.Object({
  kind: Type.Union(KINDS.map((kind) => Type.Literal(kind)), { description: 'How it repeats: "interval" (every N minutes or hours), "daily", "weekdays" (Monday to Friday), "weekly" (given days) or "once".' }),
  every: Type.Optional(Type.Integer({ minimum: 1, description: 'For "interval": how many minutes or hours between runs, e.g. 30. At least 5 minutes in all.' })),
  unit: Type.Optional(Type.Union([Type.Literal('minutes'), Type.Literal('hours')], { default: 'minutes', description: 'For "interval": "minutes" or "hours".' })),
  time: Type.Optional(Type.String({ description: 'For "daily", "weekdays" and "weekly": 24-hour local time, e.g. "08:00" or "17:30".' })),
  days: Type.Optional(Type.Array(DAY, { description: 'For "weekly": the days, e.g. ["mon", "thu"].' })),
  at: Type.Optional(Type.String({ description: 'For "once": local date and time, e.g. "2026-07-01T09:30".' })),
}, { description });
const scheduleId = Type.String({ description: 'Schedule id from schedule_list or schedule_create, e.g. "sch_3f9a0c1d2e4b".' });
const fields = {
  prompt: Type.String({ description: 'What Mars is asked at each run, written as the owner would type it, e.g. "Summarise my unread GitHub notifications."' }),
  timezone: Type.String({ description: 'IANA time zone for the times, e.g. "Australia/Sydney". Default: the owner\'s zone.' }),
  where: Type.String({ description: '"new" (default): a new conversation per run, grouped under the title. "here": add every run to this conversation. Or a conversation id.' }),
  model: Type.String({ description: 'Model for new run conversations, e.g. "gpt-6-luna" or "anthropic/claude-opus-5-5". Default "": the default model in Settings, Models.' }),
  effort: Type.String({ description: 'Thinking effort, e.g. "low", "medium" or "high". Default "": the default effort.' }),
};

/** Small-model slips repaired before validation: a JSON string for when, day names, a capitalised kind. */
export function prepareSchedule(args) {
  if (!args || typeof args !== 'object') return args;
  let when = args.when;
  if (typeof when === 'string') { try { when = JSON.parse(when); } catch { return args; } }
  if (!when || typeof when !== 'object') return { ...args, when };
  const fixed = { ...when };
  if (typeof fixed.kind === 'string') fixed.kind = fixed.kind.trim().toLowerCase();
  if (typeof fixed.unit === 'string') fixed.unit = /^h/i.test(fixed.unit) ? 'hours' : /^m/i.test(fixed.unit) ? 'minutes' : fixed.unit;
  if (typeof fixed.every === 'string' && /^\d+$/.test(fixed.every)) fixed.every = Number(fixed.every);
  const days = typeof fixed.days === 'string' ? fixed.days.split(/[\s,]+/).filter(Boolean) : fixed.days;
  if (Array.isArray(days)) fixed.days = days.map((day) => typeof day === 'string' ? day.trim().toLowerCase().slice(0, 3) : day);
  if (typeof fixed.time === 'string' && /^\d:\d\d$/.test(fixed.time.trim())) fixed.time = '0' + fixed.time.trim();
  return { ...args, when: fixed };
}

function createScheduleExtension(store, task) {
  const make = (name, description, parameters, result, execute, replay = 'unsafe', prepareArguments = undefined) => defineTool({
    name, description, parameters, replay, deferred: true, executionMode: 'sequential',
    outputLimits: { maxBytes: 10000, maxLines: 200 }, structuredOutputSchema: result,
    ...(prepareArguments ? { prepareArguments } : {}),
    execute: async (args, api) => {
      const value = await execute(args, api);
      return { output: [{ type: 'text', text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
  const one = Type.Object({ schedule: ScheduleView });
  const tools = [
    make('schedule_create', [
      'Create a schedule that sends a prompt to Mars at set times, such as every weekday at 8am.',
      'Use it when the owner wants something done regularly or later, e.g. "every weekday at 8am, summarise my GitHub notifications". Turn their words into when:',
      '{ kind: "interval", every: 30, unit: "minutes" } (at least 5 minutes), { kind: "daily", time: "08:00" }, { kind: "weekdays", time: "08:00" }, { kind: "weekly", days: ["mon", "thu"], time: "17:30" } or { kind: "once", at: "2026-07-01T09:30" }.',
      'Times are 24-hour in timezone, default the owner\'s. Each run starts a new conversation in a Recents group named after the title, unless where is "here". It keeps running after restarts. Returns the schedule with its id and nextRun. Change it with schedule_update; try it at once with schedule_run_now.',
      'Example: await tools.schedule_create({ title: "GitHub notifications", prompt: "Summarise my unread GitHub notifications.", when: { kind: "weekdays", time: "08:00" } })',
    ].join('\n'),
    Type.Object({
      title: Type.String({ description: 'Short name, up to 60 characters, e.g. "GitHub notifications". Runs are grouped under it.' }),
      prompt: fields.prompt,
      when: When('When it runs, in the structured form shown in the description.'),
      timezone: Type.Optional(fields.timezone),
      where: Type.Optional(fields.where),
      model: Type.Optional(fields.model),
      effort: Type.Optional(fields.effort),
    }), one, async (args, api) => ({ schedule: await store.create(args, { here: String(api.conversationId) }) }), 'unsafe', prepareSchedule),
    make('schedule_list', [
      'List the owner\'s schedules with their timing, next run and last result.',
      'Use it to find a schedule\'s id before schedule_update, schedule_delete or schedule_run_now, or to answer "what is scheduled?". Each lastRun has a status and, once sent, the conversationId of that run.',
      'Example: const { schedules } = await tools.schedule_list({})',
    ].join('\n'),
    Type.Object({}), Type.Object({
      schedules: Type.Array(ScheduleView, { description: 'Newest first.' }),
      timezone: Type.String({ description: 'The owner\'s default time zone.' }),
    }), () => store.list(), 'safe'),
    make('schedule_update', [
      'Change a schedule, or pause and resume it with enabled.',
      'Use it when the owner wants a different time, prompt, title or model, or says to pause or resume a schedule. Give only the fields that change; a new when replaces the whole timing. enabled: false pauses it (nothing runs) and true resumes it from the next run time. To remove it for good, use schedule_delete. Returns the updated schedule.',
      'Example: await tools.schedule_update({ id: "sch_3f9a0c1d2e4b", enabled: false })',
    ].join('\n'),
    Type.Object({
      id: scheduleId,
      title: Type.Optional(Type.String({ description: 'New name, up to 60 characters. Earlier runs keep their group.' })),
      prompt: Type.Optional(fields.prompt),
      when: Type.Optional(When('New timing, in the same form as schedule_create.')),
      timezone: Type.Optional(fields.timezone),
      where: Type.Optional(fields.where),
      model: Type.Optional(fields.model),
      effort: Type.Optional(fields.effort),
      enabled: Type.Optional(Type.Boolean({ description: 'false pauses the schedule, true resumes it.' })),
    }), one, async (args, api) => ({ schedule: await store.update(args, { here: String(api.conversationId) }) }), 'unsafe', prepareSchedule),
    make('schedule_delete', [
      'Delete a schedule so it never runs again.',
      'Use it when the owner no longer wants it. Conversations from earlier runs stay in Recents. To stop it only for a while, use schedule_update with enabled: false instead.',
      'Example: await tools.schedule_delete({ id: "sch_3f9a0c1d2e4b" })',
    ].join('\n'),
    Type.Object({ id: scheduleId }), Type.Object({
      deleted: Type.Boolean({ description: 'True once it is gone.' }),
      id: Type.String({ description: 'The schedule deleted.' }),
    }), (args) => store.remove(args)),
    make('schedule_run_now', [
      'Run a schedule once now, without changing its timetable.',
      'Use it to try a new schedule or when the owner asks for a run early. It is refused while the previous run is still going. Returns the run with the conversationId it went to; the answer arrives there.',
      'Example: await tools.schedule_run_now({ id: "sch_3f9a0c1d2e4b" })',
    ].join('\n'),
    Type.Object({ id: scheduleId }), Type.Object({
      schedule: ScheduleView,
      run: RunView,
    }), (args) => store.runNow(args)),
  ];
  return defineExtension({ name: 'mars-schedules', tools, tasks: [task] });
}
