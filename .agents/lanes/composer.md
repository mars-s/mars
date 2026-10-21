# Lane: composer (message box, model picker, context meter, attachments)

Worktree `/Users/avi/Documents/ChatGPT/mars-lanes/composer`, branch `codex/lane-composer`, UI port **3222**.

Owns: `apps/ui/components/composer/*` (composer.tsx, composer.css,
live-image-attachment.tsx), new files under `apps/ui/components/ai/` named
`composer-*` or `context-meter*` or `model-picker*`.

Goal: Claude's composer, built on the assistant-ui `ComposerPrimitive` runtime
(keep it: it owns submit, attachments, drafts and cancel), styled after the
Kokonut AI Prompt and using Kokonut parts where they fit:
- One rounded surface (20px radius, `--composer`, 1px border, soft
  `--shadow-composer`), 768px max. Textarea 16px, grows to ~9 rows, placeholder
  "How can I help you today?" (or the connect prompt when the model is not ready).
- Toolbar: left a "+" attach button ("Attach images"); right the model picker
  then the send button (32px, 8px radius, clay `--primary` fill, white up arrow;
  becomes a square "Stop response" while running; disabled styling per DESIGN.md).
- Model picker: Kokonut AI Model Selector visual, fed `snapshot.models` and the
  current `snapshot.model`; changing it calls `action("/api/model", { model })`.
  No effort levels (Pi does not expose effort): pass each model with an empty
  or single effort list, or wrap the vendored component so effort UI is hidden.
  Keep a control with accessible name "Choose model" and menu items with role
  `menuitemradio` named by model name (conversations-ui-check clicks
  `menuitemradio` "Sol"), or adjust that test only if behaviour is identical.
- Context: Kokonut AI Context Meter ring inside the composer footer, fed ONLY
  `snapshot.context` (`segments`, `limit`, `compactAt`). Hide it when
  `basis === "unavailable"`. Label estimated values as estimates in the
  breakdown. `onCompact` calls `action("/api/compact")` (new host route,
  already implemented; add it to the scoped list only via a cross-lane request
  to the controller if needed: `live-workspace.tsx` `scoped` array must include
  "/api/compact" so the conversationId is sent; report that diff). Never let
  the component fall back to its demo (always pass `segments`).
- Attachments: image drafts above the textarea as 56px rounded thumbnails with
  a remove button; keep `.live-image-draft img` and "Remove <name>" names.
- Footnote under the composer: quiet 12px, centred, as now.
- Empty state: the greeting lives in the thread lane; your composer must look
  right both centred (empty) and docked at the bottom.
Tests: live-client-check (IME Enter, one operation per Enter, stop),
conversations-ui-check (model menu, drafts), images-subthreads-ui-check
(paste, preview, remove, image-only send), claude-ui-check ("Choose model" enabled).
