# Verification

What proves a change works. Run these from the repo root.

## The honest baseline

There is no test suite. Four test files exist in the repo and no package defines
a `test` script. Nothing here runs a test suite, and `pnpm verify:pre-push` runs
lint and an architecture check only. Do not report a green test run. There isn't
one to run.

Also note `pnpm typecheck` **excludes `apps/zcode-cli`**. Green typecheck does
not mean the CLI compiles.

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

## Manual checks that need eyes

- Welcome screen shows ChatGPT OAuth and OpenCode Go. No Z.ai, no BigModel.
- Settings has no pricing, usage, or coding plan section.
- The plugin marketplace still loads local and git sources.
- The phone remote connect still connects.

## Reporting rules

Report the real result. If a command was not run, say it was not run. If the
environment blocked it, say that instead of writing it up as a pass.
