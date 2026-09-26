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

## 2026-09-26 — wave 1 lane: provider-config sync (issue #5)

Removed layer 3 of the provider config. `zcode-builtin-remote-synchronizer.ts` (lease/TTL/failure
backoff hourly scheduler) and `zcode-builtin-download.ts` (the fetch of
`https://<endpoint>/api/v1/client/configs` followed by a CDN release) are deleted, along with
`zcodeBuiltinRemoteConfig.ts` in services. 13 files, 520 lines deleted, 36 added.

What survives on purpose: the bundled JSON in `packages/server/tsup.config.ts` stays the single
source of truth, the Active/LKG file stays a discardable cache of it, and
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` still overrides both for air-gapped installs.

The load-bearing part is the timer. The 60s `setInterval` in `NodeProviderConfigRuntime` used to
run `refreshZCodeBuiltin()`, which went to the network. It is now created only when a recovery
listener is registered, so a default install does no background polling at all.

Verified on `main` after the merge: `pnpm typecheck` exit 0, `pnpm lint` exit 0 (70 warnings, all
pre-existing). Also checked that no consumer still switches on the removed `"skipped"` result.

Left for later: orphaned `zcode-builtin-refresh.json` lease files from old installs are never
cleaned up, and `onZCodeBuiltinRefreshError` is now a misnomer (it reports recovery-check
failures, not refreshes).

## 2026-09-26 — wave 1 lane: asset CDN (issue #4)

`DEFAULT_CDN_BASE_URL = https://cdn-zcode.z.ai` is gone. `resolveRemoteCdnBaseUrls` returns
`[]` when nothing is configured, which promotes the local mock-CDN path that
`remoteAssetDeployDecision` already preferred, rather than deleting the remote path. Three env
vars now carry the whole contract: `ZCODE_CDN_BASE_URL`, `ZCODE_OFFICIAL_MARKETPLACE_SOURCE`
and `ZCODE_OFFICIAL_PLUGIN_ASSETS_BASE_URL`.

The plugin engine was not touched. `parseMarketplaceSourceInput` still accepts directory, file,
git, github and url sources, and the built-in official plugins are still seeded at startup from
`OFFICIAL_PLUGIN_DEFINITIONS`, so the marketplace survives; what is gone is the remote/community
portion of the catalog, which `DECISIONS.md` entry 4 already accepted.

I then fixed `.env.example` myself. It still shipped `ZCODE_CDN_BASE_URL=https://cdn-zcode.z.ai`
and `ZCODE_REMOTE_ASSET_CDN_BASE_URL=https://cdn-zcode.z.ai/...`, so a developer copying it
would have silently undone the whole lane. Both are now empty and documented as
operator-configured, with the two new vars added.

## 2026-09-26 — wave 1 lane: telemetry (issue #3)

The vendor telemetry path is gone: the `@arms/rum-electron` dependency and its patch, 9
desktop `*Telemetry.ts` aggregators, the ARMS bootstrap and RUM bridge, the crash-capture
remote reporter, the whole `@zcode/telemetry` CLI package (OTLP exporter, bootstrap, agent trace
runtime), and the shared `ZCODE_TELEMETRY_*` / `ZCODE_ARMS_RUM_ENDPOINT` surface. 129 files,
13,417 lines deleted.

Two behaviours worth remembering:

  `reportTelemetryEvent` stays a platform method because 8 UI modules call it, but its main-side
  channel is now `DiscardTelemetryEvent` and resolves without doing anything. Deleting the method
  would have left 8 renderers with a rejected `ipcRenderer.invoke`.

  `isZCodeAgentTelemetryEnvKey` was replaced by an explicit literal `OTEL_*` guard rather than
  deleted. Removing it outright would have let OTEL credentials flow into Bash and MCP
  subprocesses, which is the confused-deputy problem it existed to stop.

`crashReporter` now runs with `uploadToServer: false`, so crash dumps stay local.

### The one bug the worker's own verification missed

The worker removed the ARMS patch from `pnpm-lock.yaml` and deleted the patch file, but left
`pnpm.patchedDependencies` in the root `package.json` still pointing at it. `pnpm install` died
with `ENOENT: no such file or directory, open 'patches/@arms__rum-electron@0.0.3.patch'`. The
worker's `typecheck` and `lint` both passed because it ran them against a pre-existing
`node_modules` without reinstalling. Removing the declaration makes
`pnpm install --frozen-lockfile` exit 0 with `Packages: -243`.

The lesson for every future wave in this repo: **a lockfile or manifest change is not verified
until `pnpm install --frozen-lockfile` has been run after it.** `pnpm typecheck` and
`pnpm lint` prove nothing about installability.

### Known second channel, deliberately not touched

`packages/desktop/src/main/localTtft*` still exports OTLP, but only to an endpoint the user
configures via `OTEL_EXPORTER_OTLP_*`. It contains no hardcoded vendor host and was out of scope
for issue #3. It is a second telemetry channel and should be a deliberate decision, not an
accident. Same for the CLI MCP telemetry tracker, which reports over local IPC to the app and
never to the network; its desktop consumer is gone, so its output now has nowhere to land.
