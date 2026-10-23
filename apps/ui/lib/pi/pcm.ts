// Pure audio helpers for voice input (lib/pi/voice.ts). No browser or host imports, so the
// unit tests can load this file directly.

export const VOICE_RATE = 16000;

/** Float samples at `from` Hz to 16-bit PCM at 16 kHz (linear interpolation, clamped). */
export function toPcm16(samples: Float32Array, from: number): Int16Array {
  const ratio = from / VOICE_RATE;
  const length = Math.floor(samples.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    const value = (samples[j] ?? 0) * (1 - f) + (samples[j + 1] ?? samples[j] ?? 0) * f;
    const clamped = Math.max(-1, Math.min(1, value));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/** Base64 of the bytes of an Int16Array, without building a giant string at once. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
