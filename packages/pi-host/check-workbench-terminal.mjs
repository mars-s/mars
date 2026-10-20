import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRing } from "./workbench/terminal.mjs";
import { startHost } from "./workbench/test-host.mjs";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (text) => Buffer.from(text).toString("base64");
const alive = async (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The ring keeps the newest bytes with absolute offsets and flags a reader that fell behind.
const ring = createRing(8);
ring.push(Buffer.from("abcdef"));
assert.deepEqual({ ...ring.since(2), data: ring.since(2).data.toString() }, { data: "cdef", offset: 6, dropped: false });
ring.push(Buffer.from("ghijkl"));
assert.deepEqual({ ...ring.since(0), data: ring.since(0).data.toString() }, { data: "efghijkl", offset: 12, dropped: true });
assert.equal(ring.since(12).data.length, 0);

const host = await startHost({ MARS_TERMINAL_IDLE_MS: "1500", SHELL: "/bin/sh" });
const api = (path, options) => host.request("/api/workbench/" + path, options);
const created = [];
async function open(size = { cols: 100, rows: 30 }) {
  const reply = await api("terminal", { method: "POST", body: size });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  assert.match(reply.json.id, /^[a-f0-9]{24}$/);
  created.push(reply.json.id);
  return reply.json.id;
}
const send = (id, text) => api(`terminal/${id}/input`, { method: "POST", body: { data: b64(text) } });
/** Long-polls until `pattern` appears in the output after `since`; returns the text and next offset. */
async function until(id, pattern, since = 0, limit = 15000) {
  let text = "";
  let offset = since;
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const reply = await api(`terminal/${id}?since=${offset}`);
    assert.equal(reply.status, 200, JSON.stringify(reply.json));
    text += Buffer.from(reply.json.data, "base64").toString();
    offset = reply.json.offset;
    if (pattern.test(text)) return { text, offset, reply: reply.json };
    if (reply.json.exited) break;
  }
  assert.fail(`expected ${pattern} in terminal output, got ${JSON.stringify(text.slice(-400))}`);
}

