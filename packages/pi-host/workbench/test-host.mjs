// Shared harness for check-workbench-*.mjs: boots a real host on a temporary data root.
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../dev-tools.mjs";

/** Boot a real host. `reuse` ({ base, port, uiPort }) restarts one on the same data root. */
export async function startHost(extraEnv = {}, reuse) {
  const base = reuse?.base ?? (await mkdtemp(join(tmpdir(), "mars workbench ")));
  const root = join(base, "data");
  const port = reuse?.port ?? (await freePort());
  const uiPort = reuse?.uiPort ?? (await freePort());
  const env = { ...process.env, MARS_PI_ROOT: root, MARS_PI_PORT: String(port), MARS_UI_PORT: String(uiPort), MARS_PI_STAGING: "1", MARS_PUBLIC_ORIGIN: "", MARS_ALLOWED_ORIGINS: "", ...extraEnv };
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolve) => child.once("close", resolve));
  for (let n = 0; n < 300 && !log.includes("agent ready"); n++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(log.includes("agent ready"), "host boots: " + log.slice(-2000));
  const token = (await readFile(join(root, "data/web-token"), "utf8")).trim();
  const origin = `http://127.0.0.1:${port}`;
  const request = (path, { method = "GET", body, headers = {}, auth = true, raw = false } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            host: `127.0.0.1:${port}`,
            ...(auth ? { authorization: "Bearer " + token } : {}),
            ...(payload !== undefined && !headers["content-type"] ? { "content-type": "application/json" } : {}),
            ...(method !== "GET" ? { origin } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          // A response cut off mid-stream (for example at a size cap) settles as truncated.
          res.on("aborted", () => resolve({ status: res.statusCode, headers: res.headers, truncated: true, buffer: Buffer.concat(chunks) }));
          res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, truncated: true, buffer: Buffer.concat(chunks) }));
          res.on("end", () => {
            const buffer = Buffer.concat(chunks);
            let json;
            try {
              json = raw ? undefined : JSON.parse(buffer.toString() || "null");
            } catch {
              json = undefined;
            }
            resolve({ status: res.statusCode, headers: res.headers, json, text: buffer.toString(), buffer });
          });
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  const stop = async () => {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };
  return { base, root, work: join(root, "workspace"), port, uiPort, token, request, stop, log: () => log };
}
