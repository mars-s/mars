# Mars

A Next.js workspace for your Pi agent, built from the supplied Claude desktop screenshots. Dark neutral surfaces, grouped sessions, a compact composer, and a workbench for context, files, tasks, terminal and browser previews.

**This is a working UI project with local demo state.** It does not connect to a Pi server or call a model out of the box. You can run, explore and extend it without API keys. The chat uses real assistant-ui primitives and an application-owned transport interface that you can adapt to your VM.

![Mars workspace](docs/previews/workspace.png)

## Run it

Use Node.js 22 or newer. This project was built and verified with Node.js 24.

```bash
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. No environment file is required for the demo.

For a production build:

```bash
npm run build
npm run start
```

Both development and production bind to `127.0.0.1` by default. The scripts use the supported webpack bundler. Dependencies are pinned in `package.json` and `package-lock.json`.

## What is implemented

| Area | Working UI behavior |
| --- | --- |
| Sessions | Project groups, new session, search through titles and messages, rename, pin, archive, restore, delete, conversation export |
| Conversation | assistant-ui thread, Markdown and tables, local streaming, Stop, copy, retry, edit, model and permission selectors, keyboard slash commands |
| Context | Environment controls, collapsible context, estimated conversation tokens, memory-file links, connector details |
| Files | Folder tree, search, tabs, Markdown preview, source editing, create and download local files, persistence |
| Changes | Comparison against the sample original files, additions/deletions, copy diff, restore and undo |
| Terminal | An explicitly local demo supporting a small documented command set, input history, clear, and shared demo files |
| Browser | Built-in interactive workspace preview, local navigation, checklist and notes, address field, external-site boundary |
| Background tasks | Status list, task details, approval, pause/resume, explicit demo step completion, session links |
| Routines | Template gallery, editor, schedules, search/filter/sort, enable/pause, edit/delete, Run now as a labeled demo conversation |
| Customize | Skills, connectors and plugins; Yours/Discover; search/filter/sort; local install/remove; editable instructions; custom configurations |
| Artifacts | Preview and source, search, create, edit/delete user-created items, copy and download |
| Workspace | Resizable and expandable panels, mobile navigation, dark/light/system theme, reduced motion, keyboard shortcuts |

All controls that affect a runtime remain demo controls until you supply their server actions. Connector installation saves a configuration; it does not authenticate an account. Routine schedules are editable definitions; no scheduling service runs in the browser. The terminal does not execute a shell, and the browser preview does not drive a remote browser.

### A few things to try

1. Send a message and stop or retry the streamed demo response.
2. Press `⌘/Ctrl K`, find **Memory & continuity**, and rename the session from its title menu.
3. Open **Files**, select `README.md`, switch to source, and edit it. Open **Changes** to review the difference.
4. Open **Background tasks**, select the item waiting for approval, and move it through the demo states.
5. Choose **More → Routines**, use a template, save it, and select **Run now**.
6. Choose **Customize**, install a starter skill and edit its instructions.

## Design references

The privately supplied screenshot pack was the primary visual reference. Personal screenshots remain outside the public repository; DESIGN.md records the design direction. They are not needed to install or run Mars.

`DESIGN.md` documents the implementation's palette, layout, typography and interaction rules. The public Claude design analysis from getdesign.md was reviewed as a secondary reference. Its emphasis is the marketing site, so its large cream sections and marketing typography do not override the supplied desktop screenshots.

The project uses its own Mars wordmark and planet icon. It does not bundle Anthropic's proprietary fonts. The default stack uses local sans-serif fonts for the workspace and Georgia for the small editorial headings and document previews.

## Connecting Pi on your VM

Start with **[docs/PI-INTEGRATION.md](docs/PI-INTEGRATION.md)**. The main boundary is:

```tsx
<ChatThread
  sessionId={session.id}
  onOpenPanel={selectPanel}
  transport={yourMarsTransport}
