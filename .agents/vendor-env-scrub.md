# Scrub the vendor app's environment

A different, vendor-built copy of this app is installed at `/Applications/ZCode.app`
(ZCode 3.14.3). When it launches a shell, or any process it spawns, it injects a block of
variables into that shell's ambient environment. If you build this fork from such a shell,
the build reads the **vendor's** provider catalog instead of this repository's, and dies
with a bare `Invalid Built-in Provider config (test)` that names no cause.

Nothing in this repository exports these variables. The build scripts now detect and drop
them, so a contaminated shell produces a loud warning and a correct build. Scrubbing them
is still the right thing to do, because it also stops the runtime from inheriting the
vendor's endpoints.

## The scrub command

Paste this in front of any build command. It unsets every variable the vendor app injects:

```sh
env -u ZCODE_BUILTIN_PROVIDER_CONFIG_FILE -u ZCODE_PERSONAL_PROVIDER_CONFIG_FILE -u ZCODE_BASE_URL -u ZCODE_RUNTIME_ENV -u ZCODE_CUA_BUNDLED_HELPER_APP_PATH -u ZCODE_CUA_LAUNCHER_PID -u ZCODE_PROCESS_LABEL -u ZCODE_BUILD_COMMIT_ID -u ZCODE_APP_VERSION -u ZAI_OAUTH_ORIGIN -u ZAI_BUSINESS_BASE_URL -u ZAI_OAUTH_CLIENT_ID -u __CFBundleIdentifier pnpm build
```

Replace `pnpm build` with whatever you actually want to run. The same prefix is what the
build scripts print inside their `[vendor-env] WARNING` block, so you can copy it straight
out of the terminal.

## To scrub your whole shell session

`env -u` only affects the one command it prefixes. To clear the block for the rest of the
session, either paste the same line with a real command each time, or start a clean shell:

```sh
exec env -u ZCODE_BUILTIN_PROVIDER_CONFIG_FILE -u ZCODE_PERSONAL_PROVIDER_CONFIG_FILE -u ZCODE_BASE_URL -u ZCODE_RUNTIME_ENV -u ZCODE_CUA_BUNDLED_HELPER_APP_PATH -u ZCODE_CUA_LAUNCHER_PID -u ZCODE_PROCESS_LABEL -u ZCODE_BUILD_COMMIT_ID -u ZCODE_APP_VERSION -u ZAI_OAUTH_ORIGIN -u ZAI_BUSINESS_BASE_URL -u ZAI_OAUTH_CLIENT_ID -u __CFBundleIdentifier "$SHELL" -l
```

The durable fix is to stop launching your terminal from inside `/Applications/ZCode.app`.
A terminal started from `/Applications/Utilities/Terminal.app`, iTerm, or a plain `ssh`
session never has these variables.

## The variables, and what each one does to a build

| Variable | Effect on this fork's build | Dropped automatically |
| --- | --- | --- |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Points at the vendor's own provider catalog under `~/.zcode/v2/runtime/provider/...`, overriding `config/provider/zcode-builtin.json`. This is the root cause of the `Invalid Built-in Provider config` failure. | yes |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | Points at the vendor's personal catalog under `~/.zcode/v2/`. | yes |
| `ZCODE_BASE_URL` | Points the endpoint resolvers at the vendor host. | yes |
| `ZAI_OAUTH_ORIGIN` | Points OAuth at the vendor host. | yes |
| `ZAI_BUSINESS_BASE_URL` | Points the business API at the vendor host. | yes |
| `ZCODE_CUA_BUNDLED_HELPER_APP_PATH` | Points at a helper inside the vendor app bundle. | yes |
| `ZCODE_RUNTIME_ENV` | Set by the vendor to `production`. Read by the shared runtime env resolver. | no, detection only |
| `ZCODE_CUA_LAUNCHER_PID` | Vendor launcher pid. | no, detection only |
| `ZCODE_PROCESS_LABEL` | Vendor process label. This repo also sets it, for its own child host processes, so it cannot be used on its own as a marker. | no, detection only |
| `ZCODE_BUILD_COMMIT_ID` | Vendor build id. | no, detection only |
| `ZCODE_APP_VERSION` | Vendor app version. | no, detection only |
| `ZAI_OAUTH_CLIENT_ID` | The vendor's public OAuth client id. Referenced by name only: never write its value into a file, a log or a commit. | no, detection only |
| `__CFBundleIdentifier` | Set by macOS for any process launched from inside an app bundle. Nothing in this repository reads or writes it, which is what makes it a reliable launch marker. | no, it is the marker |

`ZCODE_ENV` is also set by the vendor, and is deliberately **not** dropped:
`scripts/dev-desktop-env.mjs` sets it on purpose for every build, so removing it would
break an in-tree setting. It is warned about instead, and it only chooses between the
`test` and `production` build flavors, which is obvious from the output.

## How the build decides a value is a leak

Two independent signals, either of which is enough. The rule and its rationale are
documented at the top of `scripts/load-endpoint-env.mjs`.

1. **Value evidence.** The value points at a vendor host (`z.ai`, `bigmodel.cn`,
   `bigmodel.com`, `zhipuai.cn`, `zhipu.ai`), at the vendor runtime cache under
   `~/.zcode/v2/runtime/provider/`, or inside a `ZCode.app` bundle.
2. **Launch marker.** `__CFBundleIdentifier` is present **and** at least one other vendor
   variable is present, which proves the whole ambient block was inherited through a
   vendor-launched shell.

## Precedence, after the fix

Highest wins:

1. ambient `process.env`, minus values classified as leaks
2. `.env.local`
3. `.env`
4. built-in defaults (empty string, or `config/provider/zcode-builtin.json`)

A `.env` file value now beats a leaked ambient value, which is the whole point. A
non-leaked ambient value still beats a file value, so `ZCODE_BASE_URL=https://mine pnpm build`
keeps working.

## When the build refuses to continue

Two conditions are hard errors, because both would put something you did not check in
into a shipped artifact:

- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` resolves to a path **outside the repository root**.
  The deliberate escape hatch is `ZCODE_ALLOW_EXTERNAL_BUILTIN_PROVIDER_CONFIG=1`.
- The catalog being loaded contains provider or template rules that reference `zhipu`,
  `bigmodel`, a `z.ai` endpoint, or an `off-peak` plan. There is no escape hatch, on
  purpose.

## Tests

```sh
node --test scripts/vendor-env-guard.test.mjs
```
