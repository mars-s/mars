# Changelog

Append-only. One entry per change. Newest at the top. Name the agent that made
the change so the other one knows who to ask.

Format: `- **<what changed>** — <agent> — <issue or reason>`

---

## Unreleased

- **Reverted the Mars fork back to upstream ZCode 3.14.3.** Deleted
  `packages/mars-gateway` and `packages/mars-desktop`, restored the original
  ZCode theme, restored the Z.ai env config. Working tree verified byte-identical
  to upstream commit `29628c9`. — ZCode — reverted a ChatGPT-authored fork that
  replaced the ZCode UI with a thin Electron client the owner did not want.
- **Added the shared agent context folder.** `.agents/README.md`,
  `CONTEXT.md`, `ROADMAP.md`, `DECISIONS.md`, `CHANGELOG.md`, `verification.md`,
  `pstack-models.md`. — ZCode — two agents share this repo and need one place to
  record what each did.
- **Pinned every pstack role to `space-bunny-free`.** — ZCode — owner instruction.
- **`pnpm install` verified clean.** 14.5s against a warm store, exit 0. — ZCode —
  baseline check before touching anything.
