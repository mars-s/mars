# Lane: thread (messages, greeting, markdown, message actions)

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/thread`, branch `codex/lane-thread`, UI port **3223**.

Owns: `apps/ui/components/thread/*` (conversation-view.tsx, messages.tsx,
thread.css), `apps/ui/app/globals.css` Markdown section is NOT yours; put
Markdown styles in thread.css under `.mars-markdown`.

Goal: Claude's conversation column.
- 768px max content column, 24px gutters, generous vertical rhythm.
- Empty state: Phase mark in clay beside a serif greeting at ~38% height,
  "What shall we work on?" (keep that heading text; tests look for it).
- User turns: right-aligned bubble `--user-bubble`, 16px radius, max 85%,
  15px text, images above text as rounded thumbnails (keep `.live-message-images img`).
- Assistant turns: unboxed 16px/1.65 text. Markdown like Claude: headings sans
  semibold, lists, tables with subtle borders, inline code chips, code blocks on
  `--surface` with a header row showing the language and a copy button,
  blockquotes, links in `--blue`.
- Action row under assistant turns: copy ("Copy response"), visible on hover
  and focus, always on touch. Only add retry/edit if assistant-ui + Pi support it
  (they do not for this host); do not add fake buttons.
- Outcome notes ("Response stopped.", provider error) as quiet inline text.
- Streaming indicator: the Phase mark gently pulsing (clay) with "Thinking" or
  "Working", stops when not running (reduced motion: static). Replace the
  current StatusMark row in conversation-view.tsx.
- Auto-scroll behaviour is assistant-ui's; keep the viewport structure
  (`ThreadPrimitive.Viewport`, `ViewportFooter` wrapping `<Composer />`).
- Leave `<ActivityTimeline>`, `<LiveWorkers>`, `<AgentActivity>` placement to
  the activity lane: keep rendering them where they are, do not restyle them.
Tests: live-client-check (Markdown table/code, tool disclosure preserved across
polling), conversations-ui-check (greeting heading, history text).
