import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createArtefacts } from "./artefacts.mjs";

const optionalString = () => Type.Optional(Type.String());
const range = { offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })) };
export function createVmControl({ root, cwd }) {
  const artefacts = createArtefacts({ root });
  const absolute = (path) => resolve(cwd, path);
  async function exec({ command, cwd: directory = cwd, timeoutMs = 120000 }, signal) {
    signal?.throwIfAborted();
    const stdout = await artefacts.allocate();
    const stderr = await artefacts.allocate();
    let child;
    let cancelled = false;
    let timedOut = false;
    let escalation;
    const kill = () => {
      // The shell and its children share a group. Killing only the shell leaks tools on abort.
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      escalation ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 500);
    };
    const abort = () => { cancelled = true; kill(); };
    let timer;
    try {
      child = spawn("/bin/bash", ["-lc", command], { cwd: absolute(directory), detached: true, stdio: ["ignore", stdout.file.fd, stderr.file.fd] });
      const finished = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal }));
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
      const result = await finished;
      // Finish escalation even if the shell exits first and a descendant ignores TERM.
      if (escalation) await new Promise((resolve) => setTimeout(resolve, 550));
      return { ...result, cancelled, timedOut, stdout: await artefacts.read(stdout.id), stderr: await artefacts.read(stderr.id) };
    } finally {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
      await Promise.all([stdout.file.close(), stderr.file.close()]);
    }
  }
  const tool = (name, description, parameters, run, replay = "unsafe") => defineTool({
    name, description, parameters: Type.Object(parameters), replay, deferred: true,
    structuredOutputSchema: Type.Any(), outputLimits: { maxBytes: 20000 },
    execute: async (args, _api, context) => {
      const value = await run(args, context?.abortSignal);
      return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
  const tools = [
    tool("host_exec", "Run unrestricted bash on the owner-authorised VM, including sudo and network. Output is persisted; use artefact tools for the rest. Effects are not replayed after interruption.", { command: Type.String(), cwd: optionalString(), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000 })) }, exec),
    tool("host_read", "Snapshot any host file into an immutable artefact and return a bounded UTF-8 byte range.", { path: Type.String(), ...range }, async ({ path, ...window }) => {
      const item = await artefacts.snapshot(absolute(path));
      return artefacts.read(item.id, window);
    }, "safe"),
    tool("host_write", "Write arbitrary host paths as UTF-8. Parent directories must exist. Never replayed after interruption.", { path: Type.String(), content: Type.String(), append: Type.Optional(Type.Boolean()) }, async ({ path, content, append }) => {
      await writeFile(absolute(path), content, { flag: append ? "a" : "w" });
      return { path: absolute(path), bytes: Buffer.byteLength(content) };
    }),
    tool("artefact_read", "Read a bounded byte range from persisted immutable output. IDs survive host restart.", { id: Type.String(), ...range }, ({ id, ...window }) => artefacts.read(id, window), "safe"),
    tool("artefact_search", "Lexical UTF-8 search in persisted output. Returns bounded matches with byte offsets.", { id: Type.String(), query: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, ({ id, ...query }) => artefacts.search(id, query), "safe"),
  ];
  return { extension: defineExtension({ name: "vm-control", tools }), artefacts };
}
