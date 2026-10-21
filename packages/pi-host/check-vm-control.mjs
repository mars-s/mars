import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { createVmControl } from "./vm-control.mjs";
import { redactFile } from "./secrets.mjs";
import { destructiveReason } from "./shell-guard.mjs";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

// Fake host secrets, before the control reads them.
const OWNER = "owner-token-" + "a".repeat(30);
const ENV_SECRET = "env-secret-" + "b".repeat(30);
process.env.MARS_PI_TOKEN = OWNER;
process.env.CHECK_SERVICE_API_KEY = ENV_SECRET;
process.env.CHECK_SHORT_TOKEN = "short";

const directory = await mkdtemp(join(tmpdir(), "mars-vm-control-"));
const WEB = "web-token-" + "c".repeat(40);
const ACCESS = "oauth-access-" + "d".repeat(60);
const DISCORD = "discord-bot-" + "e".repeat(50);
await writeFile(join(directory, "web-token"), WEB + "\n");
await writeFile(join(directory, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: ACCESS, refresh: "refresh-" + "f".repeat(30), clientId: "public-client-id-1234" } }));
await writeFile(join(directory, "connections.json"), JSON.stringify({ version: 1, guildId: "123456789012345678", discordToken: DISCORD, openCodeApiKey: null }));
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
  await check("host_exec finds the host's pinned Node first", async () => {
    const result = await run("host_exec", { command: "node -v; cd /tmp && node -v" });
    assert.equal(result.stdout.text, process.version + "\n" + process.version + "\n");
    const chosen = await run("host_exec", { command: "export PATH=/usr/bin:/bin; command -v node || echo none" });
    assert.ok(!chosen.stdout.text.startsWith(process.execPath.replace(/\/node$/, "")), "a command that sets PATH wins");
  });
  await check("host secrets never reach output or saved artefacts", async () => {
    const all = [OWNER, ENV_SECRET, WEB, ACCESS, DISCORD, "refresh-" + "f".repeat(30)];
    const env = await run("host_exec", { command: "env; echo $MARS_PI_TOKEN >&2; cat web-token auth.json connections.json" });
    const saved = (await readFile(control.artefacts.path(env.stdout.id), "utf8")) + await readFile(control.artefacts.path(env.stderr.id), "utf8");
    for (const secret of all) assert.ok(!saved.includes(secret) && !JSON.stringify(env).includes(secret), "hidden");
    assert.match(saved, /MARS_PI_TOKEN=\[redacted\]/);
    assert.match(saved, /CHECK_SHORT_TOKEN=short/);
    assert.match(saved, /public-client-id-1234/);
    // Split across two writes with a pause, and buried in large output past the first chunk.
    const split = await run("host_exec", { command: `printf '%s' "${OWNER.slice(0, 15)}"; sleep 0.2; printf '%s\\n' "${OWNER.slice(15)}"; head -c 3000000 /dev/zero | tr '\\0' x; echo "$MARS_PI_TOKEN tail"` });
    const text = await readFile(control.artefacts.path(split.stdout.id), "utf8");
    assert.ok(!text.includes(OWNER));
    assert.ok(text.startsWith("[redacted]\nxxx") && text.endsWith("x[redacted] tail\n"));
    assert.equal(split.stdout.bytes, 10 + 1 + 3000000 + 16);
    const read = await run("host_read", { path: "web-token" });
    assert.equal(read.text, "[redacted]\n");
    // A secret straddling the redactor's own chunk boundary.
    const file = join(directory, "straddle.txt");
    await writeFile(file, "a".repeat(100) + OWNER + "b".repeat(5) + OWNER);
    assert.equal(await redactFile(file, [OWNER], 110), 2);
    assert.equal(await readFile(file, "utf8"), "a".repeat(100) + "[redacted]" + "b".repeat(5) + "[redacted]");
  });
  await check("destructive commands refused, look-alikes allowed", async () => {
    const repo = join(directory, "repo");
    await mkdir(repo);
    execFileSync("bash", ["-c", "git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init && echo x > f && git add f && git -c user.email=a@b -c user.name=a commit -q -m f"], { cwd: repo });
    const home = process.env.HOME;
    const options = { cwd: repo, protectedPaths: [repo, directory] };
    const refused = ["git push --force origin main", "git push -f origin master", "cd /tmp &&  git   push --force-with-lease=main:abc origin main", "git push origin +main", "git push -uf origin HEAD",
      "git reset --hard", "git reset   --hard HEAD~1", "git clean -fdx", "git clean -f -d", "sudo git clean -fX", "git branch -D feature", "git branch --delete --force feature",
      "rm -rf /", "rm -rf ~", "rm -rf $HOME", "rm -rf \"${HOME}/\"", "rm -fr /*", "rm -r -f " + home, "cd ~ && rm -rf .", "cd .. && rm -rf repo", "rm -rf " + repo, "true; rm -rf ~/", "bash -c 'rm -rf ~'", "echo ok && rm  -Rf /home", "(cd / && rm -rf usr/..)"];
    for (const command of refused) assert.ok(destructiveReason(command, options), "refused: " + command);
    const allowed = ["git push origin feature", "git push --force origin feature", "git push origin main", "git reset --soft HEAD~1", "git reset HEAD f", "git clean -n -d", "git clean -f",
      "git branch -d merged", "rm -rf ./build", "rm -rf build node_modules/.cache", "rm -f ~/notes.txt", "echo 'rm -rf /'", "git commit -m \"git reset --hard\"", "cat <<'EOF' > x.sh\ngit reset --hard\nrm -rf ~\nEOF\necho done",
      "git checkout -- .", "git restore .", "git checkout feature"];
    for (const command of allowed) assert.equal(destructiveReason(command, options), null, "allowed: " + command);
    await writeFile(join(repo, "f"), "changed");
    assert.match(destructiveReason("git checkout -- .", options), /uncommitted/);
    assert.match(destructiveReason("cd sub; cd " + repo + " && git restore .", options), /uncommitted/);
    assert.equal(destructiveReason("git restore --staged .", options), null);
    await assert.rejects(run("host_exec", { command: "git reset --hard", cwd: repo }), /Refused: git reset --hard.*allowDestructive: true/s);
    assert.equal(await readFile(join(repo, "f"), "utf8"), "changed");
    const forced = await run("host_exec", { command: "git reset -q --hard && cat f", cwd: repo, allowDestructive: true });
    assert.equal(forced.stdout.text, "x\n");
    await assert.rejects(run("host_exec", { command: "rm -rf " + directory }), /Refused: rm -r/);
  });
  await check("host_view_image returns images and refuses other files", async () => {
    const png = join(directory, "dot.png");
    await sharp({ create: { width: 40, height: 30, channels: 4, background: "#ff0000" } }).png().toFile(png);
    const result = await tools.get("host_view_image").execute({ path: "dot.png" }, {}, BACKGROUND_CONTEXT);
    const block = result.output.find((item) => item.type === "image");
    assert.equal(block.mimeType, "image/png");
    assert.deepEqual(Buffer.from(block.data, "base64"), await readFile(png));
    assert.equal(result.structuredOutput.type, "image");
    assert.equal(result.structuredOutput.width, 40);
    assert.equal(result.structuredOutput.resized, false);
    const big = join(directory, "big.png");
    await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#00ff00" } }).png().toFile(big);
    const shrunk = await run("host_view_image", { path: big });
    assert.equal(shrunk.resized, true);
    assert.equal(shrunk.width, 2000);
    assert.equal(shrunk.mimeType, "image/webp");
    await assert.rejects(run("host_view_image", { path: "web-token" }), /not a PNG, JPEG, GIF or WebP/);
    await assert.rejects(run("host_view_image", { path: directory }), /not a file/);
  });
  console.log(JSON.stringify({ status: "PASS", checks: passed }, null, 2));
} finally {
  server.close();
  await rm(directory, { recursive: true, force: true });
}
