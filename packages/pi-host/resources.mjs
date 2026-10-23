// host_resources and host_service: let the agent see memory pressure and manage the UI
// dev server's memory. The Next dev server grew to 3.2 GB in 13 hours (2026-10), so the
// agent may restart it or cap it with a systemd drop-in (MemoryHigh plus MemoryMax). The
// host never restarts itself here: that path is host_deploy or the updater, which check
// the code first and roll back when the new host is unhealthy.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { runFile } from "./exec-limits.mjs";
import { redactText } from "./secrets.mjs";

const MB = 1024 * 1024;
const DROP_IN = "50-mars-memory.conf";
const SHOW = "Id,LoadState,ActiveState,SubState,Description,MainPID,NRestarts,MemoryCurrent,MemoryPeak,MemoryMax,MemoryHigh,CPUWeight,ActiveEnterTimestamp,ActiveEnterTimestampMonotonic";

/** Service names and where drop-ins go; every field can be overridden (tests use their own unit). */
export function serviceConfig(env = process.env, overrides = {}) {
  return {
    host: env.MARS_HOST_SERVICE || env.MARS_PI_SERVICE || "mars-pi-host.service",
    ui: env.MARS_UI_SERVICE || "mars-pi-ui.service",
    configDir: join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd/user"),
    systemctl: "systemctl",
    ...overrides,
  };
}

const unitName = (value) => {
  if (!/^[a-zA-Z0-9_.@-]+\.(service|scope)$/.test(value)) throw Error(`Invalid unit name ${JSON.stringify(value)}. Set MARS_HOST_SERVICE or MARS_UI_SERVICE to a plain name such as mars-pi-ui.service.`);
  return value;
};
// systemd prints bytes, "infinity" or "[not set]".
const mb = (value) => /^\d+$/.test(value ?? "") && Number(value) < 2 ** 62 ? Math.round(Number(value) / MB) : null;

/** Parse `systemctl show` output for one or more units into objects keyed by property. */
export function parseShow(text) {
  return text.split(/\n\s*\n/).map((block) => Object.fromEntries(block.split("\n").filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))).filter((unit) => unit.Id);
}

async function meminfo() {
  try {
    const text = await readFile("/proc/meminfo", "utf8");
    const kb = (key) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) * 1024;
    return { total: kb("MemTotal"), available: kb("MemAvailable"), swapTotal: kb("SwapTotal"), swapFree: kb("SwapFree") };
  } catch {
    return { total: totalmem(), available: freemem(), swapTotal: 0, swapFree: 0 };
  }
}
async function uptimeSeconds() {
  try { return Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]); } catch { return null; }
}

/** The biggest processes by resident memory, with secrets hidden and commands cut short. */
async function topProcesses(known, count = 8) {
  const result = await runFile("ps", ["-axo", "pid=,rss=,pcpu=,args="], { timeout: 5000 });
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, rss, cpu, args]) => ({ pid: Number(pid), rssMb: Math.round(Number(rss) / 1024), cpuPercent: Number(cpu), command: redactText(args, known).slice(0, 120) }))
    .sort((a, b) => b.rssMb - a.rssMb).slice(0, count);
}

const serviceView = (role, unit, raw = {}) => ({
  role, unit,
  state: raw.LoadState === "not-found" || !raw.LoadState ? "not installed" : `${raw.ActiveState}/${raw.SubState}`,
  memoryMb: mb(raw.MemoryCurrent), peakMb: mb(raw.MemoryPeak), maxMb: mb(raw.MemoryMax), highMb: mb(raw.MemoryHigh),
});

