import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { createVmControl } from "./vm-control.mjs";

const directory = await mkdtemp(join(tmpdir(), "mars-vm-control-"));
const control = createVmControl({ root: directory, cwd: directory });
const tools = new Map(control.extension.tools.map((tool) => [tool.name, tool]));
const run = async (name, args, context = BACKGROUND_CONTEXT) => (await tools.get(name).execute(args, {}, context)).structuredOutput;
const passed = [];
async function check(name, fn) { await fn(); passed.push(name); }
const server = http.createServer((_request, response) => response.end("network-proof"));
try {
  await check("native registry and deferred replay policies", async () => {
    createRegistry().install(control.extension);
    assert.ok([...tools.values()].every((tool) => tool.deferred));
    assert.equal(tools.get("host_exec").replay, "unsafe");
    assert.equal(tools.get("host_write").replay, "unsafe");
    assert.equal(tools.get("artefact_read").replay, "safe");
  });
  await check("absolute arbitrary file write and immutable snapshot", async () => {
    const path = join(directory, "absolute.txt");
    await run("host_write", { path, content: "original" });
    const result = await run("host_read", { path });
    await writeFile(path, "changed");
    assert.equal((await run("artefact_read", { id: result.id })).text, "original");
    const restarted = createVmControl({ root: directory, cwd: directory });
    assert.equal((await restarted.artefacts.read(result.id)).text, "original");
    await assert.rejects(control.artefacts.read("../absolute.txt"), /Invalid/);
  });
  await check("real sudo root and ordinary shell failure", async () => {
    const root = await run("host_exec", { command: "sudo -n id -u" });
    assert.equal(root.exitCode, 0);
    assert.equal(root.stdout.text.trim(), "0");
    const failure = await run("host_exec", { command: "printf failure >&2; exit 7" });
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.stderr.text, "failure");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await check("real network from shell", async () => {
    const result = await run("host_exec", { command: `curl --fail --silent http://127.0.0.1:${server.address().port}` });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.text, "network-proof");
  });
  await check("large output bounded with persistent range and lexical retrieval", async () => {
    const result = await run("host_exec", { command: "python3 -c 'print(\"x\" * 200000 + \"needle\")'" });
    assert.equal(result.stdout.bytes, 200007);
    assert.ok(JSON.stringify(result).length < 10000);
    assert.equal(result.stdout.truncated, true);
    const found = await run("artefact_search", { id: result.stdout.id, query: "needle" });
    assert.equal(found.matches[0].offset, 200000);
    assert.equal((await run("artefact_read", { id: result.stdout.id, offset: 200000 })).text, "needle\n");
    await assert.rejects(run("artefact_read", { id: result.stdout.id, limit: 200000 }), /Invalid/);
  });
  await check("native Context abort kills shell process group including TERM-ignoring child", async () => {
    const pidFile = join(directory, "child.pid");
    const marker = join(directory, "escaped");
    const abort = new AbortController();
    const command = `python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); open("${pidFile}","w").write(str(os.getpid())); time.sleep(2); open("${marker}","w").write("leaked")' & wait`;
    const pending = run("host_exec", { command }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
    for (let attempt = 0; ; attempt++) {
      try { await access(pidFile); break; } catch { assert.ok(attempt < 100, "child started"); await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    abort.abort();
    const result = await pending;
    assert.equal(result.cancelled, true);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    await assert.rejects(access(marker), { code: "ENOENT" });
    const pid = Number(await readFile(pidFile, "utf8"));
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      assert.match(status, /State:\s+Z/, "child stopped; zombie awaits host reaper");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  });
  await check("timeout stops process and pre-abort never runs command", async () => {
    const result = await run("host_exec", { command: "sleep 30", timeoutMs: 50 });
    assert.equal(result.timedOut, true);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(run("host_exec", { command: "touch should-not-exist" }, withAbortSignal(abort.signal, BACKGROUND_CONTEXT)));
    await assert.rejects(access(join(directory, "should-not-exist")), { code: "ENOENT" });
  });
  console.log(JSON.stringify({ status: "PASS", checks: passed }, null, 2));
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}
