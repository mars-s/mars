"use client";

import { useAui } from "@assistant-ui/react";
import { Loader2, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "@/components/workspace-context";
import { VoiceRecorder } from "@/lib/pi/voice";

type Phase = "idle" | "starting" | "recording" | "finishing";

/**
 * The microphone in the composer (docs/VOICE.md): click to dictate, words appear in the message
 * box as you speak, click again to finish. Escape cancels and puts back what was there before.
 */
export function VoiceButton({ disabled }: { disabled: boolean }) {
  const aui = useAui();
  const { snapshot, setActionError } = useWorkspace();
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<VoiceRecorder | null>(null);
  const before = useRef("");
  // The words dictation has written so far, right after `before` in the composer.
  const dictated = useRef("");
  const claude = snapshot?.anthropicAuth.connected === true;

  useEffect(() => {
    if (phase !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => () => void recorder.current?.cancel(), []);

  // Replace only the dictated words: anything added after them meanwhile (an image chip, typing)
  // stays. If the owner edited before or inside them, only new words are added at the end.
  const rest = () => {
    const current = aui.composer.getState().text;
    // `before` may end in a space the composer does not have yet (no words written so far).
    const head = before.current.trimEnd();
    if (!current.startsWith(head)) return null;
    const from = head.length + (/^\s*/.exec(current.slice(head.length))?.[0].length ?? 0);
    return current.startsWith(dictated.current, from) ? current.slice(from + dictated.current.length) : null;
  };
  const write = (text: string) => {
    const after = rest();
    if (after !== null) aui.composer.setText(before.current + text + after);
    else if (text.startsWith(dictated.current) && text.length > dictated.current.length)
      aui.composer.setText(aui.composer.getState().text + text.slice(dictated.current.length));
    dictated.current = text;
  };
  const start = async () => {
    const current = aui.composer.getState().text;
    before.current = current && !/\s$/.test(current) ? current + " " : current;
    dictated.current = "";
    setSeconds(0);
    setPhase("starting");
    const next = new VoiceRecorder({
      onText: write,
      onError: (message) => setActionError(message),
      // The host ended the recording by itself (its time limit, a lost connection): the microphone
      // is already off and the words so far stay in the message box.
      onEnd: () => {
        if (recorder.current !== next) return;
        recorder.current = null;
        setPhase("idle");
      },
    });
    recorder.current = next;
    try {
      await next.start();
      if (recorder.current === next) setPhase("recording");
    } catch (failure) {
      recorder.current = null;
      setPhase("idle");
      const message = failure instanceof Error ? failure.message : "Voice input could not start.";
      setActionError(/Permission|NotAllowed/i.test(message) ? "Microphone access was blocked. Allow it in the browser to use voice input." : message);
    }
  };
  const stop = async () => {
    const active = recorder.current;
    if (!active) return;
    setPhase("finishing");
    try {
      write(await active.stop());
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Voice input stopped early.");
    } finally {
      recorder.current = null;
      setPhase("idle");
    }
  };
  const cancel = async () => {
    const active = recorder.current;
    recorder.current = null;
    setPhase("idle");
    const after = rest();
    aui.composer.setText(after === null ? aui.composer.getState().text : (before.current + after).trimEnd());
    await active?.cancel();
  };
  useEffect(() => {
    if (phase !== "recording") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "finishing";
  const label = recording ? "Stop dictation" : busy ? "Preparing voice input" : "Dictate with your voice";
  const title = !claude
    ? "Voice input uses your Claude account. Connect Claude in Settings, Account."
    : recording
      ? "Stop and keep the words (Esc cancels)"
      : "Dictate: speak and the words appear here";
  return (
    <button
      type="button"
      className="live-voice"
      data-recording={recording ? "" : undefined}
      aria-label={label}
      aria-pressed={recording}
      title={title}
      disabled={(disabled || !claude) && !recording}
      onClick={() => void (recording ? stop() : phase === "idle" ? start() : undefined)}
    >
      {busy ? (
        <Loader2 size={15} className="live-voice-spin" aria-hidden="true" />
      ) : recording ? (
        <>
          <span className="live-voice-dot" aria-hidden="true" />
          <span className="live-voice-time">
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
          </span>
          <Square size={11} fill="currentColor" aria-hidden="true" />
        </>
      ) : (
        <Mic size={16} aria-hidden="true" />
      )}
      {recording && <span className="sr-only" role="status">Recording. Speak now.</span>}
    </button>
  );
}
