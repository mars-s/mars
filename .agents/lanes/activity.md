# Lane: activity (tool calls, workers, workflows, approvals in the transcript)

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/activity`, branch `codex/lane-activity`, UI port **3224**.

Owns: `apps/ui/components/activity/*` (activity-timeline.tsx,
live-workers.tsx, activity.css), new files under `apps/ui/components/ai/` named
`tool-*` or `activity-*`, and `apps/ui/components/vendor/agent-elements/*` only
for theme or bug fixes (record them in `components/vendor/SOURCES.md`).

Goal: Claude-style compact tool activity using 21st Agent Elements, mapped from
real Pi tool calls (`LiveMessage.tools: ToolActivity[]`, see live-state.ts:
name, input JSON string, output, failed, state, durationMs, exitCode, details
{patch, diff, truncated}, children for codemode nested calls).
- Collapsed group line like Claude ("Ran 3 commands", "Edited 1 file, read 2
  files" ...) with chevron; keep the `.live-activity` details/summary element and
  its "N actions" text or update live-client-check/plugins-activity-ui-check
  wording in this lane only if behaviour is preserved. Expanded: one row per call.
- Map Pi tools to 21st cards: `bash`/`powershell` -> BashToolTerminalCard
  (command, output, exit code, failed state); `edit`/`write`/`apply_patch` ->
  EditToolDiffCard using `details.patch` or edits/content (wrap in
  `DiffHighlighterReady` from `components/ai/diff-highlighter.tsx`);
  `read` -> a quiet row "Read <path>"; `web_search`/`web_fetch`/`tool_search` ->
  SearchGroupRich-style row; unknown -> GenericToolRow. Build a small typed
  adapter `components/ai/tool-adapter.ts` from ToolActivity to the 21st props
  (no `any` leaking), and unit-test it in `apps/ui/tests/tool-adapter.test.mjs`
  (add it to the `test` script in apps/ui/package.json; that one-line
  package.json edit is allowed for this lane).
- Never fabricate: running state only from `state === "running"` or missing
  output; failed only from `failed`; durations only when present.
- Workers and workflows (`LiveWorkers`): render as Claude-like compact task
  cards using the 21st SubagentTool look where it fits (title, status, model,
  elapsed when known, open thread, stop button "Stop worker <id>" and
  "Stop workflow"). Keep `.live-workers > summary` and `.live-workflow > summary`.
  Usage figures stay as a small quiet line.
Tests: plugins-activity-ui-check ("2 actions", "Read file", "Run command",
"Command failed"), live-client-check (tool disclosure preserved across polling),
conversations-ui-check (worker stop, usage "120"), images-subthreads-ui-check
(workflow stop, "aborted").
