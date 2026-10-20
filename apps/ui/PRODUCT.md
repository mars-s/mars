# Mars Pi workspace

## Purpose

Mars is a private web client for the Pi Durable agent running on Bot Box. The owner opens it from a Mac through the existing private Tailscale connection, continues a persistent conversation and inspects tools or installed extension UI without managing a terminal.

## Product commitments

- The conversation is the main activity. Settings, sign-in, appearance and runtime details stay behind deliberate controls.
- Pi owns conversation history, runs, tools and installed extensions. Browser refresh and a service restart must recover server state without submitting the prompt again.
- Show real server data. The imported ZIP's projects, routines, files, sample conversations, user profile and model choices do not establish working backend features.
- The current trial exposes the existing Pi conversation, model selection, ChatGPT sign-in and installed extension panels. Add further navigation only with a functioning server operation and verification.
- ChatGPT authentication belongs to the Pi host. Browser code must not contain provider credentials. Opening the workspace does not authorise live Discord access, external deployment or sending messages.
- A mocked Discord extension is the comparison task: the agent builds and installs its tool and UI, uses fixture data, and both survive a restart. Label mock results clearly. Report live-model evaluation separately from fixture tests.
- Pi Durable and this client form the Mars application. Preserve existing Pi conversations, credentials and installed plugins when migrating a running installation.

## Interface direction

Follow the supplied Claude app screenshots while keeping the Mars name and mark. Use a quiet dark canvas, compact navigation, clear conversation typography and a large usable composer. Copy the useful interaction patterns rather than Claude account details, proprietary branding or unavailable product features.

Use assistant-ui for conversation rendering, Markdown, composer and runtime binding; shadcn/Radix for controls; and the supplied React Bits components for restrained status feedback and hints. Use Next.js, TypeScript and Tailwind with exact dependency versions and a committed lockfile. Impeccable and Emil's guidance inform spacing, accessibility and motion decisions.

## Development and extension

Next.js development mode should reflect validated UI source changes through hot reload. Agent-written UI changes need a bounded, reviewable update path with verification and recovery. Hot reload alone is not evidence that an agent safely extended the application.

## Success checks

The owner can open the private URL, complete ChatGPT sign-in, see persisted Pi history, send a prompt and stop a run. The interface exposes current server errors and connection state without fabricated activity. Tool details and installed extension UI remain reachable with a keyboard and on a narrow screen. Motion respects the operating system preference. A verified UI edit appears without losing the conversation.

This document records the user's brief and product constraints. Verification reports establish which checks have actually passed.

The owner can configure private Discord/OpenCode connections in Settings Apps.
Discord connection is explicit and initially read-only for one selected server.
No message sending or automatic Gateway bot is provided. OpenCode Go is an
optional configured provider, separate from the verified ChatGPT login.
