import { useCallback, useSyncExternalStore } from "react";
import type { IPhoneRemoteService } from "@zcode/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * Which tasks a paired phone is driving right now, for the "Phone is using this
 * task" badge in every task list surface.
 *
 * Two properties drive the shape of this module:
 *
 * 1. The list is rendered per row, so a naive hook would open one timer and one
 *    RPC per visible row. The polling therefore lives in a single window-wide
 *    store with reference counting: rows subscribe to it, only the first
 *    subscriber starts a timer, and the last one to leave tears it down. The
 *    hooks below are cheap enough to call from a row, but there is still exactly
 *    one poll per window no matter how many rows or lists are mounted.
 * 2. Every consumer is optional. A host that does not register the service
 *    (remote, bots), a window that mounts before the channel exists, and a host
 *    whose RPC call fails all read as "the phone is driving nothing". The badge
 *    is a claim about the world, so a failure resolves to an empty set rather
 *    than to a stale badge or a thrown error in a render path.
 */

/**
 * Poll cadence. The phone can pick up a task at any moment, so this is a poll
 * rather than a one-shot read, but the answer only drives a badge, so a few
 * seconds of latency is invisible to the user while a per-second RPC per window
 * would be pure overhead. 3s also keeps a machine with the feature never opened
 * effectively free: the timer only exists while a list is mounted and the
 * service is registered.
 */
export const PHONE_DRIVEN_TASK_POLL_INTERVAL_MS = 3000;

const EMPTY_ACTIVE_TASK_IDS: ReadonlySet<string> = new Set<string>();

function getSetServerSnapshot(): ReadonlySet<string> {
  return EMPTY_ACTIVE_TASK_IDS;
}

function getBooleanServerSnapshot(): boolean {
  return false;
}

export interface PhoneDrivenTaskStoreOptions {
  readonly pollIntervalMs?: number;
  /** Timer seams, so a test can drive polling without waiting on real time. */
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onError?: (message: string) => void;
}

export interface PhoneDrivenTaskStore {
  /**
   * Registers a listener and starts polling when it is the first one. Returns the
   * release function, which is safe to call more than once.
   */
  subscribe(service: IPhoneRemoteService | undefined, listener: () => void): () => void;
  /**
   * Current ids. The reference only changes when the contents change, so React
   * can compare snapshots without re-rendering every list on every poll.
   */
  getSnapshot(): ReadonlySet<string>;
}

export function createPhoneDrivenTaskStore(
  options: PhoneDrivenTaskStoreOptions = {},
): PhoneDrivenTaskStore {
  const pollIntervalMs = options.pollIntervalMs ?? PHONE_DRIVEN_TASK_POLL_INTERVAL_MS;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as unknown);
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onError =
    options.onError ??
    ((message: string) => {
      logger.warn("[usePhoneDrivenTaskIds] phone active task lookup failed", message);
    });

  const listeners = new Set<() => void>();
  let service: IPhoneRemoteService | undefined;
  let subscriberCount = 0;
  let timer: unknown;
  let polling = false;
  let inFlight = false;
  let activeTaskIds: ReadonlySet<string> = EMPTY_ACTIVE_TASK_IDS;

  function publish(next: ReadonlySet<string>) {
    if (next === activeTaskIds) return;
    activeTaskIds = next;
    // Set iteration is safe against a listener that unsubscribes while we are
    // notifying: an entry removed before it is reached is simply not visited.
    for (const listener of listeners) listener();
  }

  function toTaskIdSet(raw: unknown): ReadonlySet<string> {
    if (!Array.isArray(raw)) return EMPTY_ACTIVE_TASK_IDS;
    const next = new Set<string>();
    for (const value of raw) {
      if (typeof value === "string" && value) next.add(value);
    }
    if (next.size === activeTaskIds.size) {
      let identical = true;
      for (const id of next) {
        if (!activeTaskIds.has(id)) {
          identical = false;
          break;
        }
      }
      if (identical) return activeTaskIds;
    }
    return next;
  }

  function reportFailure(error: unknown) {
    onError(error instanceof Error ? error.message : String(error));
    // The host could not confirm anything, so the badge must go away rather
    // than keep claiming the phone owns a task it can no longer reach.
    publish(EMPTY_ACTIVE_TASK_IDS);
  }

  function poll() {
    const current = service;
    try {
      if (!current || subscriberCount === 0) return;
      // A slow RPC must not stack up behind the timer: skip this tick instead.
      if (inFlight) return;
      inFlight = true;
      let request: Promise<string[]>;
      try {
        request = current.listActiveTaskIds();
      } catch (error) {
        inFlight = false;
        reportFailure(error);
        return;
      }
      void request.then(
        (result) => {
          inFlight = false;
          // Every subscriber left while the call was in flight, so there is
          // nobody left to notify.
          if (subscriberCount === 0) return;
          publish(toTaskIdSet(result));
        },
        (error) => {
          inFlight = false;
          if (subscriberCount === 0) return;
          reportFailure(error);
        },
      );
    } finally {
      // The chain is rescheduled on every path, including a skipped tick, so a
      // single slow call cannot stop polling for the rest of the session.
      schedule();
    }
  }

  function schedule() {
    if (!polling || !service || subscriberCount === 0) return;
    timer = setTimer(poll, pollIntervalMs);
  }

  function start() {
    if (polling || !service) return;
    polling = true;
    // The first poll runs on subscribe rather than one interval later.
    poll();
  }

  function stop() {
    if (!polling) return;
    polling = false;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  return {
    subscribe(nextService, listener) {
      listeners.add(listener);
      subscriberCount += 1;
      // Every consumer in a window reads the same service accessor, so this
      // only fires when the host swaps the service out from under us. A
      // subscriber that arrives without a service never takes a real one away
      // from the others already reading it.
      if (nextService !== service && (nextService !== undefined || subscriberCount === 1)) {
        service = nextService;
        stop();
      }
      start();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(listener);
        subscriberCount -= 1;
        if (subscriberCount > 0) return;
        stop();
        service = undefined;
        // A later mount must not inherit ids from a window that is gone.
        publish(EMPTY_ACTIVE_TASK_IDS);
      };
    },
    getSnapshot() {
      return activeTaskIds;
    },
  };
}

const phoneDrivenTaskStore = createPhoneDrivenTaskStore();

/**
 * The full set of tasks a phone is driving. Prefer this above a task list, where
 * one snapshot serves every row.
 */
export function usePhoneDrivenTaskIds(): ReadonlySet<string> {
  const services = useOptionalServices();
  const service = services?.phoneRemoteService;
  const subscribe = useCallback(
    (onStoreChange: () => void) => phoneDrivenTaskStore.subscribe(service, onStoreChange),
    [service],
  );
  const getSnapshot = useCallback(() => phoneDrivenTaskStore.getSnapshot(), []);
  return useSyncExternalStore(subscribe, getSnapshot, getSetServerSnapshot);
}

/**
 * The same signal narrowed to one task. A row that reads the boolean instead of
 * the set only re-renders when its own task starts or stops being driven, not
 * every time some other task in the list changes.
 */
export function useIsPhoneDrivenTask(taskId: string | undefined): boolean {
  const services = useOptionalServices();
  const service = services?.phoneRemoteService;
  const subscribe = useCallback(
    (onStoreChange: () => void) => phoneDrivenTaskStore.subscribe(service, onStoreChange),
    [service],
  );
  const getSnapshot = useCallback(
    () => (taskId ? phoneDrivenTaskStore.getSnapshot().has(taskId) : false),
    [taskId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getBooleanServerSnapshot);
}
