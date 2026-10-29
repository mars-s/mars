# Duet

## Parked

Duet is parked (2026-10-29): it did not work well enough to keep. The code, its checks and the
thread's data stay, but the host leaves it off unless `MARS_DUET=1` is set in its service
environment. While parked:

- the Duet tools (`duet_send`, `duet_notify` and the rest) are not installed;
- `/api/duet` and `/api/duet/*` answer 404 "Duet is parked";
- `/api/state` says `duet: false`, so the sidebar has no Duet entry and an old `?view=duet`
  link opens the chats;
- the Duet thread stays out of the chat list.

The host checks (`check-duet*.mjs`) still run, since they test `duet.mjs` directly. The browser
checks (`tests/duet-*-ui-check.mjs`) run by hand, outside the browser suite. To bring Duet back,
set `MARS_DUET=1` and put those checks back in `test:ui`.

Duet is the owner's personal assistant thread: one iMessage-style conversation under **Duet** in
the sidebar, over many background tasks that run at the same time. The research and the full
design are in `workspace/duet-research/DUET-SPEC.md`; this page describes what is built.

Code: `packages/pi-host/duet.mjs` (host), `apps/ui/components/duet/` and `apps/ui/lib/pi/duet.ts`
(interface). Checks: `packages/pi-host/check-duet.mjs`, `apps/ui/tests/duet-ui-check.mjs`.

## How it works

- **One thread, not a chat.** The first time Duet opens, the host makes one conversation titled
  "Duet" and marks it with `mars.duet-thread`. A session document, `mars.duet-home`, remembers
  which one it is. It is a different kind from the chats: it is left out of Recents and the chat
  list (with its tasks), and a link to it opens Duet's own iMessage-style page. The chats are the
  working view with tool steps; a task's Open button shows its work there. `GET /api/duet/thread`
  names the thread without building the view.
- **Front desk.** The thread's agent gets the "Duet front desk" prompt section: reply like a
  text message, never do long work, and start a task for anything bigger than a few tool calls.
  It also sees a live list of the tasks.
- **Tasks.** `duet_task_start` makes a side chat of the thread with a `mars.duet-task` document
  (id `T1`, `T2`..., label, state, brief, model, progress) and sends it the brief. It returns
  at once. Tasks are ordinary Pi conversations, so they run in parallel and survive a restart.
  Each gets the "Duet task" prompt section.
- **Reporting.** When a task gives a final answer, the host writes it into the thread as a
  `mars.duet-post` entry labelled with the task and quoting the owner's original words. The
  front desk sees a short note but is not woken. Tasks can post interim updates (one per 30 s)
  and questions with `duet_post`, and keep their card current with `duet_progress`.
