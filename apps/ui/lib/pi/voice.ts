"use client";

import { piRequest, record } from "@/lib/pi/live-state";

/*
 * Voice input for the composer (docs/VOICE.md). The microphone is read in the browser, turned
 * into 16 kHz mono 16-bit PCM, and sent to the host in small JSON chunks; the host relays it to
 * Claude's speech-to-text with the owner's Claude sign-in and returns the transcript by long
 * polling. Nothing here holds a token.
 */

import { VOICE_RATE, pcmToBase64, toPcm16 } from "@/lib/pi/pcm";

export { VOICE_RATE };
const SEND_EVERY_MS = 200;
type VoiceView = { id: string; seq: number; text: string; done: boolean; error?: string };
function parseView(value: unknown): VoiceView {
  const data = record(value);
  return {
    id: typeof data.id === "string" ? data.id : "",
    seq: typeof data.seq === "number" ? data.seq : 0,
    text: typeof data.text === "string" ? data.text : "",
    done: data.done === true,
    ...(typeof data.error === "string" && data.error ? { error: data.error } : {}),
  };
}

// The capture node: an AudioWorklet that forwards raw mono frames to the main thread.
const WORKLET = `registerProcessor("mars-voice", class extends AudioWorkletProcessor {
  process(inputs) { const input = inputs[0]; if (input && input[0]) this.port.postMessage(input[0].slice(0)); return true; }
});`;

export type VoiceCallbacks = { onText: (text: string) => void; onError: (message: string) => void };

/** One recording. start() asks for the microphone; stop() returns the final transcript. */
export class VoiceRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private id = "";
  private seq = -1;
  private pending: Int16Array[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  private text = "";
  private sending: Promise<unknown> = Promise.resolve();
  constructor(private readonly callbacks: VoiceCallbacks, private readonly language = "en") {}

  async start() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("This browser cannot record audio here. Voice input needs HTTPS and microphone access.");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
      const view = parseView(await piRequest("/api/voice", { language: this.language }));
      this.id = view.id;
      this.seq = view.seq;
    } catch (failure) {
      this.release();
      throw failure;
    }
    this.context = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "mars-voice");
    const rate = this.context.sampleRate;
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (!this.stopped) this.pending.push(toPcm16(event.data, rate));
    };
    source.connect(this.node);
    this.timer = setInterval(() => this.flush(), SEND_EVERY_MS);
    void this.poll();
  }

  private flush() {
    if (!this.pending.length || !this.id) return this.sending;
    const length = this.pending.reduce((sum, chunk) => sum + chunk.length, 0);
    const joined = new Int16Array(length);
    let offset = 0;
    for (const chunk of this.pending) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    const audio = pcmToBase64(joined);
    // Chunks go in order: each send waits for the one before.
    this.sending = this.sending.then(() => piRequest(`/api/voice/${this.id}/audio`, { audio })).catch(() => undefined);
    return this.sending;
  }

  private async poll() {
    this.polling = true;
    while (this.polling) {
      try {
        const view = parseView(await piRequest(`/api/voice/${this.id}?since=${this.seq}&wait=8000`));
        this.seq = view.seq;
        if (view.text !== this.text) {
          this.text = view.text;
          this.callbacks.onText(view.text);
        }
        if (view.error && view.error !== "Cancelled.") this.callbacks.onError(view.error);
        if (view.done) break;
      } catch (failure) {
        if (!this.polling) break;
        this.callbacks.onError(failure instanceof Error ? failure.message : "Voice input stopped.");
        break;
      }
    }
    this.polling = false;
  }

  /** Send what is left, wait for the last words, and return the whole transcript. */
  async stop(): Promise<string> {
    if (this.stopped) return this.text;
    this.stopped = true;
    clearInterval(this.timer);
    this.release();
    await this.flush();
    if (!this.id) return this.text;
    const view = parseView(await piRequest(`/api/voice/${this.id}/stop`, {}));
    this.polling = false;
    if (view.text) this.text = view.text;
    return this.text;
  }

  async cancel() {
    this.stopped = true;
    this.polling = false;
    clearInterval(this.timer);
    this.release();
    if (this.id) await piRequest(`/api/voice/${this.id}/cancel`, {}).catch(() => undefined);
  }

  private release() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close().catch(() => undefined);
    this.node = undefined;
    this.stream = undefined;
    this.context = undefined;
  }
}
