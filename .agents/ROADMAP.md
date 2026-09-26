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
| [#6](https://github.com/mars-s/mars/issues/6) | Neutralise remaining hardcoded endpoints | todo | next |

Wave 1 shipped on `main`. After the three merges: `pnpm install --frozen-lockfile` exit 0,
`pnpm typecheck` exit 0, `pnpm lint` exit 0 (70 pre-existing warnings). Vendor-host lines
across `packages/ apps/ config/ scripts/` went from 68 to 64, in 30 files down to 27. What
is left is auth and provider-catalog endpoints, not background traffic, and that is stage 1c.

## Stage 1b. Unblock the type cascade

| # | Issue | Status |
| --- | --- | --- |
| [#7](https://github.com/mars-s/mars/issues/7) | Widen `ModelProviderFamilyId` and `BuiltinModelProviderId` | todo |

Do this before touching any UI. It is an hour of work that converts the least
predictable part of the project into something estimable.

## Stage 1c. Remove the surfaces

| # | Issue | Status |
| --- | --- | --- |
| [#8](https://github.com/mars-s/mars/issues/8) | Delete Z.ai and BigModel catalog templates | todo |
| [#9](https://github.com/mars-s/mars/issues/9) | Delete coding-plan, pricing and usage stats | todo |
| [#10](https://github.com/mars-s/mars/issues/10) | Remove Z.ai from welcome screen and login | todo |
| [#11](https://github.com/mars-s/mars/issues/11) | Delete the Z.ai and BigModel OAuth subsystem | todo |
| [#12](https://github.com/mars-s/mars/issues/12) | Prune Z.ai i18n keys | todo |

## Stage 1d. UI surgery

| # | Issue | Status |
| --- | --- | --- |
| [#15](https://github.com/mars-s/mars/issues/15) | Extract Z.ai plan cards from provider settings | todo |

The hard one. Depends on [#7](https://github.com/mars-s/mars/issues/7) and
[#9](https://github.com/mars-s/mars/issues/9) landing first.

## Stage 2. Authentication

| # | Issue | Status |
| --- | --- | --- |
| [#13](https://github.com/mars-s/mars/issues/13) | Implement the ChatGPT OAuth adapter | todo |
| [#14](https://github.com/mars-s/mars/issues/14) | OpenCode Go end-to-end verification path | blocked, needs `op signin` |

## Process

| # | Issue | Status |
| --- | --- | --- |
| [#16](https://github.com/mars-s/mars/issues/16) | Resolve the language conflict in AGENTS.md | todo |

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
