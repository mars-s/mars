# Verification

What proves a change works. Run these from the repo root.

## The honest baseline

There is no test suite. Four test files exist in the repo and no package defines
a `test` script. Nothing here runs a test suite, and `pnpm verify:pre-push` runs
lint and an architecture check only. Do not report a green test run. There isn't
one to run.

Also note `pnpm typecheck` **excludes `apps/zcode-cli`**. Green typecheck does
not mean the CLI compiles.

## `pnpm typecheck` covers less than it looks like it covers

Measured while widening the provider family unions. The root script builds ten
projects, but the tree has far more. Two whole regions are invisible to it, and
one of them has pre-existing errors in it.

| Region | Covered by root `pnpm typecheck`? | How to check it |
| --- | --- | --- |
| `apps/zcode-cli` (25 packages) | **No** | `cd apps/zcode-cli && npx turbo run typecheck` |
| `packages/desktop` main / preload / renderer / scheduler | **No**, only `tsconfig.host.json` is built | `pnpm exec tsc -b packages/desktop/tsconfig.<project>.json` |

`tsc -b` is incremental, so a clean run may print nothing and exit 0 without
having recompiled anything. Use `--force` when you are establishing a baseline.

### Pre-existing desktop type errors

Running the four desktop projects that root typecheck skips produces errors on
the pristine tree. They are upstream's, not ours, and they are not a gate.

| Project | Pre-existing errors |
| --- | --- |
| `tsconfig.main.json` | 82 |
| `tsconfig.preload.json` | 3 |
| `tsconfig.renderer.json` | 123 |
| `tsconfig.scheduler.json` | 1 |

The preload 3 are missing exports (`DesktopZoomState`,
`WindowControlsOverlayMetrics`, `WindowControlsOverlayReadyPayload`).

**The rule:** if a change touches one of these regions, diff the error count
against this table. Same count means you introduced nothing. A different count
means you did, and the delta is yours to fix.

Get a baseline with `git stash -u` first. Beware that `tsc -b` writes `.d.ts` and
`.js` artifacts into `packages/desktop/src/scheduler/`, which then collide with
`git stash pop`. Delete those generated files before popping.

**Why those files appear.** `tsconfig.main.json` sets `rootDir: "src/main"` and
`outDir: "out/main"`, but it imports `../scheduler/schedulerProtocol.js`, which is
outside that root. TypeScript falls back to the common source directory, so output
for anything reached from outside `rootDir` lands next to the source instead of in
`out/`. Confirmed by running each project on its own: `main` produces the strays,
`preload`, `renderer`, `host` and `scheduler` do not. This is pre-existing and
predates all of our work.

`.gitignore` now excludes `packages/desktop/src/**/*.{js,d.ts}` and their `.map`
files, so they cannot be committed. That rule is scoped to the desktop `src` tree
on purpose: all 1386 tracked files there are `.ts`/`.tsx`, while
`packages/zcode-cua` tracks 13 hand-written `.js` files that a blanket `*.js`
ignore would have hidden. If you ever see them as `!!` in `git status
--ignored`, that is expected and harmless.

## Baseline commands

Measured on commit `3f9f09c`, the pristine reverted tree, before any wave 1 work.

| Purpose | Command | Result |
| --- | --- | --- |
| Install | `pnpm install` | **Exit 0**, 14.5s warm |
| Types | `pnpm typecheck` | **Exit 0**, 10 packages |
| Lint | `pnpm lint` | **Exit 0**, 70 warnings, 0 errors |
| Format | `pnpm fmt:check` | **Exit 1**, 31 files fail |
| Architecture | `pnpm architecture:check --changed` | not yet run |
| Desktop dev | `pnpm dev:desktop` | not yet run |
| Freshness | `node scripts/check-workspace-freshness.mjs` | not yet run |

Node version is pinned by `mise.toml` at 24.14.0, pnpm at 10.33.2. The local
Node is 24.21.0, which satisfies the range but is not the pinned patch.

## The format check is not a gate, and cannot become one for free

`pnpm fmt:check` already fails on the pristine tree. All 31 files are in the
`bots/` subsystem, which covers the Telegram, Feishu and Weixin channel
providers.

