import assert from "node:assert/strict";
import test from "node:test";
import type { IPhoneRemoteService } from "@zcode/services";
import {
  createPhoneDrivenTaskStore,
  PHONE_DRIVEN_TASK_POLL_INTERVAL_MS,
} from "../src/hooks/usePhoneDrivenTaskIds.js";

function createFakeTimers() {
  const scheduled: { handle: number; callback: () => void; delayMs: number }[] = [];
  let nextHandle = 1;
  return {
    setTimer(callback: () => void, delayMs: number) {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.push({ handle, callback, delayMs });
      return handle;
    },
    clearTimer(handle: unknown) {
      const index = scheduled.findIndex((entry) => entry.handle === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
    runNext() {
      const entry = scheduled.shift();
      entry?.callback();
    },
    get pending() {
      return scheduled.length;
    },
  };
}

function createFakeService(listActiveTaskIds: () => Promise<string[]>): IPhoneRemoteService {
  return {
    start: async () => ({ status: "stopped" as const }),
    stop: async () => {},
    getState: async () => ({ status: "stopped" as const }),
    listActiveTaskIds,
  };
}

/** Lets a pending listActiveTaskIds promise settle inside the test body. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a host without the service never polls and reads as no active tasks", () => {
  const timers = createFakeTimers();
  const store = createPhoneDrivenTaskStore({
    pollIntervalMs: PHONE_DRIVEN_TASK_POLL_INTERVAL_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: () => {},
  });
  let notifications = 0;
  const release = store.subscribe(undefined, () => {
    notifications += 1;
  });

  assert.equal(store.getSnapshot().size, 0);
  assert.equal(timers.pending, 0, "no timer is scheduled without a service");
  assert.equal(notifications, 0);

  release();
  assert.equal(timers.pending, 0);
});

test("a registered service is polled on the interval and exposes its task ids", async () => {
  const timers = createFakeTimers();
  const results: string[][] = [
    ["task-a", "task-b"],
    ["task-a", "task-b"],
    ["task-a", "task-b", "task-c"],
  ];
  let calls = 0;
  const service = createFakeService(async () => results[Math.min(calls++, results.length - 1)]!);
  const store = createPhoneDrivenTaskStore({
    pollIntervalMs: PHONE_DRIVEN_TASK_POLL_INTERVAL_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: () => {},
  });
  let notifications = 0;
  const release = store.subscribe(service, () => {
    notifications += 1;
  });

  // The first poll runs on subscribe rather than one interval later.
  assert.equal(calls, 1);
  await flush();
  assert.deepEqual([...store.getSnapshot()].sort(), ["task-a", "task-b"]);
  assert.equal(notifications, 1);
  const firstSnapshot = store.getSnapshot();

  // An unchanged answer must keep the same reference, otherwise every list
  // re-renders on every tick.
  timers.runNext();
  await flush();
  assert.equal(store.getSnapshot(), firstSnapshot);
  assert.equal(notifications, 1);

  timers.runNext();
  await flush();
  assert.deepEqual([...store.getSnapshot()].sort(), ["task-a", "task-b", "task-c"]);
  assert.equal(notifications, 2);

  // Unmounting clears the timer, so a hidden list costs nothing.
  release();
  assert.equal(timers.pending, 0);
  assert.equal(calls, 3);
});

test("an RPC failure degrades to no active tasks and recovers on the next poll", async () => {
  const timers = createFakeTimers();
  const errors: string[] = [];
  let calls = 0;
  const service = createFakeService(async () => {
    calls += 1;
    if (calls === 1) return ["task-a"];
    if (calls === 2) throw new Error("no such channel: phoneRemoteService");
    return ["task-a"];
  });
  const store = createPhoneDrivenTaskStore({
    pollIntervalMs: PHONE_DRIVEN_TASK_POLL_INTERVAL_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (message) => errors.push(message),
  });
  const release = store.subscribe(service, () => {});

  await flush();
  assert.deepEqual([...store.getSnapshot()], ["task-a"]);

  timers.runNext();
  await flush();
  assert.deepEqual(errors, ["no such channel: phoneRemoteService"]);
  assert.equal(store.getSnapshot().size, 0, "a failure clears the badge instead of freezing it");

  timers.runNext();
  await flush();
  assert.deepEqual([...store.getSnapshot()], ["task-a"]);
  assert.equal(errors.length, 1, "recovery does not report another failure");

  release();
});

test("an in-flight response that lands after unmount is dropped", async () => {
  const timers = createFakeTimers();
  let resolveCall: ((ids: string[]) => void) | undefined;
  const service = createFakeService(
    () =>
      new Promise<string[]>((resolve) => {
        resolveCall = resolve;
      }),
  );
  const errors: string[] = [];
  const store = createPhoneDrivenTaskStore({
    pollIntervalMs: PHONE_DRIVEN_TASK_POLL_INTERVAL_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: (message) => errors.push(message),
  });
  let notifications = 0;
  const release = store.subscribe(service, () => {
    notifications += 1;
  });

  release();
  assert.equal(timers.pending, 0);
  resolveCall?.(["task-late"]);
  await flush();

  assert.equal(notifications, 0);
  assert.deepEqual(errors, []);
  assert.equal(store.getSnapshot().size, 0);
});

test("many subscribers share one poll and the last release tears it down", async () => {
  const timers = createFakeTimers();
  let calls = 0;
  const service = createFakeService(async () => {
    calls += 1;
    return ["task-a"];
  });
  const store = createPhoneDrivenTaskStore({
    pollIntervalMs: PHONE_DRIVEN_TASK_POLL_INTERVAL_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onError: () => {},
  });

  const releases = [0, 1, 2, 3].map(() => store.subscribe(service, () => {}));
  assert.equal(calls, 1, "four rows still mean one RPC");
  assert.equal(timers.pending, 1);
  await flush();

  releases[0]?.();
  releases[1]?.();
  assert.equal(timers.pending, 1, "a released row does not stop the shared poll");
  releases[2]?.();
  releases[3]?.();
  assert.equal(timers.pending, 0);

  // A later mount starts clean, and does not inherit the previous answer.
  const release = store.subscribe(service, () => {});
  assert.equal(calls, 2);
  await flush();
  assert.deepEqual([...store.getSnapshot()], ["task-a"]);
  release();
});
