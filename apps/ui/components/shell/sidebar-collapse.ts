"use client";

import { useSyncExternalStore } from "react";

const KEY = "mars-sidebar-collapsed";
const listeners = new Set<() => void>();
// Storage can throw (private mode, blocked storage); collapse then lasts for the page only.
let fallback = false;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return fallback;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setSidebarCollapsed(collapsed: boolean) {
  fallback = collapsed;
  try {
    localStorage.setItem(KEY, String(collapsed));
  } catch {
    /* Browser storage is optional. */
  }
  for (const listener of listeners) listener();
}

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
