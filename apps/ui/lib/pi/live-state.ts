export type ImageReceipt = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  width: number;
  height: number;
  url: string;
};
export function parseImages(value: unknown): ImageReceipt[] {
  return (Array.isArray(value) ? value : []).flatMap((value) => {
    const row = record(value);
    if (
      typeof row.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.id) ||
      row.url !== `/api/attachments/${row.id}`
    )
      return [];
    return [
      {
        id: row.id,
        name: typeof row.name === "string" ? row.name : "Image",
        mimeType: typeof row.mimeType === "string" ? row.mimeType : "image/webp",
        size: Number(row.size) || 0,
        width: Number(row.width) || 0,
        height: Number(row.height) || 0,
        url: row.url,
      },
    ];
  });
}
export type Subthread = {
  id: string;
  conversationId: string;
  title: string;
  status: string;
  modelId: string;
  provider: string;
  /** Archived sub-threads fold away under their parent. */
  archived: boolean;
};
export type WorkflowStep = {
  index: number;
  title: string;
  status: string;
  conversationId: string;
  modelId: string;
  provider: string;
  durationMs?: number;
  usage: { label: string; value: number }[];
};
export type Workflow = {
  id: string;
  conversationId: string;
  title: string;
  status: string;
  currentStep: number;
  steps: WorkflowStep[];
};
export type ToolActivity = {
  id: string;
  name: string;
  input: string;
  output?: string;
  failed: boolean;
  state?: "running" | "complete" | "failed" | "cancelled";
  durationMs?: number;
  exitCode?: number;
  /** Pi tool result details, bounded: unified patch for edit/write, truncation flag for shell. */
  details?: { patch?: string; diff?: string; truncated?: boolean; fullOutputPath?: string };
  children?: ToolActivity[];
};
export type LiveMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolActivity[];
  /** The background model's one-line summary of this message's run of tool steps, if any. */
  summary?: string;
  images?: ImageReceipt[];
  running: boolean;
  outcome?: "error" | "cancelled";
};
/** An assistant message with tool calls and nothing else, which the next step can join. */
const toolOnly = (message: LiveMessage) =>
  message.role === "assistant" && message.tools.length > 0 && !message.text && !message.outcome && !message.running;
export type LoginState = {
  connected: boolean;
  state: string;
  error: string;
  url: string;
  code: string;
  prompt: string | null;
};
export type SideChatSummary = { id: string; title: string; running: boolean; archived?: boolean };
export type PlanStatus = "pending" | "in_progress" | "completed";
/** The agent's checklist for multi-step work (docs/TOOLS.md "plan_update"). */
export type Plan = { steps: { step: string; status: PlanStatus }[]; done: number; total: number };
const PLAN_STATUSES: readonly string[] = ["pending", "in_progress", "completed"];
/** A plan from /api/state, or null. Unknown statuses read as pending; empty steps are dropped. */
export function parsePlan(value: unknown): Plan | null {
  const steps = list(record(value).steps)
    .map(record)
    .flatMap((row) => {
      const step = string(row.step).trim().slice(0, 200);
      const status = (PLAN_STATUSES.includes(string(row.status)) ? string(row.status) : "pending") as PlanStatus;
      return step ? [{ step, status }] : [];
    })
    .slice(0, 20);
  if (!steps.length) return null;
  return { steps, done: steps.filter((row) => row.status === "completed").length, total: steps.length };
}
export type ConversationSummary = {
  id: string;
  title: string;
  modelId: string;
  provider: string;
  running: boolean;
  /** Side chats opened from this conversation, newest first (docs/WORKBENCH.md). */
  sideChats: SideChatSummary[];
  /** How many side chats exist in all, when more than the listed page. */
  sideChatTotal: number;
  /** The owner's group for this chat in Recents, or "" for the default ungrouped list. */
  group: string;
  /** Archived chats leave Recents for the Archived section; they still open and run. */
  archived: boolean;
};
export type WorkerSummary = {
  id: string;
  conversationId: string;
  modelId: string;
  provider: string;
  status: string;
  title: string;
  task: string;
  result: string;
  error: string;
};
export const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  /** Pi's supported thinking levels for this model, lowest first. Empty when unknown. */
  efforts: string[];
};
export type ContextUsage =
  | { basis: "unavailable" }
  | {
      basis: "reported" | "estimated";
      limit: number;
      used: number;
      compactAt: number;
      autoCompact: boolean;
      segments: { id: string; label: string; tokens: number }[];
    };
