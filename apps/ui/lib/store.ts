"use client";

import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { createDemoWorkspace, demoSettings } from "./demo-data";
import type { MarsMessage, Routine, Session, Task, WorkspaceSettings } from "./types";

export interface WorkspaceStore {
  sessions: Session[];
  activeSessionId: string;
  tasks: Task[];
  routines: Routine[];
  settings: WorkspaceSettings;
  setActiveSession: (id: string) => void;
  createSession: (project?: string) => string;
  renameSession: (id: string, title: string) => void;
  archiveSession: (id: string) => void;
  togglePin: (id: string) => void;
  deleteSession: (id: string) => void;
  updateSettings: (partial: Partial<WorkspaceSettings>) => void;
  updateTask: (id: string, partial: Partial<Task>) => void;
  addRoutine: (input: Omit<Routine, "id">) => string;
  updateRoutine: (id: string, partial: Partial<Routine>) => void;
  deleteRoutine: (id: string) => void;
  setMessages: (sessionId: string, messages: MarsMessage[]) => void;
}

export function createId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

function emptySession(project = "Recents"): Session {
  return { id: createId("session"), title: "New conversation", project, messages: [], updatedAt: Date.now() };
}

// Never read browser storage while rendering on the server. Storage may also be
// unavailable in private browsing, at quota, or under a restrictive browser policy.
const safeStorage: StateStorage = {
  getItem(name) {
    if (typeof window === "undefined") return null;
    try { return window.localStorage.getItem(name); } catch { return null; }
  },
  setItem(name, value) {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(name, value); } catch { /* The in-memory workspace remains usable. */ }
  },
  removeItem(name) {
    if (typeof window === "undefined") return;
    try { window.localStorage.removeItem(name); } catch { /* The in-memory workspace remains usable. */ }
  },
};

