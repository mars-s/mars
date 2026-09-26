# Context

Read this first. It is the state of the project, not the plan.

## What this project is

A fork of ZCode 3.14.3, owned outright by one person. The goal is to strip the
Z.ai / Zhipu / BigModel / GLM coupling completely, replace authentication with a
ChatGPT subscription OAuth flow, and then build a cordis-style self-modifying
plugin system on top.

Longer term, after the de-Z.ai work lands: a service surface inside the agent
process, cordis on top of that, and agent-writable plugins evaluated in a `node:vm`
realm rather than through the ESM module cache.

## Current state

- Repo is at upstream ZCode 3.14.3 content. The Mars fork's gateway and its
  Electron client were reverted away. See `ROADMAP.md` stage 0.
- `pnpm install` succeeds in about 15 seconds against a warm pnpm store.
- **There is no test suite.** Four test files in the whole repo and no `test`
  script in any package. This is the single biggest risk to the refactor.
- `pnpm typecheck` deliberately excludes `apps/zcode-cli`, so a green typecheck
  does not mean the CLI compiles. Do not read it as a full build.

## Standing rules

These are decisions the owner has made. Do not relitigate them.

1. **Phoning home stops first.** No Z.ai traffic of any kind, as soon as
   possible. This is the top priority over everything else in stage 1.
2. **The plugin marketplace stays.** It is wanted. The official Z.ai marketplace
   seed is the only part that goes.
3. **The phone remote connect stays.** The owner likes it. Remote capability is
   not in scope for removal. Only the Z.ai CDN it fetches assets from is.
4. **Pricing, BigModel and Z.ai go.** All of it. Usage stats, coding plan,
   quota banners, the upgrade webview.
5. **Removal goes as deep as is noticeable.** It does not have to be total. Some
   vestigial Z.ai strings may survive. Nothing user-visible may remain.
6. **OpenCode Go and ChatGPT OAuth are the only two providers.** Both. They are
   not alternatives.
7. **Always use the `space-bunny-free` model** unless the owner changes it. See
   `pstack-models.md`. It is a limited-time free model, so this pin has an
   expiry and needs a planned replacement.

## What is known about the Z.ai coupling

Measured, not estimated.

- 860,786 lines of TypeScript and TSX in total.
- 263 files contain a Z.ai marker, but only about 4,600 lines actually reference
  Z.ai. The coupling is wide and shallow.
- The OAuth layer is a real adapter interface, `OAuthProviderAdapter`, with
  `parseCallbackParams`, `buildAuthorizeUrl`, `exchangeToken`,
  `normalizePolledTokenSet`, `fetchUserInfo`, `refreshToken`, `normalizeError`.
  Replacing the providers is implementing that interface, not a rewrite.
- The provider catalog is data, not code. `config/provider/zcode-builtin.json`
  holds 20 templates, only 4 of which are Z.ai. OpenCode Go templates already
  exist there.
- **There is no paywall.** The only entitlement check disables the Z.ai coding
  plan from the model picker. Nothing else is gated.
- The packaged app has no live update feed. `electron-builder.config.js` points
  publish at `localhost:8081` on purpose.
- Telemetry is gated on two env endpoints, not on the enabled flag. Unset them
  and both channels are dead. `ZCODE_TELEMETRY_ENABLED` is hardcoded true and is
  inert without an endpoint.
- The marketplace already supports `source: "directory"` and `source: "git"`.
  Nothing in the plugin engine needs to change to drop the official one.

## The hard part, stated honestly

`ModelProviderFamilyId` and `BuiltinModelProviderId` are literal unions whose
entire membership is Z.ai. They gate how much of the 113-file `packages/ui`
surface can be touched without cascading type errors. Widen them first, before
writing anything else. It costs an hour and it tells you whether the UI work is
a week or a month.

The Z.ai plan surfaces are interleaved with the generic provider settings UI
inside the same components. `Detail.tsx` and `StatusCards.tsx` each render both.
That is real surgery, not file deletion, and it is most of the remaining time.

## Blocked

- **1Password is not signed in.** Neither account. The owner must run `op signin`
  before the OpenCode Go key can be read for end-to-end verification. Do not
  attempt to read the vault until then. Do not commit any credential.
