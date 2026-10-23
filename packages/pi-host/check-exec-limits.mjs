// host_exec memory limits (exec-limits.mjs), host_resources and host_service (resources.mjs).
// A command that runs out of memory is killed alone and reported, abort and timeouts stop
// everything a command started, and the host never restarts itself through host_service.
// The systemd parts skip with a message where systemd --user is not available.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createExecLimits, memoryPolicy, parseScopeReport, runFile } from "./exec-limits.mjs";
import { createVmControl } from "./vm-control.mjs";

const directory = await mkdtemp(join(tmpdir(), "mars-exec-limits-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secrets = async () => [];
const make = (options = {}) => {
  const control = createVmControl({ root: directory, cwd: directory, secrets, ...options });
  const tools = new Map(control.extension.tools.map((tool) => [tool.name, tool]));
  return async (name, args, context = BACKGROUND_CONTEXT) => (await tools.get(name).execute(args, {}, context)).structuredOutput;
};
const alive = async (pid) => {
  try { return !/State:\s+Z/.test(await readFile(`/proc/${pid}/status`, "utf8")); } catch { return false; }
};
const waitFor = async (file) => {
  for (let attempt = 0; ; attempt++) {
    try { await access(file); return; } catch { assert.ok(attempt < 250, "started: " + file); await sleep(20); }
  }
};
const passed = [];
const skipped = [];
async function check(name, fn) { await fn(); passed.push(name); }
const transient = [];
try {
  await check("memory policy: 40% default, 80% most, at least 512 MB, env overrides", async () => {
    assert.deepEqual(memoryPolicy({ env: {}, totalMb: 6000 }), { totalMb: 6000, defaultMb: 2400, maxMb: 4800 });
    assert.deepEqual(memoryPolicy({ env: {}, totalMb: 1000 }), { totalMb: 1000, defaultMb: 512, maxMb: 800 });
    assert.deepEqual(memoryPolicy({ env: { MARS_EXEC_MEMORY_MB: "1500", MARS_EXEC_MEMORY_MAX_MB: "3000" }, totalMb: 6000 }), { totalMb: 6000, defaultMb: 1500, maxMb: 3000 });
    assert.equal(memoryPolicy({ env: { MARS_EXEC_MEMORY_MB: "9000" }, totalMb: 6000 }).defaultMb, 4800, "default never above the most");
    assert.deepEqual(parseScopeReport("oom_kill 2\npeak 209715200\n"), { oomKills: 2, peakMb: 200 });
    assert.equal(parseScopeReport(""), null);
  });

  await check("fallback without systemd runs as before and says so", async () => {
    const run = make({ limits: createExecLimits({ systemdRun: join(directory, "no-systemd-run") }) });
    const result = await run("host_exec", { command: "cat /proc/self/cgroup; node -v" });
    assert.equal(result.exitCode, 0);
    assert.equal(result.limits.mode, "none");
    assert.equal(result.limits.memoryMb, null);
    assert.match(result.note, /No memory limit: systemd user scopes are not available/);
    assert.equal(result.oomKilled, false);
    assert.ok(result.stdout.text.endsWith(process.version + "\n"), "pinned Node still first");
    assert.equal(result.stdout.text.split("\n")[0], (await readFile("/proc/self/cgroup", "utf8")).trim().split("\n").pop(), "same cgroup as the host");
    const background = await run("host_exec", { command: "nice", background: true });
    assert.equal(background.stdout.text.trim(), "10");
    assert.equal(background.limits.background, true);
    const off = await make({ limits: createExecLimits({ scopes: false }) })("host_exec", { command: "true" });
    assert.match(off.note, /turned off/);
    // Abort still kills a child that ignores SIGTERM.
    const pidFile = join(directory, "fallback.pid");
    const abort = new AbortController();
    const pending = run("host_exec", { command: `bash -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 30' & wait` }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
    await waitFor(pidFile);
    abort.abort();
    assert.equal((await pending).cancelled, true);
    assert.equal(await alive(Number(await readFile(pidFile, "utf8"))), false, "TERM-ignoring child stopped");
  });

  const limits = createExecLimits();
  const state = await limits.available();
  if (!state.ok) {
    skipped.push(`systemd scope checks skipped: ${state.reason}`);
  } else {
    const run = make({ limits });
    await check("over the limit: killed alone, reported as out of memory, host survives", async () => {
      const result = await run("host_exec", { command: `echo start; python3 -c 'b = b"x" * (400 * 1024 * 1024); print(len(b))'; echo after`, memoryMb: 200 });
      assert.equal(result.oomKilled, true);
      assert.equal(result.limits.mode, "scope");
      assert.equal(result.limits.memoryMb, 200);
      assert.ok(result.limits.peakMb >= 190 && result.limits.peakMb <= 205, "peak near the limit: " + result.limits.peakMb);
      assert.match(result.note, /Out of memory: the command passed its 200 MB limit.*larger memoryMb \(for example 400/);
      assert.match(result.note, /background: true/);
      assert.equal(result.stdout.text, "start\nafter\n", "the shell went on after the kill");
      const next = await run("host_exec", { command: "echo still here" });
      assert.equal(next.stdout.text, "still here\n");
      assert.equal(next.oomKilled, false);
      assert.equal(next.note, undefined);
    });
    await check("default limit applies inside the command's own scope", async () => {
      const result = await run("host_exec", { command: `c=$(sed -n 's/^0:://p' /proc/self/cgroup); echo $c; cat /sys/fs/cgroup$c/memory.max /sys/fs/cgroup$c/memory.swap.max /sys/fs/cgroup$c/cpu.weight; nice` });
      const [cgroup, max, swap, weight, nice] = result.stdout.text.trim().split("\n");
      assert.match(cgroup, /\/mars-exec-[\w-]+\.scope$/);
      assert.ok(!cgroup.includes(".service/mars-exec"), "not inside the Mars service");
      assert.equal(Number(max), limits.policy.defaultMb * 1024 * 1024);
      assert.equal(result.limits.memoryMb, limits.policy.defaultMb);
      assert.equal(swap, "0");
      assert.equal(weight, "100");
      assert.equal(nice, "0");
    });
    await check("memoryMb is clamped to the allowed range", async () => {
      const big = await run("host_exec", { command: "true", memoryMb: 1048576 });
      assert.equal(big.limits.memoryMb, limits.policy.maxMb);
      assert.match(big.note, new RegExp(`memoryMb 1048576 was clamped to ${limits.policy.maxMb}`));
      const small = await run("host_exec", { command: "true", memoryMb: 1 });
      assert.equal(small.limits.memoryMb, 64);
    });
    await check("background mode runs at low priority", async () => {
      const result = await run("host_exec", { command: `c=$(sed -n 's/^0:://p' /proc/self/cgroup); cat /sys/fs/cgroup$c/cpu.weight; nice`, background: true });
      assert.equal(result.stdout.text, "20\n10\n");
      assert.equal(result.limits.background, true);
    });
    await check("abort and timeout kill the whole scope, even what left the process group", async () => {
      for (const how of ["abort", "timeout"]) {
        const stubborn = join(directory, how + "-stubborn.pid");
        const escaped = join(directory, how + "-escaped.pid");
        const marker = join(directory, how + "-leaked");
        const command = `bash -c 'trap "" TERM; echo $$ > ${stubborn}; sleep 3; touch ${marker}' & setsid bash -c 'echo $$ > ${escaped}; sleep 3; touch ${marker}' & wait`;
        const abort = new AbortController();
        const pending = run("host_exec", how === "abort" ? { command } : { command, timeoutMs: 800 }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
        await waitFor(stubborn);
        await waitFor(escaped);
        if (how === "abort") abort.abort();
        const result = await pending;
        assert.equal(how === "abort" ? result.cancelled : result.timedOut, true);
        assert.equal(result.oomKilled, false);
        for (const file of [stubborn, escaped]) assert.equal(await alive(Number(await readFile(file, "utf8"))), false, how + " stopped " + file);
        await sleep(3200);
        await assert.rejects(access(marker), { code: "ENOENT" }, how + ": nothing survived to finish");
      }
    });
    await check("host_resources returns its shape quickly and lists running commands", async () => {
      const pending = run("host_exec", { command: "sleep 3", memoryMb: 300, background: true });
      await sleep(400);
      const started = Date.now();
      const result = await run("host_resources", {});
      const took = Date.now() - started;
      assert.ok(took < 2000, "fast: " + took + " ms");
      assert.ok(JSON.stringify(result).length < 8000, "small");
      assert.ok(result.memory.totalMb > 0 && result.memory.availableMb > 0 && result.memory.usedPercent >= 0);
      assert.equal(typeof result.swap.totalMb, "number");
      assert.ok(result.load.cpus >= 1);
      assert.deepEqual(result.services.map((service) => service.role), ["host", "ui"]);
      assert.ok(result.processes.length > 0 && result.processes.length <= 8);
      assert.ok(result.processes.every((p) => Number.isInteger(p.pid) && p.command.length <= 120));
      // Match the whole command: other scopes on a shared machine (e.g. "sleep 30") also contain "sleep 3".
      const mine = result.commands.find((command) => /(^|: )sleep 3$/.test(command.description));
      assert.ok(mine, "running command listed");
      assert.equal(mine.maxMb, 300);
      assert.equal(mine.cpuWeight, 20);
      assert.deepEqual(result.execLimits, { mode: "scope", defaultMb: limits.policy.defaultMb, maxMb: limits.policy.maxMb });
      await pending;
    });
    await check("host_service: refuses to restart the host, manages a UI service", async () => {
      // A throwaway transient service stands in for the UI, so the real one is never touched.
      const unit = `mars-check-ui-${process.pid}.service`;
      const started = await runFile("systemd-run", ["--user", "--quiet", `--unit=${unit}`, "sleep", "300"]);
      assert.equal(started.code, 0, started.stderr);
      transient.push(unit);
      const configDir = join(directory, "systemd-user");
      const service = make({ limits, services: { host: "mars-check-host-never.service", ui: unit, configDir } });
      await assert.rejects(service("host_service", { service: "host", action: "restart" }), /Refused: host_service does not restart the Mars host.*host_deploy/s);
      await assert.rejects(service("host_service", { service: "host", action: "set_memory_limit", memoryMb: 1024 }), /Refused/);
      const host = await service("host_service", { service: "host", action: "status" });
      assert.equal(host.state, "not installed");
      const status = await service("host_service", { service: "ui", action: "status" });
      assert.equal(status.state, "active/running");
      assert.equal(status.dropIn, null);
      const set = await service("host_service", { service: "ui", action: "set_memory_limit", memoryMb: 600 });
      assert.equal(set.maxMb, 600);
      assert.equal(set.highMb, 540);
      assert.match(await readFile(join(configDir, unit + ".d/50-mars-memory.conf"), "utf8"), /3\.2 GB[\s\S]*MemoryHigh=540M\nMemoryMax=600M\n/);
      assert.equal(set.dropIn, join(configDir, unit + ".d/50-mars-memory.conf"));
      const clamped = await service("host_service", { service: "ui", action: "set_memory_limit", memoryMb: 100 });
      assert.equal(clamped.maxMb, 512);
      assert.match(clamped.note, /clamped to 512/);
      await assert.rejects(service("host_service", { service: "ui", action: "set_memory_limit" }), /needs memoryMb/);
      const before = status.mainPid;
      const restarted = await service("host_service", { service: "ui", action: "restart" });
      assert.equal(restarted.state, "active/running");
      assert.notEqual(restarted.mainPid, before);
      const removed = await service("host_service", { service: "ui", action: "set_memory_limit", memoryMb: 0 });
      assert.equal(removed.maxMb, null);
      assert.equal(removed.dropIn, null);
    });
  }
  console.log(JSON.stringify({ status: "PASS", checks: passed, skipped }, null, 2));
} finally {
  for (const unit of transient) await runFile("systemctl", ["--user", "stop", unit]);
  await rm(directory, { recursive: true, force: true });
}
