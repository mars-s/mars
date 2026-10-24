// Updates wired into the real host (docs/UPDATES.md): owner auth on /api/update, a check
// against a temporary GitHub stand-in (a bare repository), the badge in /api/state, the
// settings route, and the agent tools refusing what they must. Nothing is installed:
// apply refuses here because the host is not a systemd service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startHost } from "./workbench/test-host.mjs";
import { createUpdates } from "./updates.mjs";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// A staged deploy runs this from <deploy>/stage/app, away from the checkout; host_deploy passes
// the checkout as MARS_REPO_ROOT. From the checkout itself, its own scripts are used.
const HERE = fileURLToPath(new URL("../..", import.meta.url));
const REPO = existsSync(join(HERE, "scripts", "update.mjs")) ? HERE : process.env.MARS_REPO_ROOT || HERE;

// A checkout with the real updater scripts, tracking a bare "origin".
const base = await mkdtemp(join(tmpdir(), "mars updates "));
const origin = join(base, "origin.git"), upstream = join(base, "upstream"), repo = join(base, "install");
git(base, "init", "-q", "--bare", "-b", "main", origin);
git(base, "clone", "-q", origin, upstream);
await mkdir(join(upstream, "scripts"), { recursive: true });
await mkdir(join(upstream, "packages/pi-host"), { recursive: true });
for (const file of ["update.mjs", "update-check.mjs", "setup.mjs", "check-runtime.mjs"])
  await copyFile(join(REPO, "scripts", file), join(upstream, "scripts", file));
await copyFile(join(REPO, "packages/pi-host/protected-files.mjs"), join(upstream, "packages/pi-host/protected-files.mjs"));
await writeFile(join(upstream, "page.txt"), "one\n");
git(upstream, "add", "."); git(upstream, "commit", "-qm", "base"); git(upstream, "push", "-q", "origin", "main");
git(base, "clone", "-q", origin, repo);
await writeFile(join(upstream, "page.txt"), "two\n");
git(upstream, "commit", "-qam", "Second version"); git(upstream, "push", "-q", "origin", "main");

const host = await startHost({ MARS_REPO_ROOT: repo, MARS_UPDATE_CHECK_HOURS: "0" });
try {
  assert.equal((await host.request("/api/update", { auth: false })).status, 401, "owner auth required");
  const before = await host.request("/api/update");
  assert.equal(before.status, 200);
  assert.equal(before.json.status, null, "nothing checked yet: staging never checks on a timer");
  assert.equal((await host.request("/api/state")).json.update.state, "unknown");

  const checked = await host.request("/api/update/check", { method: "POST", body: {} });
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.json.status.state, "fast_forward");
  assert.equal(checked.json.status.behind, 1);
  assert.match(checked.json.status.commits[0], /Second version/);
  assert.deepEqual((await host.request("/api/state")).json.update, { state: "fast_forward", behind: 1 }, "badge in /api/state");

  // A staging or check host never installs, even on a server with the real services.
  const applied = await host.request("/api/update/apply", { method: "POST", body: {} });
  assert.equal(applied.status, 202);
  assert.equal(applied.json.started, false);
  assert.equal(applied.json.outcome, "refused");
  assert.match(applied.json.detail, /staging or check host/);
  assert.equal(await readFile(join(repo, "page.txt"), "utf8"), "one\n");

  assert.equal((await host.request("/api/update/settings", { method: "POST", body: { auto: "yes" } })).status, 400);
  const auto = await host.request("/api/update/settings", { method: "POST", body: { auto: true } });
  assert.equal(auto.json.settings.auto, true);
  assert.equal((await host.request("/api/update/settings", { method: "POST", body: {} })).status, 400);
  assert.equal((await host.request("/api/update/nope")).status, 404);
} finally {
  await host.stop();
}

