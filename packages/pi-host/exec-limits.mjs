// Memory and CPU limits for host_exec. Each command runs in its own transient systemd user
// scope (systemd-run --user --scope), outside the Mars service's cgroup, so when a heavy
// command (a Next build, a browser, a test run) runs out of memory the kernel kills only
// that command. On 2026-10-21 a production build run through host_exec pushed the Mars
// service over its memory and the out-of-memory killer restarted Mars.
//
// Where systemd user services are missing (a Mac, a container) commands run as before,
// in the host's own process group, and the result says so.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { totalmem } from "node:os";

const MB = 1024 * 1024;
export const MIN_MEMORY_MB = 64;
export const BACKGROUND_CPU_WEIGHT = 20;
export const BACKGROUND_NICE = 10;

/** Run a program without a shell. Resolves { code, stdout, stderr }; never rejects. */
export function runFile(file, args, { timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * MB, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
      resolve({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (error && typeof error.code !== "number" ? String(error.message) : "") });
    });
  });
}

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
};

/** The default and largest memory limits in MB. Env MARS_EXEC_MEMORY_MB and MARS_EXEC_MEMORY_MAX_MB override. */
export function memoryPolicy({ env = process.env, totalMb = Math.round(totalmem() / MB) } = {}) {
  const maxMb = Math.max(MIN_MEMORY_MB, positive(env.MARS_EXEC_MEMORY_MAX_MB) ?? Math.round(totalMb * 0.8));
  const defaultMb = Math.min(maxMb, positive(env.MARS_EXEC_MEMORY_MB) ?? Math.max(512, Math.round(totalMb * 0.4)));
  return { totalMb, defaultMb, maxMb };
}

// Runs inside the scope. The command is a login shell as before; afterwards this reads the
// scope's own out-of-memory count and peak use and writes them to fd 3 for the host.
// OOMPolicy=continue keeps this wrapper alive after the kernel kills the command.
export const SCOPE_WRAPPER = `/bin/bash -lc "$1" 3>&-
s=$?
c=$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)
{ grep -s '^oom_kill ' "/sys/fs/cgroup$c/memory.events"; printf 'peak %s\\n' "$(cat "/sys/fs/cgroup$c/memory.peak" 2>/dev/null)"; } >&3 2>/dev/null
exit $s`;

/** Parse the wrapper's fd 3 report: { oomKills, peakMb } or null when nothing arrived. */
export function parseScopeReport(text) {
  if (!text) return null;
  const oom = text.match(/^oom_kill (\d+)/m);
  const peak = text.match(/^peak (\d+)/m);
  return { oomKills: oom ? Number(oom[1]) : 0, peakMb: peak ? Math.round(Number(peak[1]) / MB) : null };
}

/**
 * Plans how each host_exec command is limited. `scopes: false` (or env MARS_EXEC_SCOPES=off)
 * turns scopes off; `systemdRun` and `systemctl` name the programs (tests point them at a
 * missing file to take the fallback path).
 */
export function createExecLimits({ env = process.env, scopes = !/^(0|off|false|no)$/i.test(env.MARS_EXEC_SCOPES ?? ""), systemdRun = "systemd-run", systemctl = "systemctl", policy = memoryPolicy({ env }) } = {}) {
  let probed;
  // One quick test scope the first time: is systemd --user reachable, and does it really
  // apply a memory limit (the memory controller is delegated to the user manager)?
  async function probe() {
    if (!scopes) return { ok: false, oomPolicy: false, reason: "scopes are turned off (MARS_EXEC_SCOPES=off)" };
    if (process.platform !== "linux") return { ok: false, oomPolicy: false, reason: `systemd user services are not available on ${process.platform}` };
    const read = `c=$(sed -n 's/^0:://p' /proc/self/cgroup); cat "/sys/fs/cgroup$c/memory.max"`;
    let last = "";
    for (const oomPolicy of [true, false]) {
      const result = await runFile(systemdRun, ["--user", "--scope", "--quiet", "--collect", "-p", "MemoryMax=64M", "-p", "MemorySwapMax=0", ...(oomPolicy ? ["-p", "OOMPolicy=continue"] : []), "-p", "CPUWeight=100", "/bin/sh", "-c", read], { timeout: 5000 });
      if (result.code === 0 && result.stdout.trim() === String(64 * MB)) return { ok: true, oomPolicy };
      last = result.code === 0 ? "the memory controller is not delegated to the systemd user manager" : (result.stderr.trim().split("\n").pop() || `systemd-run exited ${result.code}`);
    }
    return { ok: false, oomPolicy: false, reason: `systemd user scopes are not available (${last.slice(0, 200)})` };
  }
  const available = () => (probed ??= probe());

  /** How to run one command: { mode, memoryMb, background, unit?, args?, note? }. */
  async function plan({ memoryMb, background = false, description = "host_exec" } = {}) {
    const state = await available();
    if (!state.ok) {
      return { mode: "none", memoryMb: null, background, note: `No memory limit: ${state.reason}, so the command ran in the Mars host's own process group as before.` };
    }
    const requested = memoryMb == null ? policy.defaultMb : Math.round(Number(memoryMb));
    const limit = Math.min(policy.maxMb, Math.max(MIN_MEMORY_MB, requested));
    const note = limit !== requested ? `memoryMb ${requested} was clamped to ${limit} (allowed ${MIN_MEMORY_MB} to ${policy.maxMb}).` : undefined;
    const unit = `mars-exec-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const weight = background ? BACKGROUND_CPU_WEIGHT : 100;
    const args = ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, `--description=${description.slice(0, 120)}`,
      "-p", `MemoryMax=${limit}M`, "-p", "MemorySwapMax=0", ...(state.oomPolicy ? ["-p", "OOMPolicy=continue"] : []),
      "-p", `CPUWeight=${weight}`, "-p", `IOWeight=${weight}`, ...(background ? [`--nice=${BACKGROUND_NICE}`] : [])];
    return { mode: "scope", memoryMb: limit, background, unit, args, note };
  }

  /** Signal every process in a command's scope, including ones that left its process group. */
  const killScope = (unit, signal) => runFile(systemctl, ["--user", "kill", `--signal=${signal}`, `${unit}.scope`], { timeout: 5000 });

  return { policy, available, plan, killScope, systemdRun };
}

/** Plain advice for a command the kernel killed for using too much memory. */
export function oomAdvice({ memoryMb, maxMb, background }) {
  const bigger = Math.min(maxMb, memoryMb * 2);
  const more = bigger > memoryMb ? `run it again with a larger memoryMb (for example ${bigger}; the most allowed is ${maxMb})` : `it already had the most memory allowed (${maxMb} MB), so make it lighter`;
  return `Out of memory: the command passed its ${memoryMb} MB limit and the kernel killed it. Only this command was stopped; Mars is fine. To retry, ${more}${background ? "" : ", or use background: true so a long job yields to Mars"}. Lighter jobs use fewer parallel workers (e.g. --workers=1) or a smaller NODE_OPTIONS=--max-old-space-size.`;
}