This is upstream's, not ours. It has two consequences:

1. Do not report `pnpm fmt:check` as passing. It does not.
2. Do not run `pnpm fmt` to "fix" it as a side effect of other work. That would
   bury 31 unrelated files in a de-Z.ai diff and make the change unreviewable.

**Check formatting only on the files you touched:**

```bash
pnpm exec oxfmt --check <your-files>
```

If a separate formatting cleanup is wanted, it belongs in its own commit with its
own issue. Not mixed into this work.

## Lint warnings are also pre-existing

The 70 warnings are upstream's, spread across `packages/ui` (37),
`packages/desktop` (10), `packages/services` (8), `packages/shared` (6) and
`packages/rpc` (4). Many sit in the Z.ai plan code that later issues delete, so
the count should fall as the work lands. A rising count is a signal, not noise.

Do not fix them opportunistically. Same reason as the format failures.


## Proving phoning home is actually gone

This is the point of the whole stage, so it gets a real check rather than a
code review.

```bash
# 1. No Z.ai hostname survives in shipped source.
rg -n 'z\.ai|bigmodel\.cn|zhipu' packages/ apps/ config/ scripts/ \
  --glob '!**/generated/**' --glob '!**/*.md'

# 2. No telemetry endpoint is armed in a built artifact.
rg -n 'ZCODE_TELEMETRY_REPORT_ENDPOINT|ZCODE_ARMS_RUM_ENDPOINT' \
  packages/ apps/ | rg -v 'env\.ts|readme|\.md'

# 3. With the app running, confirm no socket leaves for a Z.ai host.
#    macOS, while the app is open:
nettop -P -L 1 -J bytes_in,bytes_out -p $(pgrep -f 'zcode|app-server' | tr '\n' ',' | sed 's/,$//')
```

Step 3 is the only one that actually proves it. Steps 1 and 2 prove the code is
gone, which is necessary but not sufficient.

## The remote asset and marketplace origins are operator-configured

Remote connect and the plugin marketplace both stay, but neither has a built-in
asset host any more. Nothing is fetched until an operator points the app at
their own origin.

| Origin | Env var | Unset behaviour |
| --- | --- | --- |
| Remote release assets | `ZCODE_CDN_BASE_URL` (build-time `__ZCODE_CDN_BASE_URL__`, dev override `ZCODE_REMOTE_ASSET_CDN_BASE_URL`) | Development uses `mock-cdn`; a packaged build fails with an explicit "no remote asset origin is configured" error |
| Official marketplace catalog | `ZCODE_OFFICIAL_MARKETPLACE_SOURCE` | The official marketplace is not registered as a remote source, so startup fetches nothing and the store shows only locally seeded built-in plugins |
| Official plugin store icons | `ZCODE_OFFICIAL_PLUGIN_ASSETS_BASE_URL` | Listings carry no icon and the store falls back to default plugin artwork |

```bash
# No vendor asset host survives in shipped source.
rg -n 'cdn-zcode\.z\.ai' packages/ apps/ config/ scripts/ \
  --glob '!**/node_modules/**' --glob '!**/*.md'

# With nothing configured, remote connect still works in development off mock-cdn.
node scripts/prepare-prebuilds.mjs
pnpm dev:desktop   # connect to a phone remote host; no network asset fetch happens
```

A packaged build with no `ZCODE_CDN_BASE_URL` is expected to fail remote connect
with the explicit error. That is the intended state until a self-hosted asset
base is configured; it is not a regression to be "fixed" by restoring a default.

## Proving the provider change works

```bash
# OpenCode Go is present in the catalog and the Z.ai templates are not.
node -e "const c=require('./config/provider/zcode-builtin.json');
  const t=c.providerConfigRules.templateRules.map(r=>r.id);
  console.log('zai:', t.filter(x=>/^zai/.test(x)));
  console.log('bigmodel:', t.filter(x=>/^bigmodel/.test(x)));
  console.log('opencode:', t.filter(x=>/opencode/.test(x)));"
```

## Driving the app: agent-browser over CDP, not computer use

