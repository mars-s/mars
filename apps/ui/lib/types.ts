export type View = "workspace" | "routines" | "customize" | "artifacts";
export type Panel = "context" | "files" | "terminal" | "browser" | "changes" | "tasks" | "sidechat" | null;
export type PermissionMode = "ask" | "auto" | "plan";
export type TaskStatus = "running" | "queued" | "waiting_approval" | "completed" | "paused" | "failed" | "cancelled";

export interface MarsMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "running" | "complete" | "cancelled" | "error";
  /** A disconnected client view does not imply that a remote run was cancelled. */
  streamState?: "detached";
  transport?: "demo" | "remote";
  activity?: { title: string; detail: string; status: "running" | "complete" }[];
}

export interface Session {
  id: string;
  title: string;
  project: string;
  messages: MarsMessage[];
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  parentId?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  sessionId: string;
  progress: number;
  steps: { title: string; done: boolean }[];
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  time: string;
  enabled: boolean;
  lastRun?: string;
}

export interface WorkspaceSettings {
  model: string;
  permissionMode: PermissionMode;
  theme: "dark" | "light" | "system";
  compact: boolean;
  reducedMotion: boolean;
  showActivity: boolean;
  endpoint: string;
}
