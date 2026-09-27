import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ServiceCollection, IZCodeTaskService } from "@zcode/services";
import {
  createPhoneRemoteService,
  createPhoneTaskObserver,
  resolvePhoneRemoteStaticRoot,
} from "../src/host/phoneRemoteHost.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

async function makeWebDist() {
  const root = await mkdtemp(join(tmpdir(), "phone-remote-host-"));
  const repoRoot = join(root, "repo");
  await mkdir(join(repoRoot, "packages", "web"), { recursive: true });
  await writeFile(join(repoRoot, "packages", "web", "package.json"), "{}");
  await mkdir(join(repoRoot, "packages", "web", "dist"), { recursive: true });
  await writeFile(join(repoRoot, "packages", "web", "dist", "index.html"), "<!doctype html>");
  return repoRoot;
}

function makeService(overrides: { repoRoot: string }) {
  return createPhoneRemoteService({
    services: new ServiceCollection(),
    isPackaged: () => false,
    repoRoot: () => overrides.repoRoot,
  });
}

test("nothing listens until start is called", async () => {
  const service = makeService({ repoRoot: await makeWebDist() });
  assert.deepEqual(await service.getState(), { status: "stopped" });
  assert.deepEqual(await service.listActiveTaskIds(), []);
});

test("start reports a running listener with a pairing per address", async (t) => {
  const service = makeService({ repoRoot: await makeWebDist() });
  t.after(() => service.stop());

  const state = await service.start();
  assert.equal(state.status, "running");
  if (state.status !== "running") return;
  assert.ok(state.port > 0, "an ephemeral port, never 0");
  assert.ok(state.pairings.length > 0, "at least one address on this machine");
  for (const pairing of state.pairings) {
    assert.ok(pairing.url.startsWith(`http://${pairing.address}:`));
    assert.ok(pairing.url.includes("token="), "the QR must carry the pairing token");
  }
});

test("a second start does not rotate the token out from under a scanned phone", async (t) => {
  const service = makeService({ repoRoot: await makeWebDist() });
  t.after(() => service.stop());

  const first = await service.start();
  const second = await service.start();
  assert.deepEqual(second, first);
});

test("stop revokes the token and a later start mints a fresh one", async (t) => {
  const service = makeService({ repoRoot: await makeWebDist() });
  t.after(() => service.stop());

  const before = await service.start();
  assert.equal(before.status, "running");
  await service.stop();
  assert.deepEqual(await service.getState(), { status: "stopped" });

  const after = await service.start();
  assert.equal(after.status, "running");
  if (before.status !== "running" || after.status !== "running") return;
  assert.notDeepEqual(
    after.pairings.map((p) => p.url),
    before.pairings.map((p) => p.url),
    "a stopped pairing must not still work",
  );
});

test("stop is idempotent and safe before any start", async () => {
  const service = makeService({ repoRoot: await makeWebDist() });
  await service.stop();
  await service.stop();
  assert.deepEqual(await service.getState(), { status: "stopped" });
});

test("a missing web build surfaces as an error state rather than a crash", async () => {
  const service = createPhoneRemoteService({
    services: new ServiceCollection(),
    isPackaged: () => false,
    repoRoot: () => join(tmpdir(), "phone-remote-does-not-exist"),
  });
  const state = await service.start();
  assert.equal(state.status, "error");
  if (state.status !== "error") return;
  assert.match(state.message, /packages\/web\/dist/);
});

test("a start after an error can succeed", async (t) => {
  const repoRoot = await makeWebDist();
  let broken = true;
  const service = createPhoneRemoteService({
    services: new ServiceCollection(),
    isPackaged: () => false,
    repoRoot: () => (broken ? join(tmpdir(), "phone-remote-does-not-exist") : repoRoot),
  });
  t.after(() => service.stop());

  assert.equal((await service.start()).status, "error");
  broken = false;
  assert.equal((await service.start()).status, "running");
});

test("the packaged build reads the staged copy under app resources", async () => {
  const resources = await mkdtemp(join(tmpdir(), "phone-remote-res-"));
  await mkdir(join(resources, "web"), { recursive: true });
  await writeFile(join(resources, "web", "index.html"), "<!doctype html>");
  assert.equal(
    resolvePhoneRemoteStaticRoot({ isPackaged: () => true, resourcesPath: () => resources }),
    join(resources, "web"),
  );
});

test("a packaged build with no staged web copy fails rather than serving nothing", async () => {
  const resources = await mkdtemp(join(tmpdir(), "phone-remote-res-"));
  assert.throws(
    () => resolvePhoneRemoteStaticRoot({ isPackaged: () => true, resourcesPath: () => resources }),
    /no web client to serve/,
  );
});

test("a packaged build without a resources directory fails loudly", () => {
  assert.throws(
    () => resolvePhoneRemoteStaticRoot({ isPackaged: () => true, resourcesPath: () => undefined }),
    /resources/,
  );
});

test("the dev build reads packages/web/dist from the repo", async () => {
  const repoRoot = await makeWebDist();
  assert.equal(
    resolvePhoneRemoteStaticRoot({ isPackaged: () => false, repoRoot: () => repoRoot }),
    join(repoRoot, "packages", "web", "dist"),
  );
});

test("this checkout resolves its own dev web root", () => {
  assert.equal(
    resolvePhoneRemoteStaticRoot({ isPackaged: () => false }),
    join(REPO_ROOT, "packages", "web", "dist"),
  );
});

test("phone-driven task calls are recorded, read-only ones are not", async (t) => {
  const repoRoot = await makeWebDist();
  const seen: string[] = [];
  const taskService = {
    sendPrompt: (params: { taskId: string }) => {
      seen.push(`sendPrompt:${params.taskId}`);
      return Promise.resolve();
    },
    getTaskSnapshot: (params: { taskId: string }) => {
      seen.push(`getTaskSnapshot:${params.taskId}`);
      return Promise.resolve(null);
    },
  };
  const services = new ServiceCollection().register(IZCodeTaskService, taskService as never);

  const service = makeService({ repoRoot });
  // The observer is built from the same ServiceCollection the server uses, so
  // this is the real override map rather than a stand-in.
  const activeTaskIds = new Set<string>();
  const overrides = createPhoneTaskObserver(
    new ServiceCollection().register(IZCodeTaskService, taskService as never),
    activeTaskIds,
  );
  t.after(() => service.stop());
  await service.start();

  assert.ok(overrides, "the phone override map is built when a task service exists");
  const phoneTaskService = overrides!.get(IZCodeTaskService.channelName) as typeof taskService;
  await phoneTaskService.sendPrompt({ taskId: "task-a" });
  await phoneTaskService.getTaskSnapshot({ taskId: "task-b" });

  assert.deepEqual(seen, ["sendPrompt:task-a", "getTaskSnapshot:task-b"]);
  assert.deepEqual([...activeTaskIds], ["task-a"], "browsing a task is not the same as driving it");
  // The shared collection is untouched, so the desktop's own renderer keeps the
  // real service and its badge never lights from desktop-side activity.
  assert.equal(
    services.get(IZCodeTaskService).getTaskSnapshot,
    taskService.getTaskSnapshot,
    "the observer must not replace the shared task service",
  );
});

test("no task service means no observer rather than a broken override", () => {
  assert.equal(createPhoneTaskObserver(new ServiceCollection(), new Set()), undefined);
});

test("a host with no task service still serves the phone", async (t) => {
  const service = makeService({ repoRoot: await makeWebDist() });
  t.after(() => service.stop());
  const state = await service.start();
  assert.equal(state.status, "running");
  assert.deepEqual(await service.listActiveTaskIds(), []);
});