- **Steering.** A message sent with a task as its reply target goes straight to that task as a
  Pi steer (it lands at the task's next step), and shows in the thread as the owner's bubble
  "To Hotels · T1". The front desk can do the same with `duet_task_steer`. A finished task
  picks the message up as a new turn. A queued task gets it added to its brief.
- **Stop.** `duet_task_stop` or the Stop button aborts one task and its queued messages.
  Nothing it already did is undone; the thread says it was stopped.
- **Pool.** At most `maxActive` (default 6) tasks run at once. Extra tasks wait as `queued`
  and start, oldest first, as others finish or stop.
- **Tasks talking.** `duet_mail` sends a message from one task to another (a steer, marked as
  mail and "not an order from the owner") or to the front desk (which wakes it). The thread shows
  a grey line such as "Hotels to Flights: What time do you land?". More than 6 mails between
  the same two tasks in ten minutes is refused. `duet_board_read` and `duet_board_write` share
  facts and claims on the thread's `mars.duet-board`: writes can require a version
  (compare and set), and a claim held by another task is refused until it ends.
- **Full access.** `chat_create` makes a top-level chat (optionally in a project, optionally
  with a first message), `chat_list` finds chats by title, `chat_read` reads the newest
  answer, `chat_send` messages any chat. A code session is `lane_start`, then `chat_create`
  with the lane worktree as project. These tools work from any conversation.

## Assistant behaviour

Duet works like a personal assistant that mostly just does things (after Lee Robinson's
"How always-on agents work", notes in workspace/duet-research/07-always-on-agents-talk.md).

- **A request is the approval.** The front desk and tasks do what the owner asked, including
  sending, booking, buying within what was said, deleting what was named, pushing or deploying.
  They ask only in a genuine grey area (an ambiguous target, money or people the request did not
  mention, something irreversible where they doubt it is what was meant, or going beyond the
  request), with `duet_confirm`: a small box with **Go ahead** and **Don't**. A task waits for
  the answer (its turn ends without a result), and the answer reaches it as a message.
  `POST /api/duet/confirm { confirmId, answer: "yes" | "no" }` answers once.
- **The owner comes first.** The owner's message to the front desk is a Pi steer: it cuts into
  a running turn at its next step instead of waiting behind it.
- **Events and the router.** `duet_notify` (from any other chat), `POST /api/duet/event
  { text, source?, dedupeKey?, important? }` and "Not right" hand events to Duet. The same
  `dedupeKey` is delivered once; events arriving within about 2.5 seconds are merged into one
  front desk turn, queued behind the current one. That turn's input is a `mars.duet-wake` entry,
  and its plain replies stay private: only `duet_send` reaches the owner. Often nothing does.
- **Quiet by default.** A task started without the owner's words (`origin`) files its result
  quietly (`quiet: true` on the bubble; the page groups them, collapsed). `quiet` on
  `duet_task_start` overrides it. Interim updates are limited to one every 30 minutes and are for
  news that changes what the owner should do; `duet_progress` updates the card silently.
- **A byte-stable prompt.** The front desk and task sections never change between turns, so the
  provider keeps reusing its cache. What changes (the tasks, the scratchpad) is appended as a
  model-only `mars.duet-context` note ("[Duet now]") before a front desk turn, only when it
  changed. Tasks list the others with `duet_task_list`. `GET /api/duet` reports
  `context: { cacheHitPercent, cachedTokens, inputTokens, turns }` over the last 20 answers.
- **Compaction after idle.** About ten minutes after the owner's last message, if the thread is
  idle and its last turn used more than 60,000 tokens, the thread is compacted while the cache is
  still warm, so the owner's return resumes from a short summary.
- **Layered memory.** Core facts: `memory_update` (every prompt). A dated journal:
  `duet_journal` writes `workspace/duet/journal/YYYY-MM-DD.md` (looked up with grep). An
  hour-long scratchpad: `duet_scratch`, shown in the "[Duet now]" note. Everything else: files.
- **Mistakes become evals.** "Not right" on a Duet message (`POST /api/duet/feedback
  { messageId, note }`) saves the message, the owner's request and the messages before it as
  `workspace/duet/evals/<date>-<id>.json`, marks the bubble (`feedback: "wrong"`) and hands the
  front desk an event so it can put it right. `duet_eval_add` saves a case the owner gave in words.

Check: `check-duet-assistant.mjs`.

## HTTP

- `GET /api/duet`: `{ threadId, running, messages, tasks, board }`. Messages are bubbles:
  `{ id, from: owner | duet | system, kind, text, taskId, label, quote }`.
- `POST /api/duet/open`: make the thread if needed, `{ threadId }`.
- `POST /api/duet/message { text, taskId?, requestId? }`: to the front desk, or to one task.
  The same `requestId` never sends twice.
- `POST /api/duet/stop { taskId }`.

## Interface

Sidebar **Duet** (under Chats) opens the thread at `?view=duet`. Duet's bubbles are orange
(`#b5552f`, 4.63:1 with its text), the owner's a lighter grey (`#44433f`). Task results carry
a "Label · T3" line and the quoted request. Hover (or, on a phone, the arrow) to reply to a
task; a removable chip shows the target. Above the composer, a strip says "2 working" and
expands to the task list with Reply, Open (the task's own chat) and Stop. The page polls every
1.2 s and announces finished tasks and questions to screen readers.

## Not built yet

From the spec: approval cards bound to exact actions, budget reservation, reader and actor
profiles, pending memory, proactive briefs, Telegram and Discord binding to the thread,
images in Duet messages, and task sub-tasks. Existing Mars safety rules still apply to every
task, because tasks are ordinary conversations.

On the page: quiet results that come one after another fold into one small grey card ("3 quiet
updates"); a confirm shows its action in a small box with Go ahead and Don't, then "You said go
ahead"; Duet's replies and results have a small Not right action (hover, or a long press on a
phone) with an optional one-line reason; the task strip shows "Cache 91%" when the host reports it.
