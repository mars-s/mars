# Lane: shell (sidebar, header, mobile drawer, brand)

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/shell`, branch `codex/lane-shell`, UI port **3221**.

Owns: `apps/ui/components/shell/*` (sidebar.tsx, header.tsx, mobile-nav.tsx,
child-navigation.tsx, shell.css), `apps/ui/components/shared.css`,
`apps/ui/components/mars-mark.tsx` (use only, already final).

Goal: the Claude desktop shell.
- Sidebar 288px on `--sidebar`, collapsible to a 56px icon rail via a panel
  toggle (lucide `PanelLeft`) at the top; persist collapse in localStorage
  (`mars-sidebar-collapsed`); animate width; keyboard and focus visible; the
  rail keeps New chat, Chats/Extensions icons, and the account avatar.
- Top: Phase mark in clay + "Mars" wordmark in serif, collapse toggle on the right.
- "New chat" row with a clay-tinted circular plus, like Claude's.
- Rows: Chats (conversation), Extensions (with count). 14px, 34px tall, 10px radius.
- "Recents" section label (12px, 500, muted) then the conversation list, one
  line each with ellipsis, running indicator (small clay pulse dot, stops when
  not running), selected row `--sidebar-accent` and weight 500. Subthreads
  (`useChildNavigation`) indented under their parent with their status as quiet
  text, not a raw string like "running" in a badge; keep `.live-subthread`.
- Bottom account row: avatar circle with initial, "Pi workspace" and model
  readiness dot; opens Settings. Keep accessible names.
- Header 48px, transparent, no border: on mobile a menu button ("Open
  navigation"); conversation title as quiet text; "Back to parent" as a ghost
  button with a back chevron when in a child thread; settings icon only on mobile.
- Error and connection notices: a slim inline banner below the header using
  tokens (red tint for errors), Reconnect and dismiss buttons preserved.
- Mobile (<=768px): the drawer (`.live-mobile-nav`, Dialog placement left)
  mirrors the sidebar content and order.
Tests touching this lane: conversations-ui-check, images-subthreads-ui-check,
live-client-check (mobile drawer Escape, one selected nav destination),
plugins-activity-ui-check (`.live-sidebar`, Extensions button).
