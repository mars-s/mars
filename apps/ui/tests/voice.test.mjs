import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_RATE, pcmToBase64, toPcm16 } from "../lib/pi/pcm.ts";

test("microphone samples become 16 kHz 16-bit PCM", () => {
  assert.equal(VOICE_RATE, 16000);
  const same = toPcm16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]), 16000);
  assert.deepEqual([...same], [0, 16383, -16384, 32767, -32768, 32767, -32768], "scaled and clamped");
  // 48 kHz to 16 kHz keeps every third sample's position; a 1 kHz sine keeps its shape.
  const rate = 48000;
  const sine = Float32Array.from({ length: rate / 10 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / rate));
  const down = toPcm16(sine, rate);
  assert.equal(down.length, 1600);
  for (let i = 0; i < down.length; i++) assert.ok(Math.abs(down[i] / 32767 - Math.sin((2 * Math.PI * 1000 * i) / 16000)) < 0.01);
  // 44.1 kHz gives the right length.
  assert.equal(toPcm16(new Float32Array(44100), 44100).length, 16000);
});

test("PCM is sent as little-endian base64", () => {
  const encoded = pcmToBase64(Int16Array.from([1, -1, 256]));
  assert.deepEqual([...Buffer.from(encoded, "base64")], [1, 0, 255, 255, 0, 1]);
  const big = new Int16Array(100000).fill(7);
  assert.equal(Buffer.from(pcmToBase64(big), "base64").length, 200000, "large chunks encode without overflowing the stack");
});
