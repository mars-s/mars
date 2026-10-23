# Duet

Duet is the owner's personal assistant thread: one iMessage-style conversation under **Duet** in
the sidebar, over many background tasks that run at the same time. The research and the full
design are in `workspace/duet-research/DUET-SPEC.md`; this page describes what is built.

Code: `packages/pi-host/duet.mjs` (host), `apps/ui/components/duet/` and `apps/ui/lib/pi/duet.ts`
(interface). Checks: `packages/pi-host/check-duet.mjs`, `apps/ui/tests/duet-ui-check.mjs`.

## How it works

- **One thread.** The first time Duet opens, the host makes one ordinary conversation titled
  "Duet" and marks it with `mars.duet-thread`. A session document, `mars.duet-home`, remembers
  which one it is. It also shows in Recents, so it can be opened as a normal chat.
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
