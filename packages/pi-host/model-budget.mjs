import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function installModelBudget(models, { maxConcurrent = 4, maxOutputTokens = 8192 } = {}) {
  for (const [name, value] of Object.entries({ maxConcurrent, maxOutputTokens })) {
    if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid ${name}`);
  }
  if (typeof models.streamSimple !== "function") throw Error("Models.streamSimple is required");
  const descriptor = Object.getOwnPropertyDescriptor(models, "streamSimple");
  if (descriptor ? descriptor.writable !== true : !Object.isExtensible(models)) {
    throw Error("Models instance cannot install the streamSimple budget adapter");
  }
  const original = models.streamSimple.bind(models);
  const waiting = [];
  let running = 0;
  const status = () => ({ running, waiting: waiting.length, maxConcurrent, maxOutputTokens });

  function fail(entry, error, aborted) {
    const message = {
      role: "assistant", content: [], api: entry.model.api, provider: entry.model.provider,
      model: entry.model.id, usage: zeroUsage(), stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error), timestamp: entry.timestamp,
    };
    entry.output.push({ type: "error", reason: message.stopReason, error: message });
  }

  async function dispatch(entry) {
    try {
      const source = original(entry.model, entry.context, entry.options);
      for await (const event of source) entry.output.push(event);
      // end carries provider results even when a provider ends without a terminal event.
      entry.output.end(await source.result());
    } catch (error) {
      fail(entry, error, entry.options.signal?.aborted === true);
    } finally {
      running--;
      pump();
    }
  }

  function pump() {
    while (running < maxConcurrent && waiting.length) {
      const entry = waiting.shift();
      entry.options.signal?.removeEventListener("abort", entry.abort);
      if (entry.options.signal?.aborted) {
        fail(entry, entry.options.signal.reason ?? Error("Request aborted while queued"), true);
        continue;
      }
      running++;
      void dispatch(entry);
    }
  }

  models.streamSimple = (model, context, options = {}) => {
    const output = createAssistantMessageEventStream();
    const entry = {
      model, context, output, timestamp: Date.now(),
      // Never above the configured cap, nor above what the model itself can produce.
      options: { ...options, maxTokens: Math.min(options.maxTokens ?? maxOutputTokens, maxOutputTokens, model?.maxTokens > 0 ? model.maxTokens : Infinity) },
      abort: undefined,
    };
    entry.abort = () => {
      const index = waiting.indexOf(entry);
      if (index < 0) return;
      waiting.splice(index, 1);
      entry.options.signal.removeEventListener("abort", entry.abort);
      fail(entry, entry.options.signal.reason ?? Error("Request aborted while queued"), true);
    };
    waiting.push(entry);
    entry.options.signal?.addEventListener("abort", entry.abort, { once: true });
    if (entry.options.signal?.aborted) entry.abort();
    queueMicrotask(pump);
    return output;
  };
  return { status };
}
