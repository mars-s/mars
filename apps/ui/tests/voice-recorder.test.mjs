// The voice recorder (lib/pi/voice.ts) with a fake microphone, Web Audio and host: what is left
// running, and what reaches the composer, when a recording is cancelled part way, when the host
// ends it by itself, and how many samples a recording sends. No browser, no network.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The app's "@/..." imports, as the Next.js build resolves them.
const ui = new URL("../", import.meta.url);
registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier.startsWith("@/") ? new URL(`${specifier.slice(2)}.ts`, ui).href : specifier, context),
});
const { VoiceRecorder } = await import("../lib/pi/voice.ts");
const { toPcm16 } = await import("../lib/pi/pcm.ts");

const ID = "11111111-2222-3333-4444-555555555555";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const later = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
async function until(test, what) {
  for (let i = 0; i < 200 && !test(); i++) await tick();
  assert.ok(test(), `timed out waiting for ${what}`);
}

// Intervals the recorder starts, so a test can see that none is left running.
const intervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, ms, ...rest) => {
  const timer = realSetInterval(callback, ms, ...rest);
  intervals.add(timer);
  return timer;
};
globalThis.clearInterval = (timer) => {
  intervals.delete(timer);
  realClearInterval(timer);
};

/** A fresh fake world: microphone, audio graph and host routes. Gates hold a step until opened. */
function world({ sampleRate = 48000 } = {}) {
  const state = { tracks: [], contexts: [], worklets: [], requests: [], polls: [], cancels: 0, samplesSent: 0, gates: {}, text: [], errors: [], ends: 0 };
  intervals.clear();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          if (state.gates.mic) await state.gates.mic.promise;
          const track = { stopped: false, stop() { this.stopped = true; } };
          state.tracks.push(track);
          return { getTracks: () => [track] };
        },
      },
    },
  });
  globalThis.AudioContext = class {
    constructor() {
      this.sampleRate = sampleRate;
      this.closed = false;
      this.destination = {};
      this.audioWorklet = { addModule: async () => { if (state.gates.module) await state.gates.module.promise; } };
      state.contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; return Promise.resolve(); }
  };
  globalThis.AudioWorkletNode = class {
    constructor() {
      this.port = { onmessage: null };
      this.connected = true;
      state.worklets.push(this);
    }
    disconnect() { this.connected = false; }
  };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (path, init = {}) => {
    const url = String(path);
    state.requests.push(`${init.method ?? "GET"} ${url.split("?")[0]}`);
    if (url === "/api/voice") {
      if (state.gates.start) await state.gates.start.promise;
      return reply({ id: ID, seq: 0, text: "", done: false }, 201);
    }
    if (url.endsWith("/audio")) {
      state.samplesSent += Buffer.from(JSON.parse(init.body).audio, "base64").length / 2;
      return reply({ id: ID, seq: 0, text: "", done: false });
    }
    if (url.endsWith("/stop")) return reply({ id: ID, seq: 9, text: state.finalText ?? "", done: true });
    if (url.endsWith("/cancel")) {
      state.cancels++;
      return reply({ cancelled: true });
    }
    // A long poll: the test answers it with { status, body }.
    const answer = later();
    state.polls.push(answer);
    const { status = 200, body } = await answer.promise;
    return reply(body, status);
  };
  state.recorder = new VoiceRecorder({
    onText: (text) => state.text.push(text),
    onError: (message) => state.errors.push(message),
    onEnd: () => state.ends++,
  });
  state.micOff = () => state.tracks.every((track) => track.stopped);
  state.nothingRunning = () => state.micOff() && state.contexts.every((context) => context.closed) && intervals.size === 0;
  return state;
}

test("words that arrive after Escape do not reach the composer", async () => {
  const voice = world();
  await voice.recorder.start();
  await until(() => voice.polls.length === 1, "the first poll");
  await voice.recorder.cancel();
  voice.polls[0].resolve({ body: { id: ID, seq: 1, text: "words arriving after Escape", done: false } });
  await tick();
  assert.deepEqual(voice.text, [], "nothing is written back after cancel");
  assert.equal(voice.cancels, 1);
  assert.equal(voice.polls.length, 1, "no further polls");
  assert.ok(voice.nothingRunning());
});

test("cancelling while the browser asks for the microphone leaves nothing running", async () => {
  const voice = world();
  voice.gates.mic = later();
  const starting = voice.recorder.start();
  await tick();
  await voice.recorder.cancel();
  voice.gates.mic.resolve();
  await starting;
  await tick();
  assert.equal(voice.tracks.length, 1);
  assert.ok(voice.micOff(), "the microphone granted after cancel is turned off");
  assert.equal(voice.contexts.length, 0, "no audio graph");
  assert.equal(intervals.size, 0, "no send timer");
  assert.deepEqual(voice.requests, [], "the host is not asked to start");
});