// The agent tools, on the same checkout, through the extension the host installs.
// Not systemd services (injected, so this holds on a Linux server too): the tool refuses with the command to run.
// Without the service's MARS_REPO_ROOT, which would point the updater at the real checkout.
const { MARS_REPO_ROOT: _service, ...serviceFree } = process.env;
const updates = createUpdates({ repo, root: join(base, "tool-root"), env: { ...serviceFree, MARS_PI_STAGING: "", MARS_UPDATE_CHECK_HOURS: "0" }, managed: async () => false, systemdRun: "/nonexistent-systemd-run" });
const tools = Object.fromEntries(updates.extension.tools.map((tool) => [tool.name, tool]));
const call = async (name, args = {}) => (await tools[name].execute(args, {}, {})).structuredOutput;
const status = await call("mars_update_status", { refresh: true });
assert.equal(status.state, "fast_forward");
assert.match(status.next, /mars_update_apply/);
const outside = await call("mars_update_apply");
assert.equal(outside.started, false, "refuses outside systemd");
assert.match(outside.next, /npm run update -- apply/);
const notNeeded = await call("mars_update_reconcile_start");
assert.equal(notNeeded.started, false);
assert.match(notNeeded.next, /Nothing to reconcile/);
const finish = await call("mars_update_reconcile_finish");
assert.equal(finish.ok, false);
assert.match(finish.next, /mars_update_reconcile_start/);

// A conflicting local commit: the tool says which file and offers reconcile.
await writeFile(join(repo, "page.txt"), "mine\n");
git(repo, "commit", "-qam", "Local");
const conflict = await call("mars_update_status", { refresh: true });
assert.equal(conflict.state, "needs_reconcile");
assert.deepEqual(conflict.blockers[0].files, ["page.txt"]);
assert.match(conflict.next, /mars_update_reconcile_start/);
const started = await call("mars_update_reconcile_start");
assert.equal(started.started, true);
assert.deepEqual(started.conflicts, ["page.txt"]);
await writeFile(join(started.worktree, "page.txt"), "mine and two\n");
const done = await call("mars_update_reconcile_finish");
assert.equal(done.ok, true, JSON.stringify(done));
assert.equal((await call("mars_update_status", { refresh: true })).state, "merge", "a finished reconcile is ready to install");
assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the live checkout stayed on main");
assert.equal(await readFile(join(repo, "page.txt"), "utf8"), "mine\n", "and unchanged");

// On a server with the services: apply launches the updater as its own unit, with a
// fallback that recovers and restarts Mars if the updater is killed. A fake systemd-run
// records the call instead of running it.
await writeFile(join(repo, "page.txt"), "one\n");
git(repo, "reset", "-q", "--hard", "origin/main~1");
const record = join(base, "systemd-run.args");
const fake = join(base, "systemd-run");
await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`, { mode: 0o755 });
const server = createUpdates({ repo, root: join(base, "server-root"), env: { ...serviceFree, MARS_PI_STAGING: "", MARS_UPDATE_CHECK_HOURS: "0" }, managed: async () => true, systemdRun: fake, busy: async () => false });
const launch = await server.apply();
assert.equal(launch.started, true, JSON.stringify(launch));
const argv = (await readFile(record, "utf8")).trim().split("\n");
assert.ok(argv.includes("--user") && argv.some((a) => a.startsWith("--unit=mars-update-")));
assert.ok(argv.some((a) => a.startsWith("--property=ExecStopPost=") && a.includes("recover") && a.includes("--restart")), "a killed updater recovers and restarts Mars");
assert.deepEqual(argv.slice(-3), [join(repo, "scripts/update.mjs"), "apply", "--json"]);

// Automatic installs skip a target that already rolled back.
await mkdir(join(base, "server-root/updates"), { recursive: true });
await writeFile(join(base, "server-root/updates/settings.json"), JSON.stringify({ auto: true }));
const target = git(repo, "rev-parse", "origin/main").slice(0, 12);
await writeFile(join(base, "server-root/updates/current.json"), JSON.stringify({ id: "x", phase: "done", outcome: "rolled_back", target, steps: [] }));
await rm(record, { force: true });
await server.tick();
assert.equal(await readFile(record, "utf8").catch(() => null), null, "a rolled-back target is not retried");
await writeFile(join(base, "server-root/updates/current.json"), JSON.stringify({ id: "x", phase: "done", outcome: "rolled_back", target: "000000000000", steps: [] }));
await server.tick();
assert.ok(await readFile(record, "utf8"), "a newer target is installed automatically");

await rm(base, { recursive: true, force: true });
console.log("PASS updates: owner routes, check against a bare remote, badge, settings, staging and non-systemd refusals, tools and reconcile, the updater unit with its recover fallback, no automatic retry of a rolled-back target");
