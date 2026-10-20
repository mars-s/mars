import assert from "node:assert/strict";
import test from "node:test";
import {
  backoff,
  base64ToBytes,
  bytesToBase64,
  connect,
  HostError,
  INPUT_CHUNK,
} from "../components/workbench/terminal-link.ts";
import { parseTerminalChunk, parseTerminalCreated } from "../lib/pi/workbench.ts";

const b64 = (text) => Buffer.from(text).toString("base64");
const text = (bytes) => Buffer.from(bytes).toString();
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A scripted host: each poll takes the next reply (or throws it), recording `since`. */
function fakeHost(replies) {
  const polls = [];
  const inputs = [];
  const resizes = [];
  let pending;
  return {
    polls,
    inputs,
    resizes,
    transport: {
      async poll(id, since, signal) {
        polls.push(since);
        const next = replies.shift();
        if (next === undefined)
          return new Promise((_, reject) => {
            pending = reject;
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        if (next instanceof Error) throw next;
        return parseTerminalChunk(next);
      },
      async input(id, data) {
        const reply = inputs.length < (this.busy ?? 0) ? new HostError("busy", 429) : undefined;
        inputs.push(Buffer.from(data, "base64"));
        if (reply) throw reply;
      },
      async resize(id, cols, rows) {
        resizes.push([cols, rows]);
      },
    },
    get pending() {
      return pending;
    },
  };
}

test("base64 helpers round-trip arbitrary bytes, including large input", () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  assert.equal(bytesToBase64(new TextEncoder().encode("é")), Buffer.from("é").toString("base64"));
});

test("backoff doubles from 0.5 s and caps at 10 s", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(backoff), [500, 1000, 2000, 4000, 8000, 10000, 10000]);
});

test("parsers keep only a real session id and coerce chunk fields", () => {
  assert.equal(parseTerminalCreated({ id: "a1".repeat(12) }), "a1".repeat(12));
  assert.equal(parseTerminalCreated({ id: "../etc" }), "");
  assert.equal(parseTerminalCreated(null), "");
  assert.deepEqual(parseTerminalChunk({ offset: 9, data: "aGk=", exited: true, exitCode: 2, dropped: true }), {
    offset: 9,
    data: "aGk=",
    exited: true,
    exitCode: 2,
    dropped: true,
  });
});

test("polls from byte 0, advances by the host offset, and ends with the exit code", async () => {
  const host = fakeHost([
    { offset: 3, data: b64("one") },
    { offset: 3, data: "" },
    { offset: 300_000, data: b64("tail"), dropped: true },
    { offset: 300_004, data: b64("!!!!"), exited: true, exitCode: 3 },
  ]);
  const output = [];
  const states = [];
  connect({ id: "s", transport: host.transport, onOutput: (bytes, dropped) => output.push([text(bytes), dropped]), onState: (s) => states.push(s) });
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(host.polls, [0, 3, 3, 300_000], "each poll resumes at the previous offset");
  assert.deepEqual(output, [["one", false], ["tail", true], ["!!!!", false]], "an empty reply writes nothing; dropped is passed on");
  assert.deepEqual(states, [{ kind: "connecting" }, { kind: "live" }, { kind: "ended", exitCode: 3 }]);
});

test("network failures back off and report Reconnecting; a missing session stops the loop", async () => {
  const sleeps = [];
  const host = fakeHost([new Error("offline"), new Error("offline"), { offset: 2, data: b64("ok") }, new HostError("Terminal session not found", 404)]);
  const states = [];
  connect({
    id: "s",
    transport: host.transport,
    onOutput: () => {},
    onState: (s) => states.push(s),
    sleep: async (ms) => void sleeps.push(ms),
  });
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(sleeps, [500, 1000]);
  assert.deepEqual(host.polls, [0, 0, 0, 2], "retries keep the same offset so no output is lost");
  assert.deepEqual(states, [{ kind: "connecting" }, { kind: "reconnecting", message: "offline" }, { kind: "live" }, { kind: "missing" }]);
});

test("input is sent in order, split under the host's 64 KiB cap, and retried when the host is busy", async () => {
  const host = fakeHost([]);
  host.transport.busy = 1;
  const link = connect({ id: "s", transport: host.transport, onOutput: () => {}, onState: () => {}, sleep: async () => {} });
  const big = new Uint8Array(INPUT_CHUNK * 2 + 10).fill(120);
  link.send(new TextEncoder().encode("ls\r"));
  link.send(big);
  for (let i = 0; i < 20; i++) await tick();
  assert.ok(host.inputs.every((chunk) => chunk.length <= 64 * 1024), "every request fits the cap");
  assert.equal(host.inputs[0].toString(), "ls\r");
  assert.ok(host.inputs[1].subarray(0, 3).equals(host.inputs[0]), "the refused bytes are resent before anything queued after them");
  const delivered = Buffer.concat(host.inputs.slice(1));
  assert.equal(delivered.length, 3 + big.length, "every byte is delivered once after the retry");
  assert.equal(delivered.subarray(0, 3).toString(), "ls\r", "order is kept");
  link.close();
});

test("resizes are debounced to the last size, and close stops polling and sending", async () => {
  const host = fakeHost([]);
  const link = connect({ id: "s", transport: host.transport, onOutput: () => {}, onState: () => {} });
  link.resize(80, 24);
  link.resize(100, 30);
  link.resize(132, 41);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(host.resizes, [[132, 41]]);
  link.close();
  link.send(new Uint8Array([1]));
  await tick();
  assert.equal(host.inputs.length, 0, "a closed link sends nothing");
  assert.equal(host.polls.length, 1);
});