export function parseContext(value: unknown): ContextUsage {
  const row = record(value);
  const limit = Number(row.limit);
  const used = Number(row.used);
  if (
    (row.basis !== "reported" && row.basis !== "estimated") ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !Number.isFinite(used) ||
    used < 0
  )
    return { basis: "unavailable" };
  return {
    basis: row.basis,
    limit,
    used,
    compactAt: Math.min(1, Math.max(0, Number(row.compactAt) || 0.8)),
    autoCompact: row.autoCompact !== false,
    segments: (Array.isArray(row.segments) ? row.segments : []).map(record).flatMap((segment) =>
      typeof segment.id === "string" && Number.isFinite(Number(segment.tokens))
        ? [{ id: segment.id, label: typeof segment.label === "string" ? segment.label : segment.id, tokens: Number(segment.tokens) }]
        : [],
    ),
  };
}
/**
 * A message waiting in Pi's inbox while a reply runs. "queue" waits for the reply to finish;
 * "steer" reaches the running reply at its next tool boundary.
 */
export type QueuedMessage = { id: string; mode: "queue" | "steer"; text: string; images: number };
/** Pi's `pi.inbox` document as the browser sees it (image bytes are already stripped). */
export function parseQueue(value: unknown): QueuedMessage[] {
  return list(record(value).items)
    .map(record)
    .flatMap((item) => {
      const id = identifier(item.id);
      if (!id || (item.mode !== "followUp" && item.mode !== "steer")) return [];
      const parts = typeof item.content === "string" ? [] : list(item.content).map(record);
      return [
        {
          id,
          mode: item.mode === "steer" ? ("steer" as const) : ("queue" as const),
          text: (typeof item.content === "string" ? item.content : text(item.content)).slice(0, 4000),
          images: parts.filter((part) => part.type === "image").length,
        },
      ];
    });
}
/** The owner's model choices (docs/MODELS.md); each "" when unset. */
export type ModelSettings = { defaultModel: string; defaultEffort: string; backgroundModel: string };
export function parseModelSettings(value: unknown): ModelSettings {
  const data = record(value);
  return { defaultModel: string(data.defaultModel), defaultEffort: string(data.defaultEffort), backgroundModel: string(data.backgroundModel) };
}
export type LiveSnapshot = {
  modelSettings: ModelSettings;
  /** Messages waiting for the running reply, oldest first. */
  queue: QueuedMessage[];
  context: ContextUsage;
  parentConversationId: string;
  /** Set when this conversation is a side chat: the conversation it belongs to. */
  sideChatOf: string;
  /** The agent's current checklist, or null. */
  plan: Plan | null;
  conversationTitle: string;
  subthreads: Subthread[];
  workflows: Workflow[];
  runtime: string;
  providerReady: boolean;
  conversationId: string;
  model: string;
  running: boolean;
  messages: LiveMessage[];
  models: ModelChoice[];
  /** Pi's effort (thinking level) for this conversation, or "" when the host does not report it. */
  thinkingLevel: string;
  extensions: {
    name: string;
    title: string;
    hash: string;
    enabled?: boolean;
    uiEnabled?: boolean;
  }[];
  auth: LoginState;
  anthropicAuth: LoginState;
  conversations: ConversationSummary[];
  workers: WorkerSummary[];
  usage: { label: string; value: number }[];
};

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function text(value: unknown): string {
  return typeof value === "string"
    ? value
    : list(value)
        .map(record)
        .filter((part) => part.type === "text")
        .map((part) => string(part.text))
        .join("\n");
}
function safeUrl(value: unknown): string {
  try {
    const url = new URL(string(value));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
function parseLogin(value: unknown): LoginState {
  const auth = record(value);
  const loginEvent = list(auth.events)
    .map(record)
    .findLast((event) => event.type === "auth_url" || event.type === "device_code");
  const prompt = record(auth.prompt);
  return {
    connected: auth.connected === true,
    state: string(auth.state),
    error: string(auth.error),
    url: safeUrl(loginEvent?.url || loginEvent?.verificationUri),
    code: string(loginEvent?.userCode),
    prompt: auth.prompt
      ? string(prompt.placeholder) || string(prompt.message) || "Authorisation response"
      : null,
  };
}
function identifier(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : "";
}
export function parseConversations(value: unknown): ConversationSummary[] {
  return list(value)
    .map(record)
    .flatMap((row) => {
      const id = identifier(row.id);
      return id
        ? [
            {
              id,
              title: string(row.title) || `Conversation ${id}`,
              modelId: string(row.modelId),
              provider: string(row.provider),
              running: row.running === true,
              sideChats: list(row.sideChats)
                .map(record)
                .flatMap((side) => {
                  const sideId = identifier(side.id);
                  return sideId
                    ? [
                        {
                          id: sideId,
                          title: string(side.title) || "Side chat",
                          running: side.running === true,
                          ...(side.archived === true ? { archived: true } : {}),
                        },
                      ]
                    : [];
                }),
              sideChatTotal: Number.isInteger(row.sideChatTotal) ? Number(row.sideChatTotal) : 0,
              group: string(row.group).trim(),
              archived: row.archived === true,
            },
          ]
        : [];
    });
}
export function parseCreatedConversation(value: unknown): ConversationSummary {
  const conversation = parseConversations([record(value).conversation])[0];
  if (!conversation)
    throw Error("Pi did not confirm the new conversation. Refresh before trying again.");
  return conversation;
}
function printable(value: unknown): string {
  return value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);
}
function parseWorkers(value: unknown): WorkerSummary[] {
  return list(value)
    .map(record)
    .flatMap((row) => {
      const id = identifier(row.id),
        conversationId = identifier(row.conversationId);
      return id && conversationId && typeof row.status === "string"
        ? [
            {
              id,
              conversationId,
              modelId: string(row.modelId),
              provider: string(row.provider),
              status: row.status,
              title: string(row.title),
              task: printable(row.task),
              result: printable(row.result),
              error: printable(row.error),
            },
          ]
        : [];
    });
}
function parseUsage(value: unknown): LiveSnapshot["usage"] {
  const models = Object.values(record(record(value).models)).map(record);
  const fields = [
    { label: "Input tokens", key: "input" },
    { label: "Output tokens", key: "output" },
    { label: "Total tokens", key: "totalTokens" },
  ];
  return fields.flatMap(({ label, key }) => {
    const counts = models
      .map((usage) => usage[key])
      .filter(
        (count): count is number =>
          typeof count === "number" && Number.isFinite(count) && count >= 0,
      );
    return counts.length
      ? [{ label, value: counts.reduce((total, count) => total + count, 0) }]
      : [];
  });
}
export function parseSnapshot(value: unknown): LiveSnapshot {
  const data = record(value),
    view = record(data.view),
    docs = record(view.docs),
    auth = record(data.auth);
  if (
    typeof data.runtime !== "string" ||
    !Array.isArray(view.entries) ||
    typeof auth.connected !== "boolean"
  )
    throw Error("Pi returned an unsupported snapshot. Reconnect after checking the host.");
  const live = record(docs["pi.live"]);
  const messages: LiveMessage[] = [];
  const calls = new Map<string, ToolActivity>();
  for (const entryValue of view.entries) {
    const entry = record(entryValue);
    // The agent's note that a side chat it gave work to finished: shown as a short line, not as
    // the owner speaking (the model reads it as a user message).
    if (entry.kind === "mars.side-chat-done") {
      const title = string(record(entry.data).title) || "Side chat";
      messages.push({
        id: `${String(entry.id)}:done`,
        role: "assistant",
        text: `Side chat “${title}” finished.`,
        tools: [],
        running: false,
      });
      continue;
    }
    list(entry.model).forEach((raw, index) => {
      const message = record(raw);
      if (message.role === "toolResult" || message.role === "tool") {
        const call = calls.get(string(message.toolCallId));
        if (call) {
          call.output = text(message.content);
          call.failed = message.isError === true;
          call.state = call.failed ? "failed" : "complete";
          const details = record(message.details);
          if (typeof details.exitCode === "number") call.exitCode = details.exitCode;
          const bounded = (value: unknown) =>
            typeof value === "string" && value.length <= 200000 ? value : undefined;
          const kept = {
            patch: bounded(details.patch),
            diff: bounded(details.diff),
            truncated: typeof details.truncated === "boolean" ? details.truncated : undefined,
            fullOutputPath: bounded(details.fullOutputPath),
          };
          if (Object.values(kept).some((value) => value !== undefined)) call.details = kept;
          call.children = list(details.calls)
            .map(record)
            .map((nested, index) => ({
              id: `${call.id}/c${String(nested.id ?? index)}`,
              name: string(nested.name) || "Tool",
              input: typeof nested.args === "string" ? nested.args : printable(nested.args),
              output: typeof nested.error === "string" ? nested.error : undefined,
              failed: nested.status === "error",
              state:
                nested.status === "error"
                  ? "failed"
                  : nested.status === "cancelled"
                    ? "cancelled"
                    : nested.status === "ok"
                      ? "complete"
                      : "running",
              durationMs: typeof nested.durationMs === "number" ? nested.durationMs : undefined,
            }));
        }
        return;
      }
      if (message.role !== "user" && message.role !== "assistant") return;
      const tools = list(message.content)
        .map(record)
        .filter((part) => part.type === "toolCall" || part.type === "tool-call")
        .map((part) => {
          const activity: ToolActivity = {
            id: string(part.id),
            name: string(part.name) || "Tool",
            input: JSON.stringify(part.arguments ?? {}, null, 2),
            failed: false,
          };
          calls.set(activity.id, activity);
          return activity;
        });
      const outcome =
        message.stopReason === "error"
          ? "error"
          : message.stopReason === "aborted"
            ? "cancelled"
            : undefined;
      const content = text(message.content) || string(message.errorMessage);
      const images = message.role === "user" ? parseImages(record(entry.data).attachments) : [];
      if (!(content || tools.length || outcome || images.length)) return;
      // A model turn that only called tools joins the next assistant message, so a long run
      // of steps reads as one activity group instead of one "Ran 1 command" row per step.
      const previous = messages.at(-1);
      if (message.role === "assistant" && previous && toolOnly(previous)) {
        previous.tools.push(...tools);
        previous.text = content;
        previous.outcome = outcome;
        return;
      }
      messages.push({
          id: `${String(entry.id)}:${index}`,
          role: message.role,
          text: content,
          images,
          tools,
          running: false,
          outcome,
        });
    });
  }
  const generation = record(live.generation),
    partial = record(generation.message);
  const partialText = text(partial.content);
  const running = !!live.run;
  const liveTools: ToolActivity[] = [];
  if (running)
    for (const nested of list(live.nestedTools).map(record)) {
      const summary = record(nested.summary);
      const activity: ToolActivity = {
        id: string(nested.callId),
        name: string(nested.name) || "Tool",
        input: printable(nested.arguments),
        output:
          typeof nested.output === "string"
            ? nested.output
            : typeof summary.error === "string"
              ? summary.error
              : undefined,
        failed: summary.isError === true,
        state:
          summary.isError === true ? "failed" : nested.status === "done" ? "complete" : "running",
        durationMs: typeof summary.durationMs === "number" ? summary.durationMs : undefined,
      };
      const parent = calls.get(string(nested.parentCallId));
      if (parent) {
        parent.children ??= [];
        const index = parent.children.findIndex((child) => child.id === activity.id);
        if (index >= 0) parent.children[index] = activity;
        else parent.children.push(activity);
      } else liveTools.push(activity);
    }
  const previous = messages.at(-1);
  if (running && previous && toolOnly(previous)) {
    previous.tools.push(...liveTools);
    previous.text = partialText;
    previous.running = true;
  } else if (running && (partialText || liveTools.length))
    messages.push({
      id: "live-generation",
      role: "assistant",
      text: partialText,
      tools: liveTools,
      running: true,
    });
  // Background summaries are keyed by the activity group's message id.
  const summaries = record(data.summaries);
  for (const message of messages) {
    const summary = summaries[message.id];
    if (message.tools.length && typeof summary === "string" && summary.trim()) message.summary = summary.trim().slice(0, 120);
  }
  const selectedModel = record(record(docs["pi.agent"]).model);
  const provider = string(selectedModel.provider);
  return {
    parentConversationId: identifier(data.parentConversationId),
    sideChatOf: identifier(data.sideChatOf),
    plan: parsePlan(data.plan),
    queue: parseQueue(docs["pi.inbox"]),
    modelSettings: parseModelSettings(data.modelSettings),
    conversationTitle: string(data.conversationTitle),
    subthreads: list(data.subthreads)
      .map(record)
      .flatMap((row) =>
        identifier(row.id) && identifier(row.conversationId)
          ? [
              {
                id: identifier(row.id),
                conversationId: identifier(row.conversationId),
                title: string(row.title) || `Task ${identifier(row.id)}`,
                status: string(row.status),
                modelId: string(row.modelId),
                provider: string(row.provider),
                archived: row.archived === true,
              },
            ]
          : [],
      ),
    workflows: list(data.workflows)
      .map(record)
      .flatMap((row) =>
        typeof row.id === "string" || typeof row.id === "number"
          ? [
              {
                id: String(row.id),
                conversationId: identifier(row.conversationId),
                title: string(row.title) || "Workflow",
                status: string(row.status),
                currentStep: typeof row.currentStep === "number" ? row.currentStep : 0,
                steps: list(row.steps)
                  .map(record)
                  .map((step, index) => ({
                    index: typeof step.index === "number" ? step.index : index,
                    title: string(step.title) || `Phase ${index + 1}`,
                    status: string(step.status),
                    conversationId: identifier(step.conversationId),
                    provider: string(step.provider),
                    modelId: string(step.modelId),
                    durationMs: typeof step.durationMs === "number" ? step.durationMs : undefined,
                    usage: parseUsage(step.usage),
                  })),
              },
            ]
          : [],
      ),
    runtime: data.runtime,
    providerReady: typeof data.providerReady === "boolean" ? data.providerReady : auth.connected,
    conversationId: identifier(data.selectedConversationId ?? data.conversationId),
    model:
      (provider && provider !== "openai" ? `${provider}/` : "") + string(selectedModel.modelId),
    running,
    messages,
    models: list(data.models)
      .map(record)
      .filter((model) => typeof model.id === "string")
      .map((model) => {
        const id = string(model.id);
        const slash = id.indexOf("/");
        return {
          id,
          name: string(model.name) || id,
          provider: string(model.provider) || (slash > 0 ? id.slice(0, slash) : "openai"),
          efforts: list(model.efforts)
            .filter((level): level is string => typeof level === "string")
            .filter((level) => (EFFORT_ORDER as readonly string[]).includes(level))
            .sort(
              (a, b) =>
                (EFFORT_ORDER as readonly string[]).indexOf(a) -
                (EFFORT_ORDER as readonly string[]).indexOf(b),
            ),
        };
      }),
    thinkingLevel: string(data.thinkingLevel),
    extensions: list(data.extensions)
      .map(record)
      .filter(
        (extension) =>
          typeof extension.name === "string" &&
          typeof extension.hash === "string" &&
          /^[a-f0-9]{64}$/.test(extension.hash),
      )
      .map((extension) => ({
        name: string(extension.name),
        title: string(extension.title) || string(extension.name),
        hash: string(extension.hash),
        enabled: typeof extension.enabled === "boolean" ? extension.enabled : undefined,
        uiEnabled: typeof extension.uiEnabled === "boolean" ? extension.uiEnabled : undefined,
      })),
    auth: parseLogin(auth),
    anthropicAuth: parseLogin(data.anthropicAuth),
    conversations: parseConversations(data.conversations),
    workers: parseWorkers(data.workers),
    usage: parseUsage(data.usage),
    context: parseContext(data.context),
  };
}
export async function piRequest(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw Error("Pi is unavailable. Check the connection and retry.");
  }
  if (!response.ok)
    throw Error(
      string(record(data).error) ||
        (response.status === 401
          ? "This private session has expired. Open your authenticated Pi link again."
          : `Pi request failed (${response.status}).`),
    );
  return data;
}
