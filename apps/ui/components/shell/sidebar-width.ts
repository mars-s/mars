"use client";

import { useSyncExternalStore } from "react";

// The sidebar's width, dragged by its right edge and kept per browser.
export const SIDEBAR_WIDTH = { min: 220, max: 480, initial: 288, step: 16 };
const KEY = "mars-sidebar-width";
const listeners = new Set<() => void>();
// Storage can throw (private mode, blocked storage); the width then lasts for the page only.
let fallback = SIDEBAR_WIDTH.initial;

export const clampSidebarWidth = (width: number) =>
  Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));

function read(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return saved ? clampSidebarWidth(saved) : SIDEBAR_WIDTH.initial;
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

export function setSidebarWidth(width: number) {
  fallback = clampSidebarWidth(width);
  try {
    localStorage.setItem(KEY, String(fallback));
  } catch {
    /* Browser storage is optional. */
  }
  for (const listener of listeners) listener();
}

export function useSidebarWidth(): number {
  return useSyncExternalStore(subscribe, read, () => SIDEBAR_WIDTH.initial);
}
