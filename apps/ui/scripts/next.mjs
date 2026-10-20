import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
if (command !== "dev" && command !== "start") throw Error("Expected dev or start");
const nextRequire = createRequire(require.resolve("next/package.json"));
nextRequire("@next/env").loadEnvConfig(process.cwd(), command === "dev");
const port = process.env.MARS_UI_PORT || "3082";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw Error("MARS_UI_PORT must be a port between 1 and 65535");
const child = spawn(process.execPath, [
  require.resolve("next/dist/bin/next"), command,
  ...(command === "dev" ? ["--turbopack"] : []),
  "--hostname", "127.0.0.1", "--port", port, ...args,
], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  else process.exitCode = code ?? 1;
});
