# Schedules

The owner, or the agent on the owner's behalf, can ask Mars to run a prompt on a timetable:
"every weekday at 8am, summarise my GitHub notifications". Mars sends the prompt to a
conversation at each run time, the same way a typed chat message is sent, and the agent
answers it there. Schedules keep working across restarts.

Code: `packages/pi-host/schedule-time.mjs` (pure time maths) and
`packages/pi-host/schedules.mjs` (store, task, tools, HTTP helpers). UI:
`apps/ui/components/settings/schedule-settings.tsx` in Settings, Schedules.

## No second scheduler

Pi Durable owns tasks and recovery (docs/MONOREPO.md), so schedules are built from its own
parts and nothing else:

- **Definitions** live in one session-scoped Pi document, `mars.schedules`, inside the Pi
  SQLite store. There is no other file or database.
- **Timing** is one Pi task (`mars.schedule.v1`) per enabled schedule, owned by the root
  conversation as background work. It sleeps with `runtime.sleep` until the next run time,
  sends the prompt, records the run in the document, and sleeps again. There is no
  `setInterval` and no timer outside Pi tasks. Each sleep is cut into steps of at most one
  minute that re-read the Harness clock, so a suspended machine or a clock change is noticed
  within a minute.
- **Runs** are ordinary Pi conversations and submissions, so Recents, groups, archive,
  usage and the gateway treat them like any other chat.

## A schedule

| Field | Meaning |
| --- | --- |
| `id` | `sch_` and 12 hex characters. |
| `title` | 1 to 60 characters. Also the Recents group name for its runs. |
| `prompt` | What is sent at each run, 1 to 20,000 characters. |
| `when` | One of the forms below. |
| `timezone` | IANA name, e.g. `Australia/Sydney`. Default: `MARS_TIMEZONE`, else the host's zone when it is not UTC, else `Australia/Sydney`. The UI sends the browser's zone. |
| `target` | `{ kind: "new" }`: a new conversation per run, filed in the group named after the schedule. `{ kind: "conversation", conversationId }`: append every run to that one conversation. |
| `model`, `effort` | Model id as in the model menu (`gpt-6-luna`, `anthropic/claude-opus-5-5`) and effort level. `""` means the default model and effort from Settings, Models at run time. Only used for new conversations; an appended conversation keeps its own model. |
| `enabled` | False while paused. |
| `nextRunAt`, `lastRun`, `runs` | Next run time (ms), the newest run, and the last 20 runs. |

`when` forms (times are wall-clock times in `timezone`):

- `{ kind: "interval", every: 30, unit: "minutes" }`: every N minutes or hours, at least 5
  minutes and at most 7 days, counted from when the schedule was created or its timing last
  changed.
- `{ kind: "daily", time: "08:00" }`
- `{ kind: "weekdays", time: "08:00" }`: Monday to Friday.
- `{ kind: "weekly", days: ["mon", "thu"], time: "17:30" }`
- `{ kind: "once", at: "2026-07-01T09:30" }`: one run, then the schedule pauses itself.

### Time zones and daylight saving

Wall-clock times are turned into instants with `Intl.DateTimeFormat`, never a fixed offset:

- A time that happens twice when clocks go back (02:30 on the first Sunday of April in
  Sydney) runs once, at the first of the two.
- A time that does not exist when clocks go forward (02:30 on the first Sunday of October in
  Sydney) runs at the same distance after the jump, 03:30.
- Weekday rules use the weekday in the schedule's zone, not the host's.

Natural language ("every weekday at 8am") is the agent's job: the tools take only the
structured form above.

## A run

Each scheduled time has a run key, `schedule:<id>:<time in ms>`, used as the Pi submission
`requestId`. At each run time the task:

1. Re-reads the schedule. If it was deleted, paused or replaced by a newer task, the task ends.
2. **Missed:** if the run is more than an hour late (Mars was down), it is recorded as
   `missed` and not sent. Less than an hour late, it runs once now.
3. **Overlap:** if the previous run's submission is still queued or running, this run is
   recorded as `skipped` and not sent.
4. Otherwise, in one commit, it creates the conversation (for `new`: titled
   "`<title>`, `<date time>`", filed in the group `<title>`, on the chosen or default model)
   and moves its own checkpoint to "send". It then submits the prompt with the run key and
   records the run as `running`.
5. It computes the next time after both now and the run time, records it as `nextRunAt`, and
   sleeps. A `once` schedule pauses itself instead.

A restart at any point resumes the same task from its last checkpoint: before step 4's
commit nothing was sent; after it, the submit repeats with the same request id, which Pi
returns as the existing submission, so a run is never sent twice. Run statuses are `running`,
`completed` (answered), `failed` (with a reason), `missed` and `skipped`. A `running` run is
settled from its submission whenever the schedules are read.

**Run now** sends the prompt at once with a fresh key `schedule:<id>:manual:<uuid>`, records
it like any run and leaves the timetable unchanged. It is refused while the previous run is
still going, and works on a paused schedule too.

**Changing** a schedule's timing, pausing, resuming and deleting are each one commit that
writes the document and creates the replacement task (if any), then aborts the old task. A
task whose id no longer matches the document ends itself when it wakes, so a crash between the
two steps cannot make a schedule run twice. On start-up Mars recreates the task of any enabled
schedule whose task is missing or finished.

## Agent tools (namespace `schedules`)

`schedule_create`, `schedule_list`, `schedule_update` (including `enabled: false` to pause and
`true` to resume), `schedule_delete`, `schedule_run_now`. They follow docs/TOOLS.md and are
checked by `check-tool-quality.mjs`.

## HTTP (owner auth)

- `GET /api/schedules`: `{ schedules, timezone }`, newest first, `timezone` being the default.
- `POST /api/schedules`: create; body as `schedule_create`. Returns `{ schedule }`.
- `POST /api/schedules/update`: `{ id, ...changes }`. Returns `{ schedule }`.
- `POST /api/schedules/delete`: `{ id }`. Returns `{ deleted: true, id }`.
- `POST /api/schedules/run-now`: `{ id }`. Returns `{ schedule, run }`.

Errors are `{ error }` with status 400, or 404 for an unknown id.

## UI

Settings, Schedules lists each schedule with its timing in words, next run, last result and
Pause/Resume, Run now and Delete, and a form to add one (title, prompt, frequency, time, days,
date, timezone, and where runs go). Runs appear in Recents in the schedule's group.

## Checks

`packages/pi-host/check-schedules.mjs` runs a real Harness on SQLite with a scripted fake
model and an injected clock: next-time maths (Sydney daylight saving both ways, weekdays,
weekly, intervals, once), a run on time that starts a conversation with the prompt in its
group, no double run across closing and reopening the store, the missed-run rule, the overlap
skip, pause and resume, delete stopping the task, run now and argument validation.
`apps/ui/tests/schedules-ui-check.mjs` drives Settings, Schedules against routed fixtures.