/>
```

Implement `MarsTransport` from `lib/pi/transport.ts`, then pass it at the `ChatThread` call in `components/workspace-shell.tsx`. `lib/pi/demo-transport.ts` is a small, runnable example of the event contract.

The contract is defined by this UI. It is **not a claim about Pi's native protocol**, and there are no invented Pi HTTP routes in this project. Connect it to the version and gateway you actually run.

The transport covers message streaming, detachment, optional reconnection and explicit cancellation. To complete the integration, add your server's authoritative conversation snapshots, event cursors, task actions, files, permissions, routine storage and capability discovery. See the integration guide for the individual seams.

### Tailscale

Run Next.js on your VM under your chosen process supervisor. With Next listening on localhost, you can expose the UI privately with Tailscale Serve from another terminal:

```bash
tailscale serve --bg http://127.0.0.1:3000
```

Use the HTTPS address reported by Tailscale. The connected clients must be allowed by your tailnet policy. The Pi gateway can be served behind the same origin or through a separately configured private endpoint. Keep model/provider keys on the VM.

Saving a Gateway URL in **Settings → Pi connection** only stores that preference. It does not activate a remote transport or imply a successful connection.

## Source map

| File or directory | Purpose |
| --- | --- |
| `app/` | Next.js App Router entry, metadata, theme tokens and error view |
| `components/workspace-shell.tsx` | Layout, toolbar, navigation, panel resizing, responsive behavior |
| `components/workspace-sidebar.tsx` | Session groups and session actions |
| `components/workspace-dialogs.tsx` | Search, settings and confirmation dialogs |
| `components/chat-thread.tsx` | assistant-ui runtime binding, messages, composer and streaming lifecycle |
| `components/workspace-panel.tsx` | Context, files, changes, terminal, browser, tasks and side chat |
| `components/workspace-pages.tsx` | Routines, customization and artifacts |
| `components/ui/` | shadcn component source and the shared icon button |
| `components/react-bits/` | Adapted Warm Tooltip and Status Mark components |
| `lib/types.ts` | Application types |
| `lib/store.ts` | Guarded local persistence, hydration and workspace actions |
| `lib/demo-data.ts` | Explicitly fictional sample conversations and work |
| `lib/pi/` | Application-owned transport contract and deterministic demo implementation |
| `tests/` | Browser integration tests |
| `docs/` | Integration, design decisions, verification and preview images |

## Local data

The sample workspace is saved in these browser storage keys:

- `mars-workspace-v1`: sessions, task states, routines, model/permission choices and appearance.
- `mars-workspace-pages-v1`: installed demo configurations, instructions and custom artifacts.
- `mars-ui:demo-files:v1`: demo file contents used by Files, Changes and Terminal.

Other `mars-ui:` keys keep the small browser/side-chat previews. These are browser-local examples, not a durable server database. State does not automatically synchronize across devices or tabs.

In the local demo, switching away from a streaming conversation stops that sample response. A remote transport has a different lifecycle: leaving a view detaches its stream, and **must not cancel the server run**. Explicit Stop uses the transport's separate cancellation operation. Interrupted local streams and detached remote views are restored with distinct states after reload.

Editing or retrying replaces the affected local conversation tail. A full server implementation should decide how conversation branching and history retention work.

## Verification

```bash
npm run typecheck
npm run build
npx playwright install chromium
npm run test:ui
```

The tests start or reuse a local development server. For a preinstalled Chromium executable, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. This is optional and no machine-specific path is committed to the project configuration.

See **[docs/VERIFICATION.md](docs/VERIFICATION.md)** for what was actually checked and the limits of that verification.

## Continuing development

Read `DESIGN.md`, then the screenshots for the screen you are changing. Keep the neutral dark theme as the default and preserve the compact desktop proportions. The four feature CSS files are intentionally separated so the shell, chat, workbench and full pages can evolve independently.

The next useful implementation milestone is one real conversation: load its server snapshot, send a message, follow its stream, disconnect, and reattach without duplicating the run. Once that loop works, connect the existing task approval and file actions.

## Credits and licenses

Built with [Next.js](https://nextjs.org/), [assistant-ui](https://www.assistant-ui.com/), [shadcn/ui](https://ui.shadcn.com/), [React Bits](https://reactbits.dev/c/micro), [Lucide](https://lucide.dev/), Motion and Zustand. Source links and provenance are in [docs/SOURCES.md](docs/SOURCES.md).

Original project code is MIT licensed. React Bits source has its own **MIT + Commons Clause** terms; the complete upstream license and attribution are retained in `licenses/react-bits.txt`. The supplied reference screenshots remain reference material, outside the code license. Review the retained third-party notices before redistributing the project.
