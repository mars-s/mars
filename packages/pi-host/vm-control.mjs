import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createArtefacts } from "./artefacts.mjs";

const range = {
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: 'Byte position to start reading from. Use nextOffset from the previous call to continue.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, default: 4096, description: 'How many bytes to read, up to 16384.' })),
};
const Slice = Type.Object({
  id: Type.String({ description: 'Saved-output id. Pass it to artefact_read or artefact_search for more.' }),
  offset: Type.Integer({ description: 'Byte position this text starts at.' }),
  nextOffset: Type.Integer({ description: 'Byte position to pass as offset to read on.' }),
  bytes: Type.Integer({ description: 'Total size in bytes.' }),
  text: Type.String({ description: 'The UTF-8 text read.' }),
  truncated: Type.Boolean({ description: 'True when there is more after nextOffset.' }),
});
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
  const tool = (name, description, parameters, result, run, replay = "unsafe") => defineTool({
    name, description, parameters: Type.Object(parameters), replay, deferred: true,
    structuredOutputSchema: result, outputLimits: { maxBytes: 20000 },
    execute: async (args, _api, context) => {
      const value = await run(args, context?.abortSignal);
      return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value };
    },
  });
  const tools = [
    tool("host_exec", `Run a bash command on the owner's machine and get its output.
Use it for anything the shell does: installing packages, running scripts and tests, git, system services. It runs as the owner with sudo and network access, in the workspace folder unless cwd says otherwise. Output is saved in full: stdout and stderr come back as the first part of each, and artefact_read reads the rest by id. A command interrupted by a restart is not run again; check its effects before retrying.
Example: const { exitCode, stdout } = await tools.host_exec({ command: "npm test", cwd: "projects/site", timeoutMs: 300000 })`, {
      command: Type.String({ description: 'Bash command line, e.g. "ls -la" or "cd app && npm test".' }),
      cwd: Type.Optional(Type.String({ description: 'Folder to run in, relative to the workspace or absolute. Default: the workspace folder.' })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600000, default: 120000, description: 'Stop the command after this many milliseconds. Default 120000 (2 minutes), up to 1 hour.' })),
    }, Type.Object({
      exitCode: Type.Union([Type.Integer(), Type.Null()], { description: 'The exit status; 0 means success. null when it was stopped by a signal.' }),
      signal: Type.Union([Type.String(), Type.Null()], { description: 'The signal that stopped it, e.g. "SIGTERM", or null.' }),
      cancelled: Type.Boolean({ description: 'True when the call was cancelled.' }),
      timedOut: Type.Boolean({ description: 'True when timeoutMs ran out.' }),
      stdout: Slice,
      stderr: Slice,
    }), exec),
    tool("host_read", `Read part of a file on disk, by its file path.
Use it for files outside the workspace, or for large files you want to page through. It takes a file path, never a web URL (use web_fetch) or a saved-output id (use artefact_read). It saves a copy of the file, so later reads by id see the same content even if the file changes. Returns up to 16384 bytes per call; pass nextOffset as offset to read on, or artefact_search to find text in it. For files in the workspace, read is usually simpler.
Example: await tools.host_read({ path: "/var/log/syslog", offset: 0, limit: 8000 })`, {
      path: Type.String({ description: 'File path, absolute or relative to the workspace, e.g. "/etc/hosts".' }),
      ...range,
    }, Slice, async ({ path, ...window }) => {
      // Forgiving: a saved-output id passed as path (a common small-model mix-up) reads
      // that saved output, as artefact_read would, when no file has that name.
      if (/^[0-9a-f-]{36}$/.test(path) && !existsSync(absolute(path))) return artefacts.read(path, window);
      const item = await artefacts.snapshot(absolute(path));
      return artefacts.read(item.id, window);
    }, "safe"),
    tool("host_write", `Write text to any file on the owner's machine.
Use it for files outside the workspace, such as config files. It replaces the whole file, or adds to the end with append: true. The folder must already exist. It is not run again after an interruption. For edits to existing files, edit is safer because it changes only the matched text.
Example: await tools.host_write({ path: "/etc/motd", content: "Welcome\\n" })`, {
      path: Type.String({ description: 'File path, absolute or relative to the workspace.' }),
      content: Type.String({ description: 'The full text to write, as UTF-8.' }),
      append: Type.Optional(Type.Boolean({ default: false, description: 'true adds content to the end instead of replacing the file.' })),
    }, Type.Object({
      path: Type.String({ description: 'Absolute path written.' }),
      bytes: Type.Integer({ description: 'Bytes written.' }),
    }), async ({ path, content, append }) => {
      await writeFile(absolute(path), content, { flag: append ? "a" : "w" });
      return { path: absolute(path), bytes: Buffer.byteLength(content) };
    }),
    tool("artefact_read", `Read the next part of a long output, by its saved-output id.
Use it whenever you have a saved-output id (a UUID like 3f2b9c1e-...) rather than a file path: host_exec, host_read and other tools return one when they cut their text short (truncated: true). Pass nextOffset from the last result as offset to keep reading. Saved outputs are kept after a restart.
Example: await tools.artefact_read({ id: "3f2b9c1e-8a4d-4f6e-9b1a-2c7d5e8f0a13", offset: 4096 })`, {
      id: Type.String({ description: 'Saved-output id from an earlier result, e.g. stdout.id.' }),
      ...range,
    }, Slice, ({ id, ...window }) => artefacts.read(id, window), "safe"),
    tool("artefact_search", `Find text in a saved output by its id.
Use it to jump to the interesting part of a long log or file instead of reading it all, then artefact_read at a match's offset for context. Matches exact text, case-sensitive. Returns up to 50 matches with their byte offsets and the text around them.
Example: await tools.artefact_search({ id: "3f2b9c1e-8a4d-4f6e-9b1a-2c7d5e8f0a13", query: "Error" })`, {
      id: Type.String({ description: 'Saved-output id from an earlier result.' }),
      query: Type.String({ description: 'Exact text to find, e.g. "FAIL" or "Error:".' }),
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0, description: 'Byte position to start searching from; use nextOffset to continue.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20, description: 'Most matches to return, up to 50.' })),
    }, Type.Object({
      id: Type.String({ description: 'The saved-output id searched.' }),
      matches: Type.Array(Type.Object({
        offset: Type.Integer({ description: 'Byte position of the match. Pass it to artefact_read.' }),
        text: Type.String({ description: 'The match with about 80 bytes either side.' }),
      })),
      nextOffset: Type.Integer({ description: 'Pass as offset to find more matches.' }),
    }), ({ id, ...query }) => artefacts.search(id, query), "safe"),
  ];
  return { extension: defineExtension({ name: "vm-control", tools }), artefacts };
}