**The app already exposes CDP in dev. Nothing needs to be built.**

`packages/desktop/src/main/index.ts:201` appends
`--remote-debugging-port=9229` whenever the app is not packaged. So:

```bash
pnpm dev:desktop &          # wait for the window
curl -s http://127.0.0.1:9229/json/version
agent-browser connect 9229
agent-browser snapshot -i        # the real accessibility tree, with element refs
agent-browser click @e10
agent-browser screenshot /tmp/x.png
```

`ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT=1` turns it off. Do **not** add a
`--remote-debugging-port` argument to the spawn in `packages/desktop/scripts/dev.mjs`:
the main process overrides it with its own switch, so the argument is silently
ignored and a log line claiming port 9222 is actively misleading. That was tried
and reverted.

Prefer this over computer use. `agent-browser` returns a structured accessibility
tree with stable element refs, so a check is a text assertion that can be diffed
between runs. Computer use is pixel-and-screenshot driven, which is the right tool
for "does this look right" and the wrong tool for "did this regress".

## What was verified live on 2026-09-26

Run against `main` at `9c5b937` with the dev app up and CDP connected.

| Check | Result |
| --- | --- |
| App launches, CDP answers on 9229 | Yes, `Chrome/146.0.7680.80`, `Electron/41.0.3` |
| Accessibility tree is readable | Yes, full sidebar, composer, tabs, 5 window targets |
| Plugin Marketplace opens | Yes, `heading "Plugin Marketplace"`, Refresh, sources, Public/Personal |
| Built-in plugins still listed after the CDN removal | Yes, Public segment shows Browser Use with its real description |
| Installed strip intact | Yes, Browser Use, Node Repl Host, Session Provenance |
| No "refresh failed" banner with no origin configured | Correct, as designed |
| Model in use | `OpenCode Go (Responses)/gpt-5.6-luna` |

### Phoning home, proven rather than argued

`verification.md` previously listed the socket check as "not yet run". It has now
been run. The entire process tree of the running app held exactly three sockets:

```text
127.0.0.1:9229  LISTEN                       the CDP port
127.0.0.1:9229 -> 127.0.0.1:51675  ESTABLISHED  the agent-browser session
[::1]:51516 -> [::1]:5174          ESTABLISHED  the Vite dev server
```

Zero non-loopback connections. No `z.ai`, no `bigmodel.cn`, no `cdn-zcode.z.ai`,
with the plugin marketplace open and the app otherwise idle. This is the check
that actually proves the stage, and it passes.

Reproduce it:

```bash
pnpm dev:desktop &
sleep 30
lsof -nP -a -p $(pgrep -d, -f 'ZCode Dev|desktop-dev') -i \
  | awk 'NR==1 || /ESTABLISHED|LISTEN/'
```

Any line whose address is not `127.0.0.1`, `[::1]` or `localhost` is a finding.

### The marketplace migration, proven by running it

Not reviewed, executed. The real `ensureDefaultPluginMarketplaces` was run against
seeded storage roots:

| Case | Result |
| --- | --- |
| Stale `zcode-plugins-official` record on the retired host is dropped | Pass, and the file is rewritten |
| Personal `github`, `directory` and self-hosted `url` sources all survive | Pass, 3 of 3 kept |
| Second call on clean state writes nothing | Pass, idempotent |
| Fresh install with no file creates none | Pass |
| A `git` source on the retired host is dropped, not just `url` | Pass |
| With `ZCODE_OFFICIAL_MARKETPLACE_SOURCE` set, the official record is re-added pointing at the self-hosted origin, no stale url left in the output | Pass |

## Manual checks that still need eyes

These need a real provider and cannot be automated here yet.

- Welcome screen shows ChatGPT OAuth and OpenCode Go. No Z.ai, no BigModel.
- Settings has no pricing, usage, or coding plan section. **Blocked on #9 and #15.**
- The phone remote connect still connects. **Not yet run.** Wave 1 changed the
  asset origin resolution, so this one matters and has not been proven.

## Reporting rules

Report the real result. If a command was not run, say it was not run. If the
environment blocked it, say that instead of writing it up as a pass.
