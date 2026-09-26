# Roadmap

Stage plan, issue index, wave status. Read `CONTEXT.md` first.

## Status key

`todo` · `in flight` · `review` · `done` · `blocked`

## Stage 0. Baseline

| # | Issue | Status |
| --- | --- | --- |
| [#2](https://github.com/mars-s/mars/issues/2) | Record a verified green build on the reverted tree | done |

`pnpm install`, `pnpm typecheck` and `pnpm lint` all exit 0. `pnpm fmt:check` exits 1
on 31 pre-existing `bots/` files and is therefore not a gate. See `verification.md`
for the caveat that typecheck excludes `apps/zcode-cli`.

## Stage 1a. Stop phoning home

The top priority. Nothing else in stage 1 matters until this is provably done.

| # | Issue | Status | Owner |
| --- | --- | --- | --- |
| [#3](https://github.com/mars-s/mars/issues/3) | Stop ARMS RUM and event telemetry | done | merged, 13.4k lines deleted |
| [#4](https://github.com/mars-s/mars/issues/4) | Stop the remote asset CDN fetch | done | merged, 3 env vars now opt-in |
| [#5](https://github.com/mars-s/mars/issues/5) | Stop the remote provider-config sync | done | merged, hourly poll removed |
| [#6](https://github.com/mars-s/mars/issues/6) | Neutralise remaining hardcoded endpoints | done | merged, wave A, gate 8/8 |

Wave 1 shipped on `main`. After the three merges: `pnpm install --frozen-lockfile` exit 0,
`pnpm typecheck` exit 0, `pnpm lint` exit 0 (70 pre-existing warnings). Vendor-host lines
across `packages/ apps/ config/ scripts/` went from 68 to 64, in 30 files down to 27. What
is left is auth and provider-catalog endpoints, not background traffic, and that is stage 1c.

## Stage 1b. Unblock the type cascade

| # | Issue | Status |
| --- | --- | --- |
| [#7](https://github.com/mars-s/mars/issues/7) | Widen `ModelProviderFamilyId` and `BuiltinModelProviderId` | done |

Do this before touching any UI. It is an hour of work that converts the least
predictable part of the project into something estimable.

## Stage 1c. Remove the surfaces

| # | Issue | Status |
| --- | --- | --- |
| [#8](https://github.com/mars-s/mars/issues/8) | Delete Z.ai and BigModel catalog templates | done | 0 `providerRules`, 16 templates survive |
| [#9](https://github.com/mars-s/mars/issues/9) | Delete coding-plan, pricing and usage stats | done | generic app-usage types kept |
| [#10](https://github.com/mars-s/mars/issues/10) | Remove Z.ai from welcome screen and login | done | API-key picker lists the 16 survivors |
| [#11](https://github.com/mars-s/mars/issues/11) | Delete the Z.ai and BigModel OAuth subsystem | done | `OAuthProviderAdapter` seam kept for #13 |
| [#12](https://github.com/mars-s/mars/issues/12) | Prune Z.ai i18n keys | done | 601 keys per locale file, 1467 lines |

## Stage 1d. UI surgery

| # | Issue | Status |
| --- | --- | --- |
| [#15](https://github.com/mars-s/mars/issues/15) | Extract Z.ai plan cards from provider settings | done | no plan-card code left in settings |

The hard one. Depends on [#7](https://github.com/mars-s/mars/issues/7) and
[#9](https://github.com/mars-s/mars/issues/9) landing first.

## Stage 2. Authentication

| # | Issue | Status |
| --- | --- | --- |
| [#13](https://github.com/mars-s/mars/issues/13) | Implement the ChatGPT OAuth adapter | code done, live flow unverified |
| [#14](https://github.com/mars-s/mars/issues/14) | OpenCode Go end-to-end verification path | blocked, needs `op signin` |

### #13 evidence

Landed as three commits: the adapter, the request-path wiring, then the
adversarial-review fixes. The catalog is at `revision 33` with 17 templates: the
original 16 untouched and `chatgpt-subscription` appended.

**Device code is the default and the only wired flow.** Loopback PKCE on port 1455
is implemented and tested but nothing routes to it, because the port is fixed by
OpenAI's client registration and a GUI holding it collides with a Codex CLI login.
The fallback would be device code anyway.

**The credential never enters the agent process's config.** The agent asks the host
over `interaction/requestProviderRuntimeHeaders` and the host answers per request.
Identity comes from the host's own registry, after the personal overlay: the
request's `providerId` is a lookup key, never the identity. Four facts must hold
(`templateId`, `access.type`, `api.type`, normalized `baseUrl`), and the host
returns the `baseUrl` it approved so the agent can prove its own frozen base URL
matches before attaching anything. A refusal is indistinguishable on the wire from
"not signed in".

**Refresh rotation is single-path and cross-process locked.** `ChatGptGrantStore.rotate`
holds the lock across read, POST and write-back, and adopts a peer's already-rotated
pair rather than replaying a spent token. The grant store interface has no `exchange`
seam, so nothing on the credential path can be pointed at another authorization server.

**Electron `safeStorage` is not used anywhere.** The fork never called it; the grant
store uses the app's existing pure-Node AES-256-GCM cipher instead, so a locked or
missing macOS keychain cannot raise a blocking dialog on launch.

**`store: false` is injected by a fetch wrapper**, not a provider option, because the
AI SDK's `openaiOptions.store` is `nullish` and gets stripped before serialization.
The configured base URL is the parent `https://chatgpt.com/backend-api/codex`; the SDK
appends `/responses` itself.

**Adversarial review found no exfiltration path** (23 URL bypasses probed, all fail;
rotation cannot loop; the moved API-key validation is equivalent for every non-oauth
shape and stricter for oauth). It did find three real defects, all now fixed: a TOCTOU
between the host's live registry and the agent's frozen snapshot, an unbounded growth
of `pendingProviderRuntimeHeaders`, and a load-bearing ordering that was true only by
accident of the current call graph.

**The live flow is UNVERIFIED.** Every test runs against fakes. A real model call has
never been made, and that needs a human with a ChatGPT Pro subscription. The manual
steps are in the #13 report. This is the one clause of the ticket's done-when that is
not met, so the ticket stays open.

## Verification capability, established 2026-09-26

Not a stage, but it changes how the rest gets checked.

The app already opens a Chrome DevTools Protocol port on 9229 when unpackaged, and
`agent-browser` 0.23.0 is installed, so the running app is drivable today. There is
no test suite and no test runner in this tree, and the vendor's e2e harness is
absent, so anything beyond a driven UI check has to be built. `maintain-verification-skill`
still has no target because there is no `.claude/skills/verify/` feature map; run
`/create-verification-skill` first.

The phone remote connect has been investigated. It is **not** a relay, tunnel or
QR pairing feature: there is no vendor-hosted control server in this tree. What
exists is **Bot Channels** (`packages/services/src/bots/`), which lets a phone
drive the workspace through the operator's own Telegram, Weixin, Feishu or Lark
bot, plus a generic `webhook` provider for headless use. See
`verification.md` for the full map and a headless proof.

It is **intact for local workspaces**, which need no network at all. Remote
(SSH/Docker/WSL) workspaces do need `ZCODE_CDN_BASE_URL` pointed at a self-hosted
release asset base, because the vendor default was removed in issue #4. That is
the documented trade in `DECISIONS.md`, not a regression, but it is the one
behavioural break to tell the owner about. The `mock-cdn` fallback is generated
by `pnpm prepare:remote-assets`, not committed, so dev needs that run once.

## Process

| # | Issue | Status |
| --- | --- | --- |
| [#16](https://github.com/mars-s/mars/issues/16) | Resolve the language conflict in AGENTS.md | done |

Resolved by translating `AGENTS.md` to English only and replacing the conflicting
rule with "When fixing a bug, comment in English on the cause and on the reasoning
behind the fix." All 61 backticked code spans were kept byte-identical and the file
now contains no Han characters.

## Later stages, not yet planned

These are direction, not plan. No issues yet.

- **Service surface inside the agent process.** Expose the tool registry, the
  `InMemoryHookRunner` callback seam, the session store, the MCP registry and the
  provider seam so a plugin container can reach them. This is the bulk of the
  work and it is a refactor, not an integration.
- **Cordis on top of that.** Gives lifecycle, disposal, dependency injection and
  automatic reconfiguration. Nearly free once the surface exists.
- **Agent-written plugins.** Evaluated as source strings in a `node:vm` realm with
  a capability facade. Not ESM hot reload. See `DECISIONS.md` entry 6.

## Wave discipline

One wave at a time, and a wave ends when every issue in it is reviewed, merged
and verified. Never start a wave whose prerequisite wave is unreviewed.

Within a wave, work is partitioned by file ownership. Each worker gets its own
git worktree and is told exactly which shared files it must not touch, and to
report the edit it needs instead. Cross-lane needs are resolved by the
coordinator, not by two agents editing one file.

The risk this avoids is concrete: `pnpm typecheck` excludes `apps/zcode-cli`, so
a broken import in the agent CLI is invisible to the check that everyone is
relying on. Merge one change at a time and let the reviewer's own eyes catch it.
