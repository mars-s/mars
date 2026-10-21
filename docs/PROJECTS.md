# Projects and memory

## Project instructions

Each conversation can work in one repository. Its `AGENTS.md` and `CLAUDE.md` (at the git top
level, up to 12,000 characters each) are added to the prompt as a Project section, as Claude
Code and Codex do. The repository is stored per conversation in the native `mars.project`
document (a fork keeps it; a new conversation starts without one).

- Automatic: the first tool call that names a path inside a git repository sets it: a
  `cwd` argument, a leading `cd <dir>` in a shell command, or the `path` of a file tool.
  Automatic detection never switches an existing project.
- Explicit: `project_open({ path })` sets or switches it.

Files are reread when they change (by modification time).

## Memory

`<MARS_PI_ROOT>/workspace/MEMORY.md` is a Markdown list of short notes shown in a Memory section
of every conversation. `memory_update({ add, remove })` changes it; the owner can edit the file
by hand. Notes are single lines up to 500 characters; the file is capped at 8,000 characters.
For longer how-to instructions, use skills (docs/SKILLS.md).

## Side chat notes

When a conversation's agent gives a side chat work (`side_chat_open` with a task, or
`side_chat_send`), the side chat is flagged. Its next final answer writes one
`mars.side-chat-done` entry into the parent: the model reads it as a note with the answer
(up to 4,000 characters); the UI shows "Side chat "X" finished." The owner typing in a side chat
directly never notifies the parent. `side_chat_read` returns the newest answer on demand.
