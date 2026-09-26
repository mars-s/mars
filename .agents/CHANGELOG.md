# Changelog

Append-only. One entry per change. Newest at the top. Name the agent that made
the change so the other one knows who to ask.

Format: `- **<what changed>** — <agent> — <issue or reason>`

---

## Unreleased

- **Removed every `cdn-zcode.z.ai` origin from shipped source.** Remote release
  assets, the official marketplace catalog, official plugin store icons and the
  suggested-prompt icons no longer have a built-in vendor host; each is now
  operator-configured via `ZCODE_CDN_BASE_URL`,
  `ZCODE_OFFICIAL_MARKETPLACE_SOURCE` and `ZCODE_OFFICIAL_PLUGIN_ASSETS_BASE_URL`.
  Remote connect and the plugin marketplace both stay. Development remote connect
  still runs off `mock-cdn`; a packaged build with nothing configured now fails
  with an explicit "no remote asset origin is configured" error instead of
  reaching a third party. — w1/cdn — issue #4, de-Z.ai-ify the asset CDN path.
  `packages/desktop/src/main/remoteCdn.ts`,
  `packages/server/src/remote/remoteAssetCache.ts`,
  `packages/shared/src/plugin-marketplaces.ts`,
  `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`,
  `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-reference-catalog.ts`,
  `packages/ui/src/v4/featureSuggestedPrompts.ts`,
  `packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx`.

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
