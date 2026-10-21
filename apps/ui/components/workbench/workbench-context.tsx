"use client";

import { createContext, useContext, useEffect, useReducer, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  initialState,
  parseState,
  reduce,
  serialiseState,
  STORAGE_KEY,
  type WorkbenchAction,
  type WorkbenchState,
} from "./workbench-state";

type Workbench = { state: WorkbenchState; dispatch: (action: WorkbenchAction) => void };
const WorkbenchContext = createContext<Workbench | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  // Becomes true only after the restored state has rendered, so the first save never
  // overwrites what was stored with the pre-restore default.
  const [loaded, setLoaded] = useState(false);
  // Restore after mount so the server render and first client render agree.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {
      /* Storage can be blocked; the workbench still works for this page. */
    }
    dispatch({ type: "hydrate", state: parseState(saved) });
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, serialiseState(state));
    } catch {
      /* Not persisted when storage is blocked. */
    }
  }, [state, loaded]);
  return <WorkbenchContext.Provider value={{ state, dispatch }}>{children}</WorkbenchContext.Provider>;
}

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw Error("useWorkbench must be used inside WorkbenchProvider.");
  return workbench;
}

export const PHONE_QUERY = "(max-width: 768px)";
const subscribePhone = (change: () => void) => {
  const media = matchMedia(PHONE_QUERY);
  media.addEventListener("change", change);
  return () => media.removeEventListener("change", change);
};

/** True while the workbench covers the chat as a phone sheet, so the chat must be inert. */
export function useWorkbenchSheet() {
  const { state } = useWorkbench();
  const phone = useSyncExternalStore(subscribePhone, () => matchMedia(PHONE_QUERY).matches, () => false);
  return state.open && phone;
}
