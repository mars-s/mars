"use client";

import { piRequest, record } from "@/lib/pi/live-state";

/*
 * Voice input for the composer (docs/VOICE.md). The microphone is read in the browser, turned
 * into 16 kHz mono 16-bit PCM, and sent to the host in small JSON chunks; the host relays it to
 * Claude's speech-to-text with the owner's Claude sign-in and returns the transcript by long
 * polling. Nothing here holds a token.
 */

import { VOICE_RATE, createResampler, pcmToBase64 } from "@/lib/pi/pcm";

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

// The capture node is a same-origin file (public/voice-worklet.js): the host's Content Security
// Policy allows scripts from 'self' only, so a blob: worklet is refused in production.
const WORKLET_URL = "/voice-worklet.js";

export type VoiceCallbacks = {
  onText: (text: string) => void;
  onError: (message: string) => void;
  /**
   * The recording ended by itself, without stop() or cancel(): the host finished it (its time
   * limit, an idle stream, a lost connection) or the transcript could not be read. The microphone
   * is already off and the words so far have been passed to onText.
   */
  onEnd?: () => void;
};

/** One recording. start() asks for the microphone; stop() returns the final transcript. */
export class VoiceRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode | ScriptProcessorNode;
  private id = "";
  private seq = -1;
  private pending: Int16Array[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopped = false;
  private cancelledOnHost = false;
  private text = "";
  private sending: Promise<unknown> = Promise.resolve();
  private readonly callbacks: VoiceCallbacks;
  private readonly language: string;
  constructor(callbacks: VoiceCallbacks, language = "en") {
    this.callbacks = callbacks;
    this.language = language;
  }

  /**
   * Resolves once recording. If stop() or cancel() runs first (the composer closed while the
   * browser asked for the microphone or the host was starting), it resolves without recording and
   * closes whatever it had already opened.
   */
  async start() {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("This browser cannot record audio here. Voice input needs HTTPS and microphone access.");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (this.stopped) return this.abandon();
      const view = parseView(await piRequest("/api/voice", { language: this.language }));
      this.id = view.id;
      this.seq = view.seq;
      if (this.stopped) return this.abandon();
      const context = new AudioContext();
      this.context = context;
      const source = context.createMediaStreamSource(this.stream);
      const resample = createResampler(context.sampleRate);
      const take = (samples: Float32Array) => {
        if (!this.stopped) this.pending.push(resample(samples));
      };
      const loaded = await context.audioWorklet.addModule(WORKLET_URL).then(
        () => true,
        () => false,
      );
      if (this.stopped) return this.abandon();
      this.node = (loaded && this.worklet(context, source, take)) || this.processor(context, source, take);
    } catch (failure) {
      this.abandon();
      if (this.stopped) return;
      throw failure;
    }
    this.timer = setInterval(() => this.flush(), SEND_EVERY_MS);
    void this.poll();
  }

  private worklet(context: AudioContext, source: MediaStreamAudioSourceNode, take: (samples: Float32Array) => void) {
    try {
      const worklet = new AudioWorkletNode(context, "mars-voice");
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => take(event.data);
      source.connect(worklet);
      return worklet;
    } catch {
      return undefined;
    }
  }

  // A worklet that cannot load (an old browser, a stricter policy): the older processor, which
  // works everywhere. It runs only while connected to the output, and writes silence there.
  private processor(context: AudioContext, source: MediaStreamAudioSourceNode, take: (samples: Float32Array) => void) {
    const processor = context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => take(event.inputBuffer.getChannelData(0).slice(0));
    source.connect(processor);
    processor.connect(context.destination);
    return processor;
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
      let view: VoiceView;
      try {
        view = parseView(await piRequest(`/api/voice/${this.id}?since=${this.seq}&wait=8000`));
      } catch (failure) {
        if (!this.polling) break;
        // The host may still hold the stream: free its place rather than wait for the idle sweep.
        this.end(failure instanceof Error ? failure.message : "Voice input stopped.", true);
        break;
      }
      // cancel() may have run while this request was out: its words must not reach the composer.
      if (!this.polling) break;
      this.seq = view.seq;
      if (view.text !== this.text) {
        this.text = view.text;
        this.callbacks.onText(view.text);
      }
      if (view.done) {
        this.end(view.error === "Cancelled." ? undefined : view.error);
        break;
      }
    }
    this.polling = false;
  }

  /** The recording ended by itself: turn the microphone off and tell the button. */
  private end(message?: string, hostMayBeOpen = false) {
    this.polling = false;
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.release();
    if (hostMayBeOpen) void this.cancelOnHost();
    if (message) this.callbacks.onError(message);
    this.callbacks.onEnd?.();
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
    await this.cancelOnHost();
  }

  /** Startup failed or was cancelled part way: close what it opened, here and on the host. */
  private abandon() {
    this.release();
    void this.cancelOnHost();
  }

  private cancelOnHost(): Promise<void> {
    if (!this.id || this.cancelledOnHost) return Promise.resolve();
    this.cancelledOnHost = true;
    return piRequest(`/api/voice/${this.id}/cancel`, {}).then(
      () => undefined,
      () => undefined,
    );
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
