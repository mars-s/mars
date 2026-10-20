import type { Routine, Session, Task, WorkspaceSettings } from "./types";

// These are sample conversations and work items, not records from a live agent.
const stamp = Date.UTC(2026, 9, 20, 9, 30);

export const demoSettings: WorkspaceSettings = {
  model: "Claude Sonnet",
  permissionMode: "ask",
  theme: "dark",
  compact: false,
  reducedMotion: false,
  showActivity: true,
  endpoint: "",
};

export const demoSessions: Session[] = [
  {
    id: "mars-workspace",
    title: "Building the Mars workspace",
    project: "Project Mars",
    pinned: true,
    updatedAt: stamp,
    messages: [
      {
        id: "mars-msg-1",
        role: "user",
        content: "For Mars, I want one assistant I can talk to all day. It should remember the work, even when I switch projects.",
        createdAt: stamp - 600_000,
      },
      {
        id: "mars-msg-2",
        role: "assistant",
        content: "Let’s make the conversation the steady part. Each project gets its own context, while ongoing work stays close by in the task panel.\n\nYou can move between a quick question and a longer piece of work without losing your place.",
        createdAt: stamp - 590_000,
        status: "complete",
      },
      {
        id: "mars-msg-3",
        role: "user",
        content: "That feels right. What should the first milestone be?",
        createdAt: stamp - 300_000,
      },
      {
        id: "mars-msg-4",
        role: "assistant",
        content: "**One conversation that survives a restart.**\n\nStart with a small, complete loop: send a message, follow a task, approve a change, and return to the same state after reconnecting.\n\nThe project brief is in **Context**. I’ve also sketched three example work items in **Tasks**, so you can explore how the workspace fits together. Once your Pi runtime is connected, those panels can reflect its actual work.",
        createdAt: stamp - 290_000,
        status: "complete",
        activity: [
          { title: "Project brief", detail: "Conversation, continuity, and background work", status: "complete" },
          { title: "First milestone", detail: "A single conversation, from message to reconnect", status: "complete" },
        ],
      },
    ],
  },
  {
    id: "mars-memory",
    title: "Memory & continuity",
    project: "Project Mars",
    updatedAt: stamp - 3_600_000,
    messages: [
      { id: "memory-1", role: "user", content: "What should Mars remember between conversations?", createdAt: stamp - 3_610_000 },
      { id: "memory-2", role: "assistant", content: "Start with the things you would otherwise repeat: project goals, decisions, preferences, and unfinished work.\n\nKeep those separate from a transcript. A useful memory should have a source, a clear scope, and a way for you to correct it.", createdAt: stamp - 3_600_000, status: "complete" },
    ],
  },
  {
    id: "mars-runtime",
    title: "Pi runtime architecture",
    project: "Project Mars",
    updatedAt: stamp - 86_400_000,
    messages: [
      { id: "runtime-1", role: "user", content: "Let’s keep the first version of the runtime small.", createdAt: stamp - 86_410_000 },
      { id: "runtime-2", role: "assistant", content: "A good first boundary is one server process owning the durable agent state, with this workspace acting as a client.\n\nThe client needs a conversation snapshot, live events, and explicit commands for sending, cancelling, and approving work. The transport adapter is where your server’s actual protocol will connect.", createdAt: stamp - 86_400_000, status: "complete" },
    ],
  },
  {
    id: "personal-week",
    title: "A little space for the week",
    project: "Personal",
    updatedAt: stamp - 7_200_000,
    messages: [
      { id: "week-1", role: "user", content: "Help me leave a little more space in my week.", createdAt: stamp - 7_210_000 },
      { id: "week-2", role: "assistant", content: "Pick three things that would make the week feel complete, then leave room around them.\n\nWhat’s one thing you want to finish, one thing you want to enjoy, and one thing you can let wait?", createdAt: stamp - 7_200_000, status: "complete" },
    ],
  },
  { id: "recent-notes", title: "A place for loose ideas", project: "Recents", updatedAt: stamp - 14_400_000, messages: [] },
];

export const demoTasks: Task[] = [
  {
    id: "task-workspace",
    title: "Shape the workspace",
    description: "Bring conversations, project context, and task progress into one quiet workspace.",
    status: "completed",
    sessionId: "mars-workspace",
    progress: 100,
    steps: [
      { title: "Establish the workspace layout", done: true },
      { title: "Add project sessions and context", done: true },
      { title: "Review the conversation flow", done: true },
    ],
  },
  {
    id: "task-runtime",
    title: "Connect the Pi runtime",
    description: "Replace the local demo transport with an adapter for the Pi runtime on your VM.",
    status: "paused",
    sessionId: "mars-workspace",
    progress: 33,
    steps: [
      { title: "Define the client transport boundary", done: true },
      { title: "Map the server’s actual event protocol", done: false },
      { title: "Verify streaming, cancellation, and reconnect", done: false },
    ],
  },
  {
    id: "task-restart",
    title: "Verify a durable conversation",
    description: "Prove that pending work, approvals, and the conversation can be restored after a server restart.",
    status: "waiting_approval",
    sessionId: "mars-workspace",
    progress: 0,
    steps: [
      { title: "Start a conversation with a pending task", done: false },
      { title: "Restart the owning process", done: false },
      { title: "Restore state and reconcile interrupted work", done: false },
    ],
  },
];

export const demoRoutines: Routine[] = [
  {
    id: "routine-morning",
    name: "Morning briefing",
    prompt: "Summarize my active projects, work that needs a decision, and the three things worth focusing on today.",
    schedule: "Weekdays",
    time: "08:30",
    enabled: false,
  },
  {
    id: "routine-review",
    name: "Weekly project review",
    prompt: "Review Project Mars. Summarize decisions, open questions, and the next small milestone.",
    schedule: "Weekly",
    time: "16:00",
    enabled: false,
  },
];

export function createDemoWorkspace() {
  return {
    sessions: structuredClone(demoSessions),
    activeSessionId: "mars-workspace",
    tasks: structuredClone(demoTasks),
    routines: structuredClone(demoRoutines),
    settings: { ...demoSettings },
  };
}
