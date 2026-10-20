# Mars workspace design

## Reference priority

1. The 46 user-supplied Claude desktop screenshots in the owner's privately supplied screenshot archive.
2. The working Mars screens in `docs/previews/` and the implementation tokens in `app/globals.css`.
3. The primary [assistant-ui Claude example](https://www.assistant-ui.com/examples/claude) and public Anthropic articles listed in `docs/SOURCES.md`.
4. The independent public Claude design analysis at https://getdesign.md/claude/design-md, as background only.

The public Claude analysis describes a marketing surface. Its cream hero sections, large serif type and broad spacing do not define this desktop workspace. The supplied app screenshots control density, panel geometry, backgrounds and controls.

## Product surface

Mars is a persistent personal assistant workspace. The live Pi client keeps one server-backed conversation central, with installed extensions and settings reachable from compact navigation. Future files, tasks and project surfaces must use the same visual language when the corresponding backend exists.

The browser UI has a Mars identity and omits simulated macOS traffic-light window buttons. It preserves the reference app's low-contrast navigation, quiet upper toolbar, conversation spacing and lower composer. The imported project groups and right-side workbench remain reference implementations, outside the live route. Account, appearance and connection details belong in Settings, not permanent side panels.

## Dark palette

| Role | Value |
| --- | --- |
| Main canvas | `#141414` |
| Sidebar | `#111111` |
| Surface | `#1a1a1a` |
| Raised surface / message bubble | `#222222` |
| Popover | `#242424` |
| Main text | `#d9d9d6` |
| Secondary text | `#999994` |
| Quiet labels | `#74746f` |
| Panel border | `#2b2b29` |
| Input edge | `#343431` |
| Selected tool control | Muted blue on a deep blue surface |
| Small brand accent | `#d9987d` |
| Success | `#99b59b` |
| Error | `#d88480` |

Prefer semantic variables to new hex values. Dark surfaces are predominantly neutral, with slight warmth in the text. Orange is a small identity/status accent. Borders define panels; most surfaces have no visible shadow. Popovers may have a restrained shadow for separation.

The light theme is a secondary accessibility and preference option. It uses warm off-white and the same component geometry.

## Typography

The default families are the user-supplied Anthropic Sans, Anthropic Serif and Anthropic Mono. Load the supplied files locally through `next/font/local`, without a remote font service. Anthropic Sans covers controls and conversation reading at the existing sizes: 12–13 px controls, 15 px live conversation and 10–12 px metadata. Preserve theme, text-size and motion preferences.

Use Anthropic Serif at regular weight wherever the design already uses serif type: the Mars wordmark, page headings, empty-conversation greeting and document previews. Keep the greeting at 29–43 px on desktop and 30 px on narrow screens. Keep ordinary conversation reading sans-serif. Anthropic Mono covers code, terminal content and command evidence. Keep existing fallback families for unavailable fonts and keep existing geometry.

Use the variable normal and italic Sans/Serif files and variable normal Mono file. Do not replace application icons with the archive's unrelated icon fonts. The supplied archive contains font files only, with no licence or redistribution notice. Record that provenance with the local files without asserting a licence that was not provided.

## Geometry

- Live sidebar: 256 px desktop; compact rows for Conversation, Extensions and the current Pi conversation. Settings sits at the bottom. Legacy reference widths range from 234–276 px.
- Live header: 58 px desktop, 54 px mobile; small title on the left and settings on the right.
- Live conversation: an 820 px maximum outer column with 32 px side padding, shared with the composer. Narrow screens reduce that padding.
- Composer: one rounded input surface with runtime and model controls beneath the text area. The text area grows for multiline input. In an empty conversation the greeting and composer sit together; after messages arrive the composer stays at the bottom.
- Legacy context reference: about 252 px; independent Environment, Context and Connectors cards. It is not mounted on the live Pi route.
- Workbench: resizable beside chat, with expand/restore. File navigation is on the far right of the file pane.
- Full pages: about 876 px maximum; two-column customization cards and unboxed routine template rows.
- Routine editor: about 636 px maximum, compact fields, a bounded instructions editor, and substantial whitespace below.

The larger source screenshots are 3024 × 1898. The desktop design was compared at a 1512 × 949 viewport, treating them as likely 2× captures. This is an implementation measurement assumption, not metadata supplied by the screenshot app.

## Motion and feedback

The supplied React Bits Warm Tooltip supports coordinated icon hints; Status Mark represents task-state transitions in the live client. Defaults are deliberately quiet: approximately 120–180 ms, no blur, no tooltip tilt, and tiny status glyphs. Preserve reduced-motion behavior. Do not add a particle field, glowing cards, continuous decorative motion or animated backgrounds.

Menus, forms and dialogs use shadcn/Radix behavior. Preserve visible focus, Escape, return focus, keyboard operation and informative labels. Hover actions must also appear on keyboard focus. On touch layouts keep essential actions reachable without hover.

## Responsive behavior

At widths of 760 px or less, the live sidebar becomes an overlay navigation drawer. In the legacy reference shell an opened workbench replaces the conversation view. Close returns to the conversation. Less common tools move into View options. Do not squeeze the desktop file tree, editor and conversation into three unusable columns.

Page grids collapse; forms and dialogs scroll within the viewport. Keep the composer visible and allow conversation text to wrap. Avoid horizontal document overflow.

## Live behavior and retained examples

`app/page.tsx` mounts `components/live-workspace.tsx`, which renders Pi state through the assistant-ui external store runtime. Pi owns messages, tool calls and results, run status, model choices, account state and the installed-extension catalogue. The browser stores the colour preference separately. Installed extension UI mounts inside the Extensions page from its authenticated catalogue path.

The original ZIP examples remain reference source and are not mounted on the live route. Those examples are explicitly local. Do not display fabricated live latency, connection health, exact model context capacity, authentication success or background execution. The context token figure is labeled as an estimate derived from text length.

Keep the same visual language when extending the live client, and use server-confirmed states. Leaving a chat view should detach observation; cancellation is a distinct server action. See `docs/PI-INTEGRATION.md`.

## Reference screen map

| UI area | Primary supplied screenshots |
| --- | --- |
| Session shell and composer | 01, 15–18, 34, 37–40 |
| Context and environment | 42–46 |
| Terminal | 02–04 |
| Browser | 05–08 |
| Files and document editor | 12–14, 47–48 |
| Changes | 19 |
| Customize | 20–21 |
| Routines and scheduling | 22–30 |
| Tasks and side chat | 31–35, 41, 50 |

The simulator and operating-system integration shown in the references require a backend and are not recreated as an operating-system capability in this UI project.

## Applied guidance

The supplied screenshots establish the visual direction. [Impeccable](https://impeccable.style/) and the installed Emil design-engineering skill guide the refinement: preserve the incumbent neutral palette, reduce permanent controls, explain actual errors, keep focus visible and use motion only for useful feedback. Public Anthropic articles describe reusing a design system but do not supply an official Claude app token specification. See `PRODUCT.md` for product boundaries and `docs/SOURCES.md` for dated research.

## Private connection settings

Apps is a nested Settings tab, beside Account, Appearance and Connection. It keeps
masked Discord/OpenCode fields out of the conversation. Inputs and actions are
44px on touch layouts, save feedback remains local, and explicit Connect is
separate from saving. Long mobile forms scroll inside the dialog. Connection
metadata comes from the host, never a demo account or static success label.
