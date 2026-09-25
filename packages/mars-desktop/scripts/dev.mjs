import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electron from "electron";

const vite = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)) });
await vite.listen();
const url = vite.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:5178/";

const child = spawn(electron, [fileURLToPath(new URL("../electron/main.mjs", import.meta.url))], {
  stdio: "inherit",
  env: { ...process.env, MARS_RENDERER_URL: url },
});

const shutdown = async () => {
  if (!child.killed) child.kill("SIGTERM");
  await vite.close();
};

child.on("exit", async (code) => {
  await shutdown();
  process.exit(code ?? 0);
});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