try {
  for (const [path, method] of [["terminal", "POST"], ["terminals", "GET"], ["terminal/" + "a".repeat(24), "GET"], ["terminal/" + "a".repeat(24) + "/input", "POST"]])
    assert.equal((await api(path, { method, body: method === "POST" ? {} : undefined, auth: false })).status, 401, `${method} ${path} needs owner auth`);
  assert.equal((await api("terminal", { method: "POST", body: {}, headers: { origin: "https://evil.test" } })).status, 403, "cross-origin create rejected");
  const caps = await api("capabilities");
  assert.deepEqual(caps.json.tools.terminal, { available: true }, "terminal reports available when python3 has pty");

  const id = await open();
  // macOS /bin/sh is bash, which would treat "!" in "$!" as history expansion.
  const first = await send(id, "set +H 2>/dev/null; echo mars-$((6*7))\n");
  assert.equal(first.status, 200);
  let seen = await until(id, /mars-42/);
  assert.ok(!seen.text.includes("MARS_PTY"), "bridge-only environment does not leak into the shell");

  await send(id, "pwd; stty size; printf 'env:%s:%s\\n' \"$TERM\" \"${MARS_PI_ROOT:-unset}\"; echo step-$((1+1))\n");
  seen = await until(id, /step-2/, seen.offset);
  assert.match(seen.text, /30 100/, "initial size reaches the pty");
  assert.match(seen.text, /env:xterm-256color:unset/, "env is limited to the documented variables");
  const realWork = (await run("python3", ["-c", "import os,sys;print(os.path.realpath(sys.argv[1]))", host.work])).stdout.trim();
  assert.ok(seen.text.includes(realWork) || seen.text.includes(host.work), "shell starts in the workspace");

  const resized = await api(`terminal/${id}/resize`, { method: "POST", body: { cols: 132, rows: 41 } });
  assert.deepEqual(resized.json, { cols: 132, rows: 41 });
  await send(id, "stty size\n");
  seen = await until(id, /41 132/, seen.offset);
  const clamped = await api(`terminal/${id}/resize`, { method: "POST", body: { cols: 9999, rows: 1 } });
  assert.deepEqual(clamped.json, { cols: 400, rows: 5 }, "resize is clamped to 20..400 by 5..200");
  await send(id, "stty size\n");
  seen = await until(id, /5 400/, seen.offset);

  // An idle long poll returns empty at its deadline rather than hanging; quick check with a later write.
  const waiting = api(`terminal/${id}?since=${seen.offset}`);
  await sleep(300);
  await send(id, "echo woke\n");
  const woke = await waiting;
  assert.equal(woke.status, 200);
  assert.ok(woke.json.offset > seen.offset, "a waiting poll wakes on new output");

  // Ring buffer: write more than 256 KiB, then read from zero.
  await send(id, "head -c 400000 /dev/zero | tr '\\0' x; echo; echo ring-$((2+3))\n");
  seen = await until(id, /ring-5/, seen.offset, 30000);
  const fromZero = await api(`terminal/${id}?since=0`);
  assert.equal(fromZero.json.dropped, true, "a since older than the buffer is marked dropped");
  assert.ok(Buffer.from(fromZero.json.data, "base64").length <= 256 * 1024, "at most 256 KiB retained");
  assert.ok(fromZero.json.offset > 256 * 1024, "offsets are absolute byte counts");
  const current = await api(`terminal/${id}?since=${fromZero.json.offset - 4}`);
  assert.equal(current.json.dropped, undefined);
  assert.equal(Buffer.from(current.json.data, "base64").length, 4, "since returns only bytes after the offset");

  // Input limits and validation.
  const big = await api(`terminal/${id}/input`, { method: "POST", body: { data: Buffer.alloc(64 * 1024 + 1, 97).toString("base64") } });
  assert.equal(big.status, 413, "input over 64 KiB rejected");
  await send(id, "stty raw -echo; head -c 65536 | wc -c | tr -d ' ' | sed 's/^/got-/'; stty sane\n");
  await sleep(300);
  const exact = await api(`terminal/${id}/input`, { method: "POST", body: { data: Buffer.alloc(64 * 1024, 35).toString("base64") } });
  assert.equal(exact.status, 200, "64 KiB of input accepted");
  seen = await until(id, /got-65536/, seen.offset);
  assert.equal((await api(`terminal/${id}/input`, { method: "POST", body: { data: "not base64!" } })).status, 400);
  assert.equal((await api(`terminal/${id}?since=-1`)).status, 400);
  assert.equal((await api("terminal/../../etc?since=0")).status, 404, "unknown ids are not found");
  assert.equal((await api("terminal/" + "b".repeat(24) + "?since=0")).status, 404);

  // Kill ends the whole process group, including a background job that ignores SIGHUP.
  await send(id, "(trap '' HUP; exec sleep 600) & echo bg=$!; sleep 700 & echo fg=$!\n");
  seen = await until(id, /fg=\d+\r?\n/, seen.offset);
  const pids = [...seen.text.matchAll(/(?:bg|fg)=(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.ok(await alive(pid), "children running before kill");
  const killed = await api(`terminal/${id}/kill`, { method: "POST", body: {} });
  assert.equal(killed.status, 200);
  assert.equal(killed.json.exited, true);
  await sleep(300);
  for (const pid of pids) assert.equal(await alive(pid), false, `process ${pid} ended with the session`);
  const after = await api(`terminal/${id}?since=0`);
  assert.equal(after.json.exited, true);
  assert.equal(typeof after.json.exitCode, "number");
  assert.equal((await send(id, "echo late\n")).status, 409, "input to an ended session is refused");

  // A shell exiting by itself reports its code.
  const quitter = await open();
  await send(quitter, "exit 7\n");
  const exitReply = await until(quitter, /[\s\S]*/, 0);
  let status = exitReply.reply;
  for (let n = 0; n < 50 && !status.exited; n++) status = (await api(`terminal/${quitter}?since=${status.offset}`)).json;
  assert.equal(status.exited, true);
  assert.equal(status.exitCode, 7, "exit code reaches the client");

  // Max four live sessions.
  const extra = [await open(), await open(), await open(), await open()];
  const fifth = await api("terminal", { method: "POST", body: { cols: 80, rows: 24 } });
  assert.equal(fifth.status, 429, "a fifth live session is refused");
  const list = await api("terminals");
  assert.equal(list.json.sessions.filter((session) => !session.exited).length, 4);
  for (const session of list.json.sessions) for (const key of ["id", "created", "lastActive", "exited"]) assert.ok(key in session, `sessions list ${key}`);
  await api(`terminal/${extra[0]}/kill`, { method: "POST", body: {} });
  const replacement = await open();

  // Idle timeout (1.5 s here): sessions nobody polls are ended.
  const idle = replacement;
  await send(idle, "sleep 900 & echo idle=$!\n");
  const idlePid = Number((await until(idle, /idle=\d+\r?\n/)).text.match(/idle=(\d+)/)[1]);
  await sleep(3500);
  const idleList = await api("terminals");
  const idleRow = idleList.json.sessions.find((session) => session.id === idle);
  assert.ok(!idleRow || idleRow.exited, "idle session ended");
  assert.equal(await alive(idlePid), false, "idle session's processes ended");

  // Input is never logged.
  const marker = "secret-input-" + Date.now();
  const logged = await open();
  await send(logged, `# ${marker}\n`);
  await until(logged, new RegExp(marker));
  assert.ok(!host.log().includes(marker), "host log does not contain terminal input");
  const files = await run("grep", ["-rl", marker, host.root]).then((r) => r.stdout, () => "");
  assert.equal(files, "", "no file under the data root contains terminal input");
} finally {
  for (const id of created) await api(`terminal/${id}/kill`, { method: "POST", body: {} }).catch(() => {});
  await host.stop();
}
console.log("PASS workbench terminal: owner auth, origin check, create, echo round trip, env and cwd, initial size and resize via stty, clamping, long-poll wake, 256 KiB ring with offsets and dropped, 64 KiB input cap, kill ends the group incl. HUP-ignoring jobs, exit code, max 4 sessions, idle timeout, input not logged");
