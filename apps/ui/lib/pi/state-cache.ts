// Chat state caches in the browser (docs/LIVE-INTEGRATION.md "State caching"). Opening a chat
// you have seen shows it at once from memory (or, after a reload, from IndexedDB) while the
// fresh copy loads, instead of "Connecting to Pi…". Polls send the last ETag, so a chat that has
// not changed costs a 304 with no body and no parsing.

export type CachedState<T> = { value: T; etag: string; at: number };

const MEMORY_KEEP = 12;
const memory = new Map<string, CachedState<unknown>>();

/** The cached state of one chat ("" is the main conversation before its id is known). */
export function cachedState<T>(key: string): CachedState<T> | undefined {
  const hit = memory.get(key) as CachedState<T> | undefined;
  if (hit) {
    memory.delete(key);
    memory.set(key, hit);
  }
  return hit;
}

export function rememberState<T>(key: string, value: T, etag: string) {
  memory.delete(key);
  memory.set(key, { value, etag, at: Date.now() });
  while (memory.size > MEMORY_KEEP) memory.delete(memory.keys().next().value as string);
}

/** Test seam: forget everything kept in memory. */
export function forgetStates() {
  memory.clear();
}

export type StateFetch = { unchanged: true } | { unchanged: false; value: unknown; etag: string };

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * GET /api/state for one chat. With the chat's ETag, an unchanged answer is { unchanged: true }.
 * Errors read like piRequest's.
 */
export async function fetchState(conversationId: string, etag = ""): Promise<StateFetch> {
  const path = `/api/state${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ""}`;
  const response = await fetch(path, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: etag ? { "if-none-match": etag } : undefined,
  });
  if (response.status === 304) return { unchanged: true };
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw Error("Pi is unavailable. Check the connection and retry.");
  }
  if (!response.ok) {
    const error = data && typeof data === "object" ? text((data as { error?: unknown }).error) : "";
    throw Error(
      error ||
        (response.status === 401
          ? "This private session has expired. Open your authenticated Pi link again."
          : `Pi request failed (${response.status}).`),
    );
  }
  return { unchanged: false, value: data, etag: response.headers.get("etag") ?? "" };
}

// IndexedDB: the raw state of the last few chats, so a reload shows them before the network.
const DB = "mars-state";
const STORE = "states";
const DISK_KEEP = 6;
const WRITE_GAP_MS = 10000;
const written = new Map<string, number>();

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** The raw state saved for a chat, or undefined. Never throws. */
export async function loadSavedState(key: string): Promise<{ raw: unknown; etag: string } | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => {
        const row = request.result as { raw?: unknown; etag?: string } | undefined;
        resolve(row && row.raw !== undefined ? { raw: row.raw, etag: row.etag ?? "" } : undefined);
      };
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    } finally {
      db.close();
    }
  });
}

/** Save a chat's raw state, at most once every ten seconds per chat; keeps the newest six. */
export async function saveState(key: string, raw: unknown, etag: string, force = false) {
  const last = written.get(key) ?? 0;
  if (!force && Date.now() - last < WRITE_GAP_MS) return;
  written.set(key, Date.now());
  const db = await open();
  if (!db) return;
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    store.put({ raw, etag, at: Date.now() }, key);
    const all = store.getAllKeys();
    const times = store.getAll();
    times.onsuccess = () => {
      all.onsuccess = null;
      const rows = (times.result as { at?: number }[]).map((row, index) => ({ key: all.result[index], at: row.at ?? 0 }));
      rows.sort((a, b) => b.at - a.at);
      for (const row of rows.slice(DISK_KEEP)) store.delete(row.key);
    };
  } catch {
    /* Storage is optional. */
  } finally {
    db.close();
  }
}
