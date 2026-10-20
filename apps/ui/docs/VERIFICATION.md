> Historical feature verification record. Run the current root package scripts for monorepo acceptance.

# Verification

Current live Pi workspace, verified on Debian 13 Bot Box as bot (uid1000),
20 October 2026. Node24.14.0, Next16.4.2, TypeScript6.0.3, Pi Durable1.3.0.
The original ZIP demo screens are unmounted references. Their historical 22-test
report is not evidence of current live backend functionality.

## Automated checks

- Typecheck and ESLint (including shadcn rules) pass.
- All20 unit tests pass, including native history/image refs, actual nested tool
  results and binary proxy MIME, origin, size and private token handling.
- Native image store checks pass real PNG/JPEG/WebP/GIF conversion, alpha, limits,
  malformed/MIME input, private file modes, deduplication and restart.
- Native subthread checks pass titles, followups, image isolation, ownership,
  four-worker concurrency and metadata-only paging across105 newer child chats.
- Workflow checks pass background return, ordered previous-result transfer,
  selected models, real usage/timing, failure/cancellation and graceful recovery.
  A child process was SIGKILLed during Pick, then reopened the same SQLite file:
  Map was not rerun, phase IDs and one input each remained stable, Explain ran,
  and exactly one completion entry was recorded.
- Plugin registry checks pass native callable/discoverable tool removal, common
  MCP-wrapper semantics, durable task retention, restart preferences, atomic
  concurrent updates and persistence failure rollback. The MCP test is a fixture,
  not proof of a connected external MCP account.
- Browser fixtures pass native chat/Markdown/activity, IME, unique send/stop,
  isolated drafts, stale polls, OAuth/settings, private connection forms, mobile
  navigation, image paste/preview/remove/send/reload, duplicate reference dedupe,
  failed-send caption/image recovery with the same requestId, child followups,
  workflow stop, dynamic plugin cards and tool/interface switches.
- The actual authenticated desktop/mobile browser passes image refs, four child
  links, phase cards, agent-authored plugin interface, same-origin local fonts,
  reduced motion and no horizontal overflow or browser exceptions. Captures were
  visually reviewed.
- Production build passes with webpack; the private service continues in Next
  Turbopack development mode for hot reload.
- Impeccable's mechanical detector returned zero findings on changed UI targets.
  This is not a substitute for visual review.

## Live provider and restart proof

Luna received three uploaded user screenshot references, correctly identified
independent child conversations and ordered workflows, and completed four named
mock children (eggs, tomatoes, ham, cheese). Each returned its requested one-line
answer. It also ran Map, Pick, Explain as a separate three-phase native workflow.

Pi authored manifest, native tool and browser interface files itself, imported
the module, invoked install_extension, then discovered and called image_demo_status.
Installed name image-workbench-demo1.0.0, immutable hash
ee9f9840cac3e578fcefcfd8458af22b8170a71221458b12d33c90a244211c3d.
The tool returned MARS_IMAGE_SELF_EXTENSION_V1. Its interface fetches current
child/phase metadata and links to real children. It contains no external messages.
Operator-written image/workflow/manager infrastructure is distinct from this
model-authored demonstration plugin.

The combined live trial took84.45 seconds. Native reported usage: parent115167
tokens (85504 cache reads); four children6272 total; three workflow phases9724
total. Combined131163 includes90496 cache-read tokens. These are reported token
counts, not billing statements. There is no measured before/after saving claim.
Children received small briefs and no parent screenshots or transcript.

A private consistent database/source backup preceded deployment. On a live host
restart: image retrieval, all four child IDs and results, completed workflow,
plugin hash and preferences persisted. UI-off returned404. Tool-off remained
persisted. After restoring the demonstration switches, a fresh native model call
returned its proof marker. Original root history/model, Mock Discord hash and both
OAuth connections were preserved. Authenticated invalid image upload and chunked
oversized413 checks passed; unauthenticated image retrieval returned401.

The private9443 HTTPS route passed certificate/owner authentication using the
node IP with the correct hostname/SNI. Bot Box's resolver did not resolve its own
MagicDNS name, so the local route probe used an explicit address. Mac DNS and Mac
execution remain for the owner.

No live Discord message, new external account action or public deployment ran.
Mac execution is not verified here. User-supplied font archive contains no licence
notice; app/fonts/README.md records exact provenance without inventing one.

## Reproduce

```sh
npm ci
npm run typecheck
npm run lint
npm test
# Against the running Next development server, default loopback3082:
npm run test:ui
node packages/pi-host/check-image-store.mjs
node packages/pi-host/check-subthreads.mjs
node packages/pi-host/check-workflows.mjs
node packages/pi-host/check-plugin-registry.mjs
MARS_BUILD_CHECK=1 npm run build
```

Native checks need `npm ci` at the monorepo root first. They use disposable
databases and fake model providers. Browser fixtures intercept API routes; they
do not establish live provider access. The separate opt-in command
`MARS_LIVE_HOST_CHECK=1 node tests/live-host-check.mjs` reads the private owner
token without printing it and creates one empty live chat.

Private evidence is under the Bot Box trial evidence/images-subthreads directory,
including native worker reports, live run/restart JSON and browser captures.
Credential values and user screenshot files are not committed.
