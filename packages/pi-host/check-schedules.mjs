// Scheduled jobs (docs/SCHEDULES.md) on a real Harness over SQLite, with a scripted fake model
// and an injected clock: next-time maths (Sydney daylight saving both ways, weekdays in the
// zone, weekly, intervals, once), a run on time starting a filed conversation with the prompt,
// no double run across closing and reopening the store, the missed-run rule, the overlap skip,
// pause and resume, delete stopping the task, run now, appending to one conversation and
// argument checks.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSchedules, cleanWhen, prepareSchedule, SchedulesDoc, MISSED_AFTER_MS } from './schedules.mjs';
import { describeWhen, localToInstant, nextRun, wallClock } from './schedule-time.mjs';
import { nativeTitleDoc } from './orchestration.mjs';
import { OrganiseDoc } from './organise-doc.mjs';

const TZ = 'Australia/Sydney';
const iso = (ms) => new Date(ms).toISOString();
const Z = (text) => Date.parse(text);
const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;
const passed = [];
const ok = (label) => passed.push(label);

// ---- Next-time maths --------------------------------------------------------------------
{
  const daily = (time) => ({ when: { kind: 'daily', time }, timezone: TZ });
  // Spring forward: 2025-10-05 02:00 AEST becomes 03:00 AEDT. 02:30 does not exist: 03:30.
  assert.equal(iso(nextRun(daily('02:30'), Z('2025-10-04T12:00:00Z'))), '2025-10-04T16:30:00.000Z');
  assert.equal(wallClock(Z('2025-10-04T16:30:00Z'), TZ).hour, 3);
  // 08:00 either side of the change: 22:00Z (AEST, +10) then 21:00Z (AEDT, +11), 23 hours apart.
  const before = nextRun(daily('08:00'), Z('2025-10-03T21:00:00Z'));
  const after = nextRun(daily('08:00'), before);
  assert.equal(iso(before), '2025-10-03T22:00:00.000Z');
  assert.equal(iso(after), '2025-10-04T21:00:00.000Z');
  assert.equal(after - before, 23 * HOUR);
  // Fall back: 2026-04-05 03:00 AEDT becomes 02:00 AEST. 02:30 happens twice: run at the first only.
  const first = nextRun(daily('02:30'), Z('2026-04-04T12:00:00Z'));
  assert.equal(iso(first), '2026-04-04T15:30:00.000Z');
  assert.equal(iso(nextRun(daily('02:30'), first)), '2026-04-05T16:30:00.000Z', 'the repeated 02:30 does not run twice');
  assert.equal(iso(localToInstant({ year: 2026, month: 4, day: 5, hour: 9, minute: 0 }, TZ)), '2026-04-04T23:00:00.000Z');
  ok('Sydney daylight saving: missing 02:30 runs at 03:30, repeated 02:30 runs once, 08:00 stays 08:00 local');

  // Weekdays use the zone's weekday: Sat 7 Mar 09:00 Sydney is still Friday in UTC.
  const weekdays = { when: { kind: 'weekdays', time: '10:00' }, timezone: TZ };
  assert.equal(iso(nextRun(weekdays, Z('2026-03-06T22:00:00Z'))), '2026-03-08T23:00:00.000Z', 'Saturday in Sydney skips to Monday 10:00');
  let at = Z('2026-03-06T00:00:00Z'); // Fri 11:00 Sydney
  const seen = [];
  for (let i = 0; i < 6; i++) { at = nextRun(weekdays, at); seen.push(wallClock(at, TZ).weekday); }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 1]);
  const weekly = { when: { kind: 'weekly', days: ['mon', 'thu'], time: '17:30' }, timezone: TZ };
  at = Z('2026-03-02T07:00:00Z'); // Mon 18:00 Sydney, after 17:30
  const thursday = nextRun(weekly, at);
  assert.deepEqual([wallClock(thursday, TZ).weekday, wallClock(thursday, TZ).hour, wallClock(thursday, TZ).minute], [4, 17, 30]);
  assert.equal(wallClock(nextRun(weekly, thursday), TZ).weekday, 1);
  // Another zone: New York's weekday rule follows New York.
  assert.equal(iso(nextRun({ when: { kind: 'weekdays', time: '08:00' }, timezone: 'America/New_York' }, Z('2026-03-07T12:00:00Z'))), '2026-03-09T12:00:00.000Z');
  ok('weekday and weekly rules use the weekday in the schedule zone');

  const interval = { when: { kind: 'interval', every: 90, unit: 'minutes' }, timezone: TZ, anchor: Z('2026-01-01T00:00:00Z') };
  assert.equal(iso(nextRun(interval, Z('2026-01-01T00:00:00Z'))), '2026-01-01T01:30:00.000Z');
  assert.equal(iso(nextRun(interval, Z('2026-01-01T03:00:00Z'))), '2026-01-01T04:30:00.000Z', 'exact boundary moves to the next one');
  const once = { when: { kind: 'once', at: '2026-07-01T09:30' }, timezone: TZ };
  assert.equal(iso(nextRun(once, Z('2026-06-01T00:00:00Z'))), '2026-06-30T23:30:00.000Z');
  assert.equal(nextRun(once, Z('2026-07-01T00:00:00Z')), null);
  assert.throws(() => cleanWhen({ kind: 'interval', every: 4, unit: 'minutes' }), /at most every 5 minutes/);
  assert.deepEqual(cleanWhen({ kind: 'interval', every: 2, unit: 'hours' }), { kind: 'interval', every: 2, unit: 'hours' });
  assert.deepEqual(cleanWhen({ kind: 'Weekly', days: ['Thursday', 'monday', 'mon'], time: '8:05' }), { kind: 'weekly', days: ['mon', 'thu'], time: '08:05' });
  assert.throws(() => cleanWhen({ kind: 'daily', time: '25:00' }), /24-hour/);
  assert.throws(() => cleanWhen({ kind: 'once', at: '2026-02-30T09:00' }), /local date and time/);
  assert.equal(describeWhen({ kind: 'weekly', days: ['mon', 'sun'], time: '08:00' }), 'Mon, Sun at 08:00');
  assert.deepEqual(prepareSchedule({ when: '{"kind":"Weekly","days":"Monday, Friday","time":"8:00"}' }).when, { kind: 'weekly', days: ['mon', 'fri'], time: '08:00' });
  ok('intervals from their anchor, once, minimum 5 minutes, and forgiving day names');
}

