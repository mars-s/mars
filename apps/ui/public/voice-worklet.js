// Voice input capture (apps/ui/lib/pi/voice.ts): forwards each block of microphone samples to the
// page, which converts them to 16 kHz PCM. Served from the same origin so the host's
// Content Security Policy (script-src 'self') allows it.
registerProcessor("mars-voice", class extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) this.port.postMessage(input[0].slice(0));
    return true;
  }
});
