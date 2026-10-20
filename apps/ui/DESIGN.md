# Mars design

<!-- Replaces the earlier screenshot-ledger DESIGN.md. The owner asked for a full
remake that looks very much like the Claude desktop app. -->

## Direction

Mars looks and behaves like the Claude desktop app, with the Mars name and mark.
Warm charcoal canvas, ivory text, a quiet sidebar, one big rounded composer, a
serif greeting, and a single clay accent. The interface recedes so the
conversation leads. This is an Operate surface: scanability, steady layout and
native keyboard behaviour outrank decoration.

Copy Claude's interaction patterns and visual grammar. Do not copy Anthropic's
logo, the Claude name, the spark mark or account details. The Mars mark stands
where Claude's mark would.

## Tokens (app/globals.css owns the values)

| Role | Dark | Light |
| --- | --- | --- |
| Canvas `--background` | `#262624` | `#faf9f5` |
| Sidebar `--sidebar` | `#1f1e1d` | `#f5f4ed` |
| Sidebar hover/selected `--sidebar-accent` | `#2f2e2b` | `#ebe9df` |
| Composer `--composer` | `#30302e` | `#ffffff` |
| Raised surface, menus `--surface-raised`, `--popover` | `#30302e` | `#ffffff` |
| User bubble `--user-bubble` | `#141413` | `#ebe9df` |
| Text `--text` | `#e8e6dc` | `#141413` |
| Secondary text `--text-muted` | `#9c9a92` (5.4:1) | `#6b6a64` |
| Quiet text `--text-faint` | `#85837b` (4.4:1 on sidebar, large/metadata only) | `#73726c` |
| Border `--border` | `#3e3e3a` | `#e3e1d7` |
| Clay accent `--clay` | `#d97757` | `#c6613f` |
| Primary action fill `--primary` | `#c6613f`, white glyph | same |

Use the semantic variables. Never hardcode a hex in a component stylesheet. The
OLED theme stays as an optional preference; it overrides the same variables.

Clay is rare: the send button, the Mars mark, a focus ring, and nothing else
that is not a primary action or identity. Status colours (`--green`, `--red`,
`--blue`) appear only beside a text label.

## Type

Anthropic Sans for UI and conversation, Anthropic Serif for the greeting and
page titles, Anthropic Mono for code (all self-hosted in app/fonts).

| Use | Size / line height | Weight |
| --- | --- | --- |
| Empty-state greeting (serif) | clamp(32px, 4vw, 40px) / 1.2, tracking -0.02em | 400 |
| Page title (serif) | 28px / 1.25 | 400 |
| Assistant message | 16px / 1.65 | 400 |
| User message | 15px / 1.55 | 400 |
| Composer input | 16px / 1.5 | 400 |
| Sidebar rows, menus | 14px / 20px | 400, selected 500 |
| Sidebar section labels | 12px | 500, `--text-muted` |
| Metadata, footnotes | 12px | 400 |
| Code blocks | 13px / 1.6 mono | 400 |

Assistant Markdown headings use sans semibold, not serif.

## Layout

- Sidebar: 288px expanded; collapses to a 56px icon rail with a toggle (Claude's
  panel button, top left). Collapse state persists in localStorage. Order: Mars
  mark plus wordmark and collapse toggle; New chat (clay-tinted circular plus);
  Chats and Extensions rows; a "Recents" label then the conversation list (one
  line each, ellipsis, running dot on the right, subthreads indented beneath
  their parent); a bottom account row with avatar initial, "Pi workspace" and a
  connection dot, opening Settings.
- Header: 48px, transparent, no border. Conversation title centred-left as a
  ghost button; model/settings affordances on the right only when useful.
- Conversation column: 768px max content width, 24px gutters, centred.
- Composer: 768px max, radius 20px, `--composer` fill, 1px `--border`, soft
  `--shadow-composer`. Textarea above, toolbar below: left has a "+" attach
  button and a tools/mode chip; right has the model picker (ghost text button
  with chevron) and the send button (32px, radius 8px, clay fill, white up
  arrow; stop becomes a square). In an empty conversation the greeting and
  composer sit together around 38% of the viewport height, with the Mars mark
  in clay beside the greeting.
- Messages: user turns are right-aligned bubbles (`--user-bubble`, radius 16px,
  max 85%). Assistant turns are unboxed full-width text with a small action row
  (copy, retry when supported) that appears on hover and focus, always visible
  on touch.
- Tool activity: one compact, collapsible line per group ("Ran 3 commands",
  chevron), rows inside with icon, label and state. Code and output in mono on
  `--surface`. No cards around ordinary output.
- Settings: a centred dialog, 720px, left tab list (General/Account,
  Appearance, Connection, Apps) and content on the right, like Claude settings.
- Full pages (Extensions): 768px column, serif page title, simple rows.

## Motion

120–200ms with `--ease-out`. Sidebar collapse animates width; menus and dialogs
fade and scale from 0.98. The streaming state is a small pulsing Mars mark or
the existing StatusMark, which stops when the run stops. No decorative motion.
Respect `prefers-reduced-motion` and the app's own reduced-motion setting.

## Responsive

At 768px and below the sidebar becomes a left drawer (the existing Dialog with
`placement="left"`), opened from a header menu button. Composer stays pinned
above the keyboard with safe-area padding. Touch targets are at least 40px.
No horizontal overflow at 390px.

## Accessibility

Visible focus ring (2px `--ring`, offset 2px) on every control. Hover-revealed
actions also appear on focus. Text contrast at least 4.5:1 except metadata
marked quiet. Keep existing accessible names that tests rely on: "Message Mars",
"Send message", "Stop response", "Choose model", "Open settings", "Open
navigation", "New chat", "Attach images", "Copy response".

## Truthfulness

Show only real Pi state. Do not add Projects, Artifacts, search results,
connectors or usage figures that the host does not provide. A control for an
unsupported feature is absent, not decorative.