// ---- A real Harness ---------------------------------------------------------------------
const directory = await mkdtemp(join(tmpdir(), 'mars-schedules-'));
let clock = Z('2026-03-01T21:58:00Z'); // Mon 2 Mar 2026 08:58 in Sydney (AEDT)
const calls = [];
let hold = false;
const held = new Set();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const models = {
  getModels: () => ['gpt-6-luna', 'gpt-6-astra'].map((id) => ({ id, provider: 'openai', api: 'fake', contextWindow: 100000, maxTokens: 2000, reasoning: true })),
  getModel(provider, id) { return this.getModels().find((model) => model.provider === provider && model.id === id); },
  streamSimple(model, input, options) {
    const stream = new AssistantMessageEventStream();
    const user = input.messages.findLast((message) => message.role === 'user');
    const prompt = typeof user?.content === 'string' ? user.content : user?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    calls.push({ prompt, modelId: model.id, reasoning: options.reasoning });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      held.delete(finish);
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Answer to ' + prompt }], api: 'fake', provider: model.provider, model: model.id, stopReason: options.signal?.aborted ? 'aborted' : 'stop', timestamp: Date.now(), usage };
      stream.push({ type: 'done', reason: message.stopReason, message });
      stream.end(message);
    };
    if (hold) held.add(finish); else queueMicrotask(finish);
    options.signal?.addEventListener('abort', finish, { once: true });
    return stream;
  },
};
const release = () => { for (const finish of [...held]) finish(); };

