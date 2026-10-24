// Pure audio helpers for voice input (lib/pi/voice.ts). No browser or host imports, so the
// unit tests can load this file directly.

export const VOICE_RATE = 16000;

const toInt16 = (value: number) => {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
};

/**
 * A converter for one recording: float samples at `from` Hz in, 16-bit PCM at 16 kHz out (linear
 * interpolation, clamped), one block at a time. The microphone arrives in small blocks (128
 * samples from an AudioWorklet), so it keeps the fractional read position and the last sample of
 * each block for the next one: the blocks come out exactly as if the whole recording were
 * converted at once, with no samples dropped at the joins.
 */
export function createResampler(from: number): (samples: Float32Array) => Int16Array {
  const ratio = from / VOICE_RATE;
  // Where the next output sample falls, in input samples from the start of the next block. It is
  // always above -1: a negative value falls between the previous block's last sample and this one.
  let position = 0;
  let previous = 0;
  return (samples) => {
    const length = samples.length;
    if (!length) return new Int16Array(0);
    const at = (index: number) => (index < 0 ? previous : (samples[Math.min(index, length - 1)] ?? 0));
    const count = position > length - 1 ? 0 : Math.floor((length - 1 - position) / ratio) + 1;
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const x = position + i * ratio;
      const j = Math.floor(x);
      const f = x - j;
      out[i] = toInt16(at(j) * (1 - f) + at(j + 1) * f);
    }
    position += count * ratio - length;
    previous = samples[length - 1] ?? 0;
    return out;
  };
}

/** One whole buffer of float samples at `from` Hz to 16-bit PCM at 16 kHz. */
export function toPcm16(samples: Float32Array, from: number): Int16Array {
  return createResampler(from)(samples);
}

/** Base64 of the bytes of an Int16Array, without building a giant string at once. */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
