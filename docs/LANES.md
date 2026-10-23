# Lanes: several chats changing Mars at once

Several chats can work on Mars at the same time. Each one gets a **lane**: its own git
worktree and branch, its own preview the owner can open, and a place in one **merge queue**
that lands finished work on `main` one lane at a time, in order.

Code: `packages/pi-host/lanes.mjs`. Check: `packages/pi-host/check-lanes.mjs`.
Interface: Settings, Lanes.

## The flow

1. `lane_start { title }` creates `lane/<id>` from the checkout's current `main` and a
   worktree beside the checkout (`<repo>-lanes/<id>`, or `MARS_LANES_DIR`). The root
   `node_modules` is linked in, so nothing is installed. The chat that started it is
   recorded so the owner can find it.
2. The chat edits files only inside its worktree (absolute paths, or `host_exec` with
   `cwd` set to the worktree). The live checkout and other lanes are untouched.
3. `lane_preview { id }` runs the lane's own host and interface:
   - a host from the worktree's `packages/pi-host/server.mjs` with a fresh data root
     (`$MARS_PI_ROOT/lanes/<id>`), so it has no chats, sign-ins, chat apps or schedules
     and can never act for the owner;
   - the worktree's interface as a Next development server (webpack, because Turbopack
     does not follow the linked `node_modules`);
   - both as transient user services (`mars-lane-<id>-host`, `mars-lane-<id>-ui`) with
     memory limits, so they survive a host restart and stop cleanly;
   - published inside the tailnet with `tailscale serve` on its own HTTPS port
     (8601 and up), at `https://<public host>:<port>/`. The preview host accepts the
     owner token, and the browser already sends the owner cookie (cookies ignore the port),
     so the owner opens the link and is signed in.
   At most `MARS_LANE_PREVIEWS` (default 2) previews run at once, for memory.
   `lane_preview { id, stop: true }` stops one.
4. `lane_submit { id, message }` commits everything in the worktree and puts the lane at
   the end of the queue. Unless merging is paused, the queue runs at once and the call
   returns this lane's outcome.

## The merge queue

Queued lanes merge strictly in order, one at a time. For the lane at the front:

1. **Rebase** onto the current `main`. A conflict aborts the rebase and blocks the lane
   with the conflicting files. Its chat runs `git rebase main` in the worktree, fixes
   them and submits again (which queues it at the end).
2. **Guard.** The same trust boundary as `self_edit` (`protected-files.mjs`): a lane may
   not change the files that judge a change, nor commit `node_modules`, `.env` files or
   databases.
3. **Checks**, on the files the lane changed against `main`:
   - `node --check` on changed JavaScript modules, and `JSON.parse` on changed JSON;
   - when `apps/ui` changed: the interface type check and lint on the changed files;
   - when `packages/pi-host` changed: each changed or added `check-*.mjs`, and each check
     that imports a changed host module, with a temporary data root.
   A failure blocks the lane with the log tail.
4. **Fast-forward** `main` in the checkout to the lane. The checkout must be on `main`.
   Uncommitted edits in the checkout stay; if one is in a file the lane changed, git
   refuses and the lane is blocked until the owner commits or moves that edit.
5. **Clean up:** stop the preview, remove the worktree and delete the merged branch.

Then the next queued lane goes. A blocked lane leaves the queue and does not hold up the
others. After a host restart a lane caught mid-merge is queued again; if `main` already
contains it, it is marked merged.

The interface in the checkout is the live development server, so merged interface changes
are live at once. Host changes still need `host_deploy` or the updater, and `github_push`
publishes `main`.

## Owner controls (Settings, Lanes)

- every lane with its chat, state, branch, changed files and preview link;
- the queue order, with up and down to reorder waiting lanes;
- pause merging, and merge now;
- start or stop a preview, and close a lane.

Routes: `GET /api/lanes`, `POST /api/lanes/order {ids}`, `POST /api/lanes/pause {paused}`,
`POST /api/lanes/merge`, `POST /api/lanes/<id>/preview {on}`, `POST /api/lanes/<id>/close`.

## Tools

`lane_start`, `lane_preview`, `lane_submit`, `lane_list`, `lane_close`.
