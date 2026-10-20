// Terminal transport loop (docs/WORKBENCH.md "Terminal"). No React, DOM or xterm here: node --test loads it.
import type { TerminalChunk } from "@/lib/pi/workbench";

export type LinkState =
  | { kind: "connecting" }
  | { kind: "live" }
  | { kind: "reconnecting"; message: string }
  | { kind: "ended"; exitCode?: number }
  | { kind: "missing" };

/** A JSON error from the host, with its HTTP status. */
export class HostError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type Transport = {
  poll(id: string, since: number, signal: AbortSignal): Promise<TerminalChunk>;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
};

export type Link = { send(bytes: Uint8Array): void; resize(cols: number, rows: number): void; close(): void };

/** Below the host's 64 KiB per request, measured in bytes before base64. */
export const INPUT_CHUNK = 48 * 1024;
const RESIZE_DEBOUNCE_MS = 120;
const BUSY_RETRIES = 20;

/** 0.5 s, 1 s, 2 s, 4 s, 8 s, then 10 s between failed polls. */
export const backoff = (failures: number) => Math.min(10_000, 500 * 2 ** Math.max(0, failures - 1));

export function bytesToBase64(bytes: Uint8Array) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function base64ToBytes(data: string) {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function concat(parts: Uint8Array[]) {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) all.set(part, at), (at += part.length);
  return all;
}

/**
 * Attach to a host session: long-poll output from byte 0 (the host replays what it kept),
 * send input in order, and debounce resizes. `close()` detaches without ending the session.
 */
export function connect({
  id,
  transport,
  onOutput,
  onState,
  sleep = wait,
}: {
  id: string;
  transport: Transport;
  onOutput: (bytes: Uint8Array, dropped: boolean) => void;
  onState: (state: LinkState) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Link {
  const controller = new AbortController();
  let closed = false;
  let last = "";
  const report = (state: LinkState) => {
    const key = JSON.stringify(state);
    if (key !== last && !closed) (last = key), onState(state);
  };

  void (async () => {
    let since = 0;
    let failures = 0;
    report({ kind: "connecting" });
    while (!closed) {
      let chunk: TerminalChunk;
      try {
        chunk = await transport.poll(id, since, controller.signal);
      } catch (error) {
        if (closed) return;
        if (error instanceof HostError && error.status === 404) return report({ kind: "missing" });
        failures++;
        report({ kind: "reconnecting", message: error instanceof Error ? error.message : "The Pi host did not answer." });
        await sleep(backoff(failures), controller.signal);
        continue;
      }
      if (closed) return;
      failures = 0;
      const bytes = base64ToBytes(chunk.data);
      if (bytes.length || chunk.dropped) onOutput(bytes, chunk.dropped);
      since = chunk.offset;
      if (chunk.exited) return report({ kind: "ended", exitCode: chunk.exitCode });
      report({ kind: "live" });
    }
  })();

  let queue: Uint8Array[] = [];
  let sending = false;
  async function flush() {
    if (sending) return;
    sending = true;
    let busy = 0;
    while (queue.length && !closed) {
      const all = concat(queue);
      const chunk = all.subarray(0, INPUT_CHUNK);
      queue = all.length > INPUT_CHUNK ? [all.subarray(INPUT_CHUNK)] : [];
      try {
        await transport.input(id, bytesToBase64(chunk));
        busy = 0;
      } catch (error) {
        // 429: the shell has not read earlier input yet; keep order and retry. Other failures
        // drop this chunk only; the poll loop reports the connection state.
        if (error instanceof HostError && error.status === 429 && busy++ < BUSY_RETRIES) {
          queue.unshift(chunk);
          await sleep(250, controller.signal);
        }
      }
    }
    sending = false;
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    send(bytes) {
      if (closed || !bytes.length) return;
      queue.push(bytes);
      void flush();
    },
    resize(cols, rows) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void transport.resize(id, cols, rows).catch(() => {}), RESIZE_DEBOUNCE_MS);
    },
    close() {
      closed = true;
      clearTimeout(resizeTimer);
      controller.abort();
    },
  };
}