let harness, root, schedules;
async function open() {
  const registry = createRegistry();
  schedules = createSchedules({
    harness: () => harness, rootId: () => root.id, context, models,
    defaults: async () => ({ defaultModel: 'gpt-6-astra', defaultEffort: 'high' }),
    defaultAgent: () => ({ model: { provider: 'openai', modelId: 'gpt-6-luna' } }),
    checkConversation: async (id) => { if (!(await harness.conversation(Number(id), context))) throw Object.assign(Error('Conversation not found'), { status: 404 }); },
    now: () => clock, stepMs: 15, timezone: TZ,
  });
  registry.install(schedules.extension);
  harness = await Harness.open(await openNodeSqliteStorage(join(directory, 'agent.sqlite')), { models, registry, now: () => clock, settings: { retry: { maxRetries: 0 } } }, context);
  root = await harness.root(context, { agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' } } });
  await schedules.boot();
  harness.resume();
}
async function close() { await harness.close(context); harness = undefined; }
async function until(check, message, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw Error('Timed out: ' + message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = async (id) => (await schedules.list()).schedules.find((s) => s.id === id);
async function filed(group) {
  const page = await harness.commit((tx) => tx.scanConversations({ order: 'ascending' }, 200), context);
  const rows = [];
  for (const record of page.items) {
    const organise = await harness.snapshot(OrganiseDoc, record.id, context);
    if (organise?.group === group) rows.push({ record, title: (await harness.snapshot(nativeTitleDoc, record.id, context))?.title });
  }
  return rows;
}
async function userTexts(conversationId) {
  const view = await (await harness.conversation(Number(conversationId), context)).viewState(context);
  try {
    return structuredClone(view.value.entries).flatMap((entry) => (entry.model ?? []).filter((m) => m.role === 'user')).map((m) => typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
  } finally { view.dispose(); }
}
const taskStatus = async (id) => (await harness.getTask(id, context))?.state.status;
const promptCalls = (prompt) => calls.filter((call) => call.prompt === prompt).length;

try {
  await open();
  // A run on time, in a new conversation filed under the schedule's group.
  const brief = await schedules.create({ title: 'Morning brief', prompt: 'Summarise my GitHub notifications.', when: { kind: 'weekdays', time: '09:00' } });
  assert.equal(brief.timezone, TZ);
  assert.equal(brief.summary, 'Weekdays at 09:00 (Australia/Sydney)');
  assert.equal(iso(brief.nextRunAt), '2026-03-01T22:00:00.000Z');
  assert.equal(brief.nextRun, 'Mon 2 Mar, 09:00');
  const firstTask = (await harness.snapshot(SchedulesDoc, context)).schedules[brief.id].taskId;
  assert.equal(await taskStatus(firstTask), 'running');
  await pause(80);
  assert.equal(promptCalls('Summarise my GitHub notifications.'), 0, 'nothing runs before its time');
  clock = Z('2026-03-01T22:00:00Z');
  await until(() => promptCalls('Summarise my GitHub notifications.') === 1, 'the 09:00 run reaches the model');
  const done = await until(async () => { const s = await get(brief.id); return s.lastRun?.status === 'completed' && s; }, 'the run completes');
  assert.equal(calls.at(-1).modelId, 'gpt-6-astra', 'a new run uses the Settings default model');
  assert.equal(calls.at(-1).reasoning, 'high', 'and the default effort');
  assert.equal(iso(done.nextRunAt), '2026-03-02T22:00:00.000Z', 'next is Tuesday 09:00');
  const runs = await filed('Morning brief');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].record.owner, undefined, 'run conversations are top-level, so Recents lists them');
  assert.equal(runs[0].title, 'Morning brief, Mon 2 Mar, 09:00');
  assert.equal(String(runs[0].record.id), done.lastRun.conversationId);
  assert.deepEqual(await userTexts(done.lastRun.conversationId), ['Summarise my GitHub notifications.']);
  ok('a run on time starts a conversation with the prompt, titled and filed in the schedule group, on the default model and effort');

  // No double run across close and reopen, including a close in the middle of a run.
  await close();
  await open();
  await pause(120);
  assert.equal(promptCalls('Summarise my GitHub notifications.'), 1, 'reopening at the same time does not run Monday again');
  hold = true;
  clock = Z('2026-03-02T22:00:00Z');
  await until(() => promptCalls('Summarise my GitHub notifications.') === 2, 'Tuesday run starts');
  await close();
  hold = false;
  release();
  await open();
  const tuesday = await until(async () => { const s = await get(brief.id); return s.lastRun?.due === Z('2026-03-02T22:00:00Z') && s.lastRun.status === 'completed' && s; }, 'Tuesday run finishes after reopen');
  const afterReopen = await filed('Morning brief');
  assert.equal(afterReopen.length, 2, 'one conversation per run, none duplicated');
  assert.deepEqual(await userTexts(tuesday.lastRun.conversationId), ['Summarise my GitHub notifications.'], 'the prompt was sent once');
  assert.equal(tuesday.runs.length, 2);
  ok('closing and reopening the store, even mid-run, never runs a slot twice');

  // Missed while down: more than an hour late is recorded as missed; under an hour runs once.
  await close();
  clock = Z('2026-03-03T22:00:00Z') + 2 * HOUR; // Wed 11:00, two hours after 09:00
  const before = calls.length;
  await open();
  const missed = await until(async () => { const s = await get(brief.id); return s.lastRun?.status === 'missed' && s; }, 'Wednesday recorded as missed');
  assert.equal(missed.lastRun.due, Z('2026-03-03T22:00:00Z'));
  assert.match(missed.lastRun.reason, /not running at Wed 4 Mar, 09:00/);
  assert.equal(iso(missed.nextRunAt), '2026-03-04T22:00:00.000Z', 'next is Thursday');
  await pause(80);
  assert.equal(calls.length, before, 'a missed run is not sent');
  await close();
  clock = Z('2026-03-04T22:00:00Z') + 30 * MIN; // Thursday, 30 minutes late
  await open();
  const late = await until(async () => { const s = await get(brief.id); return s.lastRun?.due === Z('2026-03-04T22:00:00Z') && s.lastRun.status === 'completed' && s; }, 'a run under an hour late still runs');
  assert.equal(calls.length, before + 1, 'once');
  assert.equal(iso(late.nextRunAt), '2026-03-05T22:00:00.000Z');
  assert.ok(MISSED_AFTER_MS === HOUR);
  ok('a run missed by more than an hour is recorded as missed; less than an hour late runs once at start-up');

  // Pause and resume.
  const paused = await schedules.update({ id: brief.id, enabled: false });
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextRunAt, null);
  await until(async () => (await taskStatus(firstTask)) === 'terminal' || (await taskStatus(firstTask)) === undefined, 'pausing ends the task');
  clock = Z('2026-03-05T22:00:00Z') + MIN;
  await pause(100);
  assert.equal(calls.length, before + 1, 'nothing runs while paused');
  const resumed = await schedules.update({ id: brief.id, enabled: true });
  assert.equal(iso(resumed.nextRunAt), '2026-03-08T22:00:00.000Z', 'resumes at the next run time (Monday), not the one missed while paused');
  const resumedTask = (await harness.snapshot(SchedulesDoc, context)).schedules[brief.id].taskId;
  assert.notEqual(resumedTask, firstTask);
  assert.equal(await taskStatus(resumedTask), 'running');
  ok('pause stops the task and runs nothing; resume starts a new task from the next run time');

  // Run now: a manual run in a new conversation, timetable unchanged; refused while one is going.
  hold = true;
  const manual = await schedules.runNow({ id: brief.id });
  assert.equal(manual.run.manual, true);
  assert.equal(manual.run.status, 'running');
  assert.equal(manual.schedule.nextRunAt, resumed.nextRunAt, 'the timetable is unchanged');
  await until(() => held.size === 1, 'run now reaches the model');
  await assert.rejects(schedules.runNow({ id: brief.id }), (error) => error.status === 409 && /still going/.test(error.message));
  release();
  hold = false;
  await until(async () => (await get(brief.id)).lastRun.status === 'completed', 'manual run completes');
  assert.deepEqual(await userTexts(manual.run.conversationId), ['Summarise my GitHub notifications.']);
  assert.equal((await filed('Morning brief')).length, 4);
  ok('run now sends the prompt at once in a new filed conversation, leaves the timetable alone, and is refused while a run is going');

  // Overlap: a run still going makes the next one skip.
  hold = true;
  const poll = await schedules.create({ title: 'Inbox poll', prompt: 'Check the inbox.', when: { kind: 'interval', every: 5, unit: 'minutes' } });
  assert.equal(poll.nextRunAt, clock + 5 * MIN);
  clock += 5 * MIN;
  await until(() => promptCalls('Check the inbox.') === 1 && held.size === 1, 'first poll is running');
  clock += 5 * MIN;
  const skipped = await until(async () => { const s = await get(poll.id); return s.lastRun?.status === 'skipped' && s; }, 'second poll skipped');
  assert.equal(skipped.runs[1].status, 'running');
  assert.match(skipped.lastRun.reason, /still going/);
  assert.equal(promptCalls('Check the inbox.'), 1);
  release();
  hold = false;
  await until(async () => (await get(poll.id)).runs[1].status === 'completed', 'first poll settles');
  clock += 5 * MIN;
  await until(() => promptCalls('Check the inbox.') === 2, 'third poll runs');
  ok('a run is skipped and recorded while the previous run of the schedule is still going');

  // Delete stops the task.
  const pollTask = (await harness.snapshot(SchedulesDoc, context)).schedules[poll.id].taskId;
  assert.deepEqual(await schedules.remove({ id: poll.id }), { deleted: true, id: poll.id });
  assert.equal(await taskStatus(pollTask), 'terminal');
  assert.equal((await harness.snapshot(SchedulesDoc, context)).schedules[poll.id], undefined);
  const count = promptCalls('Check the inbox.');
  clock += 15 * MIN;
  await pause(100);
  assert.equal(promptCalls('Check the inbox.'), count, 'nothing runs after delete');
  await assert.rejects(schedules.runNow({ id: poll.id }), (error) => error.status === 404);
  ok('delete removes the schedule and ends its task');

  // Append to one chosen conversation, on that conversation's own model; a once schedule pauses itself.
  const chosen = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'openai', modelId: 'gpt-6-luna' } } }, context);
  const local = wallClock(clock + 10 * MIN, TZ);
  const at = local.year + '-' + String(local.month).padStart(2, '0') + '-' + String(local.day).padStart(2, '0') + 'T' + String(local.hour).padStart(2, '0') + ':' + String(local.minute).padStart(2, '0');
  const reminder = await schedules.create({ title: 'Reminder', prompt: 'Remind me to stretch.', when: { kind: 'once', at }, conversationId: String(chosen.id), model: 'gpt-6-astra' });
  assert.deepEqual(reminder.target, { kind: 'conversation', conversationId: String(chosen.id) });
  clock = reminder.nextRunAt;
  const finished = await until(async () => { const s = await get(reminder.id); return s.lastRun?.status === 'completed' && s; }, 'once run completes');
  assert.equal(finished.lastRun.conversationId, String(chosen.id));
  assert.deepEqual(await userTexts(chosen.id), ['Remind me to stretch.']);
  assert.equal(calls.at(-1).modelId, 'gpt-6-luna', 'an appended conversation keeps its own model');
  assert.equal(finished.enabled, false, 'a once schedule pauses itself after its run');
  assert.equal(finished.nextRunAt, null);
  assert.equal((await filed('Reminder')).length, 0, 'nothing new is filed for an appended run');
  ok('a schedule can append to one chosen conversation; a once schedule runs once then pauses');

  // Changing the timing replaces the task; a stale task never runs.
  const weekly = await schedules.create({ title: 'Weekly review', prompt: 'Review the week.', when: { kind: 'weekly', days: ['fri'], time: '16:00' }, model: 'gpt-6-luna', effort: 'low' });
  const oldTask = (await harness.snapshot(SchedulesDoc, context)).schedules[weekly.id].taskId;
  const moved = await schedules.update({ id: weekly.id, when: { kind: 'daily', time: '07:15' }, prompt: 'Review yesterday.' });
  assert.equal(moved.summary, 'Every day at 07:15 (Australia/Sydney)');
  assert.equal(await taskStatus(oldTask), 'terminal');
  const renamed = await schedules.update({ id: weekly.id, title: 'Daily review' });
  assert.equal(renamed.nextRunAt, moved.nextRunAt, 'a title change keeps the task and time');
  clock = moved.nextRunAt;
  await until(() => promptCalls('Review yesterday.') === 1, 'the updated prompt runs at the new time');
  assert.equal(calls.at(-1).modelId, 'gpt-6-luna');
  assert.equal(calls.at(-1).reasoning, 'low');
  assert.equal(promptCalls('Review the week.'), 0);
  await until(async () => (await filed('Daily review')).length === 1, 'filed under the new title');
  ok('changing timing replaces the task, prompt and title changes apply to the next run, chosen model and effort are used');

  // Start-up repairs a schedule whose task is gone.
  await until(async () => (await get(weekly.id)).lastRun?.status === 'completed', 'review settles');
  const stored = (await harness.snapshot(SchedulesDoc, context)).schedules[weekly.id];
  await harness.abortTask(stored.taskId, context);
  await until(async () => (await taskStatus(stored.taskId)) === 'terminal', 'the task ends');
  await close();
  await open();
  const repaired = (await harness.snapshot(SchedulesDoc, context)).schedules[weekly.id];
  assert.notEqual(repaired.taskId, stored.taskId);
  assert.equal(await taskStatus(repaired.taskId), 'running');
  assert.equal(repaired.nextRunAt, stored.nextRunAt);
  ok('start-up gives an enabled schedule whose task ended a new task at the same next time');

  // Argument checks, as the HTTP routes and tools see them.
  await assert.rejects(schedules.create({ title: 'Too often', prompt: 'x', when: { kind: 'interval', every: 4 } }), /every 5 minutes/);
  await assert.rejects(schedules.create({ title: 'Bad zone', prompt: 'x', when: { kind: 'daily', time: '08:00' }, timezone: 'Mars/Olympus' }), /IANA/);
  await assert.rejects(schedules.create({ title: 'Past', prompt: 'x', when: { kind: 'once', at: '2020-01-01T08:00' } }), /already passed/);
  await assert.rejects(schedules.create({ title: '', prompt: 'x', when: { kind: 'daily', time: '08:00' } }), /title/);
  await assert.rejects(schedules.create({ title: 'Model', prompt: 'x', when: { kind: 'daily', time: '08:00' }, model: 'nope' }), /Unknown model/);
  await assert.rejects(schedules.create({ title: 'Gone', prompt: 'x', when: { kind: 'daily', time: '08:00' }, conversationId: '99999' }), /not found/);
  await assert.rejects(schedules.update({ id: 'sch_missing', enabled: false }), (error) => error.status === 404);
  assert.equal((await schedules.route('GET', '/api/schedules')).timezone, TZ);
  assert.equal(await schedules.route('POST', '/api/other', {}), undefined);
  const viaRoute = await schedules.route('POST', '/api/schedules', { title: 'From HTTP', prompt: 'Hello', when: { kind: 'daily', time: '06:00' } });
  assert.equal(viaRoute.schedule.title, 'From HTTP');
  assert.equal((await schedules.route('POST', '/api/schedules/delete', { id: viaRoute.schedule.id })).deleted, true);
  // The tools are registered with their task.
  const names = schedules.extension.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_run_now', 'schedule_update']);
  ok('bad timing, zone, past times, unknown models, conversations and ids are refused with a sentence; routes answer');

  await close();
  console.log('PASS schedules: ' + passed.length + ' checks\n- ' + passed.join('\n- '));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (harness) await harness.close(context).catch(() => {});
} finally {
  await rm(directory, { recursive: true, force: true });
}