export function createResourceTools({ limits, secrets, services: overrides = {}, env = process.env }) {
  const services = serviceConfig(env, overrides);
  const systemctl = (args, timeout = 10000) => runFile(services.systemctl, ["--user", ...args], { timeout });
  const show = async (units) => units.length ? parseShow((await systemctl(["show", "-p", SHOW, ...units.map(unitName)])).stdout) : [];

  async function resources() {
    const known = await secrets();
    const [memory, uptime, processes, scopeList, state] = await Promise.all([
      meminfo(), uptimeSeconds(), topProcesses(known),
      process.platform === "linux" ? systemctl(["list-units", "--type=scope", "--state=running", "--plain", "--no-legend", "--no-pager", "mars-exec-*"], 5000) : { code: 1, stdout: "" },
      limits.available(),
    ]);
    const scopeUnits = scopeList.code === 0 ? scopeList.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^mars-exec-[\w-]+\.scope$/.test(name)).slice(0, 20) : [];
    const shown = process.platform === "linux" ? await show([services.host, services.ui, ...scopeUnits]) : [];
    const byId = new Map(shown.map((unit) => [unit.Id, unit]));
    const [one, five, fifteen] = loadavg();
    return {
      memory: { totalMb: Math.round(memory.total / MB), availableMb: Math.round(memory.available / MB), usedPercent: Math.round(100 * (1 - memory.available / memory.total)) },
      swap: { totalMb: Math.round(memory.swapTotal / MB), freeMb: Math.round(memory.swapFree / MB) },
      load: { one: Number(one.toFixed(2)), five: Number(five.toFixed(2)), fifteen: Number(fifteen.toFixed(2)), cpus: cpus().length },
      services: [serviceView("host", services.host, byId.get(services.host)), serviceView("ui", services.ui, byId.get(services.ui))],
      processes,
      commands: scopeUnits.map((name) => byId.get(name)).filter(Boolean).map((unit) => ({
        unit: unit.Id,
        description: redactText(unit.Description || "", known).slice(0, 120),
        memoryMb: mb(unit.MemoryCurrent), maxMb: mb(unit.MemoryMax), cpuWeight: Number(unit.CPUWeight) || null,
        runningSeconds: uptime && /^\d+$/.test(unit.ActiveEnterTimestampMonotonic) ? Math.max(0, Math.round(uptime - Number(unit.ActiveEnterTimestampMonotonic) / 1e6)) : null,
      })),
      execLimits: { mode: state.ok ? "scope" : "none", defaultMb: limits.policy.defaultMb, maxMb: limits.policy.maxMb, ...(state.ok ? {} : { note: state.reason }) },
    };
  }

  async function status(role) {
    const unit = services[role];
    const [raw] = await show([unit]);
    const dropIn = join(services.configDir, unit + ".d", DROP_IN);
    return {
      ...serviceView(role, unit, raw),
      mainPid: Number(raw?.MainPID) || null,
      restarts: /^\d+$/.test(raw?.NRestarts ?? "") ? Number(raw.NRestarts) : null,
      startedAt: raw?.ActiveEnterTimestamp || null,
      dropIn: existsSync(dropIn) ? dropIn : null,
    };
  }

  async function service({ service: role, action, memoryMb }) {
    if (!["ui", "host"].includes(role)) throw Error('service must be "ui" or "host".');
    if (process.platform !== "linux") throw Error("host_service needs systemd user services, which this machine does not have. Restart the UI from where it was started.");
    if (action === "status") return { action, ...(await status(role)), note: "" };
    if (role === "host") {
      throw Error(action === "restart"
        ? "Refused: host_service does not restart the Mars host, because that would cut off this call and skip the deploy checks. Use host_deploy to restart into committed host code (it checks first and rolls back an unhealthy host), or mars_update_apply for an update from GitHub."
        : "Refused: host_service only sets a memory limit on the UI. A limit on the host would let the kernel kill Mars itself; heavy commands already run in their own memory-limited scopes through host_exec.");
    }
    const unit = unitName(services.ui);
    if (action === "restart") {
      const result = await systemctl(["restart", unit], 90000);
      if (result.code !== 0) throw Error(`systemctl --user restart ${unit} failed: ${result.stderr.trim().slice(0, 300) || "exit " + result.code}. Check host_service status, or the unit name in MARS_UI_SERVICE.`);
      return { action, ...(await status(role)), note: "Restarted. The Next dev server takes a few seconds to compile its first page again." };
    }
    if (action !== "set_memory_limit") throw Error('action must be "status", "restart" or "set_memory_limit".');
    if (!Number.isInteger(memoryMb) || memoryMb < 0) throw Error("set_memory_limit needs memoryMb: the limit in MB, e.g. 2048, or 0 to remove the limit.");
    const directory = join(services.configDir, unit + ".d");
    const file = join(directory, DROP_IN);
    let note;
    let properties;
    if (memoryMb === 0) {
      await rm(file, { force: true });
      properties = ["MemoryMax=infinity", "MemoryHigh=infinity"];
      note = "Memory limit removed.";
    } else {
      const max = Math.min(limits.policy.maxMb, Math.max(512, memoryMb));
      const high = Math.round(max * 0.9);
      await mkdir(directory, { recursive: true });
      await writeFile(file, `# Written by Mars host_service set_memory_limit. The Next dev server grew to 3.2 GB in\n# 13 hours (2026-10); past MemoryHigh the kernel reclaims its memory, and past MemoryMax\n# it is killed and systemd restarts it, instead of the whole machine running short.\n[Service]\nMemoryHigh=${high}M\nMemoryMax=${max}M\n`);
      properties = [`MemoryMax=${max}M`, `MemoryHigh=${high}M`];
      note = (max !== memoryMb ? `memoryMb ${memoryMb} was clamped to ${max} (allowed 512 to ${limits.policy.maxMb}). ` : "") + `Limit set: MemoryHigh ${high} MB, MemoryMax ${max} MB, kept after a restart. If the UI passes it, systemd restarts it.`;
    }
    const reload = await systemctl(["daemon-reload"], 30000);
    if (reload.code !== 0) throw Error(`systemctl --user daemon-reload failed: ${reload.stderr.trim().slice(0, 300)}. The drop-in is at ${file}.`);
    // daemon-reload alone does not change a running unit's cgroup, so apply it now as well.
    const live = await systemctl(["set-property", "--runtime", unit, ...properties], 30000);
    if (live.code !== 0) note += ` It applies from the next restart (applying it now failed: ${live.stderr.trim().slice(0, 200)}).`;
    return { action, ...(await status(role)), note };
  }

  const MemoryOf = (what) => Type.Union([Type.Integer(), Type.Null()], { description: what });
  const Service = {
    role: Type.Union([Type.Literal("host"), Type.Literal("ui")], { description: '"host" is the Mars host, "ui" the Next.js interface.' }),
    unit: Type.String({ description: 'The systemd user unit, e.g. "mars-pi-ui.service".' }),
    state: Type.String({ description: 'e.g. "active/running", "failed/failed" or "not installed".' }),
    memoryMb: MemoryOf("Memory in use now, in MB, or null when unknown."),
    peakMb: MemoryOf("Most memory used since it started, in MB, or null."),
    maxMb: MemoryOf("Its MemoryMax limit in MB, or null for none."),
    highMb: MemoryOf("Its MemoryHigh limit in MB, or null for none."),
  };
  const tool = (name, description, parameters, result, run, replay) => defineTool({
    name, description, parameters: Type.Object(parameters), replay, deferred: true,
    structuredOutputSchema: result, outputLimits: { maxBytes: 20000 },
    execute: async (args) => {
      const value = await run(args);
      return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
  return [
    tool("host_resources", `Show the machine's memory, swap, load, the Mars services' memory and the biggest processes in one quick call.
Use it before a heavy command (a build, a browser, a test run) to pick host_exec's memoryMb, after an out-of-memory kill, or when Mars feels slow. It also lists host_exec commands still running in their own scopes, with their limits. To restart or cap the UI dev server, use host_service.
Example: const { memory, services, commands } = await tools.host_resources({})`, {}, Type.Object({
      memory: Type.Object({
        totalMb: Type.Integer({ description: "Total RAM in MB." }),
        availableMb: Type.Integer({ description: "RAM free for new work in MB (MemAvailable)." }),
        usedPercent: Type.Integer({ description: "Share of RAM in use, 0 to 100." }),
      }, { description: "Machine memory." }),
      swap: Type.Object({ totalMb: Type.Integer({ description: "Swap size in MB; 0 when there is none." }), freeMb: Type.Integer({ description: "Free swap in MB." }) }, { description: "Swap space." }),
      load: Type.Object({
        one: Type.Number({ description: "Load average over 1 minute." }),
        five: Type.Number({ description: "Load average over 5 minutes." }),
        fifteen: Type.Number({ description: "Load average over 15 minutes." }),
        cpus: Type.Integer({ description: "CPU count; load above it means work is waiting." }),
      }, { description: "CPU load." }),
      services: Type.Array(Type.Object(Service), { description: "The Mars host and UI services." }),
      processes: Type.Array(Type.Object({
        pid: Type.Integer({ description: "Process id." }),
        rssMb: Type.Integer({ description: "Resident memory in MB." }),
        cpuPercent: Type.Number({ description: "CPU use in percent of one core, averaged over its life." }),
        command: Type.String({ description: "Command line, cut to 120 characters, secrets hidden." }),
      }), { description: "The 8 biggest processes by memory." }),
      commands: Type.Array(Type.Object({
        unit: Type.String({ description: 'The scope, e.g. "mars-exec-m2x1-a1b2c3.scope". Stop it with host_exec: systemctl --user stop <unit>.' }),
        description: Type.String({ description: "The start of the command it runs." }),
        memoryMb: MemoryOf("Memory in use now, in MB."),
        maxMb: MemoryOf("Its memory limit in MB."),
        cpuWeight: Type.Union([Type.Integer(), Type.Null()], { description: "CPU weight: 100 normal, 20 background." }),
        runningSeconds: Type.Union([Type.Integer(), Type.Null()], { description: "How long it has run, in seconds." }),
      }), { description: "host_exec commands still running, including ones left in the background, up to 20." }),
      execLimits: Type.Object({
        mode: Type.Union([Type.Literal("scope"), Type.Literal("none")], { description: '"scope" when host_exec limits memory, "none" when this machine cannot.' }),
        defaultMb: Type.Integer({ description: "host_exec's memory limit when memoryMb is left out, in MB." }),
        maxMb: Type.Integer({ description: "The largest memoryMb host_exec allows, in MB." }),
        note: Type.Optional(Type.String({ description: "Why there is no limit, when mode is none." })),
      }, { description: "host_exec's memory limits." }),
    }), resources, "safe"),
    tool("host_service", `Check, restart or cap the memory of the Mars UI service; check the host service.
Use it when host_resources shows the UI dev server using a lot of memory (it once grew to 3.2 GB in 13 hours): restart frees it, and set_memory_limit writes a systemd drop-in (MemoryHigh at 90% plus MemoryMax) so it is reclaimed and then restarted automatically, kept after a restart. Restarting the host is refused: use host_deploy for host code, or mars_update_apply for an update. Returns the service state and memory.
Example: await tools.host_service({ service: "ui", action: "set_memory_limit", memoryMb: 2048 })`, {
      service: Type.Union([Type.Literal("ui"), Type.Literal("host")], { description: '"ui" is the Next.js interface (MARS_UI_SERVICE); "host" is Mars itself (status only).' }),
      action: Type.Union([Type.Literal("status"), Type.Literal("restart"), Type.Literal("set_memory_limit")], { description: '"status" reads state and memory, "restart" restarts the UI, "set_memory_limit" caps the UI\'s memory.' }),
      memoryMb: Type.Optional(Type.Integer({ minimum: 0, maximum: 1048576, description: "For set_memory_limit: MemoryMax in MB, e.g. 2048, kept between 512 and about 80% of RAM. 0 removes the limit." })),
    }, Type.Object({
      action: Type.String({ description: "The action done." }),
      ...Service,
      mainPid: Type.Union([Type.Integer(), Type.Null()], { description: "Main process id, or null when stopped." }),
      restarts: Type.Union([Type.Integer(), Type.Null()], { description: "How many times systemd restarted it automatically." }),
      startedAt: Type.Union([Type.String(), Type.Null()], { description: "When it last started, as systemd prints it." }),
      dropIn: Type.Union([Type.String(), Type.Null()], { description: "Path of the Mars memory drop-in, or null when none is set." }),
      note: Type.String({ description: "What happened, in plain words; empty for status." }),
    }), service, "unsafe"),
  ];
}