test("cancelling while the host starts the stream cancels that stream", async () => {
  const voice = world();
  voice.gates.start = later();
  const starting = voice.recorder.start();
  await until(() => voice.requests.includes("POST /api/voice"), "the start request");
  await voice.recorder.cancel();
  assert.ok(voice.micOff(), "the microphone goes off at once");
  voice.gates.start.resolve();
  await starting;
  await tick();
  assert.equal(voice.cancels, 1, "the stream the host opened is cancelled");
  assert.equal(voice.contexts.length, 0, "no audio graph");
  assert.equal(intervals.size, 0, "no send timer");
  assert.equal(voice.polls.length, 0, "no polling");
});

test("cancelling while the audio worklet loads leaves nothing running", async () => {
  const voice = world();
  voice.gates.module = later();
  const starting = voice.recorder.start();
  await until(() => voice.contexts.length === 1, "the audio graph");
  await voice.recorder.cancel();
  voice.gates.module.resolve();
  await starting;
  await tick();
  assert.ok(voice.nothingRunning(), "microphone off, audio closed, no timer");
  assert.equal(voice.worklets.length, 0, "no capture node");
  assert.equal(voice.polls.length, 0, "no polling");
  assert.equal(voice.cancels, 1, "the host stream is cancelled once");
});

test("when the host ends the recording, the microphone stops and the button is told", async () => {
  const voice = world();
  await voice.recorder.start();
  await until(() => voice.polls.length === 1, "the first poll");
  const message = "Recording stopped: it was idle or longer than five minutes.";
  voice.polls[0].resolve({ body: { id: ID, seq: 3, text: "the words so far", done: true, error: message } });
  await until(() => voice.ends === 1, "the end");
  assert.deepEqual(voice.text, ["the words so far"], "the final words are kept");
  assert.deepEqual(voice.errors, [message]);
  assert.ok(voice.nothingRunning(), "microphone off, audio closed, no send timer");
  assert.ok(voice.worklets.every((node) => !node.connected));
  await tick();
  assert.equal(voice.polls.length, 1, "no further polls");
  assert.equal(await voice.recorder.stop(), "the words so far", "a late stop returns the words without asking the host");
  assert.ok(!voice.requests.some((request) => request.endsWith("/stop")));
});

test("when the transcript cannot be read, the microphone stops and the host stream is freed", async () => {
  const voice = world();
  await voice.recorder.start();
  await until(() => voice.polls.length === 1, "the first poll");
  voice.polls[0].resolve({ status: 404, body: { error: "That voice session has ended. Start recording again." } });
  await until(() => voice.ends === 1, "the end");
  assert.deepEqual(voice.errors, ["That voice session has ended. Start recording again."]);
  assert.ok(voice.nothingRunning(), "microphone off, audio closed, no send timer");
  await tick();
  assert.equal(voice.cancels, 1, "the host is told to let the stream go");
});

test("a cancelled host stream ends quietly", async () => {
  const voice = world();
  await voice.recorder.start();
  await until(() => voice.polls.length === 1, "the first poll");
  voice.polls[0].resolve({ body: { id: ID, seq: 1, text: "", done: true, error: "Cancelled." } });
  await until(() => voice.ends === 1, "the end");
  assert.deepEqual(voice.errors, [], "no error for a cancel");
  assert.ok(voice.nothingRunning());
});

test("a recording sends every sample, block after block", async () => {
  for (const rate of [48000, 44100]) {
    const voice = world({ sampleRate: rate });
    await voice.recorder.start();
    // One second of microphone input in the 128-sample blocks an AudioWorklet sends.
    const blocks = Math.floor(rate / 128);
    for (let i = 0; i < blocks; i++) voice.worklets[0].port.onmessage({ data: new Float32Array(128).fill(0.25) });
    voice.finalText = "done";
    assert.equal(await voice.recorder.stop(), "done");
    assert.equal(voice.samplesSent, toPcm16(new Float32Array(blocks * 128), rate).length, `${rate} Hz keeps its length at 16 kHz`);
    assert.ok(Math.abs(voice.samplesSent - (blocks * 128 * 16000) / rate) <= 1);
    voice.polls.forEach((poll) => poll.resolve({ body: { id: ID, seq: 9, text: "done", done: true } }));
    await tick();
    assert.ok(voice.nothingRunning());
  }
});
