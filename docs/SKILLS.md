# Skills

A skill is a folder with a `SKILL.md`: Markdown instructions for one kind of work, with YAML
front matter giving its `name` and a `description` that says when to use it. Extra files
(references, scripts, templates) can sit beside it. This is the format used by Claude Code,
Codex and the `npx skills` installer, so the same folders work in all of them.

## Where Mars looks

In this order; the first folder wins when two skills share a name:

1. `<MARS_PI_ROOT>/workspace/skills`: Mars's own skills. The only folder Mars writes.
2. Each folder in `MARS_SKILL_DIRS` (colon-separated), read-only.
3. `~/.agents/skills`: where `npx skills add` installs for Codex and other agents, read-only.
4. `~/.claude/skills`: Claude Code's user skills, read-only.

The folders on disk are the only store. Mars rereads them at most every 15 seconds.

## How the agent uses them

- Every turn the prompt carries a short Skills section: each skill's name and the first 80
  characters of its description, at most 16,000 characters (about 150 skills), then "N more:
  call skill_list".
- `skill_read({ name })` loads SKILL.md and lists the other files; `skill_read({ name, file })`
  reads one of them. Paths and symlinks that leave the skill folder are refused.
- `/name` in a message asks for that skill.
- `skill_create` writes or replaces one of Mars's own skills. Shared folders are never changed.
- `skill_install({ source })` clones `owner/repo` (or a sub-folder, GitHub URL, git URL or local
  folder) and copies every folder with a SKILL.md into Mars's own folder, replacing same-named
  skills. `npx skills add owner/repo` maps to `skill_install({ source: "owner/repo" })`.

GET /api/skills (optional `query`) returns `{ total, skills: [{ name, description, source }] }`.
The Extensions page lists them with search.

Skills are instructions, not code: nothing in a skill runs unless the agent decides to run it.
Install only sources you trust, as you would for any agent.
