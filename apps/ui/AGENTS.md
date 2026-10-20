<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Mars UI workspace

Read the repository root AGENTS.md and docs/MONOREPO.md first. Install and verify
from the monorepo root with its single npm lockfile. Runtime source is in
packages/pi-host. UI source is in this directory. The root .agents context owns
the current handoff and change log.

Read DESIGN.md, PRODUCT.md and docs/PI-INTEGRATION.md before changing UI. Preserve
the assistant-ui external store binding, native Pi ownership, saved drafts,
image references, workflow and subthread distinctions, plugin controls and local
fonts. Browser detachment must not cancel durable server work.

Source-owned shadcn and React Bits components retain their notices in licenses/.
The unmounted browser-local demo is reference source. It never supplies live
runtime data. Keep credentials in the Pi host or server-only development proxy,
never NEXT_PUBLIC variables. See the root README for install and Mac development.
