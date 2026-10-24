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

Files are reread when they change (by modification time and size). Only a regular file whose
real path (after symlinks) stays inside the repository is read, and only its first 48,000 bytes,
so a link to `/proc/self/environ` or `~/.ssh`, a FIFO, a device or a huge file is skipped or
cut instead of reaching the prompt or hanging the host.

## Memory

`<MARS_PI_ROOT>/workspace/MEMORY.md` is a Markdown list of short notes shown in a Memory section
of every conversation. `memory_update({ add, remove })` changes it; the owner can edit the file
by hand. Notes are single lines up to 500 characters; the file is capped at 8,000 characters.
For longer how-to instructions, use skills (docs/SKILLS.md).

- Notes are the `- ` or `* ` list lines. An update removes only the note lines asked for and
  adds new notes after the last note line; headings, numbered lists and paragraphs the owner
  wrote stay as they are.
- A note is matched for removal and duplicates as it is shown: spaces collapsed, case ignored.
- Updates run one at a time, so concurrent `memory_update` calls never lose a note. Each write
  goes to its own temporary file and is renamed into place.
- When MEMORY.md exists but cannot be read (for example its permissions), `memory_update` is
  refused and the file is left alone; it is never overwritten from an empty read.
- The Memory section shows notes up to 8,000 characters, then says how many were left out, so
  a long hand-edited file never floods every prompt. An update may always shrink a file that is
  already over the cap.

## Side chat notes

When a conversation's agent gives a side chat work (`side_chat_open` with a task, or
`side_chat_send`), the side chat records that message's request id (`mars.side-chat-notify`
`requests`) before sending it. A replayed call whose message was already sent records nothing.
A final answer of the side chat reports only the parent messages that were already in its
transcript (placed or answered, not still queued behind the owner's turn), so the owner typing
in a side chat directly never notifies the parent, and each parent message is reported once
with its own answer. The report is one `mars.side-chat-done` entry in the parent: the model
reads it as a note with the answer (up to 4,000 characters); the UI shows "Side chat "X"
finished." The entry is written before the request is cleared and is keyed by the request id,
so a stop in between repeats the same write on the side chat's next answer (still with the
answer recorded for that message) instead of losing it. `side_chat_read` returns the newest
answer on demand.
