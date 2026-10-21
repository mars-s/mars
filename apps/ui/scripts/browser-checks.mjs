// Every browser check in one command (npm run test:browser): starts the fixture Pi host and a
// separate Next dev server (its own .next-build folder, so the live dev UI is untouched), runs
// each check against http://localhost:<port>/ (the dev proxy compares the Origin with the page's
// own host name, so use localhost, not 127.0.0.1), and stops only the processes it started.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ui = fileURLToPath(new URL("..", import.meta.url));
const fixturePort = process.env.MARS_FIXTURE_PORT || "3191";
const uiPort = process.env.MARS_BROWSER_UI_PORT || "3190";
const base = `http://localhost:${uiPort}/`;
const only = process.argv.slice(2);
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
// Arguments filter the test:ui list by name; a path ending in .mjs runs that file instead.
const listed = [...new Set(pkg.scripts["test:ui"].match(/tests\/[\w-]+\.mjs/g))];
const checks = only.some((name) => name.endsWith(".mjs"))
  ? only
  : listed.filter((file) => !only.length || only.some((name) => file.includes(name)));
// The separate dev server rewrites next-env.d.ts for its own folder; put the original back after.
const nextEnv = new URL("../next-env.d.ts", import.meta.url);
const nextEnvText = await readFile(nextEnv, "utf8").catch(() => undefined);
const started = [];
const start = (args, env) => {
  const child = spawn(process.execPath, args, { cwd: ui, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"], detached: true });
  started.push(child);
  return child;
};
const stop = () => {
  for (const child of started) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stop(); process.exit(130); });

start(["scripts/preview-pi-fixture.mjs"], { MARS_FIXTURE_PORT: fixturePort });
start(["scripts/next.mjs", "dev"], { MARS_BUILD_CHECK: "1", MARS_PI_ORIGIN: `http://127.0.0.1:${fixturePort}`, MARS_UI_PORT: uiPort });
const deadline = Date.now() + 180000;
for (;;) {
  try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
  if (Date.now() > deadline) { console.error("The dev server did not start within 3 minutes."); process.exit(1); }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const results = [];
for (const file of checks) {
  const began = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ui, env: { ...process.env, MARS_UI_BASE_URL: base }, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
    child.on("close", (exit) => { clearTimeout(timer); results.push({ file, exit, ms: Date.now() - began, log: log.slice(-1200) }); resolve(exit); });
  });
  console.log(`${code === 0 ? "ok  " : "FAIL"} ${file} ${Date.now() - began}ms`);
}
const failed = results.filter((result) => result.exit !== 0);
for (const result of failed) console.log(`\n--- ${result.file}\n${result.log}`);
console.log(`\n${results.length - failed.length} of ${results.length} browser checks passed`);
process.exitCode = failed.length ? 1 : 0;
stop();
if (nextEnvText !== undefined) await writeFile(nextEnv, nextEnvText);
