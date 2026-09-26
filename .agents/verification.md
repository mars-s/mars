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

| Purpose | Command | Expected |
| --- | --- | --- |
| Install | `pnpm install` | Exit 0, about 15s warm |
| Types | `pnpm typecheck` | Exit 0 across 10 packages |
| Lint | `pnpm lint` | Exit 0 |
| Format | `pnpm fmt:check` | Exit 0 |
| Architecture | `pnpm architecture:check --changed` | Exit 0 |
| Desktop dev | `pnpm dev:desktop` | Electron window opens |
| Freshness | `node scripts/check-workspace-freshness.mjs` | Reports baseline |

Node version is pinned by `mise.toml` at 24.14.0, pnpm at 10.33.2. The local
Node is 24.21.0, which satisfies the range but is not the pinned patch.

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
