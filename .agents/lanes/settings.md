# Lane: settings (settings dialog, extensions page, theme picker)

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/settings`, branch `codex/lane-settings`, UI port **3225**.

Owns: `apps/ui/components/settings/*` (settings-dialog.tsx, settings.css,
theme-settings.tsx/.css, connection-settings.tsx/.css, plugin-manager.tsx,
extensions-page.tsx), `apps/ui/components/ui/dialog.tsx`, `tabs.tsx`,
`switch.tsx`, `button.tsx`, `input.tsx` styling only.

Goal: Claude's Settings and a calm Extensions page.
- Settings: centred dialog ~760px wide, 560px tall on desktop, left vertical
  tab list (Account, Appearance, Connection, Apps) and content on the right with
  a serif section title, like Claude settings. Full-screen sheet on mobile with
  horizontal tabs. Keep tab names, "Sign in with Claude", "Reconnect Claude",
  "Continue to Claude sign-in", "Claude authorisation code" (password input),
  "Complete Claude sign-in", ChatGPT equivalents, Apps tab labels used by
  connections-ui-check, and Appearance buttons whose names start with "Dark",
  "Light", "OLED".
- Appearance: theme cards (Dark, Light, OLED) with mini previews drawn from the
  real tokens (not hardcoded hex): use CSS that sets `data-theme` on each
  preview so it reads its own variables. Update `theme-settings.css` OLED
  tokens to sit beside the new palette (OLED = true black, ivory text, clay).
- Buttons and inputs: Claude-like: primary = ivory/dark text fill, secondary =
  bordered, 8px radius, 36px tall (44px on touch), clay focus ring.
- Extensions page: 768px column, serif "Your extensions" title, plugin rows as
  simple bordered rows (not heavy cards), switches on the right, tool toggles in
  a disclosure; keep `.live-plugin-card`, "Open interface", "Enable <name>"
  switch names, error retention text.
Tests: claude-ui-check, connections-ui-check, live-client-check (settings
appearance, blocked storage), plugins-activity-ui-check.
