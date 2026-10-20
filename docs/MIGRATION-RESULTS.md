# Pi monorepo verification

Verified on Debian13 Bot Box as bot uid1000 with pinned Node24.14.0/npm11.9.0,
20 October 2026. The owner explicitly chose a public mars-s/mars repository.

## Source and installation

The active tree has two npm workspaces, apps/ui and packages/pi-host, and one root
lockfile. There are no ZCode desktop/CLI, old Mars Strands/PostgreSQL or DeepSeek
runtime dependencies. Pi Durable1.3.0 is pinned upstream; it is not a new SDK fork.
The agent's latest web search, staged self-deploy/rollback and layered configuration
changes through db85735 are retained alongside images, subthreads, ordered workflows,
real activity and plugin controls.

Private consistent SQLite/runtime/unit backups and both complete Git histories
preceded migration. Old application services were stopped and disabled, with code
and data moved to a private cold archive. Codex remote control and Tailscale stayed
active. The public migration includes reviewed current UI source rather than
private UI history. Personal reference screenshots remain outside the public tree.
Font files and component notices retain supplied provenance.

## Automated results

| Check | Result |
| --- | --- |
| Clean root npm ci | Passed,476 packages |
| Workspace boundaries | Passed; negative import regression also passes |
| Root typecheck and JavaScript syntax | Passed |
| UI lint, including shadcn | Passed |
| Installer/process/boundary tests |13 passed |
| UI unit tests |23 passed |
| Native host check scripts |20 passed |
| Production webpack build | Passed |
| Six production browser fixture flows | Passed, desktop/mobile, no exceptions |
| Local font loading | Four local font assets returned200 |
| Fresh isolated production install/restart | Passed, no real model requests |
| Actual isolated UI patch validation | Typecheck, lint and webpack build passed with host-only dependencies separate |

The native suite includes real temporary-root host restart/auth/proxy/origin checks,
ordered workflow SIGKILL recovery, model-worker ownership, image persistence and
plugin exposure. Installer tests exercise real SQLite owner exclusion across two
ports, kernel-lock release after SIGKILL, managed runtime preservation, concurrent
bootstrap, process-group shutdown and systemd path parsing. Host deployment tests
prove native-only locked installs, isolated boot and dependency rollback. A missing
installed-lock marker forces a real workspace install, even when declarations match.
The native check runner also passes from a filesystem path containing spaces.

The fresh production smoke test creates new private state, launches actual Pi and
Next, rejects unauthenticated APIs, serves real UI HTML, stops both processes and
restarts with the same token/device/conversation and empty history. It uses no live
account. Browser fixtures intercept API data; they are not live provider evidence.

The assembled candidate also passed a staged dry run against the existing managed
runtime:20 native checks, host-only locked dependency installation and isolated
boot. Real UI patch validation ran inside Bubblewrap with the actual UI sources
and hoisted UI dependencies while its native host had only filtered dependencies.
It passed typecheck, lint and a full webpack build without promoting a change.

The separate managed app snapshot prevents a committed source edit from being
mistaken for already-running code. Development frontend cache and production build
output are separate. Repeated setup never overwrites an existing runtime or data.

## Live cutover

The managed host deployed public candidate33a5ebf6 after all20 native checks, a
locked host-only dependency installation and isolated startup. The watchdog reports
deployed and healthy. Both user services now launch from the canonical Mars checkout.
The host reports mars-monorepo-1. Existing root history has131 entries and keeps
its Anthropic model selection. Owner token and OAuth file hashes are unchanged,
both ChatGPT and Claude remain connected, and installed plugin hashes and enabled
flags match the baseline. The existing mock plugin remains owner-disabled.

The saved image demonstration retains four child conversations and its completed
Map/Pick/Explain workflow. No paid model requests or Discord messages were needed
for this migration. The main Tailscale HTTPS route and the existing9443 alias both
return the new authenticated host with certificate validation. The retired8443
DeepSeek and8787 old Mars routes are removed. The local MagicDNS lookup needed
an explicit Tailscale IP for the TLS probe; access from the Mac was not retested.

Mac execution remains unverified. Local host mode needs util-linux-compatible
flock; Mac UI-only development can proxy an existing Pi host without running it.
The app is private by default on loopback; public source publication does not
expose the running agent to the public internet.
