# Shared agent context

This folder is the single shared memory for this project. Two agents work on
this repo and neither is the owner:

- **ZCode**, the harness this repo is forked from, driving the in-editor agent.
- **ChatGPT**, working out of band in its own harness.

Everything either agent needs to resume without re-deriving the state of the
project lives here. Read `CONTEXT.md` first. It is the entry point.

## Files

| File | What it is | Who writes it |
| --- | --- | --- |
| `CONTEXT.md` | Current state, standing rules, what is in flight | Both, every session |
| `ROADMAP.md` | Stage plan, issue index, wave status | Both |
| `DECISIONS.md` | Architecture decisions and their reasons | Both |
| `CHANGELOG.md` | Append-only log of every change, by agent | Both, every commit |
| `verification.md` | Commands that prove a change works | Both |
| `pstack-models.md` | Per-role model pins | Whoever changes the pin |
| `skills/` | Upstream ZCode skills. Not ours to curate. | Nobody |

## The rules

1. **Read `CONTEXT.md` before touching code.** It records what is in flight and
   what is forbidden.
2. **Append to `CHANGELOG.md` in the same commit as the change.** A change with
   no changelog entry is treated as not done.
3. **Record a decision in `DECISIONS.md` when you change direction**, not when
   you follow the plan. Following the plan needs no entry.
4. **Never silently revert the other agent's work.** If you find a change you
   did not make, read the changelog entry first. If there is none, that is a bug
   in the other agent, raise it rather than reverting.
5. **Do not put secrets in this folder.** It is committed. Credentials live in
   the 1Password vault and are referenced by item name only.

## Why this exists

Two agents editing one 860k-line codebase with no shared state is how you get
contradictory edits and lost work. This folder is the shared surface. If you
find yourself re-deriving something another agent already established, the
folder is missing an entry, and adding it is part of your task.