type SavedWorkspace = Pick<WorkspaceStore, "sessions" | "activeSessionId" | "tasks" | "routines" | "settings">;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function restoreMessage(value: unknown): MarsMessage | null {
  if (!isRecord(value) || typeof value.id !== "string" || (value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return null;
  const interrupted = value.status === "running";
  const remote = value.transport === "remote";
  const status = interrupted ? remote ? "running" : "cancelled" : ["complete", "cancelled", "error"].includes(String(value.status)) ? value.status as MarsMessage["status"] : undefined;
  const activity = Array.isArray(value.activity) ? value.activity.filter((entry): entry is NonNullable<MarsMessage["activity"]>[number] => isRecord(entry) && typeof entry.title === "string" && typeof entry.detail === "string" && (entry.status === "complete" || (!interrupted && entry.status === "running"))) : undefined;
  return {
    id: value.id,
    role: value.role,
    content: value.content || (interrupted && !remote ? "This response was interrupted. Retry it to continue." : ""),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    status,
    transport: remote ? "remote" : "demo",
    streamState: remote && (interrupted || value.streamState === "detached") ? "detached" : undefined,
    activity,
  };
}

function restoreWorkspace(value: unknown, defaults: WorkspaceStore): SavedWorkspace {
  if (!isRecord(value)) return defaults;
  let sessions = Array.isArray(value.sessions) ? value.sessions.flatMap((entry): Session[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.project !== "string" || !Array.isArray(entry.messages)) return [];
    return [{
      id: entry.id,
      title: entry.title,
      project: entry.project,
      messages: entry.messages.map(restoreMessage).filter((message): message is MarsMessage => message !== null),
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
      pinned: entry.pinned === true,
      archived: entry.archived === true,
      parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
    }];
  }) : defaults.sessions;
  // A corrupt or entirely archived workspace must still have a valid destination.
  if (!sessions.some(session => !session.archived)) sessions = [emptySession(), ...sessions];
  const activeSessionId = sessions.some(session => session.id === value.activeSessionId && !session.archived)
    ? value.activeSessionId as string
    : sessions.find(session => !session.archived)!.id;
  const tasks = Array.isArray(value.tasks) ? value.tasks.filter((entry): entry is Task => {
    return isRecord(entry) && typeof entry.id === "string" && typeof entry.title === "string" && typeof entry.description === "string" && typeof entry.sessionId === "string" && typeof entry.progress === "number" && Array.isArray(entry.steps) && entry.steps.every(step => isRecord(step) && typeof step.title === "string" && typeof step.done === "boolean") && ["running", "queued", "waiting_approval", "completed", "paused", "failed", "cancelled"].includes(String(entry.status));
  }).map(task => ({ ...task, progress: Math.min(100, Math.max(0, task.progress)), status: task.status === "running" ? "paused" as const : task.status })) : defaults.tasks;
  const routines = Array.isArray(value.routines) ? value.routines.filter((entry): entry is Routine => isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.prompt === "string" && typeof entry.schedule === "string" && typeof entry.time === "string" && typeof entry.enabled === "boolean") : defaults.routines;
  const savedSettings = isRecord(value.settings) ? value.settings : {};
  const settings: WorkspaceSettings = {
    model: typeof savedSettings.model === "string" ? savedSettings.model : demoSettings.model,
    permissionMode: ["ask", "auto", "plan"].includes(String(savedSettings.permissionMode)) ? savedSettings.permissionMode as WorkspaceSettings["permissionMode"] : demoSettings.permissionMode,
    theme: ["dark", "light", "system"].includes(String(savedSettings.theme)) ? savedSettings.theme as WorkspaceSettings["theme"] : demoSettings.theme,
    compact: typeof savedSettings.compact === "boolean" ? savedSettings.compact : demoSettings.compact,
    reducedMotion: typeof savedSettings.reducedMotion === "boolean" ? savedSettings.reducedMotion : demoSettings.reducedMotion,
    showActivity: typeof savedSettings.showActivity === "boolean" ? savedSettings.showActivity : demoSettings.showActivity,
    endpoint: typeof savedSettings.endpoint === "string" ? savedSettings.endpoint : "",
  };
  return { sessions, activeSessionId, tasks, routines, settings };
}

function ensureActive(sessions: Session[], previous: string) {
  if (sessions.some(session => session.id === previous && !session.archived)) return { sessions, activeSessionId: previous };
  const next = sessions.find(session => !session.archived);
  if (next) return { sessions, activeSessionId: next.id };
  const created = emptySession();
  return { sessions: [created, ...sessions], activeSessionId: created.id };
}

export const useWorkspaceStore = create<WorkspaceStore>()(persist((set, get) => ({
  ...createDemoWorkspace(),
  setActiveSession: id => {
    if (get().sessions.some(session => session.id === id && !session.archived)) set({ activeSessionId: id });
  },
  createSession: project => {
    const session = emptySession(project?.trim() || "Recents");
    set(state => ({ sessions: [session, ...state.sessions], activeSessionId: session.id }));
    return session.id;
  },
  renameSession: (id, title) => {
    const cleanTitle = title.trim().slice(0, 160);
    if (!cleanTitle) return;
    set(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, title: cleanTitle } : session) }));
  },
  archiveSession: id => set(state => ensureActive(state.sessions.map(session => session.id === id ? { ...session, archived: true } : session), state.activeSessionId)),
  togglePin: id => set(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, pinned: !session.pinned } : session) })),
  deleteSession: id => set(state => ({ ...ensureActive(state.sessions.filter(session => session.id !== id), state.activeSessionId), tasks: state.tasks.filter(task => task.sessionId !== id) })),
  updateSettings: partial => set(state => ({ settings: { ...state.settings, ...partial } })),
  updateTask: (id, partial) => set(state => ({ tasks: state.tasks.map(task => task.id === id ? { ...task, ...partial, id, progress: Math.min(100, Math.max(0, partial.progress ?? task.progress)) } : task) })),
  addRoutine: input => {
    const id = createId("routine");
    set(state => ({ routines: [...state.routines, { ...input, id }] }));
    return id;
  },
  updateRoutine: (id, partial) => set(state => ({ routines: state.routines.map(routine => routine.id === id ? { ...routine, ...partial, id } : routine) })),
  deleteRoutine: id => set(state => ({ routines: state.routines.filter(routine => routine.id !== id) })),
  setMessages: (sessionId, messages) => set(state => ({
    sessions: state.sessions.map(session => session.id === sessionId ? { ...session, messages, updatedAt: Date.now() } : session),
  })),
}), {
  name: "mars-workspace-v1",
  version: 1,
  storage: createJSONStorage(() => safeStorage),
  skipHydration: true,
  partialize: ({ sessions, activeSessionId, tasks, routines, settings }) => ({ sessions, activeSessionId, tasks, routines, settings }),
  merge: (persisted, current) => ({ ...current, ...restoreWorkspace(persisted, current) }),
}));

let hydration: Promise<void> | undefined;

/** Call in a client effect. Repeated calls share one hydration operation. */
export function hydrateWorkspaceStore(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  hydration ??= Promise.resolve(useWorkspaceStore.persist.rehydrate()).then(() => undefined).catch(() => undefined);
  return hydration;
}
