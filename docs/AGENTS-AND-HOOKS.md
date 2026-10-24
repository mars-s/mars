# Named agents and session start hooks

Mars reads two parts of the Claude Code plugin format beyond skills (docs/SKILLS.md): named
agents (subagents) and a small, safe subset of hooks. This is what makes plugins such as
pstack work: its skills say "spawn the comment-sicko subagent", and its session start hook
adds a short note to every conversation.

Code: `packages/pi-host/agents.mjs`, `packages/pi-host/hooks.mjs`. Check: `check-agents.mjs`.

## Named agents

An agent is one Markdown file with front matter:

```markdown
---
name: comment-sicko
description: A comment hater that reviews a diff and lists comments to delete.
model: sonnet
---

Instructions the helper model follows.
```

`name` (lowercase, dashes) and `description` are required; files without them are skipped.
`model` is optional.

### Where Mars looks

In this order; the first wins when two agents share a name:

1. `<MARS_PI_ROOT>/workspace/agents/*.md`: Mars's own. The only folder Mars writes.
2. Each folder in `MARS_AGENT_DIRS` (colon-separated), read-only.
3. `~/.agents/agents`, read-only.
4. `~/.claude/agents`, read-only.
5. The `agents/` folder of each Claude Code plugin: first `~/.codex/*/plugins/*`, then a walk of
   `~/.claude/plugins` (at most 6 levels and 3000 folders) that stops at any folder with
   `.claude-plugin/plugin.json`, `agents/` or `hooks/hooks.json`. Version folders are read newest
   first, and a plugin name found twice keeps the first.

Files are reread at most every 15 seconds. Only `*.md` directly in each folder are read.

### How the agent uses them

- Every turn the prompt has a short Agents section (only when there are agents): one line per
  agent, at most 6000 characters, then "N more: call agent_list". It tells the model that
  "spawn the X subagent" means `agent_run`, and that `pstack:x` means `x`.
- `agent_list({ query? })` lists agents and reports which session start files are in use and
  which hooks were ignored, with why.
- `agent_run({ agent, task, model?, title? })` runs the task as a normal worker (the same task,
  replay and sidebar nesting as `worker_run`). The worker's Pi `instructions` are a short
  preamble (who it is, that it does not see the chat, Claude Code tool names mapped to Mars ones)
  followed by the agent's body, up to 60000 characters. It returns `{ agent, id, status, result,
  provider, modelId }`; `id` works with `worker_followup`.
- An agent cannot start workers, workflows or agents of its own: like any worker it is a
  task-owned conversation, where `agent_run`, `worker_run`, `worker_fanout` and
  `workflow_start` refuse (docs/TOOLS.md "Workers and workflows"). The preamble says so
  instead of mapping the Task tool to `agent_run`.
- `agent_create({ name, description, instructions, model? })` writes `<name>.md` in Mars's own
  folder. A name owned by a shared or plugin folder is refused.

### Models

`model` (the tool argument wins over the file) maps onto the host's worker models:

| Name | Worker model |
| --- | --- |
| `luna`, `sol`, `astra`, `opus` | the host alias of that name |
| an exact installed model id, e.g. `gpt-6.1-sol` | that model |
| `opus` or any `claude-opus-*` | the `opus` alias (newest installed Opus) |
| `sonnet` / `haiku` or `claude-sonnet-*` / `claude-haiku-*` | newest installed Anthropic model of that family, else `sol` / `luna` |
| `inherit`, missing, or unknown | the calling conversation's model, else `sol` |

### Not supported

- `tools` in front matter is not enforced: the worker has the same tools as any worker.
- Claude Code's other agent fields (`color`, `permissionMode` and so on) are ignored.
- Plugins are read whether or not Claude Code has them enabled. Turn the whole feature off
  with the `mars-agents` and `mars-hooks` switches on the Extensions page.

## Session start hooks

Session start notes are Markdown added to the prompt of every conversation (it renders each
turn, so it also survives compaction). Workers and `agent_run` agents do not get them, as
Claude Code subagents do not get SessionStart output. Sources, in order:

1. `<MARS_PI_ROOT>/workspace/hooks/session-start/*.md`, by file name.
2. Each plugin's `hooks/hooks.json` `SessionStart` entries that Mars can read safely.

Each file is cut at 8000 characters and the section at 16000. A file named by several hooks
(a `*` group and a `startup` group, or one command listed twice) is added once, as Claude Code
runs identical hook commands once.

### The supported hook shape

Mars **never runs a hook command**. It reads the command as text and accepts exactly:

```sh
cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
grep -s '^session hook: off' "$HOME/.claude/pstack-models.md" >/dev/null || cat "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-context.md"
```

- `type: "command"`, not `async`, and a matcher that is empty, `*` or includes `startup`.
- The cat target must be a `.md` file that resolves (after symlinks) inside the plugin folder.
  Only `${CLAUDE_PLUGIN_ROOT}`, `$HOME` and `~` are expanded.
- The optional off switch is `grep -s` (or `-q`) with a plain text pattern, optionally starting
  with `^`. Mars reads that file itself: when a line matches, the note is left out, as the
  shell would.

Everything else is ignored and listed by `agent_list` under `sessionStart.ignored`: other
events (PreToolUse, PostToolUse, Stop and so on), `;`, `&&`, pipes, `$(...)`, other commands,
files outside the plugin, and hooks in `~/.claude/settings.json` or `plugin.json`.
